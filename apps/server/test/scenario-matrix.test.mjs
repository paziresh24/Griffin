// Scenario-matrix harness: hundreds of small, deterministic end-to-end scenarios against the
// openai provider, the guard/ask funnel, and the runner's stale handling — with a scripted
// endpoint (the "test app" side) and a simulated owner. Every scenario asserts the invariants
// that failed in production on 2026-09-26/27: no runaway retries on context overflow, no
// malformed session history, capped tool output in context, no repeated owner questions, and no
// secret ever reaching an ask.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenAIProvider } from "../src/providers/openai.mjs";
import { createRunner } from "../src/runner.mjs";
import { forgetDecisions, guardTools, noteOwnerAnswer } from "../src/guard.mjs";
import { createAsks } from "../src/asks.mjs";
import { isNoReply } from "../src/integrations/peer-agent.mjs";

const SILENT = { error() {}, warn() {}, log() {} };

// ----------------------------------------------------------------------------- mock endpoint

function createMockEndpoint() {
  const requests = [];
  const consumed = [];
  let script = [];
  let pos = 0; // main-round cursor
  let sumPos = 0; // summarizer cursor
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* keep null */
      }
      requests.push({ url: req.url, body });
      const isSummary =
        !body?.tools && Array.isArray(body?.messages) && /summarize the middle/i.test(String(body.messages[0]?.content || ""));
      const step = isSummary
        ? script[sumPos++] || { type: "text", text: "خلاصهٔ تست: کارها زده شدند و نتیجه گرفته شد." }
        : script[pos++] || { type: "text", text: "پایان" };
      consumed.push(step.type);
      respond(step, res, req);
    });
  });
  function respond(step, res, req) {
    if (step.type === "text" || step.type === "sum") {
      sse(res, [
        { choices: [{ index: 0, delta: { content: step.text } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ...(step.type === "text" ? [{ choices: [], usage: { prompt_tokens: step.promptTokens ?? 12, completion_tokens: 4 } }] : []),
      ]);
      return;
    }
    if (step.type === "tool") {
      sse(res, [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: step.id || `c${pos}`, type: "function", function: { name: step.name, arguments: "" } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args || {}) } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]);
      return;
    }
    if (step.type === "overflow") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message:
              "This model's maximum context length is 1048576 tokens. However, your messages resulted in 1053442 tokens. Please reduce the length of the messages.",
          },
        }),
      );
      return;
    }
    if (step.type === "http") {
      res.writeHead(step.status, { "content-type": "application/json", ...(step.status === 429 ? { "retry-after": "0.05" } : {}) });
      res.end(JSON.stringify({ error: { message: step.message || `http ${step.status}` } }));
      return;
    }
    if (step.type === "drop") {
      req.socket.destroy();
      return;
    }
    if (step.type === "hold") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "…" } }] })}\n\n`);
      return; // never ends: the client must give up on its own (idle timer / nudge abort)
    }
    res.writeHead(500);
    res.end("{}");
  }
  return {
    server,
    requests,
    play(steps) {
      script = steps;
      pos = 0;
      sumPos = 0;
      consumed.length = 0;
    },
    get calls() {
      return pos;
    },
    get summaryCalls() {
      return sumPos;
    },
    get consumedTypes() {
      return [...consumed];
    },
  };
}

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end("data: [DONE]\n\n");
}

// ----------------------------------------------------------------------------- test apps

const APPS = {
  echo: {
    description: "echo",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    execute: async (args) => ({ ok: true, text: String(args.text ?? "") }),
  },
  bigout: {
    description: "returns N chars",
    inputSchema: { type: "object", properties: { chars: { type: "number" } } },
    execute: async (args) => ({ data: "x".repeat(Math.min(Number(args.chars) || 1000, 400_000)) }),
  },
  fail: {
    description: "always fails",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("kaboom");
    },
  },
};

// ----------------------------------------------------------------------------- helpers

function tempWorkspace(rules = "RULES v9") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-scenario-"));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), rules);
  return dir;
}

function sessionOnDisk(cwd, agentId) {
  const file = path.join(cwd, ".griffin-openai-sessions", `${agentId}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

async function send(agent, message, opts = {}) {
  const updates = [];
  const run = await agent.send(message, {
    ...opts,
    onDelta: ({ update }) => updates.push(update),
  });
  const result = await run.wait();
  return { run, result, updates };
}

function provider(baseUrl, opts = {}) {
  return createOpenAIProvider({
    apiKey: "k",
    baseUrl,
    defaultModel: "test-model",
    log: SILENT,
    idleMs: opts.idleMs ?? 150,
    ...opts,
  });
}

// A well-formed history: every tool message follows its assistant tool_calls, no orphans, no
// dangling calls, and the transcript still starts with the original user task.
function assertSessionWellFormed(messages, label) {
  assert.ok(messages.length >= 1, `${label}: empty session`);
  assert.equal(messages[0].role, "user", `${label}: session must start with the original task`);
  const openCalls = new Set();
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) openCalls.add(call.id);
    } else if (message.role === "tool") {
      assert.ok(openCalls.has(message.tool_call_id), `${label}: orphan tool result at ${index}`);
      openCalls.delete(message.tool_call_id);
    }
  }
  assert.equal(openCalls.size, 0, `${label}: dangling tool calls at end of session`);
}

function recorder() {
  const rows = [];
  const events = [];
  return {
    rows,
    events,
    recordApproval: (row) => rows.push(row),
    appendEvent: (_c, _r, type, data) => events.push({ type, data }),
    rootChatId: (id) => id,
    getChat: () => null,
  };
}

// deterministic PRNG so the sweep is reproducible
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Two tool rounds give compaction a middle to summarize; keep must be small for short sessions.
const TIGHT = { compactKeepRecent: 2 };

// ----------------------------------------------------------------------------- scenarios

describe("scenario matrix: provider context management", () => {
  let mock;
  let baseUrl;

  before(async () => {
    mock = createMockEndpoint();
    await new Promise((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${mock.server.address().port}/v1`;
  });
  after(async () => {
    mock.server.closeAllConnections?.();
    await new Promise((resolve) => mock.server.close(resolve));
  });

  it("overflow mid-run: compacts and retries instead of failing (was 13 identical errors)", async () => {
    const cwd = tempWorkspace();
    mock.play([
      { type: "tool", name: "echo", args: { text: "شماره ۱" } },
      { type: "tool", name: "echo", args: { text: "شماره ۲" } },
      { type: "overflow" },
      { type: "text", text: "انجام شد" },
    ]);
    const agent = provider(baseUrl, TIGHT).create({ cwd, customTools: APPS });
    const { result } = await send(agent, "کار تست");
    assert.equal(result.status, "finished");
    assert.equal(mock.summaryCalls, 1, "one summarize call after the overflow");
    const disk = sessionOnDisk(cwd, agent.agentId);
    assert.ok(disk.messages.some((m) => /خلاصهٔ فشردهٔ بخش میانی/.test(String(m.content))), "summary message persisted");
    assert.equal(disk.messages[0].content, "کار تست", "original task kept verbatim");
    assertSessionWellFormed(disk.messages, "overflow-once");
  });

  it("overflow twice: compacts harder each time, still finishes", async () => {
    const cwd = tempWorkspace();
    mock.play([
      { type: "tool", name: "echo", args: { text: "a" } },
      { type: "tool", name: "echo", args: { text: "b" } },
      { type: "overflow" },
      { type: "overflow" },
      { type: "text", text: "ok" },
    ]);
    const agent = provider(baseUrl, TIGHT).create({ cwd, customTools: APPS });
    const { result } = await send(agent, "کار");
    assert.equal(result.status, "finished");
    assert.equal(mock.summaryCalls, 2);
    const disk = sessionOnDisk(cwd, agent.agentId);
    assert.ok(disk.messages.some((m) => /تلاش 2/.test(String(m.content))), "second attempt is more aggressive");
    assertSessionWellFormed(disk.messages, "overflow-twice");
  });

  it("overflow with nothing compactable: fails immediately, no retry storm", async () => {
    const cwd = tempWorkspace();
    mock.play([{ type: "overflow" }, { type: "overflow" }, { type: "overflow" }]);
    const { result } = await send(provider(baseUrl).create({ cwd }), "تنها یک پیام");
    assert.equal(result.status, "error");
    assert.match(result.error.message, /maximum context length/);
    assert.equal(mock.calls, 1, "retrying the identical payload is the old 13-error loop — refuse to");
    assert.equal(mock.summaryCalls, 0);
  });

  it("pressure compaction fires before the endpoint ever overflows", async () => {
    const cwd = tempWorkspace();
    mock.play([
      { type: "tool", name: "echo", args: { text: "پرسش یک" } },
      { type: "text", text: "پاسخ ۱" },
      { type: "tool", name: "echo", args: { text: "پرسش دو" } },
      { type: "text", text: "پاسخ ۲", promptTokens: 200 },
      { type: "text", text: "پاسخ ۳" },
    ]);
    const agent = provider(baseUrl, { compactAtTokens: 120, compactKeepRecent: 3 }).create({ cwd, customTools: APPS });
    await send(agent, "کار یک");
    await send(agent, "کار دو");
    const before = sessionOnDisk(cwd, agent.agentId).messages.length;
    assert.ok(before >= 8, `preload built a real session (${before})`);
    const { result } = await send(agent, "کار سه");
    assert.equal(result.status, "finished");
    assert.ok(mock.summaryCalls >= 1, "pressure trigger summarized");
    const after = sessionOnDisk(cwd, agent.agentId);
    assert.ok(after.messages.length < before, `session shrank (${before} → ${after.messages.length})`);
    assert.equal(after.messages[0].content, "کار یک", "original task survives every compaction");
    assertSessionWellFormed(after.messages, "pressure");
  });

  it("exact usage numbers (prompt_tokens) drive the pressure trigger on the next send", async () => {
    const cwd = tempWorkspace();
    mock.play([
      { type: "tool", name: "echo", args: { text: "پیش‌بار" } },
      { type: "text", text: "اول", promptTokens: 900_000 },
      { type: "text", text: "دوم" },
    ]);
    const agent = provider(baseUrl, { compactAtTokens: 600_000, compactKeepRecent: 2 }).create({ cwd, customTools: APPS });
    await send(agent, "شروع");
    assert.equal(mock.summaryCalls, 0, "first send is small — no trigger yet");
    const { result } = await send(agent, "ادامه");
    assert.equal(result.status, "finished");
    assert.ok(mock.summaryCalls >= 1, "usage-reported tokens triggered compaction before round one");
  });

  it("summarizer 400 → fallback digest still compacts and finishes", async () => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* ignore */
        }
        const isSummary = !body?.tools && /summarize the middle/i.test(String(body?.messages?.[0]?.content || ""));
        if (isSummary) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "bad summary request" } }));
          return;
        }
        n += 1;
        if (n <= 2) {
          sse(res, [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c${n}`, type: "function", function: { name: "echo", arguments: "" } }] } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: `{"text":"${n}"}` } }] } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ]);
          return;
        }
        if (n === 3) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "This model's maximum context length is 1048576 tokens." } }));
          return;
        }
        sse(res, [{ choices: [{ index: 0, delta: { content: "done" } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]);
      });
    });
    let n = 0;
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const cwd = tempWorkspace();
      const url = `http://127.0.0.1:${server.address().port}/v1`;
      const agent = provider(url, TIGHT).create({ cwd, customTools: APPS });
      const { result } = await send(agent, "کار");
      assert.equal(result.status, "finished");
      const disk = sessionOnDisk(cwd, agent.agentId);
      assert.match(JSON.stringify(disk.messages), /خلاصهٔ فشردهٔ بخش میانی/, "digest fallback present");
      assert.match(JSON.stringify(disk.messages), /گزیدهٔ خام/, "fell back to the raw digest");
      assertSessionWellFormed(disk.messages, "summarizer-400");
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("caps giant tool outputs in the model context but keeps the full result on the timeline", async () => {
    for (const chars of [5_000, 25_000, 120_000]) {
      const cwd = tempWorkspace();
      mock.play([
        { type: "tool", name: "bigout", args: { chars } },
        { type: "text", text: "ok" },
      ]);
      const agent = provider(baseUrl, { toolMaxChars: 20_000 }).create({ cwd, customTools: APPS });
      const { result, updates } = await send(agent, "بزرگ");
      assert.equal(result.status, "finished");
      const last = mock.requests.at(-1);
      const toolMessage = last.body.messages.find((m) => m.role === "tool");
      if (chars > 20_000) {
        assert.ok(toolMessage.content.length <= 20_800, `${chars}: in-context copy capped (${toolMessage.content.length})`);
        assert.match(toolMessage.content, /کوتاه شد/);
      } else {
        assert.ok(toolMessage.content.includes("x".repeat(50)), `${chars}: small outputs pass through untouched`);
      }
      const completed = updates.find((u) => u.type === "tool-call-completed");
      assert.ok(completed.toolCall.result.value.content[0].text.length >= chars, "timeline keeps the full output");
    }
  });

  it("identical rounds: nudged once, model recovers; keeps looping → stuck error", async () => {
    const cwd = tempWorkspace();
    mock.play([
      { type: "tool", name: "echo", args: { text: "same" } },
      { type: "tool", name: "echo", args: { text: "same" } },
      { type: "tool", name: "echo", args: { text: "same" } },
      { type: "text", text: "باشه، ادامه می‌دهم" },
    ]);
    const agent = provider(baseUrl).create({ cwd, customTools: APPS });
    const { result } = await send(agent, "حلقه");
    assert.equal(result.status, "finished");
    const disk = sessionOnDisk(cwd, agent.agentId);
    assert.ok(disk.messages.some((m) => m.role === "user" && /تذکر سیستمی/.test(String(m.content))), "nudge in-band");

    mock.play(Array.from({ length: 9 }, (_, i) => ({ type: "tool", id: `k${i}`, name: "echo", args: { text: "same" } })));
    const { result: stuck } = await send(provider(baseUrl).create({ cwd: tempWorkspace(), customTools: APPS }), "حلقه بی‌پایان");
    assert.equal(stuck.status, "error");
    assert.match(stuck.error.message, /stuck/);
  });

  it("run.nudge() breaks a silent in-flight round and the loop continues", async () => {
    const cwd = tempWorkspace();
    mock.play([
      { type: "hold" },
      { type: "text", text: "ادامه دادم" },
    ]);
    const agent = provider(baseUrl, { idleMs: 10_000 }).create({ cwd });
    const run = await agent.send("شروع", { onDelta: () => {} });
    await new Promise((r) => setTimeout(r, 300)); // the hold is now the in-flight round
    await run.nudge("[تذکر بعد از سکوت] وضعیت بده و ادامه بده");
    const result = await run.wait();
    assert.equal(result.status, "finished");
    const disk = sessionOnDisk(cwd, agent.agentId);
    assert.ok(disk.messages.some((m) => m.role === "user" && /وضعیت بده و ادامه بده/.test(String(m.content))), "nudge landed in the session");
    assertSessionWellFormed(disk.messages, "nudge");
  });
});

describe("scenario matrix: guard and ask funnel (simulated owner)", () => {
  it("an unanswered confirm is never re-asked after the run dies — the retry is told to report", async () => {
    forgetDecisions();
    const asks = createAsks();
    const store = recorder();
    let ran = 0;
    const tools = { mikrotik_exec: { async execute() { ran += 1; return { content: [] }; } } };
    const guarded = guardTools(tools, { chatId: "t1", asks, store, caller: "peer:x" });

    const first = guarded.mikrotik_exec.execute({ command: "/ppp secret add name=a", router: "office" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(asks.isWaiting("t1"), true);
    asks.cancel("t1"); // the run died with the question open
    assert.ok((await first).isError);

    const retry = await guarded.mikrotik_exec.execute({ command: "/ppp secret add name=a", router: "office" });
    assert.ok(retry.isError);
    assert.match(retry.content[0].text, /بی‌پاسخ/);
    assert.equal(asks.isWaiting("t1"), false, "no second question was opened");
    assert.equal(ran, 0);
    assert.equal(store.rows.at(-1).decision, "throttled");
    forgetDecisions();
  });

  it("rephrased commands (timeout wrapper, cd && git, env prefixes) share one decision", async () => {
    forgetDecisions();
    const asks = createAsks();
    const store = recorder();
    let ran = 0;
    const tools = { mikrotik_exec: { async execute() { ran += 1; return { content: [] }; } } };
    const guarded = guardTools(tools, { chatId: "t2", asks, store, caller: "peer:x" });

    const a = guarded.mikrotik_exec.execute({ command: "/ppp secret add name=a", router: "office" });
    await new Promise((r) => setTimeout(r, 20));
    asks.answer("t2", { answer: "بله", selected: ["بله"] });
    await a;
    assert.equal(ran, 1);

    // the same logical command, wrapped differently by the model on a retry
    const b = await guarded.mikrotik_exec.execute({ command: "timeout 60 /ppp secret add name=a", router: "office" });
    assert.notEqual(b.isError, true);
    assert.equal(ran, 2, "approved variant ran without a new question");
    assert.equal(asks.isWaiting("t2"), false);
    forgetDecisions();
  });

  it("approval records carry masked args, never the credential", async () => {
    forgetDecisions();
    const asks = createAsks();
    const store = recorder();
    const tools = { pg_query: { async execute() { return { content: [] }; } } };
    const guarded = guardTools(tools, { chatId: "t3", asks, store, caller: "peer:x" });
    const pending = guarded.pg_query.execute({ sql: "CREATE ROLE r LOGIN PASSWORD 'hunter2secret'", write: true });
    await new Promise((r) => setTimeout(r, 20));
    asks.answer("t3", { answer: "بله", selected: ["بله"] });
    await pending;
    const row = store.rows.at(-1);
    assert.equal(row.decision, "approved");
    const raw = JSON.stringify(row.args);
    assert.doesNotMatch(raw, /hunter2secret/, "the password never reached the audit row");
    assert.match(raw, /\*\*\*/, "a mask is present");
    forgetDecisions();
  });

  it("ask_owner questions and options are masked before they reach any timeline", async () => {
    const store = recorder();
    const asks = createAsks({ store });
    // Assembled at runtime so no complete token literal sits in the source (GitHub push
    // protection blocks otherwise — the value is a fake fixture, never a real credential).
    const glpatFixture = ["glpat-", "AbCdEfGh123456789012"].join("");
    const pending = asks.tool("t4").execute({
      question: `کلید ${glpatFixture} را در این دستور می‌بینید؟ eyJhbGciOiJIUzI1NiJ9.eyJhbGciOiJIUzI1NiJ9.sig12345678 و رمز token=supersecret1`,
      options: [{ label: glpatFixture, description: "با توکن" }, { label: "بدون توکن" }],
    });
    await new Promise((r) => setTimeout(r, 20));
    const asked = store.events.find((e) => e.type === "ask.pending");
    assert.ok(asked, "ask.pending emitted");
    const blob = JSON.stringify(asked.data);
    assert.doesNotMatch(blob, /glpat-AbCdEfGh/);
    assert.doesNotMatch(blob, /supersecret1/);
    assert.doesNotMatch(blob, /eyJhbGciOiJIUzI1NiJ9\.eyJ/);
    assert.match(blob, /\*\*\*/);
    asks.answer("t4", { answer: "بدون توکن", selected: ["بدون توکن"] });
    const outcome = await pending;
    assert.equal(JSON.parse(outcome.content[0].text).answered, true);
  });

  it("NO_REPLY survives every streaming shape and never eats a real answer", () => {
    for (const hit of ["[NO_REPLY]", "`[NO_REPLY]`", "**[NO_REPLY]**", "  [NO_REPLY]  ", "[NO_REPLY]\n[NO_REPLY]"]) {
      assert.equal(isNoReply(hit), true, JSON.stringify(hit));
    }
    assert.equal(isNoReply("[NO" + "_REPLY]"), true, "split deltas rejoined");
    for (const miss of ["", "پاسخ واقعی اینجاست [NO_REPLY]", "[NO_REPLY_EXTRA]", "NO_REPLY مهم نیست"]) {
      assert.equal(isNoReply(miss), false, JSON.stringify(miss));
    }
  });
});

describe("scenario matrix: runner stale handling", () => {
  it("sweepStale nudges a supported silent run before ever cancelling it", async () => {
    const cwd = tempWorkspace();
    const mock = createMockEndpoint();
    await new Promise((r) => mock.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${mock.server.address().port}/v1`;
    try {
      mock.play([
        { type: "hold" },
        { type: "text", text: "برگشتم و ادامه دادم" },
      ]);
      const p = provider(url, { idleMs: 10_000 });
      const store = {
        runningRuns: () => [],
        getChat: () => ({ id: "r1", caller: "owner" }),
        appendEvent: () => {},
        finishRun: () => {},
        setAgentId: () => {},
        setSdkRunId: () => {},
        startRun: () => "run-1",
      };
      const runner = createRunner({
        store,
        providerFor: () => p,
        agentOptions: async () => ({ cwd }),
        isBlocked: () => false,
        log: SILENT,
      });
      runner.send("r1", { text: "شروع" });
      await new Promise((r) => setTimeout(r, 300));
      const acted = await runner.sweepStale({ staleMs: 100, forceMs: 5_000 });
      assert.deepEqual(acted.map((a) => a.action), ["nudged"], "nudge before cancel");
      const settled = await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (!runner.isActive("r1")) {
            clearInterval(timer);
            resolve("done");
          }
        }, 50);
        setTimeout(() => resolve("still-active"), 8_000);
      });
      assert.equal(settled, "done", "the nudged run recovered and finished on its own");
      await runner.shutdown({ timeoutMs: 2_000 }).catch(() => {});
    } finally {
      mock.server.closeAllConnections?.();
      mock.server.close();
    }
  });

  it("a run without nudge support is still cancelled by the sweeper", async () => {
    let cancelled = 0;
    const store = {
      runningRuns: () => [],
      getChat: () => ({ id: "r2", caller: "owner" }),
      appendEvent: () => {},
      finishRun: () => {},
      setAgentId: () => {},
      setSdkRunId: () => {},
      startRun: () => "run-2",
    };
    const fakeProvider = {
      create: async () => ({
        agentId: "fake-1",
        send: async () => ({
          id: "x",
          supports: () => true,
          cancel: async () => {
            cancelled += 1;
          },
          wait: () => new Promise(() => {}),
        }),
      }),
    };
    const runner = createRunner({ store, providerFor: () => fakeProvider, agentOptions: async () => ({}), isBlocked: () => false, log: SILENT });
    runner.send("r2", { text: "go" });
    await new Promise((r) => setTimeout(r, 30));
    const acted = await runner.sweepStale({ staleMs: 10, forceMs: 5_000 });
    assert.deepEqual(acted.map((a) => a.action), ["cancelled"]);
    assert.ok(cancelled >= 1);
  });
});

// ------------------------------------------------------------------------------ the sweep
// Deterministic randomized combinations: every scenario must end in a definite state and leave a
// well-formed, bounded session behind. This is the "hundreds of scenarios" bulk — it exercises
// the interaction of overflow × big outputs × transient failures × tool rounds.
describe("scenario matrix: deterministic sweep", () => {
  it("runs 120 mixed scenarios with invariant checks", { timeout: 180_000 }, async () => {
    const mock = createMockEndpoint();
    await new Promise((r) => mock.server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${mock.server.address().port}/v1`;
    const rand = lcg(20260928);
    const dir = tempWorkspace("RULES sweep");
    let overflowsRecovered = 0;
    let finished = 0;
    try {
      for (let scenario = 0; scenario < 120; scenario += 1) {
        const script = [];
        if (scenario % 4 === 3) {
          // guaranteed overflow-recovery shape: two tool rounds build a compactable middle,
          // then the endpoint refuses — the run must compact, retry and still finish.
          script.push(
            { type: "tool", name: "echo", args: { text: `f${scenario}` } },
            { type: "tool", name: "bigout", args: { chars: [2_000, 30_000, 90_000][Math.floor(rand() * 3)] } },
            { type: "overflow" },
            ...(rand() < 0.3 ? [{ type: "overflow" }] : []),
            ...(rand() < 0.3 ? [{ type: "http", status: 429, message: "Rate limit exceeded: free-models-per-day" }] : []),
          );
        } else {
          const rounds = 1 + Math.floor(rand() * 4);
          for (let i = 0; i < rounds; i += 1) {
            const dice = rand();
            if (dice < 0.16) script.push({ type: "overflow" });
            else if (dice < 0.22) script.push({ type: "http", status: 429, message: "Rate limit exceeded: free-models-per-day" });
            else if (dice < 0.28) script.push({ type: "drop" });
            else if (dice < 0.44) script.push({ type: "tool", name: "echo", args: { text: `s${scenario}-${i}` } });
            else if (dice < 0.56) script.push({ type: "tool", name: "bigout", args: { chars: [2_000, 30_000, 90_000][Math.floor(rand() * 3)] } });
            else if (dice < 0.6) script.push({ type: "tool", name: "fail", args: {} });
            else script.push({ type: "text", text: `گام ${i}` });
          }
        }
        script.push({ type: "text", text: `پایان ${scenario}` });
        mock.play(script);

        const agent = provider(baseUrl, {
          compactAtTokens: rand() < 0.3 ? 400 : 600_000,
          compactKeepRecent: 2,
          toolMaxChars: 20_000,
          runawayRounds: 40,
        }).create({ cwd: dir, customTools: APPS });
        const { result } = await send(agent, `سناریو ${scenario}`);
        // a "text" step ends the run; only steps the endpoint actually consumed happened
        const sawOverflow = mock.consumedTypes.includes("overflow");
        assert.ok(["finished", "error"].includes(result.status), `scenario ${scenario}: definite state`);
        if (result.status === "error") {
          assert.ok(result.error?.message, `scenario ${scenario}: an error carries a reason`);
          continue;
        }
        finished += 1;

        const disk = sessionOnDisk(dir, agent.agentId);
        assert.ok(disk, `scenario ${scenario}: session persisted`);
        assertSessionWellFormed(disk.messages, `scenario ${scenario}`);
        for (const message of disk.messages) {
          if (message.role === "tool") {
            assert.ok(String(message.content).length <= 21_000, `scenario ${scenario}: tool payload uncapped (${String(message.content).length})`);
          }
        }
        if (sawOverflow) {
          assert.ok(
            disk.messages.some((m) => /خلاصهٔ فشردهٔ بخش میانی/.test(String(m.content))),
            `scenario ${scenario}: an overflow that finished must have compacted`,
          );
          overflowsRecovered += 1;
        }
      }
      assert.ok(finished >= 60, `most scenarios finish (${finished}/120)`);
      assert.ok(overflowsRecovered >= 3, `the sweep actually exercised overflow-recovery (${overflowsRecovered})`);
    } finally {
      mock.server.closeAllConnections?.();
      mock.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scenario matrix: owner-answer bridge (no double ask)", () => {
  function wired() {
    forgetDecisions();
    const store = recorder();
    const asks = createAsks({
      store,
      // same wiring as index.mjs: an owner answer on an approval-style ask blesses/vetoes once
      onSettled: (chatId, info) => {
        if (info?.by !== "requester" && info?.answer != null) noteOwnerAnswer(store, chatId, info);
      },
    });
    let ran = 0;
    const tools = { arvan_dns_create: { async execute() { ran += 1; return { content: [] }; } } };
    const guarded = guardTools(tools, { chatId: "b1", asks, store, caller: "peer:x" });
    return { asks, store, guarded, count: () => ran };
  }

  it("an owner YES on the ask covers the guarded call once — no second question", async () => {
    const { asks, store, guarded, count } = wired();
    // the model asked via ask_owner (approval-shaped, three options incl. a نه)
    const modelAsk = asks.tool("b1").execute({
      question: "رکورد تستی DNS ساخته شود؟",
      options: [{ label: "بله، بساز" }, { label: "نه، رد کن" }, { label: "روی ساب‌دامینهٔ جدا" }],
    });
    await new Promise((r) => setTimeout(r, 20));
    asks.answer("b1", { answer: "بله، بساز", selected: ["بله، بساز"] });
    await modelAsk;

    const call = guarded.arvan_dns_create.execute({ domain: "example.com", name: "t", type: "A", value: "127.0.0.1" });
    const result = await Promise.race([call, new Promise((r) => setTimeout(() => r("TIMEOUT-ASKED-AGAIN"), 400))]);
    assert.notEqual(result, "TIMEOUT-ASKED-AGAIN", "the guard asked again instead of using the blessing");
    assert.equal(count(), 1, "the guarded call executed");
    assert.equal(asks.isWaiting("b1"), false, "no new question was opened");
    assert.equal(store.rows.at(-1).decision, "blessed");

    // single use only: the next call asks normally again
    const again = guarded.arvan_dns_create.execute({ domain: "example.com", name: "t2", type: "A", value: "127.0.0.1" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(asks.isWaiting("b1"), true, "blessing was consumed");
    asks.answer("b1", { answer: "نه", selected: ["نه"] });
    assert.ok((await again).isError);
    forgetDecisions();
  });

  it("an owner NO on the ask vetoes the next guarded call without another question", async () => {
    const { asks, store, guarded, count } = wired();
    const modelAsk = asks.tool("b1").execute({ question: "رکورد DNS ساخته شود؟", options: [{ label: "بله" }, { label: "نه" }] });
    await new Promise((r) => setTimeout(r, 20));
    asks.answer("b1", { answer: "نه", selected: ["نه"] });
    await modelAsk;

    const out = await guarded.arvan_dns_create.execute({ domain: "example.com", name: "t", type: "A", value: "127.0.0.1" });
    assert.ok(out.isError);
    assert.match(out.content[0].text, /پاسخ «نه» داده/);
    assert.equal(count(), 0, "nothing executed");
    assert.equal(asks.isWaiting("b1"), false, "the owner was not asked twice for one refusal");
    assert.equal(store.rows.at(-1).decision, "vetoed");
    forgetDecisions();
  });

  it("a clarification answer (no yes/no options) never blesses a guarded call", async () => {
    const { asks, guarded } = wired();
    const clarify = asks.tool("b1").execute({
      question: "کدام کلاستر مدنظرت بود؟",
      options: [{ label: "کلاستر ۱" }, { label: "کلاستر ۲" }, { label: "هر دو" }, { label: "فرقی ندارد" }],
    });
    await new Promise((r) => setTimeout(r, 20));
    asks.answer("b1", { answer: "کلاستر ۲", selected: ["کلاستر ۲"] });
    await clarify;

    const call = guarded.arvan_dns_create.execute({ domain: "example.com", name: "t", type: "A", value: "127.0.0.1" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(asks.isWaiting("b1"), true, "a guarded call still asks on its own");
    asks.answer("b1", { answer: "نه", selected: ["نه"] });
    assert.ok((await call).isError);
    forgetDecisions();
  });

  it("the owner's own words bless too: «مرج کن» and «دوباره تأیید می‌کنم» count as yes (2026-09-29: a merge was re-asked seven times)", async () => {
    for (const reply of ["مرج کن", "تأیید — مرج شود", "دوباره تأیید می‌کنم"]) {
      const { asks, guarded, count } = wired();
      const modelAsk = asks.tool("b1").execute({ question: "MR شمارهٔ ۹۶۶ مرج شود؟", options: [{ label: "بله" }, { label: "نه" }] });
      await new Promise((r) => setTimeout(r, 20));
      asks.answer("b1", { answer: reply, selected: [] });
      await modelAsk;
      const call = guarded.arvan_dns_create.execute({ domain: "example.com", name: "t", type: "A", value: "127.0.0.1" });
      const result = await Promise.race([call, new Promise((r) => setTimeout(() => r("TIMEOUT-ASKED-AGAIN"), 400))]);
      assert.notEqual(result, "TIMEOUT-ASKED-AGAIN", `reply «${reply}» did not bless the guarded call`);
      assert.equal(count(), 1, `reply «${reply}» executed the guarded call`);
      forgetDecisions();
    }
  });

  it("a mid-sentence negation («مرج نکن») is a veto, and an answering question blesses nothing", async () => {
    const neg = wired();
    const negAsk = neg.asks.tool("b1").execute({ question: "MR ۹۶۶ مرج شود؟", options: [{ label: "بله" }, { label: "نه" }] });
    await new Promise((r) => setTimeout(r, 20));
    neg.asks.answer("b1", { answer: "مرج نکن", selected: [] });
    await negAsk;
    const out = await neg.guarded.arvan_dns_create.execute({ domain: "example.com", name: "t", type: "A", value: "127.0.0.1" });
    assert.ok(out.isError, "«مرج نکن» must veto");
    assert.equal(neg.count(), 0);
    forgetDecisions();

    const q = wired();
    const qAsk = q.asks.tool("b1").execute({ question: "MR ۹۶۶ مرج شود؟", options: [{ label: "بله" }, { label: "نه" }] });
    await new Promise((r) => setTimeout(r, 20));
    q.asks.answer("b1", { answer: "کدام MR منظورت بود؟", selected: [] });
    await qAsk;
    // An answer that is a question blesses nothing — and like an explicit no it must not let the
    // very next guarded call through on the owner's confusion.
    const qOut = await q.guarded.arvan_dns_create.execute({ domain: "example.com", name: "t", type: "A", value: "127.0.0.1" });
    assert.ok(qOut.isError, "an answer that is a question blesses nothing");
    assert.equal(q.count(), 0);
    forgetDecisions();
  });

  it("a stop-word answer («متوفقف شو» — the owner's live typo of «متوقف شو») is a veto, never consent", async () => {
    const neg = wired();
    const negAsk = neg.asks.tool("b1").execute({ question: "پیام به همکار بفرستم؟", options: [{ label: "بله" }, { label: "نه" }] });
    await new Promise((r) => setTimeout(r, 20));
    neg.asks.answer("b1", { answer: "متوفقف شو", selected: [] });
    await negAsk;
    // Not consent (never executes), not ignored (the refusal reaches the model as the owner's no).
    const out = await neg.guarded.arvan_dns_create.execute({ domain: "example.com", name: "t", type: "A", value: "127.0.0.1" });
    assert.ok(out.isError, "«متوفقف شو» must veto");
    assert.equal(neg.count(), 0);
    forgetDecisions();

    // The correctly-spelled forms too — both count only as a veto.
    for (const answer of ["متوقف شو", "توقف کن", "ولش کن"]) {
      const w = wired();
      const ask = w.asks.tool("b1").execute({ question: "پیام به همکار بفرستم؟", options: [{ label: "بله" }, { label: "نه" }] });
      await new Promise((r) => setTimeout(r, 20));
      w.asks.answer("b1", { answer, selected: [] });
      await ask;
      const result = await w.guarded.arvan_dns_create.execute({ domain: "example.com", name: "t", type: "A", value: "127.0.0.1" });
      assert.ok(result.isError, `«${answer}» must veto`);
      assert.equal(w.count(), 0);
      forgetDecisions();
    }
  });

  it("the guard's own typed answer in the owner's words («مرج کن») runs and caches as approved", async () => {
    const { asks, guarded, count, store } = wired();
    const call = guarded.arvan_dns_create.execute({ domain: "example.com", name: "t", type: "A", value: "127.0.0.1" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(asks.isWaiting("b1"), true);
    asks.answer("b1", { answer: "مرج کن", selected: [] });
    await call;
    assert.equal(count(), 1, "typed consent executed the guarded call");
    assert.equal(store.rows.at(-1).decision, "approved");
    forgetDecisions();
  });

  it("nag guard: a similar owner question just answered is refused with the previous answer, a different one passes", async () => {
    const { asks } = wired();
    const parse = (result) => JSON.parse(result.content[0].text);
    const first = asks.tool("b1").execute({ question: "MR شمارهٔ ۹۶۶ platform-gitops برای finmodel مرج شود؟", options: [{ label: "بله" }, { label: "نه" }] });
    await new Promise((r) => setTimeout(r, 20));
    asks.answer("b1", { answer: "مرج کن", selected: [] });
    assert.equal(parse(await first).answered, true);

    const duplicate = parse(await asks.tool("b1").execute({ question: "پنجرهٔ تأیید مرج MR ۹۶۶ finmodel هنوز باز است — دوباره تأیید می‌کنید؟", options: [{ label: "بله" }, { label: "نه" }] }));
    assert.equal(duplicate.answered, false, "the re-ask must not reach the owner again");
    assert.match(duplicate.reason, /مرج کن/, "the refusal carries the owner's previous answer");
    assert.equal(asks.isWaiting("b1"), false, "no new question opened");

    const different = asks.tool("b1").execute({ question: "رکورد DNS جدید در آروان برای دامنهٔ test ساخته شود؟", options: [{ label: "بله" }, { label: "نه" }] });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(asks.isWaiting("b1"), true, "a genuinely different question goes through");
    asks.answer("b1", { answer: "بله", selected: ["بله"] });
    await different;
  });
});
