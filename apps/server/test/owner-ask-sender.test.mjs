import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAsks } from "../src/asks.mjs";
import { openStore } from "../src/db.mjs";
import { createIntegrations } from "../src/integrations/manager.mjs";

// A bare "1" sent to the bot answered the only open owner question, whoever sent it: an unpaired
// DM or any member of a group the bot is in could approve a gated call (guard approvals offer
// [بله, نه]). Only the owner's own number or tap answers now (2026-10-14).

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
    if (method === "getMe") return Response.json({ ok: true, result: { username: "griffinops_bot", first_name: "Griffin" } });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  let id = 0;
  const push = (update) => { queue.push({ update_id: ++id, ...update }); waiter?.(); waiter = null; };
  return { fetchImpl, calls, push };
}

// The owner (chat 777) is paired with the bot; one guard approval from an owner chat is open.
async function setup({ kind = "telegram_bot", account = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-owner-sender-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const accountInteg = account && store.createIntegration({ kind: "telegram_account", name: "acct", secret: "", settings: { me: { id: account, name: "Owner" } } });
  const holder = { current: null };
  const asks = createAsks({ store, log: {}, onSettled: (chatId, info) => holder.current?.clearQuestion(chatId, info) });
  const runner = { isActive: () => false, send: async () => {}, cancel: async () => {} };
  const bot = fakeBotApi();
  const integrations = createIntegrations({ store, runner, asks, fetchImpl: bot.fetchImpl, log: {} });
  holder.current = integrations;
  const added = await integrations.addBot({ kind, token: "555:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
  store.updateIntegration(added.id, { settings: { pairedChats: ["777"], pairedNames: { 777: "Owner" }, username: "griffinops_bot" } });
  const chat = store.createChat({ title: "owner work", caller: "owner", agent: "griffin" });
  const approval = asks.confirm(chat.id, { question: "روتر را پاک کنم؟" });
  const questions = () => bot.calls.filter((c) => c.method === "sendMessage" && c.body.reply_markup);
  await until(() => questions().length === 1);
  const askId = asks.list()[0].id;
  const settled = (ms = 800) => Promise.race([approval, sleep(ms).then(() => "still-pending")]);
  const cleanup = async () => {
    integrations.stopAll();
    await sleep(30);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, asks, bot, integrations, added, accountInteg, chat, askId, approval, settled, cleanup };
}

test("an unpaired stranger's '1' in a DM does not answer the owner's question", async () => {
  const env = await setup();
  try {
    env.bot.push({ message: { message_id: 50, chat: { id: 999, type: "private", first_name: "Stranger" }, from: { id: 999 }, text: "1" } });
    assert.equal(await env.settled(), "still-pending");
    assert.ok(env.asks.isWaiting(env.chat.id), "still waiting for the owner");
    assert.ok(!env.bot.calls.some((c) => c.method === "sendMessage" && c.body.chat_id === 999), "the stranger hears nothing");
  } finally {
    await env.cleanup();
  }
});

test("a group member's '1' does not answer the owner's question", async () => {
  const env = await setup();
  try {
    env.bot.push({ message: { message_id: 51, chat: { id: -100123, type: "supergroup", title: "Team" }, from: { id: 4242, first_name: "Member" }, text: "1" } });
    assert.equal(await env.settled(), "still-pending");
    assert.ok(env.asks.isWaiting(env.chat.id));
  } finally {
    await env.cleanup();
  }
});

test("the owner's own '1' answers it", async () => {
  const env = await setup();
  try {
    env.bot.push({ message: { message_id: 52, chat: { id: 777, type: "private", first_name: "Owner" }, from: { id: 777 }, text: "1" } });
    const out = await env.settled(5000);
    assert.notEqual(out, "still-pending");
    assert.equal(out.answer, "بله");
  } finally {
    await env.cleanup();
  }
});

test("on an install with the owner's own account, his account id is the owner on the bot", async () => {
  const env = await setup({ account: "5781" });
  try {
    // 777 is paired with the bot but is not the owner's account: not the owner.
    env.bot.push({ message: { message_id: 53, chat: { id: 777, type: "private" }, from: { id: 777 }, text: "1" } });
    assert.equal(await env.settled(), "still-pending");
    env.bot.push({ message: { message_id: 54, chat: { id: 5781, type: "private" }, from: { id: 5781 }, text: "2" } });
    const out = await env.settled(5000);
    assert.notEqual(out, "still-pending");
    assert.equal(out.answer, "نه");
  } finally {
    await env.cleanup();
  }
});

test("a non-owner's button press does not answer, even with the question id", async () => {
  const env = await setup();
  try {
    // A group member taps a forwarded copy of the buttons; the chat in the update is the group.
    env.bot.push({ callback_query: { id: "cq1", data: `a:${env.askId}:0`, from: { id: 4242 }, message: { chat: { id: -100123 }, message_id: 9 } } });
    await until(() => env.bot.calls.some((c) => c.method === "answerCallbackQuery"));
    assert.equal(await env.settled(), "still-pending");
    assert.ok(env.asks.isWaiting(env.chat.id));
    // The owner's own tap still works.
    env.bot.push({ callback_query: { id: "cq2", data: `a:${env.askId}:0`, from: { id: 777 }, message: { chat: { id: 777 }, message_id: 2 } } });
    const out = await env.settled(5000);
    assert.notEqual(out, "still-pending");
    assert.equal(out.answer, "بله");
  } finally {
    await env.cleanup();
  }
});

test("a Bale bot: only the owner's chat answers", async () => {
  const env = await setup({ kind: "bale_bot" });
  try {
    env.bot.push({ message: { message_id: 55, chat: { id: 999, type: "private" }, from: { id: 999 }, text: "1" } });
    assert.equal(await env.settled(), "still-pending");
    env.bot.push({ message: { message_id: 56, chat: { id: 777, type: "private" }, from: { id: 777 }, text: "1" } });
    const out = await env.settled(5000);
    assert.notEqual(out, "still-pending");
    assert.equal(out.answer, "بله");
  } finally {
    await env.cleanup();
  }
});

test("a Bale bot next to the owner's Telegram account: the question goes to his Bale chat, and only that chat answers", async () => {
  // 5781 is the owner's Telegram id; on Bale it is some other user.
  const env = await setup({ kind: "bale_bot", account: "5781" });
  try {
    const question = env.bot.calls.find((c) => c.method === "sendMessage" && c.body.reply_markup);
    assert.equal(String(question.body.chat_id), "777", "sent to the owner's Bale chat, not to Bale user 5781");
    env.bot.push({ callback_query: { id: "cq3", data: `a:${env.askId}:0`, from: { id: 5781 }, message: { chat: { id: 5781 }, message_id: 9 } } });
    await until(() => env.bot.calls.some((c) => c.method === "answerCallbackQuery"));
    assert.equal(await env.settled(), "still-pending", "Bale user 5781 is not the owner");
    env.bot.push({ message: { message_id: 57, chat: { id: 777, type: "private" }, from: { id: 777 }, text: "2" } });
    const out = await env.settled(5000);
    assert.notEqual(out, "still-pending");
    assert.equal(out.answer, "نه");
  } finally {
    await env.cleanup();
  }
});

test("the owner's \"1\" in his own Saved Messages answers what his Telegram bot asked; another id does not", async () => {
  const env = await setup({ account: "5781" });
  try {
    const accountId = env.accountInteg.id;
    assert.equal(await env.integrations.bridge.answerOwnerAsk(accountId, 0, null, { senderId: "777" }), false);
    assert.equal(env.integrations.bridge.ownerAskCountFor(accountId, "5781"), 1);
    assert.equal(await env.integrations.bridge.answerOwnerAsk(accountId, 0, null, { senderId: "5781" }), true);
    const out = await env.settled(5000);
    assert.notEqual(out, "still-pending");
    assert.equal(out.answer, "بله");
  } finally {
    await env.cleanup();
  }
});
