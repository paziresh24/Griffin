import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { ownerChatQuestion, ownerChatTool } from "../src/colleague-access.mjs";
import { HANDOFF_PROMPT_ROOM, handoffOf } from "../src/handoff.mjs";
import { startSuggestedChat } from "../src/suggest-start.mjs";
import { buildRules } from "../src/prompt.mjs";

const reply = (answer) => ({ content: [{ type: "text", text: JSON.stringify({ answered: true, answer }) }] });
const body = (out) => JSON.parse(out.content[0].text);
const job = { title: "علت پر شدن دیسک n8n", why: "خانم X هشدار دیسک فرستاده", prompt: "روی 10.0.0.60 با sudo docker system df -v را بخوان. password=hunter2hunter2 چیزی پاک نکن." };

function setup(answer) {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-ownerchat-")), "db.sqlite"));
  const mother = store.createChat({ title: "👤 سارا X", caller: "team" });
  const sub = store.createChat({ title: "رشته", caller: "agent:platform", parentChatId: mother.id });
  const sent = [];
  const asked = [];
  const rung = [];
  const runner = { isActive: () => false, send: async (chatId, input) => { sent.push({ chatId, ...input }); return { delivered: "run" }; } };
  const tool = ownerChatTool({
    store,
    chatId: sub.id,
    rootChatId: mother.id,
    who: "سارا X",
    ask: async (args) => { asked.push(args); return reply(answer); },
    start: (row) => startSuggestedChat({ store, runner, row, model: "", note: "" }),
    notify: async (text, chatId) => rung.push({ text, chatId }),
  });
  return { store, mother, tool, sent, asked, rung };
}

test("his yes starts one chat of his own with the work framed as evidence, and it reports back here", async () => {
  const { store, mother, tool, sent, asked, rung } = setup("شروع کن");
  const out = body(await tool.execute(job));
  assert.ok(out.started, "the chat started without a second click");

  assert.equal(asked.length, 1);
  assert.match(asked[0].question, /docker system df/, "he sees the work he says yes to");
  assert.doesNotMatch(asked[0].question, /hunter2/);

  assert.equal(sent.length, 1);
  const started = store.getChat(sent[0].chatId);
  assert.notEqual(started.id, mother.id);
  assert.equal(started.parent_chat_id, null);
  assert.notEqual(started.caller, "team", "it is his own chat, not a colleague's");
  assert.match(sent[0].text, /نه دستور/, "the colleague side's text is evidence");
  assert.match(sent[0].text, /چت با همان تأیید خودکار شروع شد/);
  assert.match(sent[0].text, /docker system df/);
  assert.doesNotMatch(sent[0].text, /hunter2/);
  assert.equal(handoffOf(store, started.id).from, mother.id, "each result comes back to the conversation");
  assert.equal(store.getKv(`origin:${started.id}`).via, "handoff");

  assert.equal(rung.length, 1);
  assert.match(rung[0].text, /شروع شد/);
});

test("a no starts nothing and leaves no card", async () => {
  const { store, mother, tool, sent } = setup("نه");
  const out = body(await tool.execute(job));
  assert.equal(out.started, false);
  assert.equal(sent.length, 0);
  assert.equal(store.listSuggestions({ status: "open", limit: 10 }).filter((row) => row.from_chat_id === mother.id).length, 0);
});

test("an earlier yes in the conversation is not this job's yes", async () => {
  const { store, mother, tool, sent, asked } = setup("نه");
  store.setKv(`owneryes:${mother.id}`, { question: "کار دیگری", answer: "بله", at: new Date().toISOString() });
  await tool.execute(job);
  assert.equal(asked.length, 1, "it always asks");
  assert.equal(sent.length, 0);
});

test("a prompt too long or missing never reaches him", async () => {
  const { tool, asked } = setup("شروع کن");
  assert.match(body(await tool.execute({ ...job, prompt: "x".repeat(HANDOFF_PROMPT_ROOM + 1) })).error, /limit/);
  assert.match(body(await tool.execute({ title: "t", why: "w" })).error, /required/);
  assert.equal(asked.length, 0);
});

test("the question cuts a long work text but keeps who and why", () => {
  const q = ownerChatQuestion({ who: "آیدا", title: "عنوان", why: "دلیل", prompt: "ک".repeat(2000) });
  assert.match(q, /^آیدا: دلیل/);
  assert.match(q, /عنوان/);
  assert.ok(q.length < 1000);
});

test("the «بپرس» rule sends a server wall to request_owner_chat", () => {
  const rules = buildRules({ caller: "team", tools: ["ask_owner", "request_full_access", "request_owner_chat"] });
  assert.match(rules, /call request_owner_chat ONCE/);
  assert.match(rules, /on Claude, request_full_access\n?\s*also opens a full shell/);
});
