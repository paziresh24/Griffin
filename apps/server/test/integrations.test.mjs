import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAsks, ASK_TOOL } from "../src/asks.mjs";
import { openStore } from "../src/db.mjs";
import { createIntegrations } from "../src/integrations/manager.mjs";
import { answerStamp, chunk, liveStatusLine, markdownToPlain, markdownToTelegramHtml, withAgentFooter } from "../src/integrations/format.mjs";
import { createRunner } from "../src/runner.mjs";
import { seedExampleAgents } from "./fixture-agents.mjs";

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout");
};

// A Bot API server in memory: tests push updates; the bot's calls are recorded.
function fakeBotApi() {
  const calls = [];
  const queue = [];
  let waiter = null;
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body || "{}");
    if (String(url).includes("/botBAD")) return Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
    if (method === "getUpdates") {
      if (!queue.length) await new Promise((resolve) => { waiter = resolve; init.signal?.addEventListener("abort", resolve); });
      const updates = queue.splice(0);
      return Response.json({ ok: true, result: updates });
    }
    calls.push({ method, body });
    if (method === "getMe") return Response.json({ ok: true, result: { username: "griffin_test_bot", first_name: "Griffin" } });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  let id = 0;
  const push = (update) => { queue.push({ update_id: ++id, ...update }); waiter?.(); waiter = null; };
  return { fetchImpl, calls, push, sent: () => calls.filter((c) => /^send/.test(c.method)) };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-int-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  seedExampleAgents(store);
  // Same cycle-breaking holder as production (index.mjs): asks needs to tell integrations a
  // question closed, but integrations itself is built later (it takes asks as an argument).
  const integrationsHolder = { current: null };
  const asks = createAsks({ store, onSettled: (chatId, info) => integrationsHolder.current?.clearQuestion(chatId, info) });
  const bot = fakeBotApi();
  // Agent: asks a question when the message says "بپرس", otherwise answers and returns a file.
  const sdk = {
    async create(options) {
      return {
        agentId: "a1",
        async send(message, sendOptions) {
          const text = typeof message === "string" ? message : message.text;
          return {
            id: "r", supports: () => true, async cancel() {},
            async wait() {
              if (/بپرس/.test(text)) {
                const args = { question: "کدام کلاستر؟", options: [{ label: "پروداکشن" }, { label: "دی‌آر" }] };
                const call = { type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: ASK_TOOL, args } };
                await sendOptions.onDelta({ update: { type: "tool-call-started", callId: "q1", toolCall: call } });
                const result = await options.local.customTools[ASK_TOOL].execute(args);
                const answer = JSON.parse(result.content[0].text).answer;
                await sendOptions.onDelta({ update: { type: "tool-call-completed", callId: "q1", toolCall: { ...call, result: { status: "success", value: result } } } });
                await sendOptions.onDelta({ update: { type: "text-delta", text: `باشه، **${answer}**` } });
              } else {
                const mediaId = store.saveMedia({ chatId: store.listChats({ archived: false })[0].id, mimeType: "image/png", data: Buffer.from("png"), meta: {} });
                const summary = JSON.stringify({ title: "عکس", media: { mediaId, mimeType: "image/png", name: "a.png" } });
                const call = { type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: "show_media", args: {} } };
                await sendOptions.onDelta({ update: { type: "tool-call-completed", callId: "m1", toolCall: { ...call, result: { status: "success", value: { content: [{ text: { text: summary } }] } } } } });
                await sendOptions.onDelta({ update: { type: "text-delta", text: "| a | b |\n|---|---|\n| 1 | 2 |" } });
              }
              return { status: "finished" };
            },
          };
        },
      };
    },
  };
  const runner = createRunner({ store, sdk, log: {}, onCancel: (c) => asks.cancel(c), agentOptions: (chat) => ({ local: { customTools: { [ASK_TOOL]: asks.tool(chat.id) } } }) });
  const integrations = createIntegrations({ store, runner, asks, fetchImpl: bot.fetchImpl, log: {} });
  integrationsHolder.current = integrations;
  const cleanup = async () => {
    integrations.stopAll();
    // In-flight ask_owner delivers may still touch the store after stopAll.
    await new Promise((r) => setTimeout(r, 50));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, bot, integrations, runner, asks, cleanup };
}

const msg = (chatId, text, extra = {}) => ({ message: { message_id: 1, chat: { id: chatId, first_name: "سارا" }, text, ...extra } });

test("bot: wrong token rejected; strangers ignored; pairing; message → run → answer and file back", async () => {
  const { store, bot, integrations, cleanup } = setup();
  try {
    await assert.rejects(integrations.addBot({ kind: "telegram_bot", token: "BAD" }), /Unauthorized/);
    const added = await integrations.addBot({ kind: "telegram_bot", token: "123:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    assert.equal(added.username, "griffin_test_bot");
    assert.match(added.pairingCode, /^[A-Z0-9]{8}$/);
    assert.equal(JSON.stringify(integrations.list()).includes("ABCDEFGHIJ"), false, "token never listed");

    bot.push(msg(555, "سلام"));
    bot.push(msg(555, "/start WRONGCODE"));
    await until(() => bot.sent().length === 1);
    assert.match(bot.sent()[0].body.text, /خصوصی/);
    assert.equal(store.listChats({ archived: false }).length, 0, "stranger created nothing");

    bot.push(msg(777, `/start ${added.pairingCode}`));
    await until(() => bot.sent().some((c) => /وصل شد/.test(c.body.text || "")));
    assert.deepEqual(integrations.list()[0].paired, [{ id: "777", name: "سارا" }]);
    assert.equal(integrations.list()[0].pairingCode, null, "code is single-use");

    bot.push(msg(777, "عکس را نشان بده"));
    await until(() => bot.calls.some((c) => c.method === "sendPhoto"));
    const reply = bot.sent().findLast((c) => c.method === "sendMessage");
    assert.equal(reply.body.parse_mode, "HTML");
    assert.match(reply.body.text, /<pre>a │ b\n1 │ 2<\/pre>/);
    assert.match(reply.body.text, /⏱ [۰-۹]{2}:[۰-۹]{2} · [۰-۹]+ث/, "the owner's answer says when it came and how long it took");
    assert.equal(bot.calls.find((c) => c.method === "sendPhoto").body.chat_id, "777");
    assert.equal(store.listChats({ archived: false }).length, 1);
  } finally {
    await cleanup();
  }
});

test("bot: getUpdates Conflict becomes unavailable with Persian userMessage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-conflict-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  seedExampleAgents(store);
  const asks = createAsks();
  const runner = createRunner({ store, sdk: { create: async () => ({ agentId: "a", send: async () => ({ id: "r", supports: () => true, cancel: async () => {}, wait: async () => ({ status: "finished" }) }) }) }, log: {}, agentOptions: () => ({}) });
  let polls = 0;
  const fetchImpl = async (url) => {
    const method = String(url).split("/").pop();
    if (method === "getMe") return Response.json({ ok: true, result: { username: "x_bot" } });
    if (method === "getUpdates") {
      polls += 1;
      return Response.json({ ok: false, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" }, { status: 409 });
    }
    return Response.json({ ok: true, result: {} });
  };
  const integrations = createIntegrations({ store, runner, asks, fetchImpl, log: {} });
  try {
    await integrations.addBot({ kind: "telegram_bot", token: "1:CONFLICTTOKENXXXXXXXXXXXX" });
    await until(() => integrations.list()[0]?.status?.state === "unavailable", 5000);
    const view = integrations.list()[0];
    assert.equal(view.status.state, "unavailable");
    assert.match(view.status.userMessage || "", /getUpdates|دریافت/);
    assert.ok(polls >= 1);
  } finally {
    integrations.stopAll();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bot: ask_owner becomes buttons; tapping one answers the waiting agent; /new starts a fresh chat", async () => {
  const { store, bot, integrations, cleanup } = setup();
  try {
    const added = await integrations.addBot({ kind: "bale_bot", token: "999:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    bot.push(msg(42, `/start ${added.pairingCode}`));
    await until(() => bot.sent().length === 1);
    bot.push(msg(42, "بپرس"));
    await until(() => bot.sent().some((c) => c.body.reply_markup));
    const question = bot.sent().find((c) => c.body.reply_markup);
    assert.match(question.body.text, /کدام کلاستر/);
    assert.equal(question.body.parse_mode, undefined, "Bale gets plain text");
    assert.deepEqual(question.body.reply_markup.inline_keyboard.map((row) => row[0].text), ["پروداکشن", "دی‌آر"]);
    const cb = question.body.reply_markup.inline_keyboard[1][0].callback_data;
    assert.match(cb, /^a:[a-f0-9]+:1$/i, "button bound to ask id");

    bot.push({ callback_query: { id: "cb1", data: cb, from: { id: 42 }, message: { chat: { id: 42 } } } });
    await until(() => bot.sent().some((c) => /باشه، دی‌آر/.test(c.body.text || "")));

    const first = store.linkedChat(added.id, "42");
    bot.push(msg(42, "/new"));
    await until(() => bot.sent().some((c) => /تازه شروع شد/.test(c.body.text || "")));
    assert.equal(store.linkedChat(added.id, "42"), null);
    assert.ok(store.getChat(first), "old chat kept");
  } finally {
    await cleanup();
  }
});

test("coverage ask buttons stay bound to their own chat", async () => {
  const { parseAskCallback } = await import("../src/integrations/bots.mjs");
  const { COVERAGE_CALLER } = await import("../src/integrations/coverage.mjs");
  const { store, bot, integrations, runner, cleanup } = setup();
  try {
    const added = await integrations.addBot({ kind: "telegram_bot", token: "111:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    store.createIntegration({
      kind: "telegram_account",
      name: "acc",
      secret: "{}",
      settings: { me: { id: "5781", name: "Owner" } },
    });
    const peerA = store.createChat({ title: "/agent · A", mode: "agent", caller: COVERAGE_CALLER });
    const peerB = store.createChat({ title: "/agent · B", mode: "agent", caller: COVERAGE_CALLER });
    store.linkChat(added.id, "1001", peerA.id);
    store.linkChat(added.id, "1002", peerB.id);
    store.updateIntegration(added.id, {
      settings: {
        pairedChats: ["5781", "1001", "1002"],
        pairedNames: { 5781: "Owner", 1001: "Rad", 1002: "Team C" },
        username: "griffinops_bot",
        coverage: {
          1001: { name: "Rad", chatId: peerA.id, startedAt: new Date().toISOString() },
          1002: { name: "Team C", chatId: peerB.id, startedAt: new Date().toISOString() },
        },
      },
    });

    const ask = (chatId, q) => store.appendEvent(chatId, "r", "ask.pending", { question: q, options: [{ label: "بله" }, { label: "خیر" }] });
    ask(peerA.id, "تأیید کار احمدی؟");
    ask(peerB.id, "تأیید کار نوری؟");
    await until(() => bot.sent().filter((c) => c.body.reply_markup && /از گفتگو/.test(c.body.text || "")).length >= 2);

    const questions = bot.sent().filter((c) => c.body.reply_markup && /از گفتگو/.test(c.body.text || ""));
    const ente = questions.find((c) => /احمدی/.test(c.body.text));
    const sali = questions.find((c) => /نوری/.test(c.body.text));
    assert.ok(ente && sali);
    const enteCb = ente.body.reply_markup.inline_keyboard[0][0].callback_data;
    const saliCb = sali.body.reply_markup.inline_keyboard[0][0].callback_data;
    assert.notEqual(parseAskCallback(enteCb).askId, parseAskCallback(saliCb).askId);
    assert.equal(integrations.bridge.openOwnerAskCount(), 2);

    // With two open asks, a bare number must not guess which chat.
    assert.equal(await integrations.bridge.answerOwnerAsk(added.id, 0, null), false);
    assert.equal(integrations.bridge.openOwnerAskCount(), 2);

    const enteAsk = parseAskCallback(enteCb);
    assert.equal(await integrations.bridge.answerOwnerAsk(added.id, enteAsk.index, enteAsk.askId), true);
    assert.equal(integrations.bridge.openOwnerAskCount(), 1);

    const saliAsk = parseAskCallback(saliCb);
    assert.equal(await integrations.bridge.answerOwnerAsk(added.id, saliAsk.index, saliAsk.askId), true);
    assert.equal(integrations.bridge.openOwnerAskCount(), 0);

    await runner.cancel(peerA.id).catch(() => {});
    await runner.cancel(peerB.id).catch(() => {});
  } finally {
    await cleanup();
  }
});

test("answer stamp: Tehran clock and duration, nothing without an end time", () => {
  assert.equal(answerStamp({ startedAt: "2026-09-24T06:04:16Z", endedAt: "2026-09-24T06:04:39Z" }), "⏱ ۰۹:۳۴ · ۲۳ث");
  assert.equal(answerStamp({ startedAt: "2026-09-24T06:00:00Z", endedAt: "2026-09-24T06:02:05Z" }), "⏱ ۰۹:۳۲ · ۲د ۵ث");
  assert.equal(answerStamp({ endedAt: "2026-09-24T06:04:39Z" }), "⏱ ۰۹:۳۴");
  assert.equal(answerStamp({ startedAt: "2026-09-24T06:04:16Z" }), "");
});

test("formatting", () => {
  assert.equal(markdownToTelegramHtml("**فروش** `169` <x>"), "<b>فروش</b> <code>169</code> &lt;x&gt;");
  assert.equal(markdownToPlain("**a** [b](https://x.y)"), "a b (https://x.y)");
  assert.deepEqual(chunk("a".repeat(10), 4).map((p) => p.length), [4, 4, 2]);
  assert.equal(liveStatusLine({ type: "run.started" }), "شروع کار…");
  assert.equal(liveStatusLine({ type: "tool.started", data: { name: "kube_logs", args: { cluster: "prod", pod: "x" } } }), "خواندن لاگ: prod · x");
  assert.equal(liveStatusLine({ type: "tool.started", data: { name: "ask_owner" } }), "منتظر تأیید Owner");
  assert.equal(
    liveStatusLine({
      type: "tool.started",
      data: { name: "ask_agent", args: { agent: "platform", request: "فضای آزاد دیسک ۱" } },
    }),
    "platform در حال انجام فضای آزاد دیسک ۱…",
  );
  assert.equal(liveStatusLine({ type: "text.delta" }), null);
  assert.match(withAgentFooter("سلام"), /سلام\n\n— گریفین$/);
  assert.equal(withAgentFooter(withAgentFooter("سلام")), withAgentFooter("سلام"));
  assert.equal(withAgentFooter("سلام\n\n— گریفین"), "سلام\n\n— گریفین");
});

test("telegram account: live status edits one line then deletes before final", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  const outbox = [];
  const edits = [];
  const deletes = [];
  let nextId = 800;
  const fakeClient = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "owner" }),
    addEventHandler: () => {},
    sendMessage: async (to, { message }) => { const id = ++nextId; outbox.push({ to: String(to), message, id }); return { id }; },
    editMessage: async (to, { message, text }) => { edits.push({ to: String(to), id: message, text }); },
    deleteMessages: async (to, ids) => { deletes.push({ to: String(to), ids: [...ids] }); },
    getEntity: async (x) => x,
    getDialogs: async () => [],
    getMessages: async () => [],
    disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return fakeClient; }, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const bridge = {
    receive: async () => {}, answer: async () => false, answerOwnerAsk: async () => false,
    isCovered: () => false, coverageName: () => null, startCoverage: async () => ({}), endCoverage: async () => null,
  };
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge, load, log: {} });
  await channel.start();

  await channel.deliver("55", { status: "شروع کار…" });
  assert.match(outbox.at(-1).message, /⏳ شروع کار/);
  const statusId = outbox.at(-1).id;

  await channel.deliver("55", { status: "خواندن لاگ: prod" });
  assert.equal(edits.length, 1);
  assert.equal(edits[0].id, statusId);
  assert.match(edits[0].text, /خواندن لاگ/);
  assert.equal(outbox.filter((m) => m.to === "55").length, 1, "status stays one message");

  await channel.deliver("55", { text: "کار انجام شد." });
  assert.deepEqual(deletes[0]?.ids, [statusId]);
  assert.ok(outbox.some((m) => /کار انجام شد\./.test(m.message) && /گریفین/.test(m.message)));
});

test("telegram account tools: read, and send directly to the named chat", async () => {
  const { createAccountTools } = await import("../src/integrations/telegram-account.mjs");
  const sent = [];
  const client = {
    getDialogs: async () => [{ id: 1n, title: "آلارم‌های گریفین", isChannel: true, isGroup: true, entity: { username: "alerts" }, unreadCount: 3, date: 1789400000 }],
    getMessages: async (_entity, opts) => [{ id: 9, date: 1789400000, message: "disk full", sender: { firstName: "بات" }, media: null }].slice(0, opts.limit),
    sendMessage: async (entity, { message }) => { sent.push({ entity, message }); return { id: 10 }; },
    getEntity: async () => ({ title: "x" }),
  };
  const tools = createAccountTools({ getClient: () => client });
  const parse = (r) => JSON.parse(r.content[0].text);

  assert.equal(parse(await tools.telegram_dialogs.execute({ query: "آلارم" })).dialogs[0].type, "supergroup");
  const read = parse(await tools.telegram_read.execute({ chat: "آلارم", limit: 5 }));
  assert.equal(read.chat, "آلارم‌های گریفین");
  assert.equal(read.messages[0].text, "disk full");

  const done = parse(await tools.telegram_send.execute({ chat: "آلارم", text: "دیسک پاک شد" }));
  assert.equal(done.sent, true);
  assert.equal(done.chat, "آلارم‌های گریفین");
  assert.deepEqual(sent.map((s) => s.message), ["دیسک پاک شد"]);

  const none = createAccountTools({ getClient: () => null });
  assert.match(parse(await none.telegram_read.execute({ chat: "x" })).error, /no Telegram account/);
});

test("telegram account: Saved Messages bridge ignores its own replies and maps numbered answers", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  let handler;
  const outbox = [];
  const fakeClient = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "owner" }),
    addEventHandler: (fn) => { handler = fn; },
    sendMessage: async (_to, { message }) => { outbox.push(message); return { id: 500 + outbox.length }; },
    editMessage: async () => {},
    deleteMessages: async () => {},
    getDialogs: async () => [],
    getMessages: async () => [],
    disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return fakeClient; }, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const received = [];
  const answers = [];
  const bridge = {
    receive: async (...a) => received.push(a),
    answer: async (id, chat, index) => { answers.push(index); return index === 0; },
    answerOwnerAsk: async () => false,
    isCovered: () => false,
    coverageName: () => null,
    startCoverage: async () => ({}),
    endCoverage: async () => null,
  };
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge, load, log: {} });
  await channel.start();
  assert.equal(channel.status.state, "polling");

  await handler({ message: { out: true, chatId: 100n, id: 1, message: "گریفین فروش امروز؟" } });
  await handler({ message: { out: true, chatId: 200n, id: 2, message: "to someone else" } });
  await handler({ message: { out: false, chatId: 100n, id: 3, message: "incoming" } });
  await handler({ message: { out: true, chatId: 100n, id: 4, message: "یک یادداشت خصوصی" } }); // no trigger → ignored
  assert.deepEqual(received.map((r) => r[2].text), ["فروش امروز؟"]); // trigger stripped

  await channel.deliver("me", { question: { question: "کدام؟", options: [{ label: "الف" }, { label: "ب" }] } });
  assert.ok(outbox.some((m) => /🤖 ❓ کدام؟\n\n1\. الف\n2\. ب/.test(m)), "question delivered with numbered options");
  await handler({ message: { out: true, chatId: 100n, id: 501, message: outbox.at(-1) } });
  assert.equal(received.length, 1, "own reply not treated as a prompt");
  await handler({ message: { out: true, chatId: 100n, id: 7, message: "1" } });
  assert.deepEqual(answers, [0]);
  assert.equal(received.length, 1);
});

test("telegram account: /agent starts stand-in; agent intro run; /agent off kills", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  const { COVERAGE_CALLER } = await import("../src/integrations/coverage.mjs");
  let handler;
  const outbox = [];
  const fakeClient = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "owner" }),
    addEventHandler: (fn) => { handler = fn; },
    sendMessage: async (to, { message }) => { outbox.push({ to: String(to), message }); return { id: 700 + outbox.length }; },
    editMessage: async () => {},
    deleteMessages: async () => {},
    getEntity: async () => ({ firstName: "علی", lastName: "تیم" }),
    getDialogs: async () => [],
    getMessages: async () => [],
    disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return fakeClient; }, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const covered = new Set();
  const received = [];
  const started = [];
  const ended = [];
  const bridge = {
    receive: async (...a) => received.push(a),
    answer: async () => false,
    answerOwnerAsk: async () => false,
    isCovered: (_id, peer) => covered.has(String(peer)),
    coverageName: () => "علی تیم",
    startCoverage: async (_id, peer, meta) => { covered.add(String(peer)); started.push(meta); return meta; },
    endCoverage: async (_id, peer) => { covered.delete(String(peer)); ended.push(peer); return { name: "علی تیم" }; },
  };
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge, load, log: {} });
  await channel.start();

  await handler({ message: { out: true, chatId: 55n, peerId: { userId: 55n }, id: 1, message: "/agent" } });
  assert.equal(started.length, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0][2].caller, COVERAGE_CALLER);
  assert.match(received[0][2].text, /معرفی|تاریخچه/);
  assert.ok(outbox.some((m) => /\/agent برای «علی تیم»/.test(m.message)));
  assert.ok(!outbox.some((m) => /از این لحظه پاسخ‌دهنده/.test(m.message)), "no canned announce to peer");

  await handler({ message: { out: false, chatId: 55n, peerId: { userId: 55n }, id: 2, message: "دیسک پروداکشن پر شده" } });
  assert.equal(received.length, 1, "peer inbound ignored in owner-only mode");

  await handler({ message: { out: true, chatId: 55n, peerId: { userId: 55n }, id: 3, message: "/agent off" } });
  assert.deepEqual(ended, ["55"]);
  assert.ok(!outbox.some((m) => /کار ایجنت پلتفرم‌بان در این گفتگو تمام شد/.test(m.message)), "no canned end to peer");
});

test("telegram account: /agent as reply focuses that message and replies to it", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  const { COVERAGE_CALLER } = await import("../src/integrations/coverage.mjs");
  let handler;
  const outbox = [];
  const fakeClient = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "owner" }),
    addEventHandler: (fn) => { handler = fn; },
    sendMessage: async (to, opts) => { outbox.push({ to: String(to), message: opts.message, replyTo: opts.replyTo || null }); return { id: 900 + outbox.length }; },
    editMessage: async () => {},
    deleteMessages: async () => {},
    getEntity: async () => ({ firstName: "Ahmadi", username: "aliahmadi" }),
    getDialogs: async () => [],
    getMessages: async () => [],
    disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return fakeClient; }, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const covered = new Set();
  const received = [];
  const bridge = {
    receive: async (...a) => received.push(a),
    answer: async () => false,
    answerOwnerAsk: async () => false,
    isCovered: (_id, peer) => covered.has(String(peer)),
    coverageName: () => "Ahmadi",
    startCoverage: async (_id, peer, meta) => { covered.add(String(peer)); return meta; },
    endCoverage: async () => null,
  };
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge, load, log: {} });
  await channel.start();

  await handler({
    message: {
      out: true, chatId: 41026785n, peerId: { userId: 41026785n }, id: 10, message: "/agent",
      replyTo: { replyToMsgId: 446436 },
      getReplyMessage: async () => ({ id: 446436, message: "ماچ به لپت" }),
    },
  });
  assert.equal(covered.has("41026785"), true);
  assert.equal(received.length, 1);
  assert.equal(received[0][2].caller, COVERAGE_CALLER);
  assert.match(received[0][2].text, /ماچ به لپت/);
  assert.match(received[0][2].text, /پیامی که باید جوابش را بدهی/);
  assert.doesNotMatch(received[0][2].text, /معرفی کن/);

  await channel.deliver("41026785", { text: "قربونتون ولی ایجنتیک 😁" });
  const replied = outbox.find((m) => m.replyTo === 446436);
  assert.ok(replied, `expected replyTo=446436 in ${JSON.stringify(outbox)}`);
  assert.match(replied.message, /قربونتون/);
  assert.match(replied.message, /— گریفین/);
});

test("Saved Messages: acts only when called by name; leaves notes and passwords alone", async () => {
  const { callToGriffin } = await import("../src/integrations/telegram-account.mjs");
  assert.equal(callToGriffin("گریفین فروش امروز چقدر بود؟"), "فروش امروز چقدر بود؟");
  assert.equal(callToGriffin("griffin وضعیت کلاستر"), "وضعیت کلاستر");
  assert.equal(callToGriffin("@گریفین: دیسک ۱"), "دیسک ۱");
  assert.equal(callToGriffin("گریفین وضعیت کلاستر"), "وضعیت کلاستر");
  assert.equal(callToGriffin("گریف دیسک ۱"), "دیسک ۱");
  assert.equal(callToGriffin("/ask رمز دیتابیس"), "رمز دیتابیس");
  assert.equal(callToGriffin(". لاگ پاد"), "لاگ پاد");
  // untouched: plain notes and secrets
  assert.equal(callToGriffin("WEdKQDISfJLIVXAVoylQXYRZXR2uHu7E"), null);
  assert.equal(callToGriffin("یادداشت: فردا جلسه ساعت ۱۰"), null);
  assert.equal(callToGriffin("گریف"), null, "name with no request is ignored");
  assert.equal(callToGriffin("گریفین"), null, "griffin name alone is ignored");
});

test("owner web-chat ask_owner (no messenger link) is pushed to the Owner's bot", async () => {
  const { store, bot, integrations, cleanup } = setup();
  try {
    const added = await integrations.addBot({ kind: "telegram_bot", token: "222:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    // A bot paired with the Owner's numeric id, no chat linked to any messenger.
    store.updateIntegration(added.id, {
      settings: { pairedChats: ["777"], pairedNames: { 777: "Owner" }, username: "griffinops_bot" },
    });
    const chat = store.createChat({ title: "chat", mode: "agent", caller: "owner", agent: "griffin" });
    store.appendEvent(chat.id, "r", "ask.pending", { question: "PVC را حذف کنم؟", options: [{ label: "بله" }, { label: "خیر" }] });
    await until(() => bot.sent().some((c) => c.body.reply_markup && /PVC را حذف کنم/.test(c.body.text || "")));
    assert.equal(integrations.bridge.openOwnerAskCount(), 1);
    const sent = bot.sent().find((c) => /PVC را حذف کنم/.test(c.body.text || ""));
    assert.equal(String(sent.body.chat_id), "777");
  } finally {
    await cleanup();
  }
});

// A question inside a chain an external agent started is still the owner's to answer: it must
// reach their Telegram (nobody may have a browser tab open), tagged with who is asking. Only a
// clarification the agent marked audience:"requester" stays with the requester.
test("a peer's chain asks the Owner in Telegram; a clarification does not", async () => {
  const { store, bot, integrations, cleanup } = setup();
  try {
    const added = await integrations.addBot({ kind: "telegram_bot", token: "333:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    store.updateIntegration(added.id, {
      settings: { pairedChats: ["777"], pairedNames: { 777: "Owner" }, username: "griffinops_bot" },
    });
    store.createPeerUser({ id: "reza-nouri", label: "آقای رضایی" });
    const chat = store.createChat({ title: "peer", caller: "peer:reza-nouri", agent: "griffin" });

    store.appendEvent(chat.id, "r", "ask.pending", { question: "دسترسی VPN صادر شود؟", options: [{ label: "بله" }, { label: "نه" }] });
    await until(() => bot.sent().some((c) => /دسترسی VPN صادر شود/.test(c.body.text || "")));
    const sent = bot.sent().find((c) => /دسترسی VPN صادر شود/.test(c.body.text || ""));
    assert.equal(String(sent.body.chat_id), "777");
    assert.match(sent.body.text, /آقای رضایی/, "the owner sees whose request it is");

    const before = bot.sent().length;
    store.appendEvent(chat.id, "r", "ask.pending", { question: "کدام کلاستر؟", options: [{ label: "پروداکشن" }], audience: "requester" });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(bot.sent().length, before, "a clarification for the requester is not pushed to the Owner");
  } finally {
    await cleanup();
  }
});

test("answering an ask_owner from the UI deletes the mirrored Telegram question; only open ones stay", async () => {
  const { store, bot, integrations, asks, cleanup } = setup();
  try {
    const added = await integrations.addBot({ kind: "telegram_bot", token: "333:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    store.updateIntegration(added.id, {
      settings: { pairedChats: ["777"], pairedNames: { 777: "Owner" }, username: "griffinops_bot" },
    });
    const chat = store.createChat({ title: "chat", mode: "agent", caller: "owner", agent: "griffin" });
    // Simulated ask_owner tool call actually waiting, as the SDK would set up mid-run.
    const pending = asks.tool(chat.id).execute({ question: "PVC را حذف کنم؟", options: [{ label: "بله" }, { label: "خیر" }] });
    await until(() => bot.sent().some((c) => c.body.reply_markup && /PVC را حذف کنم/.test(c.body.text || "")));
    // fakeBotApi answers every non-getUpdates call with { message_id: calls.length } (1-based) —
    // recover the id it assigned to the question message from its position in the call log.
    const sentCallIndex = bot.calls.findIndex((c) => c.method === "sendMessage" && /PVC را حذف کنم/.test(c.body.text || ""));
    const assignedMessageId = sentCallIndex + 1;

    await until(() => asks.isWaiting(chat.id));

    // Owner answers from the web UI (this is what POST /api/chats/:id/answer does).
    assert.equal(asks.answer(chat.id, { answer: "بله", selected: ["بله"] }), true);
    await pending;

    // The message stays, minus its buttons, so the owner can see their tap landed — and so a
    // question sent before a restart can never look answerable again.
    await until(() => bot.calls.some((c) => c.method === "editMessageText" && /پاسخ: بله/.test(c.body.text || "")));
    const closed = bot.calls.find((c) => c.method === "editMessageText" && /پاسخ: بله/.test(c.body.text || ""));
    assert.match(closed.body.text, /PVC را حذف کنم/, "the question stays readable above the answer");
    assert.equal(String(closed.body.chat_id), "777");
    assert.equal(closed.body.message_id, assignedMessageId);
    assert.deepEqual(closed.body.reply_markup.inline_keyboard, []);
    assert.equal(integrations.bridge.openOwnerAskCount(), 0, "no longer open once answered from the UI");

    // And a restart leaves nothing tappable behind.
    store.appendEvent(chat.id, "r2", "ask.pending", { question: "یکی دیگر؟", options: [{ label: "بله" }] });
    await until(() => bot.sent().some((c) => /یکی دیگر/.test(c.body.text || "")));
    const swept = await integrations.sweepStaleAsks();
    assert.equal(swept, 1);
    assert.ok(bot.calls.some((c) => c.method === "editMessageText" && /دیگر باز نیست/.test(c.body.text || "")));
  } finally {
    await cleanup();
  }
});

// A delegated child's question is mirrored onto the root chat by asks; only that copy may reach
// Telegram. Delivering the child's own tool.started too sent every question twice (2026-09-22).
test("a delegated child's question reaches the Owner once, under the root requester", async () => {
  const { store, bot, integrations, asks, cleanup } = setup();
  try {
    const added = await integrations.addBot({ kind: "telegram_bot", token: "444:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    store.updateIntegration(added.id, {
      settings: { pairedChats: ["777"], pairedNames: { 777: "Owner" }, username: "griffin_ops_bot" },
    });
    store.createPeerUser({ id: "ali-ahmadi", label: "آقای احمدی" });
    const root = store.createChat({ title: "peer", caller: "peer:ali-ahmadi", agent: "griffin" });
    const child = store.createChat({ title: "child", caller: "griffin", agent: "platform", parentChatId: root.id });
    assert.equal(store.rootChatId(child.id), root.id);

    store.appendEvent(child.id, "r", "tool.started", { name: "ask_owner", args: { question: "روتر را بخوانم؟", options: [{ label: "بله" }, { label: "نه" }] } });
    const pending = asks.tool(child.id).execute({ question: "روتر را بخوانم؟", options: [{ label: "بله" }, { label: "نه" }] });
    await until(() => bot.sent().some((c) => /روتر را بخوانم/.test(c.body.text || "")));
    await new Promise((r) => setTimeout(r, 120));
    const copies = bot.sent().filter((c) => /روتر را بخوانم/.test(c.body.text || ""));
    assert.equal(copies.length, 1, "one message per question");
    assert.match(copies[0].body.text, /آقای احمدی/);
    assert.doesNotMatch(copies[0].body.text, /از مسیر «griffin»/);

    assert.equal(await integrations.bridge.answerOwnerAsk(added.id, 0), true);
    assert.deepEqual(JSON.parse((await pending).content[0].text).answer, "بله");

    // A guard approval raised inside the child keeps its yes/no buttons on the way up.
    const confirm = asks.confirm(child.id, { question: "روتر: کار دوم؟" });
    await until(() => bot.sent().some((c) => /کار دوم/.test(c.body.text || "")));
    const approval = bot.sent().find((c) => /کار دوم/.test(c.body.text || ""));
    assert.equal(approval.body.reply_markup?.inline_keyboard?.length, 2);
    assert.equal(await integrations.bridge.answerOwnerAsk(added.id, 1), true);
    assert.equal((await confirm).answer, "نه");
  } finally {
    await cleanup();
  }
});

// Owner 2026-09-23: «پیام خودکار رو خاموش کن» — Griffin no longer answers colleagues' signed
// assistants from the owner's account unless settings.autoReplyAgents is turned on.
test("telegram account: assistant-signed DMs are answered only when autoReplyAgents is on", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  let handler;
  const fakeClient = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "owner" }),
    addEventHandler: (fn) => { handler = fn; },
    sendMessage: async () => ({ id: 900 }), editMessage: async () => {}, deleteMessages: async () => {},
    getDialogs: async () => [], getMessages: async () => [], getEntity: async () => ({ firstName: "Maryam" }), disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return fakeClient; }, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const settings = {};
  const peerCalls = [];
  const person = { id: "p1", display_name: "Maryam", access: { peerAgent: { user: "maryam-sadeghi" } } };
  const bridge = {
    integration: () => ({ settings }),
    upsertPerson: async () => person,
    addPersonMessage: () => {},
    receive: async () => {}, answer: async () => false, answerOwnerAsk: async () => false,
    isCovered: () => false, coverageName: () => null, startCoverage: async () => ({}), endCoverage: async () => null,
    bindPeerAgentPerson: async () => ({ user: "maryam-sadeghi", created: false }),
    receivePeerAgent: async (...a) => peerCalls.push(a),
  };
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge, load, log: {} });
  await channel.start();
  const signed = { out: false, chatId: 42n, peerId: { userId: 42n }, id: 11, message: "سلام سارا، لاگ n8n رو می‌خوام\n— دستیار هوشمند مریم صادقی (پیام خودکار)" };

  await handler({ message: signed });
  assert.equal(peerCalls.length, 0, "off by default: no automatic reply");

  settings.autoReplyAgents = true;
  await handler({ message: { ...signed, id: 12 } });
  assert.equal(peerCalls.length, 1, "on: answered agent-to-agent");
});

// In a colleague's linked Telegram chat, approvals went nowhere (the bridge read
// tool.started, which streaming providers log with empty args) and ask_requester was never delivered.
test("in a colleague's linked chat, approval goes to the Owner's bot and a clarification to the colleague", async () => {
  const { store, bot, integrations, asks, cleanup } = setup();
  try {
    const added = await integrations.addBot({ kind: "telegram_bot", token: "555:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    store.updateIntegration(added.id, {
      settings: { pairedChats: ["777"], pairedNames: { 777: "Owner" }, username: "griffin_ops_bot" },
    });
    store.createPeerUser({ id: "maryam-sadeghi", label: "مریم صادقی" });
    const chat = store.createChat({ title: "peer", caller: "peer:maryam-sadeghi", agent: "griffin" });
    store.linkChat(added.id, "91499258", chat.id);

    asks.tool(chat.id).execute({ question: "دسترسی n8n بدهم؟", options: [{ label: "بله" }, { label: "نه" }] });
    await until(() => bot.sent().some((c) => /دسترسی n8n بدهم/.test(c.body.text || "")));
    const approval = bot.sent().find((c) => /دسترسی n8n بدهم/.test(c.body.text || ""));
    assert.equal(String(approval.body.chat_id), "777", "the approval reaches the Owner, not the colleague");

    asks.answer(chat.id, { answer: "بله", selected: ["بله"] });
    asks.requesterTool(chat.id).execute({ question: "ایمیلت چیه؟" });
    await until(() => bot.sent().some((c) => /ایمیلت چیه/.test(c.body.text || "")));
    const clarify = bot.sent().find((c) => /ایمیلت چیه/.test(c.body.text || ""));
    assert.equal(String(clarify.body.chat_id), "91499258", "the clarification reaches the colleague");
  } finally {
    await cleanup();
  }
});

// 2026-09-24 (owner): teammate DMs thread themselves. Idle → a classifier decides; open → every
// message, either side, feeds the thread; «گریفین» reopens; groups and non-team people never.
test("telegram account: teammate DMs open, feed and reopen Griffin threads", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  let handler;
  const fakeClient = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "owner" }),
    addEventHandler: (fn) => { handler = fn; },
    sendMessage: async () => ({ id: 900 }), editMessage: async () => {}, deleteMessages: async () => {},
    getEntity: async () => ({ firstName: "Karimi", username: "skarimi" }),
    getDialogs: async () => [], getMessages: async () => [], disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return fakeClient; }, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const covered = new Map();
  const received = [];
  const classified = [];
  let category = "team";
  const bridge = {
    integration: () => ({ settings: {} }),
    upsertPerson: async () => ({ id: "p1", display_name: "سارا کریمی", username: "skarimi", category }),
    addPersonMessage: () => {},
    receive: async (...a) => received.push(a),
    answer: async () => false, answerOwnerAsk: async () => false,
    isCovered: (_id, peer) => covered.has(String(peer)),
    coverageName: () => "Karimi",
    classifyThread: async (args) => { classified.push(args); return { start: /خرابه|درست کن/.test(args.message), topic: "پوش با توکن", reason: "request" }; },
    startCoverage: async (_id, peer, meta) => { covered.set(String(peer), meta); return meta; },
    endCoverage: async (_id, peer) => { covered.delete(String(peer)); return null; },
  };
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge, load, log: {} });
  await channel.start();
  const dm = (id, text, out = false) => handler({ message: { out, chatId: 272188041n, peerId: { userId: 272188041n }, id, message: text } });

  await dm(1, "سلام خوبی؟");
  assert.equal(received.length, 0, "small talk opens nothing");
  assert.equal(classified.at(-1).from, "teammate");

  await dm(2, "پایپ‌لاین patient خرابه");
  assert.equal(covered.has("272188041"), true, "a real request opens and locks a thread");
  assert.equal(covered.get("272188041").fresh, true);
  assert.match(covered.get("272188041").title, /پوش با توکن/);
  assert.match(received.at(-1)[2].text, /رشتهٔ تازه/);

  const before = classified.length;
  await dm(3, "اشتباه نمیکنه؟");
  assert.equal(classified.length, before, "inside a thread nothing is re-classified");
  assert.match(received.at(-1)[2].text, /^«سارا کریمی»: /);
  assert.match(received.at(-1)[2].text, /اشتباه نمیکنه؟$/);

  await dm(4, "من خودم چکش کردم، توکنش مال کریمیه", true);
  assert.equal(covered.has("272188041"), true, "the owner typing does not close the thread or cancel its work");
  assert.match(received.at(-1)[2].text, /در تلگرام به سارا کریمی»: /, "the owner's message reaches the thread as context");
  covered.delete("272188041");

  const asked = classified.length;
  await dm(41, "سرور خرابه درست کن");
  assert.equal(covered.has("272188041"), false, "while the owner is in the conversation, nothing opens");
  assert.equal(classified.length, asked, "not even a classification");

  await dm(42, "باشه، بزنم؟", true);
  assert.equal(classified.length, asked, "the owner's own message never opens a thread");

  await dm(5, "گریفین یه چیز دیگه هم هست");
  assert.equal(covered.get("272188041").fresh, false, "«گریفین» reopens the last thread chat");

  covered.clear();
  category = "unclassified";
  const n = received.length;
  await dm(6, "سرور خرابه درست کن");
  assert.equal(received.length, n, "people not marked team never get automatic threads");
});

test("a colleague on the team roster is marked team on first contact", async () => {
  const { store, integrations, cleanup } = setup();
  try {
    const added = await integrations.addBot({ kind: "telegram_bot", token: "666:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    store.updateIntegration(added.id, { settings: { teamRoster: ["Mostafa Dehghan P24", "@Mamad3"] } });
    assert.equal(integrations.bridge.upsertPerson(added.id, "333", { name: "Mohammad", username: "mamad3" }).category, "team", "@username entries match too");
    assert.equal(integrations.bridge.upsertPerson(added.id, "111", { name: "Mostafa Dehghan P24" }).category, "team");
    assert.equal(integrations.bridge.upsertPerson(added.id, "222", { name: "Random Person" }).category, "unclassified");
  } finally {
    await cleanup();
  }
});
