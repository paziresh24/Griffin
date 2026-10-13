import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAsks } from "../src/asks.mjs";
import { openStore } from "../src/db.mjs";
import { createIntegrations } from "../src/integrations/manager.mjs";
import { createAccountChannel } from "../src/integrations/telegram-account.mjs";

// Two sub-agents asking the owner at once used to share one Telegram slot per root chat: a tap
// on the first question's button was read against the second's options. Each ask now carries its
// asks id end to end (callback data, open rows, settle).

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout");
};

// A Bot API server in memory (same shape as integrations.test.mjs): every call is recorded and
// answered with { message_id: <1-based call index> }.
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

test("two open owner asks in one root: each button settles its own ask and closes only its own row", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-askids-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const holder = { current: null };
  const asks = createAsks({ store, log: {}, onSettled: (chatId, info) => holder.current?.clearQuestion(chatId, info) });
  const sends = [];
  const runner = { isActive: () => false, send: async (...args) => { sends.push(args); }, cancel: async () => {} };
  const bot = fakeBotApi();
  const integrations = createIntegrations({ store, runner, asks, fetchImpl: bot.fetchImpl, log: {} });
  holder.current = integrations;
  try {
    const added = await integrations.addBot({ kind: "telegram_bot", token: "555:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    store.updateIntegration(added.id, { settings: { pairedChats: ["777"], pairedNames: { 777: "Owner" }, username: "griffin_ops_bot" } });
    const root = store.createChat({ title: "root", caller: "owner", agent: "griffin" });
    const c1 = store.createChat({ title: "c1", caller: "griffin", agent: "platform", parentChatId: root.id });
    const c2 = store.createChat({ title: "c2", caller: "griffin", agent: "arvan-ban", parentChatId: root.id });

    const first = asks.tool(c1.id).execute({ question: "اولی را انجام بدهم؟", options: [{ label: "الف" }, { label: "ب" }] });
    const second = asks.tool(c2.id).execute({ question: "دومی را انجام بدهم؟", options: [{ label: "ج" }, { label: "د" }] });
    const questionCalls = () => bot.calls.filter((c) => c.method === "sendMessage" && c.body.reply_markup);
    await until(() => questionCalls().length === 2);

    const [idA, idB] = asks.list().map((item) => item.id);
    const msgIdOf = (askId) => bot.calls.indexOf(questionCalls().find((c) => c.body.reply_markup.inline_keyboard[0][0].callback_data === `a:${askId}:0`)) + 1;
    const msgA = msgIdOf(idA);
    const msgB = msgIdOf(idB);
    assert.ok(msgA > 0 && msgB > 0, "both questions went out, each with buttons bound to its asks id");

    // The owner taps «ب» under the FIRST question (the second is newer and used to win).
    bot.push({ callback_query: { id: "cq1", data: `a:${idA}:1`, from: { id: 777 }, message: { chat: { id: 777 }, message_id: msgA } } });
    const firstAnswer = JSON.parse((await first).content[0].text);
    assert.equal(firstAnswer.answer, "ب", "its own options, not the second's");
    assert.ok(asks.isWaiting(root.id), "the second question is still open");
    await until(() => bot.calls.some((c) => c.method === "answerCallbackQuery" && c.body.text === "✅ ثبت شد"));

    await until(() => bot.calls.some((c) => c.method === "editMessageText" && c.body.message_id === msgA));
    const edits = bot.calls.filter((c) => c.method === "editMessageText");
    assert.ok(edits.every((c) => c.body.message_id !== msgB), "the second question's message is untouched");
    const editA = edits.find((c) => c.body.message_id === msgA).body.text;
    assert.match(editA, /پاسخ: ب/);
    // Both sends were in flight together: the closed message keeps ITS question, not the newer one's.
    assert.match(editA, /اولی را انجام بدهم/);
    assert.doesNotMatch(editA, /دومی/);
    assert.deepEqual(store.getKv("ask:open").map((row) => row.askId), [idB], "only the second row stays open");

    // A second tap on the closed question settles nothing and sends no follow-up.
    assert.equal(await integrations.bridge.answerOwnerAsk(added.id, 0, idA), false);
    assert.equal(sends.length, 0);

    // A bare digit with exactly one open owner ask answers that one.
    assert.equal(integrations.bridge.openOwnerAskCount(), 1);
    assert.equal(await integrations.bridge.answerOwnerAsk(added.id, 0, null), true);
    assert.equal(JSON.parse((await second).content[0].text).answer, "ج");
    await until(() => bot.calls.some((c) => c.method === "editMessageText" && c.body.message_id === msgB));
    assert.deepEqual(store.getKv("ask:open"), []);
    assert.equal(integrations.bridge.openOwnerAskCount(), 0);
    assert.equal(sends.length, 0);
  } finally {
    integrations.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setup({ account = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-askids-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const holder = { current: null };
  const asks = createAsks({ store, log: {}, onSettled: (chatId, info) => holder.current?.clearQuestion(chatId, info) });
  const sends = [];
  const runner = { isActive: () => false, send: async (...args) => { sends.push(args); }, cancel: async () => {} };
  const bot = fakeBotApi();
  // The real account channel over a gramjs stand-in: Saved Messages only, every send recorded.
  const tg = { sent: [], deleted: [], nextId: 900 };
  const fakeClient = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "owner" }),
    addEventHandler: () => {},
    sendMessage: async (to, { message }) => { const id = ++tg.nextId; tg.sent.push({ to, id, message }); return { id }; },
    editMessage: async () => {}, deleteMessages: async (_to, ids) => { tg.deleted.push(...ids); },
    getEntity: async (x) => x, getDialogs: async () => [], getMessages: async () => [], disconnect: async () => {},
    downloadProfilePhoto: async () => null,
  };
  const load = async () => ({ TelegramClient: function () { return fakeClient; }, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const channelFactories = account ? { telegram_account: (integration, bridge) => createAccountChannel({ integration, bridge, load, log: {} }) } : {};
  const integrations = createIntegrations({ store, runner, asks, fetchImpl: bot.fetchImpl, channelFactories, log: {} });
  holder.current = integrations;
  const cleanup = async () => {
    integrations.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, asks, runner, sends, bot, tg, integrations, cleanup };
}

const answerOf = async (pending) => JSON.parse((await pending).content[0].text);

// Review #1: the per-id close left askTargets behind; a later full close of that root then told
// the bot to delete its LAST question — another chain's, still open.
test("closing one root's question by id never deletes another root's open question later", async () => {
  const { store, asks, bot, integrations, cleanup } = setup();
  try {
    const added = await integrations.addBot({ kind: "telegram_bot", token: "555:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    store.updateIntegration(added.id, { settings: { pairedChats: ["777"], pairedNames: { 777: "Owner" }, username: "griffin_ops_bot" } });
    const rootA = store.createChat({ title: "A", caller: "owner", agent: "griffin" });
    const rootB = store.createChat({ title: "B", caller: "owner", agent: "griffin" });
    const questionCalls = () => bot.calls.filter((c) => c.method === "sendMessage" && c.body.reply_markup);

    const first = asks.tool(rootA.id).execute({ question: "سؤال الف؟", options: [{ label: "بله" }, { label: "نه" }] });
    await until(() => store.getKv("ask:open")?.length === 1);
    asks.tool(rootB.id).execute({ question: "سؤال ب؟", options: [{ label: "بله" }, { label: "نه" }] });
    await until(() => store.getKv("ask:open")?.length === 2);
    const msgB = bot.calls.indexOf(questionCalls().find((c) => /سؤال ب/.test(c.body.text))) + 1;
    const [idA, idB] = asks.list().map((item) => item.id);

    // Answered on the board, then A's run ends: the chain-wide close of A.
    assert.equal(asks.answer(rootA.id, { answer: "بله", selected: ["بله"], askId: idA }), true);
    assert.equal((await answerOf(first)).answer, "بله");
    asks.cancel(rootA.id);
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(!bot.calls.some((c) => c.method === "deleteMessage" && c.body.message_id === msgB), "B's question is not deleted");
    assert.ok(!bot.calls.some((c) => c.method === "editMessageText" && c.body.message_id === msgB), "nor closed");
    assert.deepEqual(store.getKv("ask:open").map((row) => row.askId), [idB]);
    assert.ok(asks.isWaiting(rootB.id));
  } finally {
    await cleanup();
  }
});

// Review #4/#10: a question delivered through the account (Saved Messages here) came back without
// a message id, so no row was kept and answering it by id left it in Telegram.
test("a question in Saved Messages is removed when answered, and only that one", async () => {
  const { store, asks, tg, integrations, cleanup } = setup({ account: true });
  try {
    const acc = integrations.add("telegram_account", { name: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: { me: { id: "100" } } });
    await until(() => integrations.channels.get(acc.id)?.status?.state === "polling");
    const root = store.createChat({ title: "saved", caller: "owner", agent: "griffin" });
    store.linkChat(acc.id, "me", root.id);
    const c1 = store.createChat({ title: "c1", caller: "griffin", agent: "platform", parentChatId: root.id });
    const c2 = store.createChat({ title: "c2", caller: "griffin", agent: "arvan-ban", parentChatId: root.id });

    const first = asks.tool(c1.id).execute({ question: "اولی؟", options: [{ label: "الف" }, { label: "ب" }] });
    asks.tool(c2.id).execute({ question: "دومی؟", options: [{ label: "ج" }, { label: "د" }] });
    await until(() => store.getKv("ask:open")?.length === 2);
    const idOf = (re) => tg.sent.find((m) => re.test(m.message)).id;
    const [idA] = asks.list().map((item) => item.id);

    assert.equal(asks.answer(root.id, { answer: "ب", selected: ["ب"], askId: idA }), true);
    assert.equal((await answerOf(first)).answer, "ب");
    // (Status lines ⏳ come and go in the same chat; only the questions matter here.)
    await until(() => tg.deleted.includes(idOf(/اولی/)));
    assert.ok(!tg.deleted.includes(idOf(/دومی/)), "the answered question goes, the other stays");
    assert.equal(store.getKv("ask:open").length, 1);
  } finally {
    await cleanup();
  }
});

// Review #6: a bare «1» in a linked owner chat took the NEWEST question's label and settled the
// OLDEST — with two approvals open it could approve the wrong change.
test("a bare digit with two questions open in one chat is refused; with one, it answers that one", async () => {
  const { store, asks, tg, sends, integrations, cleanup } = setup({ account: true });
  try {
    const acc = integrations.add("telegram_account", { name: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: { me: { id: "100" } } });
    await until(() => integrations.channels.get(acc.id)?.status?.state === "polling");
    const root = store.createChat({ title: "saved", caller: "owner", agent: "griffin" });
    store.linkChat(acc.id, "me", root.id);
    const c1 = store.createChat({ title: "c1", caller: "griffin", agent: "platform", parentChatId: root.id });
    const c2 = store.createChat({ title: "c2", caller: "griffin", agent: "arvan-ban", parentChatId: root.id });

    const first = asks.tool(c1.id).execute({ question: "اولی؟", options: [{ label: "A-yes" }, { label: "A-no" }] });
    const second = asks.tool(c2.id).execute({ question: "دومی؟", options: [{ label: "B-yes" }, { label: "B-no" }] });
    await until(() => store.getKv("ask:open")?.length === 2);

    assert.equal(await integrations.bridge.answer(acc.id, "me", 0), true, "handled: not a new message");
    assert.equal(asks.list().length, 2, "neither question was settled");
    assert.ok(tg.sent.some((m) => /چند سؤال باز است/.test(m.message)), "the owner is told why");

    // B answered elsewhere: now «1» means A, with A's own options.
    const [, idB] = asks.list().map((item) => item.id);
    assert.equal(asks.answer(root.id, { answer: "B-no", selected: ["B-no"], askId: idB }), true);
    assert.equal((await answerOf(second)).answer, "B-no");
    assert.equal(await integrations.bridge.answer(acc.id, "me", 0), true);
    assert.equal((await answerOf(first)).answer, "A-yes");
    assert.equal(asks.list().length, 0);
    assert.equal(sends.length, 0, "no follow-up message");
    // Nothing open any more: a digit is just a digit.
    assert.equal(await integrations.bridge.answer(acc.id, "me", 0), false);
  } finally {
    await cleanup();
  }
});
