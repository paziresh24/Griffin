import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAsks } from "../src/asks.mjs";
import { openStore } from "../src/db.mjs";
import { createIntegrations } from "../src/integrations/manager.mjs";

// In a group paired with the bot, any member's "1" or tap settled that group's questions, recorded
// as the owner's answer (the linked chat is the owner's). Only the owner answers there now; with no
// known owner for the bot nobody does.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error("timeout");
};

function fakeBotApi() {
  const calls = [];
  const queue = [];
  let waiter = null;
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body || "{}");
    if (method === "getUpdates") {
      if (!queue.length) await new Promise((resolve) => { waiter = resolve; init.signal?.addEventListener("abort", resolve); });
      return Response.json({ ok: true, result: queue.splice(0) });
    }
    calls.push({ method, body });
    if (method === "getMe") return Response.json({ ok: true, result: { username: "griffin_ops_bot", first_name: "Griffin" } });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  let id = 0;
  const push = (update) => { queue.push({ update_id: ++id, ...update }); waiter?.(); waiter = null; };
  return { fetchImpl, calls, push };
}

const GROUP = -100123;

// A group paired with the bot and linked to an owner chat, with one guard approval open in it.
async function setup({ kind = "telegram_bot", paired = ["777", String(GROUP)], account = null, where = GROUP } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-group-answer-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  if (account) store.createIntegration({ kind: "telegram_account", name: "acct", secret: "", settings: { me: { id: account, name: "Owner" } } });
  const holder = { current: null };
  const asks = createAsks({ store, log: {}, onSettled: (chatId, info) => holder.current?.clearQuestion(chatId, info) });
  const sends = [];
  const runner = { isActive: () => false, send: async (...args) => { sends.push(args); }, cancel: async () => {} };
  const bot = fakeBotApi();
  const warnings = [];
  const integrations = createIntegrations({ store, runner, asks, fetchImpl: bot.fetchImpl, log: { warn: (m) => warnings.push(m), error() {}, log() {} } });
  holder.current = integrations;
  const added = await integrations.addBot({ kind, token: "555:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
  store.updateIntegration(added.id, { settings: { pairedChats: paired, pairedNames: { 777: "Owner", [GROUP]: "Team", 1001: "Colleague" }, username: "griffin_ops_bot" } });
  const chat = store.createChat({ title: "team group", caller: "owner", agent: "griffin" });
  store.linkChat(added.id, String(where), chat.id);
  const approval = asks.confirm(chat.id, { question: "روتر را پاک کنم؟" });
  const questions = () => bot.calls.filter((c) => c.method === "sendMessage" && c.body.reply_markup && String(c.body.chat_id) === String(where));
  await until(() => questions().length === 1);
  const askId = questions()[0].body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
  const settled = (ms = 800) => Promise.race([approval, sleep(ms).then(() => "still-pending")]);
  const cleanup = async () => {
    integrations.stopAll();
    await sleep(30);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, asks, bot, chat, askId, settled, warnings, sends, cleanup };
}
const member = (text, id = 4242) => ({ message: { message_id: Math.floor(Math.random() * 1e6), chat: { id: GROUP, type: "supergroup", title: "Team" }, from: { id, first_name: "M" }, text } });
const tap = (askId, index, fromId) => ({ callback_query: { id: `cq${Math.random()}`, data: `a:${askId}:${index}`, from: { id: fromId }, message: { chat: { id: GROUP }, message_id: 2 } } });

test("a group member's '1' does not settle the group's question", async () => {
  const env = await setup();
  try {
    env.bot.push(member("1"));
    assert.equal(await env.settled(), "still-pending");
    assert.ok(env.asks.isWaiting(env.chat.id));
    await until(() => env.sends.some(([, input]) => /(^|\D)1(\D|$)/.test(String(input?.text || ""))));
  } finally {
    await env.cleanup();
  }
});

test("a group member's tap does not settle the group's question", async () => {
  const env = await setup();
  try {
    env.bot.push(tap(env.askId, 0, 4242));
    await until(() => env.bot.calls.some((c) => c.method === "answerCallbackQuery"));
    assert.equal(await env.settled(), "still-pending");
    const stripped = env.bot.calls.filter((c) => c.method === "editMessageText" && String(c.body.chat_id) === String(GROUP));
    assert.equal(stripped.length, 0, "a member's tap leaves the owner's buttons in place");
    // The owner's own tap in the same group does.
    env.bot.push(tap(env.askId, 1, 777));
    const out = await env.settled(5000);
    assert.notEqual(out, "still-pending");
    assert.equal(out.answer, "نه");
  } finally {
    await env.cleanup();
  }
});

test("the owner's '1' in the group settles it", async () => {
  const env = await setup();
  try {
    env.bot.push(member("1", 777));
    const out = await env.settled(5000);
    assert.notEqual(out, "still-pending");
    assert.equal(out.answer, "بله");
  } finally {
    await env.cleanup();
  }
});

test("with the owner's account connected, the account id is the owner in the group", async () => {
  const env = await setup({ account: "5781" });
  try {
    env.bot.push(member("1", 777));
    assert.equal(await env.settled(), "still-pending", "777 is paired but is not the account");
    env.bot.push(member("1", 5781));
    const out = await env.settled(5000);
    assert.notEqual(out, "still-pending");
    assert.equal(out.answer, "بله");
  } finally {
    await env.cleanup();
  }
});

test("on Bale, a group member does not settle; the bot's own owner chat does", async () => {
  const env = await setup({ kind: "bale_bot", account: "5781" });
  try {
    env.bot.push(member("1"));
    env.bot.push(member("1", 5781));
    assert.equal(await env.settled(), "still-pending", "neither a member nor the owner's Telegram id");
    env.bot.push(member("2", 777));
    const out = await env.settled(5000);
    assert.notEqual(out, "still-pending");
    assert.equal(out.answer, "نه");
  } finally {
    await env.cleanup();
  }
});

test("no known owner for the bot: nobody's answer in the group settles, and it is logged", async () => {
  const env = await setup({ paired: [String(GROUP)] });
  try {
    env.bot.push(member("1", 777));
    env.bot.push(tap(env.askId, 0, 4242));
    await until(() => env.bot.calls.some((c) => c.method === "answerCallbackQuery"));
    assert.equal(await env.settled(), "still-pending");
    assert.ok(env.warnings.some((w) => /no owner id/.test(w)), "the refusal is logged");
  } finally {
    await env.cleanup();
  }
});

test("a private chat is unchanged: the colleague's own '1' answers his chat's question", async () => {
  const env = await setup({ paired: ["777", "1001"], where: 1001 });
  try {
    env.bot.push({ message: { message_id: 61, chat: { id: 1001, type: "private", first_name: "C" }, from: { id: 1001 }, text: "1" } });
    const out = await env.settled(5000);
    assert.notEqual(out, "still-pending");
    assert.equal(out.answer, "بله");
  } finally {
    await env.cleanup();
  }
});
