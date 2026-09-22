import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { openStore } from "../src/db.mjs";
import { createAsks } from "../src/asks.mjs";
import { createPeerAuth } from "../src/peer-auth.mjs";
import { createPeerTasks } from "../src/peer-tasks.mjs";
import { createMcpHandler } from "../src/mcp.mjs";

// Fake runner: each send runs `script(chatId, emit)`; emit appends chat events like the real one.
function setup(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tasks-"));
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
          emit("run.finished", { status });
          store.finishRun(chatId, runId, status);
        });
      return { runId, delivered: "run" };
    },
    async cancel(chatId) {
      active.delete(chatId);
      return { status: "cancelling" };
    },
  };
  const auth = createPeerAuth({ store });
  auth.createUser({ id: "ali-ahmadi", label: "آقای قانع" });
  auth.createUser({ id: "someone-else" });
  const peer = { userId: "ali-ahmadi", clientId: "c1", caller: "peer:ali-ahmadi", label: "آقای قانع" };
  const tasks = createPeerTasks({ store, runner, asks });
  return { store, tasks, peer, auth, runner, asks };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("quick task finishes inline; peer sees answer and tool names, not args", async () => {
  const { tasks, peer } = setup(async (_id, emit) => {
    emit("tool.started", { name: "kube_df", args: { secret: "x" } });
    emit("text", { text: "۸٫۶G " });
    emit("text", { text: "آزاد" });
  });
  const r = await tasks.send(peer, { message: "دیسک ۱ S3 پروداکشن؟", waitSec: 2 });
  assert.equal(r.state, "completed");
  assert.equal(r.answer, "۸٫۶G آزاد");
  assert.ok(r.progress.some((p) => p.kind === "tool" && p.tool === "kube_df"));
  assert.ok(!JSON.stringify(r).includes("secret"));
});

test("long task returns working quickly and streams progress through wait", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { tasks, peer } = setup(async (_id, emit) => {
    emit("text", { text: "شروع کردم" });
    await gate;
    emit("text", { text: " — تمام" });
  });
  const started = await tasks.send(peer, { message: "کار طولانی", waitSec: 0 });
  assert.equal(started.state, "working");
  const first = await tasks.wait(peer, { taskId: started.taskId, afterSeq: 0, waitSec: 2 });
  assert.equal(first.state, "working");
  assert.match(first.progress.map((p) => p.text).join(""), /شروع کردم/);
  release();
  let last = first;
  for (let i = 0; i < 5 && last.state !== "completed"; i += 1) {
    last = await tasks.wait(peer, { taskId: started.taskId, afterSeq: last.seq, waitSec: 2 });
  }
  assert.equal(last.state, "completed");
  assert.equal(last.answer, "شروع کردم — تمام");
});

// Plenty of real work needs a word with the requester — ask_requester is that conversation, and
// unlike ask_owner it is theirs to answer.
test("ask_requester -> input-required -> reply -> completed", async () => {
  const { tasks, peer } = setup(async (chatId, emit, { asks }) => {
    const ask = asks.requesterTool(chatId);
    emit("tool.started", { name: "ask_requester", args: { question: "کدام کلاستر؟", options: [{ label: "prod" }, { label: "dr" }] } });
    const res = await ask.execute({ question: "کدام کلاستر؟" });
    const answer = JSON.parse(res.content[0].text).answer;
    emit("text", { text: `باشه، ${answer}` });
  });
  const r = await tasks.send(peer, { message: "لاگ گذرگاه", waitSec: 2 });
  assert.equal(r.state, "input-required");
  assert.equal(r.question.text, "کدام کلاستر؟");
  assert.deepEqual(r.question.options, ["prod", "dr"]);
  const done = await tasks.reply(peer, { taskId: r.taskId, answer: "dr", waitSec: 2 });
  assert.equal(done.state, "completed");
  assert.match(done.answer, /dr/);
  const again = await tasks.reply(peer, { taskId: r.taskId, answer: "prod" });
  assert.ok(again.error);
});

test("messageId dedupes; other users cannot see the task; busy context is refused", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { tasks, peer } = setup(async () => {
    await gate;
  });
  const a = await tasks.send(peer, { message: "x", messageId: "m-1", waitSec: 0 });
  const b = await tasks.send(peer, { message: "x", messageId: "m-1", waitSec: 0 });
  assert.equal(b.duplicate, true);
  assert.equal(b.taskId, a.taskId);
  const other = { userId: "someone-else", caller: "peer:someone-else" };
  assert.ok((await tasks.wait(other, { taskId: a.taskId, waitSec: 0 })).error);
  assert.ok((await tasks.send(other, { message: "y", contextId: a.contextId })).error);
  const busy = await tasks.send(peer, { message: "دومی", contextId: a.contextId, waitSec: 0 });
  assert.match(busy.error, /busy/);
  release();
  await tick(20);
  const follow = await tasks.send(peer, { message: "دومی", contextId: a.contextId, waitSec: 1 });
  assert.equal(follow.state, "completed");
  assert.equal(follow.contextId, a.contextId);
  assert.equal(tasks.list(peer).tasks.length, 2);
});

test("agent without a quota row for this peer is refused", async () => {
  const { tasks, store } = setup(async () => {});
  store.updateAgentProfile("griffin", { meta: { callers: {} } });
  const r = await tasks.send({ userId: "ali-ahmadi", caller: "peer:ali-ahmadi" }, { message: "hi" });
  assert.match(r.error, /not available/);
});

test("MCP over HTTP: initialize, tools/list, tools/call, auth required", async () => {
  const { tasks, auth } = setup(async (_id, emit) => {
    emit("text", { text: "pong" });
  });
  const { token } = auth.issueClient("ali-ahmadi", { label: "laptop" });
  const mcp = createMcpHandler({ tasks });
  const app = new Hono();
  app.post("/mcp", auth.middleware(), mcp.post);
  app.get("/mcp", mcp.notAllowed);
  const call = (body, headers = { authorization: `Bearer ${token}` }) =>
    app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  assert.equal((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {})).status, 401);
  const init = await (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ["griffin_send", "griffin_wait", "griffin_reply", "griffin_cancel", "griffin_tasks"]);
  const sent = await (await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "griffin_send", arguments: { message: "ping", waitSec: 2 } } })).json();
  assert.equal(sent.result.structuredContent.state, "completed");
  assert.equal(sent.result.structuredContent.answer, "pong");
  assert.equal((await app.request("/mcp")).status, 405);
});

test("MCP answers as SSE when the client accepts it (for waits longer than the edge timeout)", async () => {
  const { tasks, auth } = setup(async (_id, emit) => {
    emit("text", { text: "ok" });
  });
  const { token } = auth.issueClient("ali-ahmadi");
  const mcp = createMcpHandler({ tasks });
  const app = new Hono();
  app.post("/mcp", auth.middleware(), mcp.post);
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "griffin_send", arguments: { message: "x", waitSec: 2 } } }),
  });
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  const reply = JSON.parse(data.slice(6));
  assert.equal(reply.id, 7);
  assert.equal(reply.result.structuredContent.state, "completed");
});

test("every MCP call is recorded: handshake-only clients, bad tool names and malformed arguments", async () => {
  const { tasks, auth, store } = setup(async (_id, emit) => {
    emit("text", { text: "ok" });
  });
  const { token } = auth.issueClient("ali-ahmadi", { label: "laptop" });
  const mcp = createMcpHandler({ tasks, record: (call) => store.recordPeerCall(call), log: { log() {}, error() {} } });
  const app = new Hono();
  app.post("/mcp", auth.middleware(), mcp.post);
  const call = (body) =>
    app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const unknown = await (await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "griffin_do", arguments: {} } })).json();
  assert.match(unknown.error.message, /unknown tool: griffin_do — this server offers griffin_send/);
  const bad = await (await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "griffin_send", arguments: { body: "PRIVATE-REQUEST-TEXT" } } })).json();
  assert.match(bad.result.structuredContent.error, /message is required.*received: body/);

  const calls = store.listPeerCalls("ali-ahmadi");
  assert.deepEqual(
    calls.map((c) => [c.method, c.tool, c.outcome]).reverse(),
    [
      ["initialize", null, "ok"],
      ["tools/list", null, "ok"],
      ["tools/call", "griffin_do", "error"],
      ["tools/call", "griffin_send", "error"],
    ],
  );
  assert.equal(calls.at(0).arg_keys, "body");
  assert.ok(calls.every((c) => !JSON.stringify(c).includes("PRIVATE-REQUEST-TEXT")), "argument values are never stored");
});

test("a namespaced tool name from a hand-rolled client still reaches the tool", async () => {
  const { tasks, peer, store } = setup(async (_id, emit) => {
    emit("text", { text: "pong" });
  });
  const mcp = createMcpHandler({ tasks, record: (call) => store.recordPeerCall(call), log: { log() {}, error() {} } });
  const app = new Hono();
  app.post("/mcp", (c) => {
    c.set("peer", peer);
    return mcp.post(c);
  });
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "mcp__griffin__griffin_send", arguments: { prompt: "ping", waitSec: 2 } },
    }),
  });
  const reply = await res.json();
  assert.equal(reply.result.structuredContent.state, "completed");
  assert.equal(reply.result.structuredContent.answer, "pong");
  assert.equal(store.listPeerCalls("ali-ahmadi").at(0).tool, "griffin_send");
});

// The requester must never approve its own request: an ask_owner with no explicit audience belongs
// to the owner, so the task reports auth-required, griffin_reply bounces, and only an owner answer
// (web UI or their Telegram) moves it on.
test("permission question -> auth-required: the peer cannot answer, the owner can", async () => {
  const { tasks, peer, asks } = setup(async (chatId, emit) => {
    const ask = asks.tool(chatId);
    emit("tool.started", { name: "ask_owner", args: { question: "دسترسی VPN صادر شود؟", options: [{ label: "بله" }, { label: "نه" }] } });
    const res = await ask.execute({ question: "دسترسی VPN صادر شود؟" });
    emit("text", { text: `Owner گفت: ${JSON.parse(res.content[0].text).answer}` });
  });
  const r = await tasks.send(peer, { message: "برای همکار جدید VPN بساز", waitSec: 2 });
  assert.equal(r.state, "auth-required");
  assert.equal(r.waitingFor, "owner");
  assert.ok(!r.question, "a question the peer may not answer is not handed to it");

  const refused = await tasks.reply(peer, { taskId: r.taskId, answer: "بله" });
  assert.match(refused.error, /owner/);
  assert.equal(asks.answer(r.contextId, { answer: "بله", selected: ["بله"], by: "requester" }), false);

  assert.equal(asks.answer(r.contextId, { answer: "بله", selected: ["بله"] }), true);
  let last = { seq: r.seq, state: r.state };
  for (let i = 0; i < 10 && last.state !== "completed"; i += 1) {
    last = await tasks.wait(peer, { taskId: r.taskId, afterSeq: last.seq, waitSec: 2 });
  }
  assert.equal(last.state, "completed");
  assert.match(last.answer, /Owner گفت: بله/);
});

// Griffin hands work to a specialist and ends its turn while the child is still waiting on the
// owner. That question must stay open: it is the child's, not the parent's.
test("a parent finishing its turn does not cancel the question its child is waiting on", async () => {
  const { store, asks } = setup(async () => {});
  const parent = store.createChat({ title: "parent", caller: "peer:ali-ahmadi" });
  const child = store.createChat({ title: "child", caller: "griffin", parentChatId: parent.id });

  let childAnswer = null;
  const pending = asks.tool(child.id).execute({ question: "ابزار قفل را باز کنم؟" }).then((r) => {
    childAnswer = JSON.parse(r.content[0].text);
  });
  await tick(20);
  assert.ok(asks.isWaiting(child.id));

  asks.cancel(parent.id); // the parent's run ends normally
  await tick(20);
  assert.equal(childAnswer, null, "the child's question survives the parent's turn");
  assert.ok(asks.isWaiting(child.id));

  assert.equal(asks.answer(parent.id, { answer: "بله", selected: ["بله"] }), true, "the owner can still answer it");
  await pending;
  assert.equal(childAnswer.answer, "بله");
});
