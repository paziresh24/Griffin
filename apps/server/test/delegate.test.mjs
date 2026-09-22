import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createAsks } from "../src/asks.mjs";
import { createPeers } from "../src/peers.mjs";
import { createPeerTasks } from "../src/peer-tasks.mjs";
import { seedExampleAgents } from "./fixture-agents.mjs";

// Fake runner: per-chat scripts; a chat without a script finishes at once with "ok".
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-delegate-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  seedExampleAgents(store);
  const active = new Map();
  const sent = [];
  const scripts = new Map(); // chatId -> async (emit) => status
  const gates = new Map();
  const runner = {
    isActive: (id) => active.has(id),
    async send(chatId, { text, intent = "send" }) {
      sent.push({ chatId, text, intent });
      store.appendEvent(chatId, null, "user", { text });
      const runId = store.startRun(chatId);
      active.set(chatId, runId);
      const emit = (type, data = {}) => store.appendEvent(chatId, runId, type, data);
      emit("run.started", {});
      const script = scripts.get(chatId) || (async (e) => { e("text", { text: "ok" }); });
      Promise.resolve().then(() => script(emit)).then((status = "finished") => {
        active.delete(chatId);
        emit("run.finished", { status });
        store.finishRun(chatId, runId, status);
      });
      return { runId, delivered: "run" };
    },
    async cancel(chatId) {
      const gate = gates.get(chatId);
      if (gate) gate("cancelled");
      return { status: "cancelling" };
    },
  };
  const peers = createPeers({ store, runner, wakeDelayMs: 20, log: { error() {} } });
  return { store, runner, peers, sent, scripts, gates, active };
}

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

test("delegate returns at once; the parent is woken with the result", async () => {
  const { store, peers, sent } = setup();
  const parent = store.createChat({ title: "p", agent: "griffin" });
  const r = JSON.parse((await peers.delegateTool(parent.id).execute({ agent: "platform", request: "دیسک" })).content[0].text);
  assert.equal(r.state, "working");
  assert.equal(peers.pendingDelegates(parent.id), 1);
  assert.ok(await until(() => sent.some((s) => s.chatId === parent.id)));
  const wake = sent.find((s) => s.chatId === parent.id);
  assert.match(wake.text, /گزارش خودکار زیرکارها/);
  assert.match(wake.text, new RegExp(r.subtask));
  assert.equal(peers.pendingDelegates(parent.id), 0);
});

test("subtasks lists, steers and cancels; wake is coalesced", async () => {
  const { store, peers, sent, scripts, gates } = setup();
  const parent = store.createChat({ title: "p", agent: "griffin" });
  // make every child created from now on wait for a gate
  const origCreate = store.createChat.bind(store);
  store.createChat = (opts) => {
    const chat = origCreate(opts);
    if (opts.parentChatId) {
      scripts.set(chat.id, (emit) => new Promise((resolve) => gates.set(chat.id, (status = "finished") => { emit("text", { text: `done ${chat.id}` }); resolve(status); })));
    }
    return chat;
  };
  const d = peers.delegateTool(parent.id);
  const a = JSON.parse((await d.execute({ agent: "platform", request: "A" })).content[0].text).subtask;
  const b = JSON.parse((await d.execute({ agent: "arvan-ban", request: "B" })).content[0].text).subtask;
  const tool = peers.subtasksTool(parent.id);
  const list = JSON.parse((await tool.execute({ action: "list" })).content[0].text).subtasks;
  assert.deepEqual(list.map((x) => x.state), ["working", "working"]);
  const steer = JSON.parse((await tool.execute({ action: "steer", id: a, message: "فقط prod" })).content[0].text);
  assert.equal(steer.delivered, "run");
  assert.ok(sent.some((s) => s.chatId === a && s.intent === "steer"));
  // both finish close together → a single parent wake mentioning both
  gates.get(a)();
  gates.get(b)();
  assert.ok(await until(() => sent.filter((s) => s.chatId === parent.id).length === 1));
  await new Promise((r) => setTimeout(r, 80));
  const wakes = sent.filter((s) => s.chatId === parent.id);
  assert.equal(wakes.length, 1);
  assert.match(wakes[0].text, new RegExp(a));
  assert.match(wakes[0].text, new RegExp(b));
  assert.ok((await tool.execute({ action: "get", id: "nope" })).isError);
});

test("delegate keeps loop guard and unknown-agent checks", async () => {
  const { store, peers } = setup();
  const parent = store.createChat({ title: "p", agent: "griffin" });
  const d = peers.delegateTool(parent.id);
  assert.ok((await d.execute({ agent: "griffin", request: "x" })).isError);
  assert.ok((await d.execute({ agent: "nope", request: "x" })).isError);
  const child = store.createChat({ title: "c", agent: "platform", parentChatId: parent.id, callChain: ["griffin"] });
  const loop = await peers.delegateTool(child.id).execute({ agent: "griffin", request: "x" });
  assert.ok(loop.isError);
  assert.match(loop.content[0].text, /loop/);
});

test("peer task stays working until delegated work is reported and answered", async () => {
  const { store, runner, peers, scripts } = setup();
  const asks = createAsks({ store });
  const tasks = createPeerTasks({ store, runner, asks, pendingWork: (id) => peers.pendingDelegates(id) });
  const peer = { userId: "u1", caller: "peer:u1", label: "u1" };
  store.updateAgentProfile("griffin", { meta: { callers: { "peer:u1": { tools: ["delegate"] } } } });
  // The peer's griffin chat: first run delegates and ends; the wake run writes the answer.
  const origCreate = store.createChat.bind(store);
  store.createChat = (opts) => {
    const chat = origCreate(opts);
    if (opts.caller === "peer:u1") {
      let turn = 0;
      scripts.set(chat.id, async (emit) => {
        turn += 1;
        if (turn === 1) {
          await peers.delegateTool(chat.id).execute({ agent: "platform", request: "دیسک" });
          emit("text", { text: "به پلتفرم‌بان سپردم. " });
        } else emit("text", { text: "۳۷۰G آزاد" });
      });
    }
    return chat;
  };
  const first = await tasks.send(peer, { message: "دیسک؟", waitSec: 0 });
  let snap = first;
  for (let i = 0; i < 20 && snap.state !== "completed"; i += 1) snap = await tasks.wait(peer, { taskId: first.taskId, afterSeq: snap.seq, waitSec: 1 });
  assert.equal(snap.state, "completed");
  const full = await tasks.wait(peer, { taskId: first.taskId, waitSec: 0 });
  assert.match(full.answer, /سپردم/);
  assert.match(full.answer, /۳۷۰G آزاد/);
});

test("a run ending does not cancel delegated subtasks; an explicit cancel does", async () => {
  const { store, peers, runner, scripts, gates } = setup();
  const cancelled = [];
  runner.cancel = async (id) => { cancelled.push(id); return { status: "cancelling" }; };
  const parent = store.createChat({ title: "p", agent: "griffin" });
  const origCreate = store.createChat.bind(store);
  store.createChat = (opts) => {
    const chat = origCreate(opts);
    scripts.set(chat.id, () => new Promise((resolve) => gates.set(chat.id, resolve)));
    return chat;
  };
  const child = JSON.parse((await peers.delegateTool(parent.id).execute({ agent: "platform", request: "x" })).content[0].text).subtask;
  await peers.cancelChildren(parent.id); // what every run end does
  assert.deepEqual(cancelled, []);
  await peers.cancelChildren(parent.id, { includeDelegates: true }); // user pressed stop
  assert.deepEqual(cancelled, [child]);
  gates.get(child)("cancelled");
});

test("an identical ask_agent / delegate already in flight is joined, not run twice", async () => {
  const { store, peers, scripts, gates } = setup();
  const parent = store.createChat({ title: "p", agent: "griffin" });
  const origCreate = store.createChat.bind(store);
  let children = 0;
  store.createChat = (opts) => {
    const chat = origCreate(opts);
    if (opts.parentChatId) {
      children += 1;
      scripts.set(chat.id, (emit) => new Promise((resolve) => gates.set(chat.id, () => { emit("text", { text: "yes" }); resolve("finished"); })));
    }
    return chat;
  };
  const ask = peers.tool(parent.id);
  const a = ask.execute({ agent: "platform", request: "دسترسی داری؟" });
  const b = ask.execute({ agent: "platform", request: "دسترسی داری؟" });
  await until(() => gates.size === 1);
  [...gates.values()][0]();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(children, 1);
  assert.equal(ra, rb);
  const d = peers.delegateTool(parent.id);
  const first = JSON.parse((await d.execute({ agent: "arvan-ban", request: "کش" })).content[0].text);
  const second = JSON.parse((await d.execute({ agent: "arvan-ban", request: "کش" })).content[0].text);
  assert.equal(second.subtask, first.subtask);
  assert.equal(children, 2);
});
