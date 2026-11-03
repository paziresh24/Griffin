import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createAsks } from "../src/asks.mjs";
import { buildRules } from "../src/prompt.mjs";
import { colleagueCaller, COLLEAGUE_MODE, FULL_ACCESS_HOURS, fullAccess, fullAccessNote, fullAccessTool, grantFullAccess } from "../src/colleague-access.mjs";
import { guardTeamTools } from "../src/integrations/coverage.mjs";

const fresh = () => openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-colleague-")), "db.sqlite"));
const body = (out) => JSON.parse(out.content[0].text);
const tick = () => new Promise((r) => setTimeout(r, 5));

test("colleague conversations sit on «بپرس»; the old «بدون پرسیدن» default without a grant moves back", () => {
  const store = fresh();
  assert.equal(colleagueCaller("team"), true);
  assert.equal(colleagueCaller("peer:mahdi"), true);
  assert.equal(colleagueCaller("owner"), false);
  const chat = store.createChat({ title: "x", caller: "peer:mahdi" });
  assert.equal(store.getChat(chat.id).mode, "agent");
  assert.equal(fullAccess(store, chat.id), null);
  assert.equal(store.getChat(chat.id).mode, COLLEAGUE_MODE);
  // His «بدون پرسیدن» is the grant; it runs out by itself.
  const now = Date.now();
  grantFullAccess(store, chat.id, { why: "w", now });
  assert.equal(store.getChat(chat.id).mode, "agent");
  assert.ok(fullAccess(store, chat.id, now + 60_000));
  assert.equal(fullAccess(store, chat.id, now + (FULL_ACCESS_HOURS + 1) * 3_600_000), null);
  assert.equal(store.getChat(chat.id).mode, COLLEAGUE_MODE);
});

test("request_full_access: one question to the owner; his yes grants the conversation and its next turn starts by itself", async () => {
  const store = fresh();
  const chat = store.createChat({ title: "پوش mohr", caller: "peer:mahdi" });
  const asks = createAsks({ store, log: null });
  const resumed = [];
  const tool = fullAccessTool({ store, rootChatId: chat.id, who: "نوید (مهدی حسینی)", ask: (args) => asks.tool(chat.id).execute(args), resume: async (text) => resumed.push(text) });
  const pending = tool.execute({ why: "مهدی پوش مستقیم روی master پروژهٔ mohr می‌خواهد" });
  await tick();
  const [open] = asks.list();
  assert.match(open.question, /نوید \(مهدی حسینی\): مهدی پوش مستقیم/);
  assert.match(open.question, /بدون پرسیدن/);
  // The colleague's agent cannot say yes for him.
  assert.equal(asks.answer(chat.id, { answer: "اجازه بده", by: "requester" }), false);
  assert.equal(asks.answer(chat.id, { answer: "اجازه بده" }), true);
  const out = body(await pending);
  assert.equal(out.granted, true);
  assert.equal(store.getChat(chat.id).mode, "agent");
  assert.ok(fullAccess(store, chat.id));
  assert.equal(resumed.length, 1);
  assert.match(resumed[0], /ابزارهای کامل/);
  // Already granted: no second question.
  assert.equal(body(await tool.execute({ why: "x" })).granted, true);
  assert.equal(asks.list().length, 0);
});

test("request_full_access: a no grants nothing and starts nothing", async () => {
  const store = fresh();
  const chat = store.createChat({ title: "t", caller: "team" });
  const asks = createAsks({ store, log: null });
  const resumed = [];
  const tool = fullAccessTool({ store, rootChatId: chat.id, ask: (args) => asks.tool(chat.id).execute(args), resume: async (t) => resumed.push(t) });
  const pending = tool.execute({ why: "w" });
  await tick();
  asks.answer(chat.id, { answer: "نه" });
  assert.equal(body(await pending).granted, false);
  assert.equal(fullAccess(store, chat.id), null);
  assert.equal(resumed.length, 0);
});

test("with full access a team chain's writes are not fenced, but a message to another person still asks", async () => {
  const ran = [];
  const tools = {
    kube_create: { execute: async () => ran.push("kube_create") },
    telegram_send: { execute: async () => ran.push("telegram_send") },
  };
  const asks = { tool: () => ({}), enqueue: async () => ({ answered: false }) };
  const fenced = guardTeamTools(tools, { chatId: "c", asks, verdictOf: (name) => (name === "kube_create" ? { approve: "ساخت" } : null) });
  const refused = await fenced.kube_create.execute({});
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /request_full_access/);
  const open = guardTeamTools(tools, { chatId: "c", asks, writes: false, verdictOf: (name) => (name === "kube_create" ? { approve: "ساخت" } : null) });
  await open.kube_create.execute({});
  assert.deepEqual(ran, ["kube_create"]);
  assert.notEqual(open.telegram_send.execute, tools.telegram_send.execute, "telegram_send is still gated");
});

test("the «بپرس» rule tells the model to ask once and then do the work, never to suggest a chat", () => {
  const rules = buildRules({ caller: "peer:mahdi", tools: ["ask_owner", "request_full_access"] });
  assert.match(rules, /call request_full_access ONCE/);
  assert.doesNotMatch(rules, /handoff_to_owner/);
});

test("full access opens kube_delete; without it the colleague chain refuses it", async () => {
  const { classify } = await import("../src/guard.mjs");
  const ran = [];
  const tools = { kube_delete: { execute: async () => ran.push("kube_delete") } };
  const asks = { tool: () => ({}), enqueue: async () => ({ answered: false }) };
  const args = { cluster: "east", namespace: "akazemi", kind: "CronJob", name: "freeturn-monitor" };
  const refused = await guardTeamTools(tools, { chatId: "c", asks, verdictOf: classify }).kube_delete.execute(args);
  assert.equal(refused.isError, true);
  await guardTeamTools(tools, { chatId: "c", asks, writes: false, verdictOf: classify }).kube_delete.execute(args);
  assert.deepEqual(ran, ["kube_delete"]);
});

test("a full-access run with no tool for the change asks for the tool in the same turn, not a menu", () => {
  const note = fullAccessNote({ until: "2026-10-29T12:00:00Z", why: "حذف کرون‌جاب" });
  assert.match(note, /never end on a menu of options/);
  assert.match(note, /same turn call build_tool/);
  assert.match(note, /2026-10-29, freeturn-monitor/);
});
