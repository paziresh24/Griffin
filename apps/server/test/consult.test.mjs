import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";
import {
  CONSULT_WITHHELD,
  CONSULT_MAX_PER_HOUR,
  CONSULT_MAX_RUNNING,
  CONSULT_MAX_PER_HOUR_ALL,
  consultCandidates,
  consultOf,
  createPeers,
  resolveConsultAccounts,
} from "../src/peers.mjs";
import { FORWARDING_TOOLS, lastHop, thirdPartyKey } from "../src/related.mjs";
import { simulateTools } from "../src/sim.mjs";
import { APP_TOOL_NAMES } from "../src/agents/profiles.mjs";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-consult-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  return { store, dir, done: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const parse = (result) => JSON.parse(result.content[0].text);

// A runner whose child runs answer at once: one run per send, labelled with the pinned account.
function answeringRunner(store, { reply = () => "جواب.", parentRunId = "run-parent" } = {}) {
  const sent = [];
  const cancelled = [];
  return {
    sent,
    cancelled,
    async send(chatId, input) {
      sent.push({ chatId, input });
      const chat = store.getChat(chatId);
      const [provider, model] = String(chat.model).split(/:(.*)/s);
      const runId = store.startRun(chatId);
      store.appendEvent(chatId, runId, "run.started", { provider, model });
      store.appendEvent(chatId, runId, "text", { text: "اول این را می‌خوانم. " });
      store.appendEvent(chatId, runId, "tool.done", { name: "read_file", args: {}, result: "x" });
      store.appendEvent(chatId, runId, "text", { text: reply(chatId, input) });
      store.appendEvent(chatId, runId, "run.finished", { status: "finished" });
      store.finishRun(chatId, runId, "finished", null);
      return { runId, delivered: "run" };
    },
    async cancel(chatId) {
      cancelled.push(chatId);
    },
    isActive: () => false,
    runIdOf: () => parentRunId,
  };
}

const twoClaudes = async (provider, model) => resolveConsultAccounts({
  provider,
  model,
  accounts: [{ id: "cursor", kind: "cursor" }, { id: "claude", kind: "claude" }, { id: "claude-2", kind: "claude" }, { id: "openai", kind: "openai" }],
});

test("consult runs the asked model in a sub-chat of the asking chat and returns its final answer", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "کار اصلی", agent: "griffin", caller: "owner", mode: "plan" });
  const runner = answeringRunner(store, { reply: () => "به نظرم مسیر دوم امن‌تر است، چون برگشت‌پذیر است." });
  const peers = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5 });
  const result = parse(await peers.consultTool(parent.id).execute({ provider: "claude", model: "claude-opus-4-7", prompt: "کدام مسیر؟" }));

  assert.equal(result.state, "finished");
  assert.equal(result.from, "claude:claude-opus-4-7");
  // The text after the last tool call is the answer, not the narration before it.
  assert.equal(result.answer, "به نظرم مسیر دوم امن‌تر است، چون برگشت‌پذیر است.");
  const child = store.getChat(result.consultId);
  assert.equal(child.parent_chat_id, parent.id);
  assert.equal(child.agent, "griffin");
  assert.equal(child.caller, "owner");
  assert.equal(child.mode, "plan");
  assert.equal(child.model, "claude:claude-opus-4-7");
  // Every usable account of that kind is a fallback, the named one first.
  assert.deepEqual(consultOf(store, child.id), { from: parent.id, accounts: ["claude", "claude-2"], model: "claude-opus-4-7" });
  assert.match(runner.sent[0].input.text, /مشورت از چتِ «کار اصلی»/);
  assert.match(runner.sent[0].input.text, /کدام مسیر؟$/);
  // Not a top-level chat: it does not show up in the sidebar list.
  assert.equal(store.listChats().some((c) => c.id === child.id), false);
  done();
});

test("a consult's engine candidates are its accounts on the asked model, nothing else", () => {
  const row = { from: "p", accounts: ["claude", "claude-2"], model: "claude-opus-4-7" };
  assert.deepEqual(consultCandidates(row), [
    { provider: "claude", model: "claude-opus-4-7" },
    { provider: "claude-2", model: "claude-opus-4-7" },
  ]);
  assert.deepEqual(consultCandidates(row, { usable: (id) => id !== "claude" }), [{ provider: "claude-2", model: "claude-opus-4-7" }]);
  assert.deepEqual(consultCandidates(null), []);
});

test("resolveConsultAccounts: named account first, a limited one skipped, another openai vendor only when it lists the model", async () => {
  const accounts = [
    { id: "cursor", kind: "cursor" },
    { id: "claude", kind: "claude" },
    { id: "claude-2", kind: "claude" },
    { id: "openai", kind: "openai" },
    { id: "openai-openrouter", kind: "openai" },
  ];
  assert.deepEqual((await resolveConsultAccounts({ provider: "claude-2", model: "m", accounts })).accounts, ["claude-2", "claude"]);
  const limited = await resolveConsultAccounts({ provider: "claude", model: "m", accounts, check: async (id) => (id === "claude" ? "at its plan limit" : null) });
  assert.deepEqual(limited.accounts, ["claude-2"]);
  const none = await resolveConsultAccounts({ provider: "claude", model: "m", accounts, check: async () => "turned off" });
  assert.equal(none.accounts, undefined);
  assert.match(none.error, /turned off/);
  const glm = await resolveConsultAccounts({ provider: "openai", model: "glm-5.3", accounts, lists: async () => false });
  assert.deepEqual(glm.accounts, ["openai"]);
  const both = await resolveConsultAccounts({ provider: "openai", model: "glm-5.3", accounts, lists: async (id) => id === "openai-openrouter" });
  assert.deepEqual(both.accounts, ["openai", "openai-openrouter"]);
  assert.match((await resolveConsultAccounts({ provider: "gemini", model: "x", accounts })).error, /unknown engine account/);
});

test("consult reports the account that actually answered after a plan-limit fallback", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  const runner = answeringRunner(store);
  const send = runner.send;
  runner.send = async (chatId, input) => {
    // First run hits the plan limit on claude; the runner retries on the next candidate.
    const runId = store.startRun(chatId);
    store.appendEvent(chatId, runId, "run.started", { provider: "claude", model: "claude-opus-4-7" });
    store.appendEvent(chatId, runId, "run.finished", { status: "error", error: "plan limit" });
    store.finishRun(chatId, runId, "error", "plan limit");
    store.updateChat(chatId, { model: "claude-2:claude-opus-4-7" });
    return send(chatId, input);
  };
  const peers = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5 });
  const result = parse(await peers.consultTool(parent.id).execute({ provider: "claude", model: "claude-opus-4-7", prompt: "q" }));
  assert.equal(result.state, "finished");
  assert.equal(result.from, "claude-2:claude-opus-4-7");
  done();
});

test("consult is refused outside the owner's own top-level chats and with no usable account", async () => {
  const { store, done } = tempStore();
  const runner = answeringRunner(store);
  const peers = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5 });
  const owner = store.createChat({ title: "o", agent: "griffin", caller: "owner" });
  const child = store.createChat({ title: "c", agent: "platform", caller: "griffin", parentChatId: owner.id });
  const peer = store.createChat({ title: "peer", agent: "griffin", caller: "peer:acme" });
  const side = store.createChat({ title: "s", agent: "griffin", caller: "owner", sideOf: owner.id });
  const args = { provider: "claude", model: "claude-opus-4-7", prompt: "q" };
  for (const chat of [child, peer, side]) {
    const result = await peers.consultTool(chat.id).execute(args);
    assert.equal(result.isError, true, chat.title);
  }
  const unknown = await peers.consultTool(owner.id).execute({ ...args, provider: "gemini" });
  assert.equal(unknown.isError, true);
  assert.match(parse(unknown).error, /unknown engine account/);
  const long = await peers.consultTool(owner.id).execute({ ...args, prompt: "x".repeat(4001) });
  assert.equal(long.isError, true);
  assert.equal(runner.sent.length, 0);
  done();
});

test("consult is capped per chat per hour", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  const runner = answeringRunner(store);
  const peers = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5 });
  const tool = peers.consultTool(parent.id);
  for (let i = 0; i < CONSULT_MAX_PER_HOUR; i += 1) {
    assert.equal(parse(await tool.execute({ provider: "claude", model: "m", prompt: `q${i}` })).state, "finished");
  }
  const over = await tool.execute({ provider: "claude", model: "m", prompt: "one more" });
  assert.equal(over.isError, true);
  assert.match(parse(over).error, /consulted 6 times/);
  done();
});

test("a consult over its time limit is cancelled and says so; so is one whose asking run ended", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  const active = new Set();
  let parentRun = "r1";
  const cancelled = [];
  const runner = {
    async send(chatId) {
      store.startRun(chatId);
      active.add(chatId);
      return { delivered: "run" };
    },
    async cancel(chatId) {
      cancelled.push(chatId);
      active.delete(chatId);
    },
    isActive: (chatId) => active.has(chatId),
    runIdOf: () => parentRun,
  };
  const slow = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5, consultTimeoutMs: 40 });
  const timedOut = parse(await slow.consultTool(parent.id).execute({ provider: "claude", model: "m", prompt: "q" }));
  assert.equal(timedOut.state, "failed");
  assert.match(timedOut.error, /time limit/);
  assert.deepEqual(cancelled, [timedOut.consultId]);

  const peers = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5, consultTimeoutMs: 60_000 });
  const pending = peers.consultTool(parent.id).execute({ provider: "claude", model: "m", prompt: "q2" });
  setTimeout(() => { parentRun = "r2"; }, 30);
  const stopped = parse(await pending);
  assert.equal(stopped.state, "failed");
  assert.match(stopped.error, /asking chat stopped/);
  assert.equal(cancelled.at(-1), stopped.consultId);
  done();
});

test("parallel consult calls cannot pass the caps together", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  const active = new Set();
  const runner = {
    async send(chatId) { store.startRun(chatId); active.add(chatId); return { delivered: "run" }; },
    async cancel(chatId) { active.delete(chatId); },
    isActive: (chatId) => active.has(chatId),
    runIdOf: () => "r",
  };
  // The account lookup is async (model lists): every call is in flight before any child exists.
  const slowAccounts = async (provider, model) => { await new Promise((r) => setTimeout(r, 20)); return twoClaudes(provider, model); };
  const peers = createPeers({ store, runner, consultAccounts: slowAccounts, consultPollMs: 5, consultTimeoutMs: 60 });
  const tool = peers.consultTool(parent.id);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => tool.execute({ provider: "claude", model: "m", prompt: `q${i}` })));
  const started = results.filter((r) => !r.isError);
  assert.equal(started.length, CONSULT_MAX_RUNNING);
  // The refused calls gave nothing back to the hourly count beyond what really ran.
  const later = await Promise.all(Array.from({ length: 10 }, (_, i) => tool.execute({ provider: "claude", model: "m", prompt: `r${i}` })));
  assert.equal(later.filter((r) => !r.isError).length, CONSULT_MAX_RUNNING);
  for (let i = 0; i < 4; i += 1) await tool.execute({ provider: "claude", model: "m", prompt: `s${i}` });
  const over = await tool.execute({ provider: "claude", model: "m", prompt: "over" });
  assert.match(parse(over).error, /consulted 6 times/);
  done();
});

test("an account refusal gives the hourly slot back", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  const runner = answeringRunner(store);
  const peers = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5 });
  const tool = peers.consultTool(parent.id);
  for (let i = 0; i < 10; i += 1) assert.equal((await tool.execute({ provider: "gemini", model: "m", prompt: "q" })).isError, true);
  assert.equal(parse(await tool.execute({ provider: "claude", model: "m", prompt: "q" })).state, "finished");
  done();
});

test("a consult cannot hand work on, and its effort is the asking chat's", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  store.updateChat(parent.id, { effort: "high" });
  const runner = answeringRunner(store);
  const peers = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5 });
  const result = parse(await peers.consultTool(parent.id).execute({ provider: "claude", model: "m", prompt: "q" }));
  assert.equal(store.getChat(result.consultId).effort, "high");
  for (const name of ["ask_agent", "delegate", "subtasks", "consult"]) assert.ok(CONSULT_WITHHELD.includes(name), name);
  const handed = await peers.delegateTool(result.consultId).execute({ agent: "arvan-ban", request: "x" });
  assert.equal(handed.isError, true);
  const asked = await peers.tool(result.consultId).execute({ agent: "arvan-ban", request: "x" });
  assert.equal(asked.isError, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chats WHERE parent_chat_id = ?").get(result.consultId).n, 0);
  done();
});

test("a consult cut by a crash is not continued after the restart; its asking chat is", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-consult-resume-"));
  const file = path.join(dir, "db.sqlite");
  const store = openStore(file);
  const hanging = () => {
    const sent = [];
    const agent = {
      agentId: "a1",
      async send(message) {
        sent.push(typeof message === "string" ? message : message.text);
        return { id: `s${sent.length}`, supports: () => true, async cancel() {}, wait: () => new Promise(() => {}) };
      },
      close() {},
    };
    return { sent, sdk: { async create() { return agent; }, async resume() { return agent; } } };
  };
  const log = { error() {}, info() {} };
  const first = hanging();
  const runner = createRunner({ store, sdk: first.sdk, agentOptions: async () => ({}), log });
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  const child = store.createChat({ title: "c", agent: "griffin", caller: "owner", parentChatId: parent.id });
  store.setKv(`consult:${child.id}`, { from: parent.id, accounts: ["claude"], model: "m" });
  await runner.send(parent.id, { text: "parent work" });
  await runner.send(child.id, { text: "consult work" });
  const until = async (check) => { const end = Date.now() + 2000; while (Date.now() < end && !check()) await new Promise((r) => setTimeout(r, 5)); };
  await until(() => first.sent.length === 2);
  store.close(); // the process dies

  const reopened = openStore(file);
  const second = hanging();
  createRunner({ store: reopened, sdk: second.sdk, agentOptions: async () => ({}), log, resumeGapMs: 0, notResumable: (chat) => Boolean(consultOf(reopened, chat.id)) });
  await until(() => reopened.getKv("resume:pending") === null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(second.sent.length, 1, "only the asking chat continues");
  assert.match(second.sent[0], /parent work/);
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no more than two consults of one chat run at once", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  const active = new Set();
  const runner = {
    async send(chatId) { store.startRun(chatId); active.add(chatId); return { delivered: "run" }; },
    async cancel(chatId) { active.delete(chatId); },
    isActive: (chatId) => active.has(chatId),
    runIdOf: () => "r",
  };
  const peers = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5, consultTimeoutMs: 200 });
  const tool = peers.consultTool(parent.id);
  const first = tool.execute({ provider: "claude", model: "m", prompt: "a" });
  const second = tool.execute({ provider: "claude", model: "m", prompt: "b" });
  await new Promise((r) => setTimeout(r, 20));
  const third = await tool.execute({ provider: "claude", model: "m", prompt: "c" });
  assert.equal(third.isError, true);
  assert.match(parse(third).error, new RegExp(`${CONSULT_MAX_RUNNING} consults of this chat are still running`));
  await Promise.all([first, second]);
  assert.equal(peers.hasChildren(parent.id), false);
  done();
});

test("a chat holding a colleague's text cannot consult, a rehearsal records it, and the owner's tool list has it", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  let calls = 0;
  assert.ok(FORWARDING_TOOLS.includes("consult"));
  store.setKv(thirdPartyKey(parent.id), { from: "peer:acme" });
  const wrapped = lastHop({ consult: { execute: async () => { calls += 1; return {}; } } }, { store, chatId: parent.id });
  const refused = await wrapped.consult.execute({});
  assert.equal(refused.isError, true);
  assert.equal(calls, 0);
  const sim = simulateTools({ consult: { execute: async () => { calls += 1; return {}; } } });
  await sim.consult.execute({ provider: "claude", model: "m", prompt: "q" });
  assert.equal(calls, 0);
  assert.ok(APP_TOOL_NAMES.includes("consult"));
  done();
});

// Consult hardening.
test("the prompt sent to the other model is redacted", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  const runner = answeringRunner(store);
  const peers = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5 });
  const secret = "glpat-" + "Ab3dEf6hIj9kLm2nOp5q";
  const result = parse(await peers.consultTool(parent.id).execute({ provider: "claude", model: "m", prompt: `این توکن کار نمی‌کند: ${secret} و password=hunter2hunter2` }));
  assert.equal(result.state, "finished");
  const text = runner.sent[0].input.text;
  assert.ok(!text.includes(secret), "the GitLab token does not leave for the other model");
  assert.ok(!text.includes("hunter2hunter2"), "a password assignment does not either");
  assert.ok(!JSON.stringify([...store.allEvents(result.consultId)]).includes(secret), "nor is it stored raw in the consult chat");
  done();
});

test("a consult has no way to the owner or out of the chat: ask_owner, owner_task, Telegram and other senders are withheld", () => {
  for (const name of ["ask_owner", "ask_requester", "owner_task", "telegram_send", "chat_send", "tell_person", "thread_join", "telegram_pause", "send_to_person", "jobs_create", "jobs_run", "agent_settings_set", "chat_suggest", "knowledge_write"]) {
    assert.ok(CONSULT_WITHHELD.includes(name), name);
  }
});

test("consult is refused in the Telegram global chat and in a chat linked to Telegram", async () => {
  const { store, done } = tempStore();
  const runner = answeringRunner(store);
  const peers = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5 });
  const args = { provider: "claude", model: "m", prompt: "q" };
  const global = store.createChat({ title: "global", agent: "griffin", caller: "owner" });
  store.setKv("tg:global", global.id);
  const linked = store.createChat({ title: "linked", agent: "griffin", caller: "owner" });
  const integration = store.createIntegration({ kind: "telegram_bot", name: "bot", secret: "{}", settings: {} });
  store.linkChat(integration.id, "1001", linked.id);
  for (const chat of [global, linked]) {
    const result = await peers.consultTool(chat.id).execute(args);
    assert.equal(result.isError, true, chat.title);
    assert.match(parse(result).error, /Telegram/);
  }
  assert.equal(runner.sent.length, 0);
  done();
});

test("the same consult asked twice at once runs once and both calls get its answer", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  const runner = answeringRunner(store);
  const slowAccounts = async (provider, model) => { await new Promise((r) => setTimeout(r, 20)); return twoClaudes(provider, model); };
  const peers = createPeers({ store, runner, consultAccounts: slowAccounts, consultPollMs: 5 });
  const args = { provider: "claude", model: "m", prompt: "کدام؟" };
  const [a, b] = await Promise.all([peers.consultTool(parent.id).execute(args), peers.consultTool(parent.id).execute({ ...args, prompt: " کدام؟ " })]);
  assert.equal(runner.sent.length, 1);
  assert.equal(parse(a).consultId, parse(b).consultId);
  // Only spacing differs: still the same consult.
  await Promise.all([peers.consultTool(parent.id).execute({ ...args, prompt: "یک  دو" }), peers.consultTool(parent.id).execute({ ...args, prompt: "یک دو" })]);
  assert.equal(runner.sent.length, 2);
  // A different prompt is a different consult.
  await peers.consultTool(parent.id).execute({ ...args, prompt: "دیگری" });
  assert.equal(runner.sent.length, 3);
  done();
});

test("a consult that failed before any output leaves no kept message to retry", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  const base = answeringRunner(store);
  const runner = { ...base, async send(chatId, input) { const out = await base.send(chatId, input); store.setKv(`kept:${chatId}`, [{ id: "k1", message: "x", ids: [] }]); return out; } };
  const peers = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5 });
  const result = parse(await peers.consultTool(parent.id).execute({ provider: "claude", model: "m", prompt: "q" }));
  assert.equal(store.getKv(`kept:${result.consultId}`), null);
  done();
});

test("the hourly consult caps survive a restart: they are kept in the database", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  const runner = answeringRunner(store);
  const before = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5 });
  for (let i = 0; i < CONSULT_MAX_PER_HOUR; i += 1) {
    assert.equal(parse(await before.consultTool(parent.id).execute({ provider: "claude", model: "m", prompt: `q${i}` })).state, "finished");
  }
  // A new server process on the same database.
  const after = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5 });
  const over = await after.consultTool(parent.id).execute({ provider: "claude", model: "m", prompt: "after restart" });
  assert.equal(over.isError, true);
  assert.match(parse(over).error, /consulted 6 times/);
  // The all-chats cap too: fill it from other chats, restart, and one more is refused.
  let i = 0;
  while (i < CONSULT_MAX_PER_HOUR_ALL - CONSULT_MAX_PER_HOUR) {
    const other = store.createChat({ title: `o${i}`, agent: "griffin", caller: "owner" });
    for (let k = 0; k < CONSULT_MAX_PER_HOUR && i < CONSULT_MAX_PER_HOUR_ALL - CONSULT_MAX_PER_HOUR; k += 1, i += 1) {
      assert.equal(parse(await after.consultTool(other.id).execute({ provider: "claude", model: "m", prompt: `o${i}` })).state, "finished");
    }
  }
  const third = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5 });
  const fresh = store.createChat({ title: "fresh", agent: "griffin", caller: "owner" });
  const all = await third.consultTool(fresh.id).execute({ provider: "claude", model: "m", prompt: "one more" });
  assert.equal(all.isError, true);
  assert.match(parse(all).error, new RegExp(`consulted ${CONSULT_MAX_PER_HOUR_ALL} times`));
  // An hour later the slots are free again.
  const later = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5, now: () => new Date(Date.now() + 3_600_001) });
  assert.equal(parse(await later.consultTool(parent.id).execute({ provider: "claude", model: "m", prompt: "next hour" })).state, "finished");
  done();
});

test("no more than four consults run at once across all the owner's chats", async () => {
  const { store, done } = tempStore();
  const active = new Set();
  const runner = {
    async send(chatId) { store.startRun(chatId); active.add(chatId); return { delivered: "run" }; },
    async cancel(chatId) { active.delete(chatId); },
    isActive: (chatId) => active.has(chatId),
    runIdOf: () => "r",
  };
  const peers = createPeers({ store, runner, consultAccounts: twoClaudes, consultPollMs: 5, consultTimeoutMs: 300 });
  const chats = Array.from({ length: 3 }, (_, i) => store.createChat({ title: `c${i}`, agent: "griffin", caller: "owner" }));
  const running = [];
  for (const chat of chats.slice(0, 2)) {
    for (const p of ["a", "b"]) running.push(peers.consultTool(chat.id).execute({ provider: "claude", model: "m", prompt: p }));
  }
  await new Promise((r) => setTimeout(r, 30));
  const fifth = await peers.consultTool(chats[2].id).execute({ provider: "claude", model: "m", prompt: "e" });
  assert.equal(fifth.isError, true);
  assert.match(parse(fifth).error, /4 consults are already running across the owner's chats/);
  await Promise.all(running);
  // Once they ended, the third chat may consult.
  const next = await peers.consultTool(chats[2].id).execute({ provider: "claude", model: "m", prompt: "f" });
  assert.equal(next.isError, undefined, String(parse(next).error || ""));
  assert.equal(parse(next).consultId !== undefined, true);
  done();
});

test("a consult whose account lookup throws at once gives its hourly slot back", async () => {
  const { store, done } = tempStore();
  const parent = store.createChat({ title: "p", agent: "griffin", caller: "owner" });
  const runner = answeringRunner(store);
  let throwNow = true;
  const accounts = (provider, model) => {
    if (throwNow) throw new Error("registry down");
    return twoClaudes(provider, model);
  };
  const peers = createPeers({ store, runner, consultAccounts: accounts, consultPollMs: 5 });
  const tool = peers.consultTool(parent.id);
  for (let i = 0; i < CONSULT_MAX_PER_HOUR + 2; i += 1) {
    const refused = await tool.execute({ provider: "claude", model: "m", prompt: `q${i}` });
    assert.equal(refused.isError, true);
    assert.match(parse(refused).error, /registry down/);
  }
  throwNow = false;
  assert.equal(parse(await tool.execute({ provider: "claude", model: "m", prompt: "now" })).state, "finished");
  done();
});
