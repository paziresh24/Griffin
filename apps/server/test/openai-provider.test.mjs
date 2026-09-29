import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenAIProvider } from "../src/providers/openai.mjs";
import { normalizeProvider, PROVIDER_OPENAI } from "../src/providers/ids.mjs";
import { createProviders } from "../src/providers/index.mjs";

// A tiny OpenAI-compatible mock: scripted responses, request journal, SSE support.

function createMockOpenAI() {
  const requests = [];
  let handler = () => ({ status: 404, body: { error: { message: "no handler" } } });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* keep null */
      }
      const record = { method: req.method, url: req.url, auth: req.headers.authorization, body: parsed };
      requests.push(record);
      const result = handler(record, res);
      if (result?.raw) return; // the handler wrote the response itself
      res.writeHead(result?.status || 200, { "content-type": result?.type || "application/json" });
      res.end(typeof result?.body === "string" ? result.body : JSON.stringify(result?.body ?? {}));
    });
  });
  return {
    server,
    requests,
    on(fn) {
      handler = fn;
    },
  };
}

function sse(res, events, { delayMs = 3, holdAfter = null } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  let i = 0;
  const tick = () => {
    if (i >= events.length) {
      if (holdAfter) return void holdAfter(() => res.end("data: [DONE]\n\n"));
      res.end("data: [DONE]\n\n");
      return;
    }
    res.write(`data: ${JSON.stringify(events[i])}\n\n`);
    i += 1;
    setTimeout(tick, delayMs);
  };
  tick();
}

function textChunks(...parts) {
  const events = parts.map((p) => ({ choices: [{ index: 0, delta: { content: p } }] }));
  events.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  events.push({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
  return events;
}

function toolCallChunks(id, name, argsJson) {
  return [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function tempWorkspace(systemText = "TEST RULES v1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-openai-test-"));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), systemText);
  return dir;
}

const TOOLS = {
  echo: {
    description: "echo the text",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (args) => ({ ok: true, text: args.text }),
  },
  debug_exec: {
    description: "terminal",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: async () => ({ ok: true, stdout: "" }),
  },
  boom: {
    description: "always fails",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("kaboom");
    },
  },
};

function providerFor(baseUrl, { model = "test-model" } = {}) {
  return createOpenAIProvider({ apiKey: "test-key", baseUrl, defaultModel: model, log: { error() {}, warn() {} } });
}

async function runSend(agent, message, sendOpts = {}) {
  const updates = [];
  const run = await agent.send(message, {
    ...sendOpts,
    onDelta: ({ update }) => {
      updates.push(update);
      sendOpts.onUpdate?.(update);
    },
  });
  const result = await run.wait();
  return { run, result, updates };
}

describe("openai-compatible provider", () => {
  let mock;
  let baseUrl;

  before(async () => {
    mock = createMockOpenAI();
    await new Promise((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${mock.server.address().port}/v1`;
  });

  after(async () => {
    await new Promise((resolve) => mock.server.close(resolve));
  });

  it("normalizes the openai provider id", () => {
    assert.equal(normalizeProvider("openai"), PROVIDER_OPENAI);
    assert.equal(normalizeProvider("claude"), "claude");
    assert.equal(normalizeProvider("whatever"), "cursor");
  });

  it("exposes the openai provider through createProviders", () => {
    const providers = createProviders({ openaiApiKey: "k", openaiBaseUrl: "http://x/v1", openaiModel: "m" });
    assert.equal(providers.openai.id, "openai");
    assert.equal(providers.openai.defaultModel, "m");
  });

  it("lists only available models and reports health", async () => {
    mock.on((req) => {
      if (req.url === "/v1/models") {
        return {
          body: {
            object: "list",
            data: [
              { id: "good/one", object: "model", available: true },
              { id: "bad/one", object: "model", available: false, status: "plan_required" },
              { id: "plain/one", object: "model" },
            ],
          },
        };
      }
      return { status: 404 };
    });
    const provider = providerFor(baseUrl);
    const models = await provider.listModels();
    assert.deepEqual(models.map((m) => m.id), ["good/one", "plain/one"]);
    assert.equal(models[0].provider, "openai");
    const health = await provider.health();
    assert.equal(health.ok, true);
    assert.equal(health.status, 200);
  });

  it("treats 401 as reachable in health, and reports missing config", async () => {
    mock.on(() => ({ status: 401, body: { error: { message: "bad key" } } }));
    const provider = providerFor(baseUrl);
    const health = await provider.health();
    assert.equal(health.ok, true);
    assert.equal(health.status, 401);

    const bare = createOpenAIProvider({ apiKey: "", baseUrl });
    assert.equal((await bare.health()).error, "no openai api key");
    const noUrl = createOpenAIProvider({ apiKey: "k", baseUrl: "" });
    assert.equal((await noUrl.health()).error, "no openai base url");
  });

  it("streams a text-only run and sends system + auth + model", async () => {
    const cwd = tempWorkspace("RULES: be brief");
    mock.on((req, res) => {
      if (req.url !== "/v1/chat/completions") return { status: 404 };
      sse(res, textChunks("سلام ", "دنیا"));
      return { raw: true };
    });
    const provider = providerFor(baseUrl);
    const { result, updates } = await runSend(provider.create({ cwd, model: { id: "m1" } }), "درود");
    assert.equal(result.status, "finished");
    const texts = updates.filter((u) => u.type === "text-delta").map((u) => u.text);
    assert.deepEqual(texts, ["سلام ", "دنیا"]);
    assert.ok(updates.some((u) => u.type === "turn-ended" && u.usage?.completion_tokens === 2));
    const sent = mock.requests.at(-1);
    assert.equal(sent.auth, "Bearer test-key");
    assert.equal(sent.body.model, "m1");
    assert.equal(sent.body.stream, true);
    assert.equal(sent.body.messages[0].role, "system");
    assert.match(sent.body.messages[0].content, /RULES: be brief/);
    assert.deepEqual(sent.body.messages.slice(1), [{ role: "user", content: "درود" }]);
  });

  it("sends reasoning_effort only when configured", async () => {
    const cwd = tempWorkspace();
    mock.on((req, res) => {
      sse(res, textChunks("ok"));
      return { raw: true };
    });
    const tuned = createOpenAIProvider({ apiKey: "k", baseUrl, defaultModel: "m", reasoningEffort: "medium", log: { error() {} } });
    await runSend(tuned.create({ cwd }), "سلام");
    assert.equal(mock.requests.at(-1).body.reasoning_effort, "medium");
    await runSend(providerFor(baseUrl).create({ cwd }), "سلام");
    assert.equal("reasoning_effort" in mock.requests.at(-1).body, false);
  });

  it("falls back to a plain JSON body when the endpoint ignores streaming", async () => {
    const cwd = tempWorkspace();
    mock.on(() => ({
      body: { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "plain answer" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    }));
    const provider = providerFor(baseUrl);
    const { result, updates } = await runSend(provider.create({ cwd }), "hi");
    assert.equal(result.status, "finished");
    assert.deepEqual(updates.filter((u) => u.type === "text-delta").map((u) => u.text), ["plain answer"]);
  });

  it("runs a streamed tool-call round trip", async () => {
    const cwd = tempWorkspace();
    const firstRequest = mock.requests.length;
    let turn = 0;
    mock.on((req, res) => {
      if (req.url !== "/v1/chat/completions") return { status: 404 };
      turn += 1;
      if (turn === 1) sse(res, toolCallChunks("call-1", "echo", '{"text":"hey"}'));
      else sse(res, textChunks("done"));
      return { raw: true };
    });
    const provider = providerFor(baseUrl);
    const { result, updates } = await runSend(provider.create({ cwd, customTools: TOOLS }), "run echo");
    assert.equal(result.status, "finished");

    const started = updates.find((u) => u.type === "tool-call-started");
    assert.equal(started.callId, "call-1");
    assert.equal(started.toolCall.args.toolName, "echo");
    const partial = updates.find((u) => u.type === "partial-tool-call");
    assert.deepEqual(partial?.toolCall?.args?.args, { text: "hey" });
    const completed = updates.find((u) => u.type === "tool-call-completed");
    assert.equal(completed.callId, "call-1");
    assert.equal(completed.toolCall.result.status, "success");
    assert.equal(completed.toolCall.result.value.content[0].text.includes("hey"), true);
    assert.ok(Array.isArray(completed.toolCall.result.value.content), "cursor-SDK MCP shape for the UI/delivery stack");

    const second = mock.requests.at(-1);
    const roles = second.body.messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "tool"]);
    const assistant = second.body.messages[2];
    assert.equal(assistant.tool_calls[0].id, "call-1");
    assert.equal(assistant.tool_calls[0].function.name, "echo");
    const tool = second.body.messages[3];
    assert.equal(tool.tool_call_id, "call-1");
    assert.match(tool.content, /hey/);
    const toolsSent = mock.requests[firstRequest].body.tools;
    assert.equal(toolsSent.find((t) => t.function.name === "echo").function.parameters.properties.text.type, "string");
  });

  it("reports a failing tool as an error result and continues", async () => {
    const cwd = tempWorkspace();
    let turn = 0;
    mock.on((req, res) => {
      turn += 1;
      if (turn === 1) sse(res, toolCallChunks("c-boom", "boom", "{}"));
      else sse(res, textChunks("survived"));
      return { raw: true };
    });
    const provider = providerFor(baseUrl);
    const { result, updates } = await runSend(provider.create({ cwd, customTools: TOOLS }), "go");
    assert.equal(result.status, "finished");
    const completed = updates.find((u) => u.type === "tool-call-completed");
    assert.equal(completed.toolCall.result.status, "error");
    assert.match(completed.toolCall.result.value.content[0].text, /kaboom/);
  });

  it("answers unknown tools with an error result", async () => {
    const cwd = tempWorkspace();
    let turn = 0;
    mock.on((req, res) => {
      turn += 1;
      if (turn === 1) sse(res, toolCallChunks("c-x", "nope", "{}"));
      else sse(res, textChunks("ok"));
      return { raw: true };
    });
    const provider = providerFor(baseUrl);
    const { result, updates } = await runSend(provider.create({ cwd, customTools: TOOLS }), "go");
    assert.equal(result.status, "finished");
    const completed = updates.find((u) => u.type === "tool-call-completed");
    assert.equal(completed.toolCall.result.status, "error");
    assert.match(completed.toolCall.result.value.content[0].text, /unknown tool: nope/);
  });

  it("surfaces endpoint errors with status, message and hint", async () => {
    const cwd = tempWorkspace();
    // 400, not 429: a 429 is retried (see "rate limit" below); this checks how errors surface.
    mock.on(() => ({ status: 400, body: { error: { message: "context too long", hint: "Trim the history" } } }));
    const provider = providerFor(baseUrl);
    const { result } = await runSend(provider.create({ cwd }), "go");
    assert.equal(result.status, "error");
    assert.match(result.error.message, /context too long/);
    assert.match(result.error.message, /Trim the history/);
  });

  it("maps reasoning deltas to thinking events", async () => {
    const cwd = tempWorkspace();
    mock.on((req, res) => {
      sse(res, [
        { choices: [{ index: 0, delta: { reasoning_content: "در حال فکر" } }] },
        { choices: [{ index: 0, delta: { content: "پاسخ" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
      return { raw: true };
    });
    const provider = providerFor(baseUrl);
    const { result, updates } = await runSend(provider.create({ cwd }), "go");
    assert.equal(result.status, "finished");
    assert.deepEqual(updates.filter((u) => u.type === "thinking-delta").map((u) => u.text), ["در حال فکر"]);
    const done = updates.find((u) => u.type === "thinking-completed");
    assert.equal(typeof done?.thinkingDurationMs, "number");
    assert.deepEqual(updates.filter((u) => u.type === "text-delta").map((u) => u.text), ["پاسخ"]);
  });

  it("cancels mid-stream and leaves no phantom turn in the history", async () => {
    const cwd = tempWorkspace();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    mock.on((req, res) => {
      sse(res, textChunks("partial"), { holdAfter: (end) => held.then(end) });
      return { raw: true };
    });
    const provider = providerFor(baseUrl);
    const agent = provider.create({ cwd });
    let sawDelta;
    const deltaSignal = new Promise((resolve) => {
      sawDelta = resolve;
    });
    const updates = [];
    const run = await agent.send("go", {
      onDelta: ({ update }) => {
        updates.push(update);
        if (update.type === "text-delta") sawDelta();
      },
    });
    await deltaSignal;
    await run.cancel();
    const result = await run.wait();
    release();
    assert.equal(result.status, "cancelled");

    // The retry must not contain the cancelled turn's assistant message.
    mock.on((req, res) => {
      sse(res, textChunks("after cancel"));
      return { raw: true };
    });
    const again = await runSend(agent, "retry");
    assert.equal(again.result.status, "finished");
    const sent = mock.requests.at(-1);
    assert.ok(!sent.body.messages.some((m) => m.role === "assistant" && m.content === "partial"));
    assert.deepEqual(sent.body.messages.filter((m) => m.role === "user").map((m) => m.content), ["go", "retry"]);
  });

  it("resumes a session from disk in a fresh provider instance", async () => {
    const cwd = tempWorkspace("RULES resume");
    mock.on((req, res) => {
      sse(res, textChunks("first answer"));
      return { raw: true };
    });
    const first = providerFor(baseUrl);
    const agent1 = first.create({ cwd });
    await runSend(agent1, "first question");
    const agentId = agent1.agentId;

    mock.on((req, res) => {
      sse(res, textChunks("second answer"));
      return { raw: true };
    });
    const second = providerFor(baseUrl); // new instance: session must come from disk
    const agent2 = second.resume(agentId, { cwd });
    assert.equal(agent2.agentId, agentId);
    await runSend(agent2, "second question");
    const sent = mock.requests.at(-1);
    assert.deepEqual(
      sent.body.messages.map((m) => `${m.role}:${m.content}`),
      ["system:RULES resume", "user:first question", "assistant:first answer", "user:second question"],
    );
  });

  it("throws agent_not_found when resuming an unknown session", () => {
    const provider = providerFor(baseUrl);
    assert.throws(() => provider.resume("no-such-id", { cwd: tempWorkspace() }), (error) => error.code === "agent_not_found");
  });

  it("fails fast without an api key", async () => {
    const provider = createOpenAIProvider({ apiKey: "", baseUrl });
    const { result } = await runSend(provider.create({ cwd: tempWorkspace() }), "go");
    assert.equal(result.status, "error");
    assert.match(result.error.message, /api key missing/i);
  });

  it("a streak of one-command terminal rounds gets one batching nudge, not a lecture", async () => {
    const cwd = tempWorkspace();
    let n = 0;
    mock.on((req, res) => {
      if (req.url !== "/v1/chat/completions") return { status: 404 };
      const nudged = req.body.messages.some((m) => m.role === "user" && String(m.content).includes("تذکر سیستمی"));
      if (nudged) {
        sse(res, textChunks("done"));
        return { raw: true };
      }
      n += 1;
      sse(res, toolCallChunks(`c${n}`, "debug_exec", JSON.stringify({ command: `check ${n}` })), { delayMs: 0 });
      return { raw: true };
    });
    const provider = createOpenAIProvider({
      apiKey: "test-key",
      baseUrl,
      runawayRounds: 50,
      smallCmdAfter: 3,
      silentAfter: 50,
      log: { error() {}, warn() {} },
    });
    const { result } = await runSend(provider.create({ cwd, customTools: TOOLS }), "investigate");
    assert.equal(result.status, "finished");
    const nudges = mock.requests.at(-1).body.messages.filter((m) => String(m.content).includes("تذکر سیستمی"));
    assert.equal(nudges.length, 1, "exactly one nudge");
    assert.match(nudges[0].content, /اسکریپت/);
    assert.ok(n >= 3, `nudge fired after the streak (${n} rounds)`);
  });

  it("a batched script round does not trip the terminal nudge", async () => {
    const cwd = tempWorkspace();
    let n = 0;
    mock.on((req, res) => {
      if (req.url !== "/v1/chat/completions") return { status: 404 };
      n += 1;
      const script = `echo "== section ${n}"\nkubectl get pods\nkubectl get svc`;
      sse(res, toolCallChunks(`c${n}`, "debug_exec", JSON.stringify({ command: script })), { delayMs: 0 });
      return { raw: true };
    });
    const provider = createOpenAIProvider({
      apiKey: "test-key",
      baseUrl,
      runawayRounds: 4,
      smallCmdAfter: 2,
      silentAfter: 50,
      log: { error() {}, warn() {} },
    });
    const { result } = await runSend(provider.create({ cwd, customTools: TOOLS }), "investigate");
    assert.match(result.error.message, /runaway/); // ran to the cap with no batching nudge
    const since = mock.requests.slice(mock.requests.length - n);
    assert.ok(!since.some((r) => r.body?.messages?.some((m) => String(m.content).includes("تذکر سیستمی"))));
  });

  it("many tool rounds with no text for the owner get one progress nudge", async () => {
    const cwd = tempWorkspace();
    let n = 0;
    mock.on((req, res) => {
      if (req.url !== "/v1/chat/completions") return { status: 404 };
      const nudged = req.body.messages.some((m) => m.role === "user" && String(m.content).includes("تذکر سیستمی"));
      if (nudged) {
        sse(res, textChunks("پیشرفت: همچنان در حال بررسی‌ام"));
        return { raw: true };
      }
      n += 1;
      sse(res, toolCallChunks(`c${n}`, "echo", JSON.stringify({ text: `step-${n}` })), { delayMs: 0 });
      return { raw: true };
    });
    const provider = createOpenAIProvider({
      apiKey: "test-key",
      baseUrl,
      runawayRounds: 50,
      smallCmdAfter: 50,
      silentAfter: 3,
      log: { error() {}, warn() {} },
    });
    const { result } = await runSend(provider.create({ cwd, customTools: TOOLS }), "investigate");
    assert.equal(result.status, "finished");
    const nudges = mock.requests.at(-1).body.messages.filter((m) => String(m.content).includes("تذکر سیستمی"));
    assert.equal(nudges.length, 1, "exactly one nudge");
    assert.match(nudges[0].content, /پیشرفت/);
    assert.ok(n >= 4, `nudge fired after the silent streak (${n} rounds)`);
  });

  it("no round ration: tools stay available; an identical loop is nudged once, then fails as stuck", async () => {
    const cwd = tempWorkspace();
    let n = 0;
    mock.on((req, res) => {
      if (req.url !== "/v1/chat/completions") return { status: 404 };
      n += 1;
      assert.ok(req.body.tools, "every round keeps its tools");
      sse(res, toolCallChunks(`c${n}`, "echo", '{"text":"x"}'), { delayMs: 0 });
      return { raw: true };
    });
    const provider = createOpenAIProvider({ apiKey: "test-key", baseUrl, runawayRounds: 50, log: { error() {}, warn() {} } });
    const { result } = await runSend(provider.create({ cwd, customTools: TOOLS }), "loop forever");
    assert.equal(result.status, "error");
    assert.match(result.error.message, /stuck/);
    // nudge at round 3 (default stuckAfter), one more identical round, then stop — long before the cap.
    assert.ok(n >= 3 && n < 10, `expected an early stop, got ${n} rounds`);
  });

  it("a changing loop still runs until the runaway cap, loudly", async () => {
    const cwd = tempWorkspace();
    let n = 0;
    mock.on((req, res) => {
      if (req.url !== "/v1/chat/completions") return { status: 404 };
      n += 1;
      sse(res, toolCallChunks(`c${n}`, "echo", JSON.stringify({ text: `call-${n}` })), { delayMs: 0 });
      return { raw: true };
    });
    const provider = createOpenAIProvider({ apiKey: "test-key", baseUrl, runawayRounds: 5, log: { error() {}, warn() {} } });
    const { result } = await runSend(provider.create({ cwd, customTools: TOOLS }), "loop forever");
    assert.equal(result.status, "error");
    assert.match(result.error.message, /runaway/);
    assert.equal(n, 5);
  });
});

describe("openai provider: stalled stream", () => {
  it("aborts a silent stream and retries the round once", async () => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (requests === 1) {
        send({ choices: [{ index: 0, delta: { reasoning_content: "hmm" } }] }); // then silence
        return;
      }
      send({ choices: [{ index: 0, delta: { content: "جواب" } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.end("data: [DONE]\n\n");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: `http://127.0.0.1:${server.address().port}`, idleMs: 200, log: { error() {} } });
      const { result } = await runSend(provider.create({ cwd: tempWorkspace(), rules: "R" }), "سلام");
      assert.equal(result.status, "finished");
      assert.equal(requests, 2);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});

describe("openai provider: rate limit", () => {
  it("waits and retries a 429 instead of failing the run", async () => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests += 1;
      if (requests === 1) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0.05" });
        res.end(JSON.stringify({ error: { code: "1302", message: "Rate limit reached for requests" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: `http://127.0.0.1:${server.address().port}`, log: { error() {} } });
      const { result } = await runSend(provider.create({ cwd: tempWorkspace(), rules: "R" }), "سلام");
      assert.equal(result.status, "finished");
      assert.equal(requests, 2);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});

describe("openai provider: dropped connection", () => {
  it("retries a round whose connection was cut before any answer text", async () => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests += 1;
      if (requests === 1) {
        req.socket.destroy(); // «fetch failed» on the client
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: `http://127.0.0.1:${server.address().port}`, log: { error() {} } });
      const { result } = await runSend(provider.create({ cwd: tempWorkspace(), rules: "R" }), "سلام");
      assert.equal(result.status, "finished");
      assert.equal(requests, 2);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
