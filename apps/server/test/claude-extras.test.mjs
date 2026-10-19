// For chats on the Claude engine (and engine-neutral where cheap): continue after the
// plan limit resets, the «/» list, the suggested next message, fast mode, fork from a reply.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createApp } from "../src/app.mjs";
import { createRunner, LIMIT_RESUME_TEXT, MAX_LIMIT_RESUMES, setFastWanted } from "../src/runner.mjs";
import { createClaudeEventBridge } from "../src/providers/claude-events.mjs";
import { eventsFromUpdate } from "../src/updates.mjs";

const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout");
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-extras-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  return { store, done: () => (store.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

// A fake engine: each send runs `script(n, options)` → the run's result; options are kept.
function fakeSdk(script) {
  const sends = [];
  const agent = (agentId) => ({
    agentId,
    async send(message, options) {
      sends.push({ message: typeof message === "string" ? message : message.text, options });
      const n = sends.length;
      return { id: `r${n}`, supports: () => true, async cancel() {}, wait: async () => script(n, options) };
    },
  });
  return { sends, sdk: { kind: "claude", create: async () => agent("a"), resume: async (id) => agent(id) } };
}

const limitHit = () => ({ status: "error", error: { message: "You've hit your limit", code: "plan_limit", resetsAt: Date.now() + 1000 } });
const runsDone = (store, chatId, n) => store.eventsAfter(chatId).filter((e) => e.type === "run.finished").length === n;

test("plan limit with no other engine: the chat continues by itself after the reset, three tries at most", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk(() => limitHit());
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {} });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "کار را تمام کن" });
    await until(() => runsDone(store, chat.id, 1));
    assert.ok(runner.limitResumeAt(chat.id) > Date.now(), "waits for the reset");
    assert.match(store.eventsAfter(chat.id).find((e) => e.type === "note").data.text, /خودکار ادامه می‌دهد/);
    for (let i = 1; i <= MAX_LIMIT_RESUMES; i += 1) {
      assert.deepEqual(await runner.sweepLimitResumes(Date.now() + 10 * 60_000), [chat.id]);
      await until(() => runsDone(store, chat.id, i + 1));
    }
    // The message never reached the agent: it went again as itself, not as «continue».
    assert.equal(sends[1].message, "کار را تمام کن");
    assert.equal(runner.limitResumeAt(chat.id), null, "gave up after three tries");
    assert.match(store.eventsAfter(chat.id).filter((e) => e.type === "note").at(-1).data.text, /دیگر خودکار ادامه نمی‌دهد/);
    assert.deepEqual(await runner.sweepLimitResumes(Date.now() + 10 * 60_000), []);
  } finally {
    done();
  }
});

test("auto-continue: an answer that got out continues with «ادامه»; a message, Stop or the switch ends the wait", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk(async (n, options) => {
    if (n !== 1 && n !== 3) return { status: "finished" };
    await options.onDelta({ update: { type: "text-delta", text: "نیمه" } });
    return limitHit();
  });
  let on = true;
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, autoContinue: () => on });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "شروع" });
    await until(() => runsDone(store, chat.id, 1));
    await runner.sweepLimitResumes(Date.now() + 10 * 60_000);
    await until(() => runsDone(store, chat.id, 2));
    assert.equal(sends[1].message, LIMIT_RESUME_TEXT);
    assert.equal(runner.limitResumeAt(chat.id), null, "a finished run leaves nothing to continue");

    await runner.send(chat.id, { text: "دوباره" });
    await until(() => runsDone(store, chat.id, 3));
    assert.ok(runner.limitResumeAt(chat.id));
    runner.cancelLimitResume(chat.id);
    assert.equal(runner.limitResumeAt(chat.id), null);

    on = false;
    await runner.send(chat.id, { text: "باز" });
    await until(() => runsDone(store, chat.id, 4));
  } finally {
    done();
  }
});

test("auto-continue is for the owner's own chats, and not when another engine took the run over", async () => {
  const { store, done } = setup();
  const { sdk } = fakeSdk((n) => (n === 1 ? limitHit() : n === 2 ? limitHit() : { status: "finished" }));
  const marked = [];
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: (chat) => (marked.push(chat.id), true) });
  try {
    const owner = store.createChat({ title: "t" });
    await runner.send(owner.id, { text: "x" });
    await until(() => runsDone(store, owner.id, 2));
    assert.equal(marked.length, 2, "the fallback's own limit marks its account too");
    assert.ok(runner.limitResumeAt(owner.id), "the fallback ran dry as well: wait for the reset");

    const thread = store.createChat({ title: "رشته", caller: "team" });
    await runner.send(thread.id, { text: "y" });
    await until(() => runsDone(store, thread.id, 1));
    assert.equal(runner.limitResumeAt(thread.id), null, "a colleague's thread is not continued by itself");
  } finally {
    done();
  }
});

test("Claude extras on an owner chat: commands list, next-message suggestion, fast mode", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk(async (n, options) => {
    await options.onDelta({ update: { type: "fast-mode", state: "off", reason: "extra_usage_disabled" } });
    options.onCommands?.([{ name: "review", description: "  Review\n the diff ", argumentHint: "" }, { nope: 1 }]);
    return { status: "finished" };
  });
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {} });
  try {
    const chat = store.createChat({ title: "t" });
    setFastWanted(store, chat.id, true);
    await runner.send(chat.id, { text: "سلام" });
    await until(() => runsDone(store, chat.id, 1));
    assert.equal(sends[0].options.fast, true);
    assert.deepEqual(runner.fastState(chat.id), { state: "off", reason: "extra_usage_disabled" });
    assert.deepEqual(runner.commandsFor(store.getChat(chat.id)), [{ name: "review", description: "Review the diff", argumentHint: "" }]);
    // The suggestion arrives after the result, once the run is over.
    sends[0].options.onSuggestion("حالا تست‌ها را اجرا کن");
    assert.equal(runner.suggestion(chat.id), "حالا تست‌ها را اجرا کن");
    await runner.send(chat.id, { text: "بعدی" });
    assert.equal(runner.suggestion(chat.id), null, "a new run drops it");
    await until(() => runsDone(store, chat.id, 2));

    const job = store.createChat({ title: "j", caller: "scheduler" });
    await runner.send(job.id, { text: "x" });
    await until(() => runsDone(store, job.id, 1));
    assert.equal(sends[2].options.onSuggestion, undefined);
    assert.equal(sends[2].options.onCommands, undefined);
  } finally {
    done();
  }
});

test("Claude bridge: a result carries the fork checkpoint and the fast-mode state", () => {
  const bridge = createClaudeEventBridge();
  bridge.consume({ type: "assistant", uuid: "u-1", message: { content: [] } });
  const out = bridge.consume({ type: "result", session_id: "s-1", fast_mode_state: "on" });
  assert.deepEqual(out.find((u) => u.type === "checkpoint"), { type: "checkpoint", lastMessageId: "u-1", sessionId: "s-1" });
  assert.deepEqual(out.find((u) => u.type === "fast-mode"), { type: "fast-mode", state: "on", reason: null });
  assert.deepEqual(eventsFromUpdate(out.find((u) => u.type === "checkpoint")), [{ type: "checkpoint", data: { lastMessageId: "u-1", sessionId: "s-1" } }]);
  assert.deepEqual(eventsFromUpdate({ type: "fast-mode", state: "on" }), []);
});

function appSetup({ engine = "claude", forkSession = null } = {}) {
  const { store, done } = setup();
  const sent = [];
  const cancelled = [];
  const runner = {
    isActive: () => false,
    activeCount: () => 0,
    engineOf: () => engine,
    commandsFor: () => [{ name: "review", description: "r", argumentHint: "" }],
    cancelLimitResume: (id) => cancelled.push(id),
    forkSession,
    send: async (chatId, input) => (sent.push({ chatId, ...input }), { delivered: "run" }),
  };
  return { store, app: createApp({ store, runner }), sent, cancelled, done };
}
const post = (app, url, body) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("«/» list: Claude's commands plus /clear; on the OpenAI engine /clear and a local /compact", async () => {
  const claude = appSetup();
  const chat = claude.store.createChat({ title: "t" });
  const names = async (a) => (await (await a.app.request(`/api/commands?chat=${chat.id}`)).json()).commands.map((c) => c.name);
  assert.deepEqual(await names(claude), ["review", "clear"]);
  assert.equal((await (await claude.app.request(`/api/commands?chat=${chat.id}`)).json()).engine, "claude");
  assert.deepEqual((await (await claude.app.request("/api/commands")).json()).commands.map((c) => c.name), ["review", "clear"], "the new-chat page lists them too");
  claude.done();

  const glm = appSetup({ engine: "openai" });
  const g = glm.store.createChat({ title: "t" });
  assert.deepEqual((await (await glm.app.request(`/api/commands?chat=${g.id}`)).json()).commands.map((c) => c.name), ["clear", "compact"]);
  glm.store.setAgentId(g.id, "session-1");
  const res = await post(glm.app, `/api/chats/${g.id}/messages`, { text: "/compact" });
  assert.deepEqual(await res.json(), { delivered: "compacted" });
  assert.equal(glm.store.getChat(g.id).agent_id, null, "the next run starts a fresh, seeded session");
  assert.equal(glm.sent.length, 0);
  assert.deepEqual(glm.cancelled, [g.id], "an owner message ends the auto-continue wait");
  glm.done();
});

test("fork: a new chat with the turns up to that reply, in the same folder, on a forked Claude session", async () => {
  const forks = [];
  const { store, app, done } = appSetup({ forkSession: async (chat, args) => (forks.push(args), "forked-session") });
  try {
    const parent = store.createChat({ title: "اصلی" });
    store.updateChat(parent.id, { repo: "group/app", worktreePath: "/w/_wt/abc" });
    const turn = (text, answer, mark) => {
      store.appendEvent(parent.id, null, "user", { text });
      const runId = store.startRun(parent.id);
      store.appendEvent(parent.id, runId, "run.started", {});
      store.appendEvent(parent.id, runId, "text", { text: answer });
      if (mark) store.appendEvent(parent.id, runId, "checkpoint", { lastMessageId: mark, sessionId: "s-1" });
      store.appendEvent(parent.id, runId, "run.finished", { status: "finished" });
      return runId;
    };
    const first = turn("یک", "جواب یک", "u-1");
    turn("دو", "جواب دو", "u-2");
    const res = await post(app, `/api/chats/${parent.id}/fork`, { runId: first });
    assert.equal(res.status, 201);
    const { chat } = await res.json();
    assert.deepEqual(forks, [{ sessionId: "s-1", upToMessageId: "u-1" }]);
    assert.equal(store.getChat(chat.id).agent_id, "forked-session");
    assert.equal(store.getKv(`fork-of:${chat.id}`), parent.id);
    assert.deepEqual(store.priorTurns(chat.id), [{ role: "user", content: "یک" }, { role: "assistant", content: "جواب یک" }]);
    assert.equal(chat.repo, "group/app");
    assert.equal((await post(app, `/api/chats/${parent.id}/fork`, { runId: "nope" })).status, 404);
    const job = store.createChat({ title: "j", caller: "scheduler" });
    assert.equal((await post(app, `/api/chats/${job.id}/fork`, { runId: first })).status, 403);
  } finally {
    done();
  }
});
