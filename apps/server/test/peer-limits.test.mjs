import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { openStore, usageTokens } from "../src/db.mjs";
import { createAsks } from "../src/asks.mjs";
import { createPeerAuth } from "../src/peer-auth.mjs";
import { createPeerTasks } from "../src/peer-tasks.mjs";
import { allowsModel, mergeLimits, peerSettings } from "../src/peer-limits.mjs";

// Fake runner: each send runs `script(chatId, emit)`; runs end on their own unless the script waits.
function setup(script = async () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-limits-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  const asks = createAsks({ store });
  const active = new Set();
  const runner = {
    isActive: (id) => active.has(id),
    async send(chatId, { text }) {
      store.appendEvent(chatId, null, "user", { text });
      active.add(chatId);
      const runId = store.startRun(chatId);
      const emit = (type, data = {}) => store.appendEvent(chatId, runId, type, data);
      emit("run.started", {});
      Promise.resolve()
        .then(() => script(chatId, emit, { asks }))
        .then((status = "finished") => {
          active.delete(chatId);
          emit("run.finished", { status, ...(status === "error" ? { error: "provider down" } : {}) });
          store.finishRun(chatId, runId, status);
        })
        .catch(() => {}); // the chat was deleted meanwhile
      return { runId, delivered: "run" };
    },
    async cancel(chatId) {
      active.delete(chatId);
      return { status: "cancelling" };
    },
  };
  const auth = createPeerAuth({ store });
  auth.createUser({ id: "alice", label: "خانم نمونه" });
  const peer = { userId: "alice", clientId: "c1", caller: "peer:alice", label: "خانم نمونه" };
  const tasks = createPeerTasks({ store, runner, asks });
  const setLimits = (patch) => {
    const profile = store.getAgentProfile("griffin");
    const callers = { ...profile.meta.callers };
    callers[peer.caller] = { ...callers[peer.caller], ...patch };
    store.updateAgentProfile("griffin", { meta: { callers } });
  };
  return { store, tasks, peer, auth, setLimits, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("usage tokens: OpenAI prompt includes its cache, Anthropic input gets its cache parts added", () => {
  assert.equal(usageTokens({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 90 } }), 105);
  assert.equal(usageTokens({ input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5, output_tokens: 5 }), 100);
});

test("a new colleague has no token cap by default; owner's PUT validates models, budget and texts", () => {
  const { store, cleanup } = setup();
  try {
    const settings = peerSettings(store.getAgentProfile("griffin"), "peer:alice");
    assert.deepEqual(settings.budget, { hourly: null, daily: null });
    // A cap the owner sets for one colleague still counts.
    assert.deepEqual(mergeLimits({}, { budget: { hourly: 1_000 } }).entry.budget, { hourly: 1_000, daily: null });
    assert.deepEqual(settings.models, []);
    assert.match(settings.messages.overBudget, /\{retryAt\}/);
    assert.match(mergeLimits({}, { models: ["nope"] }).error, /unknown model/);
    assert.match(mergeLimits({}, { models: ["claude"], model: "openai:glm-5.3" }).error, /one of the allowed/);
    assert.deepEqual(mergeLimits({}, { models: ["claude"], model: "claude:sonnet" }).entry, { models: ["claude"], model: "claude:sonnet" });
    assert.match(mergeLimits({}, { budget: { hourly: -1 } }).error, /non-negative/);
    assert.equal(mergeLimits({}, { budget: { daily: null } }).entry.budget.daily, null);
    assert.match(mergeLimits({}, { messages: "x" }).error, /object/);
    assert.equal(allowsModel(["claude"], "claude", "opus"), true);
    assert.equal(allowsModel(["claude:sonnet"], "claude", "opus"), false);
    assert.equal(allowsModel([], "openai", "x"), true);
  } finally {
    cleanup();
  }
});

test("over the hourly cap: a new request creates nothing and gets the owner's text; a follow-up is rejected", async () => {
  const { store, tasks, peer, setLimits, cleanup } = setup(async (_id, emit) => {
    emit("usage", { prompt_tokens: 900, completion_tokens: 200 });
    emit("text", { text: "ok" });
  });
  try {
    setLimits({ budget: { hourly: 1_000, daily: null }, messages: { overBudget: "پر شد: {window} {used}/{limit} تا {retryAt}" } });
    const first = await tasks.send(peer, { message: "اول", waitSec: 2 });
    assert.equal(first.state, "completed");
    const chats = store.listTasks(peer.userId).length;
    const over = await tasks.send(peer, { message: "دوم", waitSec: 1 });
    assert.equal(over.state, "rejected");
    assert.match(over.answer, /^پر شد: سقف یک ساعت 1,100\/1,000 تا /);
    assert.equal(store.listTasks(peer.userId).length, chats, "no task or chat for an over-cap new request");
    const follow = await tasks.send(peer, { message: "ادامه", contextId: first.contextId, waitSec: 1 });
    assert.equal(follow.state, "rejected");
    assert.match(follow.answer, /^پر شد/);
    assert.equal(follow.limit.window, "hourly");
    const limits = tasks.limits(peer, {});
    assert.equal(limits.budget.hourly.used, 1_100);
    assert.equal(limits.budget.hourly.remaining, 0);
  } finally {
    cleanup();
  }
});

test("at most two open requests per colleague per agent; follow-ups count, a deleted chat does not", async () => {
  const gates = [];
  const { store, tasks, peer, cleanup } = setup(() => new Promise((r) => gates.push(r)));
  try {
    const a = await tasks.send(peer, { message: "یک", waitSec: 0 });
    const b = await tasks.send(peer, { message: "دو", waitSec: 0 });
    assert.equal(a.state, "working");
    const third = await tasks.send(peer, { message: "سه", waitSec: 0 });
    assert.match(third.error, /too many open requests: 2/);
    store.deleteChat(b.contextId);
    const c = await tasks.send(peer, { message: "سه", waitSec: 0 });
    assert.equal(c.state, "working");
    // A follow-up in a finished context still counts against the two.
    gates.shift()();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await tasks.wait(peer, { taskId: a.taskId, waitSec: 1 })).state, "completed");
    const d = await tasks.send(peer, { message: "چهار", waitSec: 0 });
    assert.equal(d.state, "working");
    const follow = await tasks.send(peer, { message: "ادامه", contextId: a.contextId, waitSec: 0 });
    assert.match(follow.error, /too many open requests/);
    for (const g of gates) g();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    cleanup();
  }
});

test("a run the provider could not finish returns the owner's unavailable text, the partial answer apart", async () => {
  const { tasks, peer, setLimits, cleanup } = setup(async (_id, emit) => {
    emit("text", { text: "نیمه" });
    return "error";
  });
  try {
    setLimits({ messages: { unavailable: "سرویس در دسترس نیست" } });
    const r = await tasks.send(peer, { message: "x", waitSec: 2 });
    assert.equal(r.state, "failed");
    assert.equal(r.answer, "سرویس در دسترس نیست");
    assert.equal(r.partialAnswer, "نیمه");
  } finally {
    cleanup();
  }
});

test("models: a new context is pinned to the colleague's default, a model outside the allowed list is refused", async () => {
  const { store, tasks, peer, setLimits, cleanup } = setup(async (_id, emit) => {
    emit("text", { text: "ok" });
  });
  try {
    setLimits({ models: ["claude:haiku", "openai"], model: "claude:haiku" });
    assert.match((await tasks.send(peer, { message: "x", model: "claude:opus", waitSec: 0 })).error, /not allowed/);
    const r = await tasks.send(peer, { message: "x", waitSec: 2 });
    assert.equal(store.getChat(r.contextId).model, "claude:haiku");
    assert.equal(store.getChat(r.contextId).provider, "claude");
    // The owner narrows the list: the next follow-up moves to the default.
    setLimits({ models: ["openai:glm-5.3"], model: "openai:glm-5.3" });
    await tasks.send(peer, { message: "y", contextId: r.contextId, waitSec: 2 });
    assert.equal(store.getChat(r.contextId).model, "openai:glm-5.3");
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    cleanup();
  }
});

test("PUT /api/peers/:id/quota changes only the fields sent; usage shows on the peers list", async () => {
  const { store, auth, cleanup } = setup();
  try {
    const app = new Hono();
    auth.routes(app);
    const put = (body) => app.request("/api/peers/alice/quota", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "griffin", ...body }) });
    assert.equal((await put({ budget: { hourly: 10 } })).status, 200);
    const entry = store.getAgentProfile("griffin").meta.callers["peer:alice"];
    assert.equal(entry.tools, undefined, "no tool grant per colleague");
    assert.equal(entry.budget.hourly, 10);
    assert.equal((await put({ model: "bogus" })).status, 400);
    const list = await (await app.request("/api/peers")).json();
    const q = list.users[0].quotas.find((x) => x.agent === "griffin");
    assert.deepEqual(q.usage, { hourly: 0, daily: 0 });
    assert.ok(list.defaultMessages.unavailable);
  } finally {
    cleanup();
  }
});
