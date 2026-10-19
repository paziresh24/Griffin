// Telegram DM mode: TELEGRAM_DM_MODE=<assistant mode> (default: the assistant answers for the owner)
// or inbox (a dispatcher: a reply goes back to the chat that sent the message it answers, a
// new topic becomes a suggested chat, nothing reaches the colleague without the owner). Switched in
// Settings at any time, without a restart; items in flight are neither lost nor duplicated.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createConfig } from "../src/config.mjs";
import { createChatTools, promptSha, settleSuggestion } from "../src/chat-tools.mjs";
import { createApp } from "../src/app.mjs";
import { createAsks } from "../src/asks.mjs";
import { ORIGIN_KEY } from "../src/chat-origin.mjs";
import { telegramOriginKey } from "../src/db.mjs";
import { instructionPathsFor, telegramOrigin } from "../src/chat-origin.mjs";
import { createIntegrations } from "../src/integrations/manager.mjs";
import { createAccountChannel } from "../src/integrations/telegram-account.mjs";
import { motherChatId } from "../src/integrations/mother.mjs";
import { thirdPartyKey } from "../src/related.mjs";
import { rememberShareSend } from "../src/integrations/share-sends.mjs";
import { DM_MODES, INBOX_TOOLS, THIRD_PARTY_HEAD, createInbox, createInboxTools, restrictForInbox } from "../src/telegram-inbox.mjs";

// The default mode: the assistant answers DMs itself (mother chats), as without an inbox.
const ASSISTANT = DM_MODES.find((m) => m !== "inbox");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error("timeout");
};
const payload = (result) => JSON.parse(result.content[0].text);
const msg = (id, ts, out = false, replyTo = null, text = `m${id}`) => ({ id, ts, out, text, replyTo });
const peer = (id, name = `P${id}`) => ({ peerId: String(id), name, isUser: true });

// A store, a fake runner and fake timers around createInbox; `mode` is switched by the test.
function inboxSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tg-inbox-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  let clock = 1_000_000_000;
  let mode = "inbox";
  const timers = [];
  const sent = [];
  const active = new Set();
  const histories = {};
  const runner = {
    isActive: (id) => active.has(id),
    async send(chatId, message) {
      sent.push({ chatId, ...message });
      active.add(chatId);
      return { delivered: "run" };
    },
  };
  const inbox = createInbox({
    store,
    runner,
    mode: () => mode,
    now: () => clock,
    history: async (peerId) => histories[peerId] || [],
    timers: {
      set: (fn, ms) => {
        const t = { fn, at: clock + ms, live: true };
        timers.push(t);
        return t;
      },
      clear: (t) => {
        if (t) t.live = false;
      },
    },
    log: { error() {} },
  });
  const s = { store, runner, sent, histories, active, inbox, setMode: (m) => (mode = m) };
  s.advance = async (ms) => {
    clock += ms;
    for (const t of timers.filter((x) => x.live && x.at <= clock)) {
      t.live = false;
      await t.fn();
    }
    await inbox.idle();
  };
  s.finish = async (chatId, status = "finished") => {
    active.delete(chatId);
    store.appendEvent(chatId, null, "run.finished", { status });
    await inbox.idle();
  };
  s.secs = () => Math.floor(clock / 1000);
  s.iso = (agoS = 0) => new Date((s.secs() - agoS) * 1000).toISOString();
  /** A message from a peer the account already wrote to; true when the inbox took it. */
  s.dm = (id, messageId, { text = `m${messageId}`, replyTo = null } = {}) => {
    histories[id] = [msg(messageId, s.secs(), false, replyTo, text), ...(histories[id] || [msg(messageId - 1, s.secs() - 500, true)])];
    return inbox.onIncoming(peer(id), { id: messageId });
  };
  s.tools = (chatId) => createInboxTools({ store, runner, chatId, suggest: createChatTools({ store, chatId }).chat_suggest });
  s.cleanup = () => {
    inbox.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return s;
}

test("inbox mode: a reply to a message a chat sent (send ledger) is routed back to that chat, as third-party content", async () => {
  const s = inboxSetup();
  try {
    const asking = s.store.createChat({ title: "دسترسی لاگ برای بهرامی" });
    // That chat sent message 100 to peer 5 through telegram_send (the ledger row).
    s.histories[5] = [msg(100, s.secs() - 300, true, null, "لاگ را دیدی؟")];
    s.store.recordTelegramSend({ peerId: "5", chatId: asking.id, messageId: 100, at: s.iso(300) });
    assert.equal(s.dm(5, 101, { text: "آره، خطای 403 می‌دهد", replyTo: 100 }), true, "inbox mode takes the DM");
    assert.equal(s.sent.length, 0, "nothing before the quiet time");
    await s.advance(91_000);

    const dispatcher = s.inbox.status().chatId;
    assert.ok(dispatcher, "the dispatcher chat was made");
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0].chatId, dispatcher);
    assert.match(s.sent[0].text, /📥 تلگرام — peer 5 — person — item \d+/);
    assert.match(s.sent[0].text, new RegExp(`پاسخ تلگرامی به پیام ما: message 100 از چت ${asking.id}`));
    const [item] = s.store.listInboxItems({ status: "delivered" });

    // The dispatcher routes it; the server writes the message, not the model.
    const routed = payload(await s.tools(dispatcher).inbox_route.execute({ itemId: item.id, chatId: asking.id }));
    assert.deepEqual(routed, { delivered: true, chatId: asking.id });
    const delivered = s.sent.find((m) => m.chatId === asking.id);
    assert.ok(delivered.text.startsWith(THIRD_PARTY_HEAD), delivered.text);
    assert.match(delivered.text, /خطای 403/);
    assert.ok(s.store.getKv(thirdPartyKey(asking.id)), "the target chat holds third-party content");
    // Any other chat is refused: the ledger decides, not the text.
    const other = s.store.createChat({ title: "x" });
    assert.match(payload(await s.tools(dispatcher).inbox_route.execute({ itemId: item.id, chatId: other.id })).error, /not a candidate/);

    await s.finish(dispatcher);
    assert.equal(s.store.getInboxItem(item.id).status, "done");
  } finally {
    s.cleanup();
  }
});

test("inbox mode: a new topic becomes a suggested chat the owner starts; that chat is Telegram-born (instruction guard applies)", async () => {
  const s = inboxSetup();
  try {
    s.dm(7, 201, { text: "سلام، پنل پزشک برای من باز نمی‌شود" });
    await s.advance(91_000);
    const dispatcher = s.inbox.status().chatId;
    assert.match(s.sent[0].text, /چت نامزدی نیست/);

    const tools = restrictForInbox({ telegram_send: {}, ask_owner: {}, knowledge_write: {}, ...s.tools(dispatcher) });
    assert.deepEqual(Object.keys(tools).sort(), ["chat_list", "chat_read", "chat_suggest", "inbox_route"]);
    for (const t of ["telegram_send", "ask_owner", "knowledge_write", "chat_send"]) assert.equal(INBOX_TOOLS.includes(t), false, t);
    assert.equal(tools.chat_suggest.inputSchema.properties.repo, undefined, "the dispatcher does not pick the repo or model");

    const { id } = payload(await tools.chat_suggest.execute({ title: "پنل پزشک باز نمی‌شود", tldr: "یک همکار گزارش داد", prompt: "فرستنده P7 (peer 7) … اول RCA" }));
    const suggestion = s.store.getSuggestion(id);
    assert.equal(suggestion.status, "open", "nothing starts by itself");
    assert.equal(suggestion.from_chat_id, dispatcher);
    assert.equal(suggestion.title, "تلگرام: پنل پزشک باز نمی‌شود");
    assert.equal(s.sent.length, 1, "no chat was sent anything");

    // The owner starts it (the real route): the new chat carries the Telegram-origin marker itself.
    const app = createApp({ store: s.store, runner: { ...s.runner, activeCount: () => 0 }, asks: createAsks({ store: s.store, log: {} }) });
    const res = await app.request(`/api/suggestions/${id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ promptSha: promptSha(suggestion.prompt) }) });
    assert.equal(res.status, 201, await res.clone().text());
    const started = (await res.json()).chat;
    assert.equal(s.store.getKv(ORIGIN_KEY(started.id))?.from, "telegram");
    assert.ok(s.store.getKv(telegramOriginKey(started.id)), "own-row checks (knowledge trust, owner chat tools) see it too");
    assert.ok(telegramOrigin(s.store, s.store.getChat(started.id)), "Telegram-born");
    assert.ok(instructionPathsFor(s.store, s.store.getChat(started.id), { configDirs: ["/tmp/claude-x"] }).length > 0, "the instruction-file guard covers it");
    assert.equal(telegramOrigin(s.store, s.store.createChat({ title: "the owner's own" })), null);
    // A suggestion from any other owner chat starts an unmarked chat, as before.
    const plain = s.store.createChat({ title: "plain" });
    const other = payload(await createChatTools({ store: s.store, chatId: plain.id }).chat_suggest.execute({ title: "t", tldr: "d", prompt: "p" }));
    const res2 = await app.request(`/api/suggestions/${other.id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ promptSha: promptSha("p") }) });
    assert.equal(s.store.getKv(ORIGIN_KEY((await res2.json()).chat.id)), null);
  } finally {
    s.cleanup();
  }
});

test("a switch to the assistant mode while an item is in flight: the item finishes once, the queued one still goes, new DMs go to the assistant and are never queued later", async () => {
  const s = inboxSetup();
  try {
    s.dm(5, 11);
    s.dm(6, 21);
    await s.advance(91_000);
    const dispatcher = s.inbox.status().chatId;
    assert.equal(s.sent.length, 1, "one at a time");
    assert.deepEqual(s.store.listInboxItems().map((i) => i.status), ["delivered", "pending"]);
    // A burst whose quiet time is still running when the mode changes is not dropped.
    s.dm(8, 31);

    s.setMode(ASSISTANT); // Settings, no restart
    assert.equal(s.dm(5, 12), false, "a new DM is the assistant's now");
    await s.advance(91_000);
    await s.finish(dispatcher);
    assert.deepEqual(s.store.listInboxItems().map((i) => [i.peer_id, i.status]), [["5", "done"], ["6", "delivered"], ["8", "pending"]]);
    await s.finish(dispatcher);
    await s.finish(dispatcher);
    assert.deepEqual(s.store.listInboxItems().map((i) => i.status), ["done", "done", "done"]);
    assert.equal(s.sent.filter((m) => m.chatId === dispatcher).length, 3, "each item delivered exactly once");
    assert.equal(s.sent.filter((m) => /item 1\b/.test(m.text)).length, 1);

    // Back to inbox: what the assistant had (message 12) is not queued again; a new message is.
    s.setMode("inbox");
    s.dm(5, 13);
    await s.advance(91_000);
    const last = s.store.listInboxItems().at(-1);
    assert.equal(last.peer_id, "5");
    assert.deepEqual(JSON.parse(last.meta).messageIds, [13], "message 12 went to the assistant and is not repeated");
  } finally {
    s.cleanup();
  }
});

test("a switch to the assistant mode during one person's wait: what came before the switch is the inbox's, what came after is the assistant's — none lost, none twice", async () => {
  const s = inboxSetup();
  try {
    assert.equal(s.dm(5, 11), true);
    s.setMode(ASSISTANT);
    assert.equal(s.dm(5, 12), false, "the assistant has message 12");
    await s.advance(91_000);
    const items = s.store.listInboxItems();
    assert.equal(items.length, 1, "message 11 is not lost");
    assert.deepEqual(JSON.parse(items[0].meta).messageIds, [11], "message 12 is not queued as well");
    s.setMode("inbox");
    s.dm(5, 13);
    await s.advance(91_000);
    assert.deepEqual(JSON.parse(s.store.listInboxItems().at(-1).meta).messageIds, [13]);

    // the assistant's message arriving 30 s before the wait ends (still inside the quiet time) does not hold it back.
    s.dm(5, 14);
    await s.advance(60_000);
    s.setMode(ASSISTANT);
    s.dm(5, 15);
    await s.advance(31_000);
    assert.deepEqual(JSON.parse(s.store.listInboxItems().at(-1).meta).messageIds, [14], "message 14 is not lost");
    assert.equal(s.store.getKv("tg-inbox").seenUpto?.["5"] >= 15 || s.store.getKv("tg-inbox").queuedUpto["5"] === 14, true);
  } finally {
    s.cleanup();
  }
});

test("inbox mode: a first DM in a dialog the owner never wrote in makes no item, and the owner is told (not silently dropped)", async () => {
  const s = inboxSetup();
  try {
    let told = 0;
    s.histories[9] = [msg(1, s.secs(), false, null, "سلام، من تازه به تیم آمدم")];
    assert.equal(s.inbox.onIncoming({ ...peer(9), unrouted: () => told++ }, { id: 1 }), true);
    await s.advance(91_000);
    assert.equal(s.store.listInboxItems().length, 0);
    assert.equal(told, 1);
    // An entity that could not be read (maybe a bot) is not taken either, and is reported.
    assert.equal(s.inbox.onIncoming({ ...peer(10), isBot: true, unrouted: () => told++ }, { id: 2 }), true);
    assert.equal(told, 2);
  } finally {
    s.cleanup();
  }
});

test("inbox mode: a private-share invite or code sent from the owner's account never enters the inbox and never closes the person's question", async () => {
  const s = inboxSetup();
  try {
    // The owner wrote in this dialog long ago; the person asked something; then the account sent a
    // private-share invite and a code (share-sends.mjs ids); then the person wrote again.
    s.histories[5] = [
      msg(104, s.secs(), false, null, "لینک را باز کردم"),
      msg(103, s.secs() - 100, true, null, "کد ورود به گفتگوی «فروش»: 123456\nده دقیقه اعتبار دارد. https://g.example/#/p/abc"),
      msg(102, s.secs() - 200, true, null, "گفتگوی «فروش» را با شما به اشتراک گذاشتم:\nhttps://g.example/#/p/abc"),
      msg(101, s.secs() - 300, false, null, "قیمتِ پلنِ سالانه چند است؟"),
      msg(90, s.secs() - 5000, true, null, "سلام"),
    ];
    rememberShareSend(s.store, "5", 102);
    rememberShareSend(s.store, "5", 103);
    assert.equal(s.inbox.onIncoming(peer(5), { id: 104 }), true);
    await s.advance(91_000);
    const items = s.store.listInboxItems();
    assert.equal(items.length, 1);
    const item = items[0];
    // The invite is not the owner answering: the question before it is still open.
    assert.deepEqual(JSON.parse(item.meta).messageIds, [101, 104]);

    // A person whose only line from the account is an invite is not one the owner wrote to: their reply
    // makes no item, and the owner is told (as for any first DM).
    let told = 0;
    s.histories[6] = [
      msg(202, s.secs(), false, null, "ممنون، باز شد"),
      msg(201, s.secs() - 60, true, null, "گفتگوی «فروش» را با شما به اشتراک گذاشتم:\nhttps://g.example/#/p/xyz"),
    ];
    rememberShareSend(s.store, "6", 201);
    assert.equal(s.inbox.onIncoming({ ...peer(6), unrouted: () => told++ }, { id: 202 }), true);
    await s.advance(91_000);
    assert.equal(s.store.listInboxItems().filter((i) => i.peer_id === "6").length, 0);
    assert.equal(told, 1);
  } finally {
    s.cleanup();
  }
});

// A Telegram account over a fake gramjs client, on the real store, bridge and Settings.
function accountHarness({ mode }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tg-mode-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const config = createConfig({ store });
  if (mode) config.set({ TELEGRAM_DM_MODE: mode });
  const sends = [];
  const runner = {
    isActive: () => false,
    send: async (chatId, input) => {
      sends.push({ chatId, ...input });
      store.appendEvent(chatId, null, "user", { text: input.text });
      return { delivered: "run" };
    },
    cancel: async () => {},
    retry: () => ({ status: "nothing-kept" }),
  };
  let handler = null;
  const outbox = [];
  let history = [];
  const client = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "owner" }),
    addEventHandler: (fn) => { handler = fn; },
    sendMessage: async (to, opts) => { outbox.push({ to: String(to), message: opts.message }); return { id: 900 + outbox.length }; },
    editMessage: async () => {}, deleteMessages: async () => {},
    getEntity: async () => ({ firstName: "Bahrami", username: "abahrami" }),
    getDialogs: async () => [], getMessages: async () => history, disconnect: async () => {}, invoke: async () => {},
    downloadProfilePhoto: async () => null,
  };
  const Api = { messages: { SendReaction: function (o) { Object.assign(this, o); } }, ReactionEmoji: function (o) { Object.assign(this, o); } };
  const load = async () => ({ TelegramClient: function () { return client; }, Api, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const holder = {};
  const inbox = createInbox({ store, runner, quietMs: 30, history: async () => history.map((m) => ({ id: m.id, ts: m.date, out: m.out, text: m.message, replyTo: null })), log: { error() {} } });
  const acc = store.createIntegration({ kind: "telegram_account", name: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: { autoReplyAgents: true } });
  const integrations = createIntegrations({ store, runner, asks: null, inbox, channelFactories: { telegram_account: (integration, bridge) => createAccountChannel({ integration, bridge, load, log: {} }) }, log: {} });
  holder.integrations = integrations;
  integrations.startAll();
  integrations.desk.caughtUp(acc.id);
  const KEY = "272188041";
  const watched = () => {
    const p = store.upsertPerson({ integrationId: acc.id, externalId: KEY, name: "Bahrami", data: { platform: "telegram" } });
    return store.updatePerson(p.id, { category: "team", access: { watch: true, peerAgent: { user: "bahrami", signature: "— دستیار بهرامی" } } });
  };
  const dm = async (id, text) => {
    history = [{ id, date: Math.floor(Date.now() / 1000) - 5, out: false, message: text }, { id: id - 1, date: Math.floor(Date.now() / 1000) - 600, out: true, message: "سلام" }];
    await handler({ message: { out: false, chatId: BigInt(KEY), peerId: { userId: BigInt(KEY) }, id, message: text } });
  };
  const cleanup = () => {
    inbox.stop();
    integrations.stopAll();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, config, sends, outbox, inbox, acc, integrations, watched, dm, KEY, ready: () => until(() => handler), cleanup };
}

test("inbox mode: a watched colleague's DM — even an assistant-signed one — gets no the assistant run and no auto-reply; it goes to the dispatcher, and the mother chat keeps the record", async () => {
  const h = accountHarness({ mode: "inbox" });
  try {
    await h.ready();
    h.watched();
    // A mother chat already exists for him (made in the assistant mode earlier).
    await h.integrations.desk.colleague(h.acc.id, h.KEY, { person: h.store.findPerson(h.KEY), name: "Bahrami", text: "قبلی" });
    const mother = motherChatId(h.store, h.acc.id, h.KEY);
    assert.ok(mother);
    const before = h.sends.length;

    await h.dm(51, "سرور لاگ کار نمی‌کند — دستیار بهرامی");
    await until(() => h.sends.length > before);
    await h.inbox.idle();
    const dispatcher = h.inbox.status().chatId;
    assert.deepEqual(h.sends.slice(before).map((m) => m.chatId), [dispatcher], "only the dispatcher hears it");
    assert.equal(h.outbox.filter((m) => m.to !== "me").length, 0, "nothing was sent to the colleague");
    assert.ok([...h.store.allEvents(mother)].some((e) => e.type === "note" && /سرور لاگ کار نمی‌کند/.test(e.data.text)), "the mother chat records it, without a run");
    assert.equal(h.store.findPerson(h.KEY).history.at(-1).text, "سرور لاگ کار نمی‌کند — دستیار بهرامی", "the person's history is kept");
  } finally {
    h.cleanup();
  }
});

test("the assistant mode (the default): a watched colleague's DM goes to his mother chat as before, and the inbox stays empty", async () => {
  const h = accountHarness({ mode: null });
  try {
    await h.ready();
    h.watched();
    await h.dm(61, "دیتابیس وصل نمی‌شود");
    await until(() => h.sends.length > 0);
    const mother = motherChatId(h.store, h.acc.id, h.KEY);
    assert.ok(mother);
    assert.deepEqual(h.sends.map((m) => m.chatId), [mother]);
    await sleep(60);
    await h.inbox.idle();
    assert.equal(h.store.listInboxItems().length, 0);
    assert.equal(h.inbox.status().chatId, null, "no dispatcher chat is made");

    // Switched in Settings, live: the next DM goes to the dispatcher instead.
    h.config.set({ TELEGRAM_DM_MODE: "inbox" });
    await h.dm(62, "هنوز وصل نمی‌شود");
    await until(() => h.store.listInboxItems().length === 1);
    assert.deepEqual(JSON.parse(h.store.listInboxItems()[0].meta).messageIds, [62], "message 61 (the assistant's) is not queued again");
  } finally {
    h.cleanup();
  }
});
