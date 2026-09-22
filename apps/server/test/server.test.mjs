import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { foldEvents, finalText } from "@griffin/timeline";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";

// Fake SDK agent: plays a scripted list of InteractionUpdates through onDelta.
function fakeSdk(script, { holdUntilCancel = false } = {}) {
  const calls = { create: 0, resume: 0, sends: [] };
  const makeAgent = (agentId) => ({
    agentId,
    async send(message, options) {
      calls.sends.push({ message, options });
      let cancelled = false;
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      const run = {
        id: `sdk-${calls.sends.length}`,
        supports: () => true,
        async cancel() {
          cancelled = true;
          release();
        },
        async wait() {
          for (const update of script) await options.onDelta({ update });
          if (holdUntilCancel) await gate;
          return { id: run.id, status: cancelled ? "cancelled" : "finished" };
        },
      };
      return run;
    },
  });
  return {
    calls,
    sdk: {
      async create() {
        calls.create += 1;
        return makeAgent("agent-1");
      },
      async resume(id) {
        calls.resume += 1;
        return makeAgent(id);
      },
    },
  };
}

function setup(script, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-test-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const fake = fakeSdk(script, options);
  const runner = createRunner({ store, sdk: fake.sdk, agentOptions: () => ({}), log: {} });
  const app = createApp({ store, runner });
  const cleanup = () => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, runner, app, fake, cleanup };
}

const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout");
};

const json = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("new chat runs the agent and stores a single-source timeline", async () => {
  const script = [
    { type: "thinking-delta", text: "دیسک " },
    { type: "thinking-delta", text: "را بخوانم" },
    { type: "thinking-completed", thinkingDurationMs: 900 },
    { type: "text-delta", text: "الان df می‌گیرم." },
    {
      type: "tool-call-started",
      callId: "c1",
      toolCall: { type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: "kube_df", args: { pod: "p" } } },
    },
    {
      type: "tool-call-completed",
      callId: "c1",
      toolCall: {
        type: "mcp",
        args: { providerIdentifier: "custom-user-tools", toolName: "kube_df", args: { pod: "p" } },
        result: { status: "success", value: { content: [], isError: false } },
      },
    },
    { type: "text-delta", text: "۸٫۶G " },
    { type: "text-delta", text: "آزاد است." },
    { type: "token-delta", tokens: 3 },
  ];
  const { app, store, fake, cleanup } = setup(script);
  try {
    const res = await app.request("/api/chats", json({ text: "دیسک ۱ چقدر آزاد است؟" }));
    assert.equal(res.status, 201);
    const { chat } = await res.json();
    await until(() => store.eventsAfter(chat.id).some((e) => e.type === "run.finished"));

    const timeline = foldEvents(store.eventsAfter(chat.id));
    const [user, run] = timeline.messages;
    assert.equal(user.text, "دیسک ۱ چقدر آزاد است؟");
    assert.equal(run.status, "finished");
    assert.deepEqual(run.parts.map((p) => p.type), ["reasoning", "text", "tool", "text"]);
    assert.equal(run.parts[2].name, "kube_df");
    assert.equal(finalText(run), "۸٫۶G آزاد است.");
    assert.equal(fake.calls.create, 1);
    assert.equal(store.getChat(chat.id).agent_id, "agent-1");

    // follow-up reuses the cached agent
    const again = await app.request(`/api/chats/${chat.id}/messages`, json({ text: "و دیسک ۲؟" }));
    assert.equal(again.status, 202);
    await until(() => store.eventsAfter(chat.id).filter((e) => e.type === "run.finished").length === 2);
    assert.equal(fake.calls.create, 1);
    assert.equal(fake.calls.sends.length, 2);
    const list = await (await app.request("/api/chats")).json();
    assert.equal(list.chats[0].runStatus, "finished");
  } finally {
    cleanup();
  }
});

test("busy chat rejects send, queues follow-ups, and cancels", async () => {
  const { app, store, runner, fake, cleanup } = setup([{ type: "text-delta", text: "…" }], { holdUntilCancel: true });
  try {
    const { chat } = await (await app.request("/api/chats", json({ text: "کار طولانی" }))).json();
    await until(() => fake.calls.sends.length === 1);

    const busy = await app.request(`/api/chats/${chat.id}/messages`, json({ text: "دوباره" }));
    assert.equal(busy.status, 409);

    const queued = await app.request(`/api/chats/${chat.id}/messages`, json({ text: "بعدش این", intent: "queue" }));
    assert.equal((await queued.json()).delivered, "queued");

    const cancel = await app.request(`/api/chats/${chat.id}/cancel`, { method: "POST" });
    assert.equal((await cancel.json()).status, "cancelling");
    await until(() => !runner.isActive(chat.id));
    const finished = store.eventsAfter(chat.id).filter((e) => e.type === "run.finished");
    assert.equal(finished.length, 1);
    assert.equal(finished[0].data.status, "cancelled");
    assert.equal(fake.calls.sends.length, 1, "cancel drops the queue");
  } finally {
    cleanup();
  }
});

test("SSE replays after Last-Event-ID only", async () => {
  const { app, store, cleanup } = setup([{ type: "text-delta", text: "سلام" }]);
  try {
    const { chat } = await (await app.request("/api/chats", json({ text: "سلام" }))).json();
    await until(() => store.eventsAfter(chat.id).some((e) => e.type === "run.finished"));
    const all = store.eventsAfter(chat.id);
    const from = all[1].id;

    const controller = new AbortController();
    const res = await app.request(`/api/chats/${chat.id}/stream`, {
      headers: { "last-event-id": String(from) },
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    let text = "";
    while (!text.includes(`id: ${all.at(-1).id}`)) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    await reader.cancel().catch(() => {});
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids, all.slice(2).map((e) => e.id));
  } finally {
    cleanup();
  }
});

test("restart resumes orphaned runs instead of leaving them as errors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-test-"));
  try {
    const file = path.join(dir, "db.sqlite");
    let store = openStore(file);
    const chat = store.createChat({ title: "x" });
    store.appendEvent(chat.id, null, "user", { text: "فضای دیسک را بگو", images: 0 });
    const runId = store.startRun(chat.id);
    store.setAgentId(chat.id, "agent-resume");
    store.close();

    store = openStore(file);
    const fake = fakeSdk([{ type: "text-delta", text: "ادامه دادم" }]);
    fake.sdk.clearStuck = async () => ({ cancelled: 1 });
    createRunner({ store, sdk: fake.sdk, agentOptions: () => ({}), log: {} });
    assert.equal(store.runningRuns().length, 0);
    const closed = store.eventsAfter(chat.id).find((e) => e.type === "run.finished" && e.runId === runId);
    assert.equal(closed.data.status, "cancelled");
    assert.match(closed.data.error, /ازسرگیری/);

    await until(() => fake.calls.sends.length >= 1);
    await until(() => store.eventsAfter(chat.id).some((e) => e.type === "run.finished" && e.runId !== runId));
    assert.match(String(fake.calls.sends[0].message), /ری‌استارت|ادامه/);
    assert.match(String(fake.calls.sends[0].message), /فضای دیسک/);
    const resumed = store.eventsAfter(chat.id).filter((e) => e.type === "run.finished").at(-1);
    assert.equal(resumed.data.status, "finished");
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects bad input", async () => {
  const { app, cleanup } = setup([]);
  try {
    assert.equal((await app.request("/api/chats", json({ text: "  " }))).status, 400);
    const badImage = json({ text: "x", images: [{ mimeType: "text/html", data: "x" }] });
    assert.equal((await app.request("/api/chats", badImage)).status, 400);
    assert.equal((await app.request("/api/chats/nope/cancel", { method: "POST" })).status, 404);
  } finally {
    cleanup();
  }
});

test("ask_owner waits for the owner's answer; late answers become a message", async () => {
  const { createAsks, ASK_TOOL } = await import("../src/asks.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-ask-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const asks = createAsks();
  const toolResults = [];
  let sends = 0;
  // Agent whose run calls ask_owner, then finishes with the answer it got.
  const sdk = {
    async create(options) {
      return {
        agentId: "agent-ask",
        async send(message, sendOptions) {
          sends += 1;
          return {
            id: `sdk-${sends}`,
            supports: () => true,
            async cancel() {},
            async wait() {
              if (sends === 1) {
                const result = await options.local.customTools[ASK_TOOL].execute({ question: "کدام کلاستر؟", options: [{ label: "پروداکشن" }, { label: "دی‌آر" }] });
                toolResults.push(JSON.parse(result.content[0].text));
              }
              await sendOptions.onDelta({ update: { type: "text-delta", text: "باشه" } });
              return { status: "finished" };
            },
          };
        },
      };
    },
    async resume() { throw new Error("not used"); },
  };
  const runner = createRunner({
    store, sdk, log: {},
    onCancel: (chatId) => asks.cancel(chatId),
    agentOptions: (chat) => ({ local: { customTools: { [ASK_TOOL]: asks.tool(chat.id) } } }),
  });
  const app = createApp({ store, runner, asks });
  try {
    const { chat } = await (await app.request("/api/chats", json({ text: "مصرف مموری" }))).json();
    await until(() => asks.isWaiting(chat.id));
    assert.equal(runner.isActive(chat.id), true, "run stays active while the question waits");

    const answered = await app.request(`/api/chats/${chat.id}/answer`, json({ selected: ["پروداکشن"], text: "فقط p24core" }));
    assert.deepEqual(await answered.json(), { delivered: "tool" });
    await until(() => !runner.isActive(chat.id));
    assert.deepEqual(toolResults, [{ answered: true, answer: "پروداکشن — فقط p24core", selected: ["پروداکشن"] }]);

    // Nobody is waiting any more: the answer is sent as a normal follow-up message.
    const late = await app.request(`/api/chats/${chat.id}/answer`, json({ question: "کدام کلاستر؟", text: "دی‌آر هم ببین" }));
    assert.equal(late.status, 202);
    await until(() => sends === 2 && !runner.isActive(chat.id));
    const userTexts = store.eventsAfter(chat.id, 0).filter((e) => e.type === "user").map((e) => e.data.text);
    assert.equal(userTexts.at(-1), "پاسخ به سؤالت «کدام کلاستر؟»: دی‌آر هم ببین");

    assert.equal((await app.request(`/api/chats/${chat.id}/answer`, json({}))).status, 400);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelling a run releases a waiting question", async () => {
  const { createAsks, ASK_TOOL } = await import("../src/asks.mjs");
  const asks = createAsks();
  const pending = asks.tool("c1").execute({ question: "ادامه بدهم؟" });
  assert.equal(asks.isWaiting("c1"), true);
  asks.cancel("c1");
  assert.deepEqual(JSON.parse((await pending).content[0].text), { answered: false, reason: "the owner stopped the run before answering" });
  assert.equal(asks.isWaiting("c1"), false);
  assert.equal(asks.answer("c1", { answer: "x" }), false);
  assert.equal(ASK_TOOL, "ask_owner");
});

test("an answer posted before ask_owner starts waiting is delivered to the question, not queued", async () => {
  const { createAsks } = await import("../src/asks.mjs");
  const asks = createAsks();
  let active = true;
  const early = asks.waitForQuestion("c2", { timeoutMs: 2_000, stillActive: () => active, pollMs: 10 });
  const pending = new Promise((resolve) => setTimeout(() => resolve(asks.tool("c2").execute({ question: "کدام کلاستر؟" })), 50));
  assert.equal(await early, true);
  assert.equal(asks.answer("c2", { answer: "دی‌آر", selected: ["دی‌آر"] }), true);
  assert.deepEqual(JSON.parse((await (await pending)).content[0].text), { answered: true, answer: "دی‌آر", selected: ["دی‌آر"] });

  // Run ends without the tool ever waiting: give up so the caller sends a follow-up message.
  const never = asks.waitForQuestion("c3", { timeoutMs: 2_000, stillActive: () => active, pollMs: 10 });
  active = false;
  assert.equal(await never, false);
});

test("timeline snapshot is folded server-side and oversized old events are compacted", async () => {
  const { store, app, cleanup } = setup([{ type: "text-delta", text: "سلام" }]);
  try {
    const chat = store.createChat({ title: "t", mode: "agent" });
    store.appendEvent(chat.id, null, "user", { text: "hi" });
    const runId = store.startRun(chat.id);
    store.appendEvent(chat.id, runId, "run.started", {});
    const bytes = Object.fromEntries(Array.from({ length: 80_000 }, (_, i) => [String(i), 255]));
    store.appendEvent(chat.id, runId, "tool.done", { callId: "c1", name: "s3_get", args: {}, result: { value: { content: [{ image: { data: bytes } }] } } });
    store.appendEvent(chat.id, runId, "run.finished", { status: "finished" });
    const { clip } = await import("../src/updates.mjs");
    assert.equal(store.compactLargeEvents((d) => clip(d)), 1);
    const res = await app.request(`/api/chats/${chat.id}/timeline`);
    const { timeline } = await res.json();
    assert.equal(timeline.messages.length, 2);
    assert.equal(timeline.messages[1].parts[0].result.value.content[0].image.data, "[binary omitted: 80000 bytes]");
    assert.ok(timeline.lastEventId >= 4);
  } finally {
    cleanup();
  }
});

test("an answer given before the agent starts waiting is held for that question, not queued as a duplicate", async () => {
  const { createAsks } = await import("../src/asks.mjs");
  const asks = createAsks();
  asks.holdEarly("c1", { answer: "پروداکشن", selected: ["پروداکشن"] });
  const pending = asks.tool("c1").execute({ question: "کدام کلاستر؟" });
  assert.deepEqual(JSON.parse((await pending).content[0].text), { answered: true, answer: "پروداکشن", selected: ["پروداکشن"] });
  assert.equal(asks.cancel("c1"), null, "consumed");

  asks.holdEarly("c2", { answer: "دی‌آر" });
  assert.deepEqual(asks.cancel("c2"), { answered: true, answer: "دی‌آر", selected: [] }, "run ended without asking: returned for delivery as a message");
});

test("PATCH agent switches persona on an open chat and clears the SDK handle", async () => {
  const { store, app, cleanup } = setup([{ type: "text-delta", text: "ok" }]);
  try {
    const created = await (await app.request("/api/chats", json({ text: "سلام", agent: "griffin" }))).json();
    await until(() => !store.runningRuns().length);
    const chat = store.getChat(created.chat.id);
    assert.equal(chat.agent, "griffin");
    assert.equal(chat.provider, "cursor");
    assert.ok(chat.agent_id);

    const patched = await app.request(`/api/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "platform" }),
    });
    assert.equal(patched.status, 200);
    const body = await patched.json();
    assert.equal(body.chat.agent, "platform");
    assert.deepEqual(body.chat.agents, ["griffin"]);
    const after = store.getChat(chat.id);
    assert.equal(after.agent, "platform");
    assert.equal(after.agent_id, null);

    const list = await (await app.request("/api/chats")).json();
    const row = list.chats.find((c) => c.id === chat.id);
    assert.deepEqual(row.agents, ["griffin"]);
  } finally {
    cleanup();
  }
});

test("provider comes from agent profile; chat PATCH provider is ignored", async () => {
  const { store, app, cleanup } = setup([{ type: "text-delta", text: "ok" }]);
  try {
    store.updateAgentProfile("griffin", { provider: "claude", model: "sonnet" });

    const created = await (
      await app.request("/api/chats", json({ text: "سلام", agent: "griffin" }))
    ).json();
    await until(() => !store.runningRuns().length);
    assert.equal(created.chat.provider, "claude");
    assert.equal(created.chat.model, "sonnet");

    // Old clients may still send provider on the chat — ignored.
    const patched = await app.request(`/api/chats/${created.chat.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "cursor" }),
    });
    assert.equal(patched.status, 200);
    const body = await patched.json();
    assert.equal(body.chat.provider, "claude");
    assert.equal(store.getAgentProfile("griffin").provider, "claude");
  } finally {
    cleanup();
  }
});

test("agents list includes peer agents that ran via ask_agent children", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-agents-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  try {
    const parent = store.createChat({ title: "root", agent: "griffin" });
    const runId = store.startRun(parent.id);
    store.finishRun(parent.id, runId, "finished");
    assert.deepEqual(store.agentsWorked(store.getChat(parent.id)), ["griffin"]);

    const child = store.createChat({
      title: "peer",
      agent: "arvan-ban",
      caller: "griffin",
      parentChatId: parent.id,
    });
    store.startRun(child.id);
    assert.deepEqual(store.agentsWorked(store.getChat(parent.id)), ["griffin", "arvan-ban"]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("chats list and chat get include ask_agent children with live run status", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-children-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  try {
    const parent = store.createChat({ title: "root", agent: "griffin" });
    const child = store.createChat({
      title: "← گریفین: کار سپیدار",
      agent: "platform",
      caller: "griffin",
      parentChatId: parent.id,
    });
    const runId = store.startRun(child.id);

    const app = createApp({ store, runner: { isActive: () => false, send: async () => ({}) } });
    const listed = Object.fromEntries(
      (await (await app.request("/api/chats")).json()).chats.map((chat) => [chat.id, chat]),
    );
    assert.ok(listed[parent.id].children, "parent carries children");
    assert.equal(listed[parent.id].children.length, 1);
    assert.equal(listed[parent.id].children[0].id, child.id);
    assert.equal(listed[parent.id].children[0].agent, "platform");
    assert.equal(listed[parent.id].children[0].runStatus, "running");
    assert.ok(!listed[child.id], "child itself stays out of the sidebar list");

    store.finishRun(child.id, runId, "cancelled");
    const single = await (await app.request(`/api/chats/${parent.id}`)).json();
    assert.equal(single.chat.children[0].runStatus, "cancelled");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
