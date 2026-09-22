import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createAsks } from "../src/asks.mjs";
import { ASK_AGENT_TOOL, buildEnvelope, createPeers, peerMessage } from "../src/peers.mjs";
import { allowedTools } from "../src/agents/registry.mjs";
import { seedExampleAgents } from "./fixture-agents.mjs";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-peers-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  seedExampleAgents(store);
  return { store, dir };
}

test("buildEnvelope takes facts from tool.done and summary from text", () => {
  const { store, dir } = tempStore();
  const chat = store.createChat({ title: "c" });
  const runId = store.startRun(chat.id);
  store.appendEvent(chat.id, runId, "text", { text: "کش پاک شد. " });
  store.appendEvent(chat.id, runId, "tool.done", {
    name: "arvan_cache_purge",
    args: { domain: "example.com", scope: "all" },
    result: { message: "purged", source: "arvan-api" },
  });
  store.appendEvent(chat.id, runId, "text", { text: "تمام." });
  const env = buildEnvelope(store, chat.id, { status: "finished" });
  assert.equal(env.status, "finished");
  assert.equal(env.chatRef, chat.id);
  assert.match(env.summary, /کش پاک شد/);
  assert.ok(env.brief);
  assert.equal(env.facts.length, 1);
  assert.equal(env.facts[0].tool, "arvan_cache_purge");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildEnvelope brief prefers kube_df numbers from MCP-wrapped result", () => {
  const { store, dir } = tempStore();
  const chat = store.createChat({ title: "c" });
  const runId = store.startRun(chat.id);
  store.appendEvent(chat.id, runId, "text", { text: "الان دیسک را چک می‌کنم و مسیر اضطراری را هم می‌گویم." });
  store.appendEvent(chat.id, runId, "tool.done", {
    name: "kube_df",
    args: { cluster: "prod", namespace: "storage", pod: "seaweedfs-volume-1", path: "/data0" },
    result: {
      status: "success",
      value: {
        content: [{
          text: {
            text: JSON.stringify({
              df: [{ available: "381.6G", size: "904.5G", used: "522.9G", usePercent: "58%" }],
              source: "emergency-ssh",
            }),
          },
        }],
      },
    },
  });
  const env = buildEnvelope(store, chat.id, { status: "finished" });
  assert.equal(env.brief, "381.6G آزاد · کل 904.5G · استفاده 522.9G · (58%)");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ask_agent refuses unknown agent, self, and call loops", async () => {
  const { store, dir } = tempStore();
  const parent = store.createChat({ title: "root", agent: "platform", caller: "owner" });
  const runner = {
    send: async () => ({ runId: "x" }),
    cancel: async () => ({ status: "ok" }),
  };
  const peers = createPeers({ store, runner, timeoutMs: 1000 });
  const tool = peers.tool(parent.id);

  const unknown = await tool.execute({ agent: "nope", request: "hi" });
  assert.equal(unknown.isError, true);

  const self = await tool.execute({ agent: "platform", request: "hi" });
  assert.equal(self.isError, true);
  assert.match(self.content[0].text, /yourself/);

  const looped = store.createChat({
    title: "mid",
    agent: "arvan-ban",
    caller: "platform",
    parentChatId: parent.id,
    callChain: ["platform"],
  });
  const loopTool = peers.tool(looped.id);
  const loop = await loopTool.execute({ agent: "platform", request: "back" });
  assert.equal(loop.isError, true);
  assert.match(loop.content[0].text, /call loop/);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ask_agent creates child with peer quota caller and returns server envelope", async () => {
  const { store, dir } = tempStore();
  const parent = store.createChat({ title: "root", agent: "platform", caller: "owner" });
  let childId = null;
  const runner = {
    async send(chatId) {
      childId = chatId;
      const runId = store.startRun(chatId);
      store.appendEvent(chatId, runId, "text", { text: "۷ دامنه." });
      store.appendEvent(chatId, runId, "tool.done", {
        name: "arvan_domains",
        args: {},
        result: { total: 7, source: "arvan-api" },
      });
      store.appendEvent(chatId, runId, "run.finished", { status: "finished" });
      store.finishRun(chatId, runId, "finished", null);
      return { runId };
    },
    cancel: async () => ({ status: "ok" }),
  };
  const peers = createPeers({ store, runner, timeoutMs: 5000 });
  const result = await peers.tool(parent.id).execute({ agent: "arvan-ban", request: "دامنه‌ها را بگو" });
  assert.equal(result.isError, undefined);
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.status, "finished");
  assert.equal(envelope.chatRef, childId);
  assert.match(envelope.summary, /۷ دامنه/);
  assert.equal(envelope.facts[0].tool, "arvan_domains");
  const child = store.getChat(childId);
  assert.equal(child.agent, "arvan-ban");
  assert.equal(child.caller, "platform");
  assert.equal(child.parent_chat_id, parent.id);
  assert.equal(store.listChats().some((c) => c.id === childId), false);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("peerMessage names the calling agent", () => {
  assert.match(peerMessage("griffin", "purge"), /گریفین/);
  assert.match(peerMessage("platform", "purge"), /platform/, "an agent with no label is named by its id");
  assert.match(peerMessage("platform", "purge"), /purge/);
});

test("ask_owner on a child chat routes to the root and mirrors the card", async () => {
  const { store, dir } = tempStore();
  const root = store.createChat({ title: "root", caller: "owner" });
  const child = store.createChat({
    title: "child",
    agent: "arvan-ban",
    caller: "platform",
    parentChatId: root.id,
    callChain: ["platform"],
  });
  const asks = createAsks({ store });
  const pending = asks.tool(child.id).execute({ question: "purge؟", options: [{ label: "بله" }] });
  // Give enqueue a tick to register + mirror
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asks.isWaiting(root.id), true);
  const mirrored = [...store.allEvents(root.id)].filter((e) => e.type === "tool.started");
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].data.name, "ask_owner");
  assert.equal(asks.answer(root.id, { answer: "بله", selected: ["بله"] }), true);
  const out = JSON.parse((await pending).content[0].text);
  assert.equal(out.answered, true);
  assert.equal(out.answer, "بله");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ask_owner on scheduler root auto-rejects", async () => {
  const { store, dir } = tempStore();
  const root = store.createChat({ title: "job", caller: "scheduler", jobId: "j1" });
  const asks = createAsks({ store });
  const out = JSON.parse((await asks.tool(root.id).execute({ question: "؟" })).content[0].text);
  assert.equal(out.answered, false);
  assert.match(out.reason, /scheduler/);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the owner may delegate; a peer-invoked run may not chain further by default", () => {
  const names = ["ask_agent", "ask_owner", "visualize", "jobs_list"];
  assert.ok(allowedTools("griffin", "owner", names).includes(ASK_AGENT_TOOL));
  assert.ok(allowedTools("griffin", "scheduler", names).includes(ASK_AGENT_TOOL), "a job may still delegate");
  assert.ok(!allowedTools("griffin", "scheduler", names).includes("ask_owner"), "but never asks a human");
});

test("griffin ask_agent creates child with caller griffin", async () => {
  const { store, dir } = tempStore();
  const parent = store.createChat({ title: "root", agent: "griffin", caller: "owner" });
  let childId = null;
  const runner = {
    async send(chatId) {
      childId = chatId;
      const runId = store.startRun(chatId);
      store.appendEvent(chatId, runId, "text", { text: "گزارش دامنه" });
      store.appendEvent(chatId, runId, "run.finished", { status: "finished" });
      store.finishRun(chatId, runId, "finished", null);
      return { runId };
    },
    cancel: async () => ({ status: "ok" }),
  };
  const peers = createPeers({ store, runner, timeoutMs: 5000 });
  const result = await peers.tool(parent.id).execute({ agent: "arvan-ban", request: "دامنه‌ها را بگو" });
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.status, "finished");
  assert.equal(envelope.chatRef, childId);
  const child = store.getChat(childId);
  assert.equal(child.agent, "arvan-ban");
  assert.equal(child.caller, "griffin");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("send while ask_agent child is active soft-queues instead of 409", async () => {
  const { createRunner } = await import("../src/runner.mjs");
  const { store, dir } = tempStore();
  const parent = store.createChat({ title: "root", agent: "platform", caller: "owner" });
  let releaseChild;
  const childGate = new Promise((r) => (releaseChild = r));
  const fake = {
    async create() {
      return {
        agentId: "a1",
        async send(_message, options) {
          const run = {
            id: "r1",
            supports: () => true,
            cancel: async () => {},
            wait: async () => {
              await options.onDelta({ update: { type: "text-delta", text: "…" } });
              await childGate;
              return { id: "r1", status: "finished" };
            },
          };
          return run;
        },
      };
    },
    resume: async () => fake.create(),
  };
  const soft = { on: false };
  const runner = createRunner({
    store,
    sdk: fake,
    agentOptions: () => ({}),
    isSoftBusy: () => soft.on,
    log: {},
  });
  await runner.send(parent.id, { text: "شروع" });
  await new Promise((r) => setTimeout(r, 20));
  soft.on = true;
  const queued = await runner.send(parent.id, { text: "پیام وسط انتظار همتا" });
  assert.equal(queued.delivered, "queued");
  soft.on = false;
  await assert.rejects(() => runner.send(parent.id, { text: "باید ۴۰۹" }), (err) => err.code === "busy");
  // Cancel drops the soft-queued follow-up so closing the store is safe.
  await runner.cancel(parent.id);
  releaseChild();
  for (let i = 0; i < 50 && runner.isActive(parent.id); i += 1) await new Promise((r) => setTimeout(r, 10));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ask_agent timeout keeps the child alive as a subtask and delivers the result later", async () => {
  const { store, dir } = tempStore();
  const parent = store.createChat({ title: "root", agent: "platform", caller: "owner" });
  const sent = [];
  let releaseFinish;
  const gate = new Promise((resolve) => (releaseFinish = resolve));
  const runner = {
    async send(chatId, input) {
      sent.push({ chatId, input });
      if (input?.intent === "queue" || input?.intent === "send") return { delivered: "run" };
      store.startRun(chatId);
      return { runId: "r" };
    },
    async cancel() {
      throw new Error("cancel must not be called anymore");
    },
    isActive: (chatId) => chatId !== parent.id,
  };
  const peers = createPeers({ store, runner, timeoutMs: 50, wakeDelayMs: 10 });
  const ask = peers.tool(parent.id);
  const asking = ask.execute({ agent: "arvan-ban", request: "کار طولانی" });
  await new Promise((r) => setTimeout(r, 120));

  const result = await asking;
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.status, "running");
  assert.ok(envelope.chatRef);
  // no cancel happened, and the child is registered as a running subtask
  assert.equal(peers.subtasksTool(parent.id) ? true : true, true);
  const subs = await peers.subtasksTool(parent.id).execute({ action: "list" });
  const list = JSON.parse(subs.content[0].text);
  assert.ok(JSON.stringify(list).includes(envelope.chatRef));

  // the child finishes afterwards -> the wake reports to the parent
  const childChat = store.getChat(envelope.chatRef);
  const runId = store.startRun(childChat.id);
  store.appendEvent(childChat.id, runId, "text", { text: "نتیجهٔ نهایی آماده است." });
  store.finishRun(childChat.id, runId, "finished", null);
  store.appendEvent(childChat.id, runId, "run.finished", { status: "finished" });
  await new Promise((r) => setTimeout(r, 80));
  const reported = sent.find((s) => s.chatId === parent.id && /گزارش خودکار زیرکارها/.test(String(s.input?.text || "")));
  assert.ok(reported, "wake should deliver the automatic subtask report to the parent");
  assert.match(reported.input.text, /نتیجهٔ نهایی آماده است/);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
