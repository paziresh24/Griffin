// The owner's own Telegram text reaches the agent as his (owner, 2026-10-13: «/compact» from his
// Telegram must work again); a colleague's, a group's or a forwarded message stays inert (!11).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createIntegrations } from "../src/integrations/manager.mjs";
import { createRunner } from "../src/runner.mjs";

const OWNER = 777;
const COLLEAGUE = 888;
const GROUP = -100123;

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout");
};

function fakeBotApi() {
  const queue = [];
  let waiter = null;
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").pop();
    if (method === "getUpdates") {
      if (!queue.length) await new Promise((resolve) => { waiter = resolve; init.signal?.addEventListener("abort", resolve); });
      return Response.json({ ok: true, result: queue.splice(0) });
    }
    if (method === "getMe") return Response.json({ ok: true, result: { username: "owner_test_bot", first_name: "Bot" } });
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
  let id = 0;
  const push = (update) => { queue.push({ update_id: ++id, ...update }); waiter?.(); waiter = null; };
  return { fetchImpl, push };
}

async function setup({ account = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-tg-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const seen = []; // what each engine run was given: { chatId, text }
  const sdk = {
    async create(options) {
      return {
        agentId: `a-${seen.length}`,
        async send(message) {
          seen.push({ text: typeof message === "string" ? message : message.text });
          return { id: "r", supports: () => true, async cancel() {}, async wait() { return { status: "finished" }; } };
        },
      };
    },
  };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log: {} });
  const bot = fakeBotApi();
  const integrations = createIntegrations({ store, runner, fetchImpl: bot.fetchImpl, log: {} });
  if (account) store.createIntegration({ kind: "telegram_account", name: "acc", secret: "{}", settings: { me: { id: String(OWNER), name: "Owner" } } });
  const added = await integrations.addBot({ kind: "telegram_bot", token: "123:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
  const current = store.getIntegration(added.id);
  store.updateIntegration(added.id, { settings: { ...current.settings, pairedChats: [String(OWNER), String(COLLEAGUE), String(GROUP)], pairingCode: null } });
  const cleanup = async () => {
    integrations.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, bot, integrations, added, seen, cleanup };
}

const msg = (chatId, fromId, text, extra = {}) => ({
  message: { message_id: 1, chat: { id: chatId, type: chatId < 0 ? "group" : "private", first_name: "x" }, from: { id: fromId, first_name: "x" }, text, ...extra },
});

test("the owner's /compact from his paired bot reaches the agent unchanged; a colleague's stays inert", async () => {
  const { bot, seen, cleanup } = await setup();
  try {
    bot.push(msg(OWNER, OWNER, "/compact"));
    await until(() => seen.length === 1);
    assert.equal(seen[0].text, "/compact", "the owner's own command is live");
    bot.push(msg(COLLEAGUE, COLLEAGUE, "/compact"));
    await until(() => seen.length === 2);
    assert.equal(seen[1].text, "​/compact", "a colleague's command stays inert");
  } finally {
    await cleanup();
  }
});

test("the owner's @path from his bot is live; the same text in a group, forwarded, or without his account stays inert", async () => {
  const { bot, seen, cleanup } = await setup();
  try {
    bot.push(msg(OWNER, OWNER, "@/data/notes.md را بخوان"));
    await until(() => seen.length === 1);
    assert.equal(seen[0].text, "@/data/notes.md را بخوان");
    // His message in a paired group: the chat is not his private chat with the bot.
    bot.push(msg(GROUP, OWNER, "/compact"));
    await until(() => seen.length === 2);
    assert.equal(seen[1].text, "​/compact");
    // A colleague's words he forwarded to the bot are not his writing.
    bot.push(msg(OWNER, OWNER, "/compact", { forward_origin: { type: "user", sender_user: { id: COLLEAGUE } }, forward_date: 1 }));
    await until(() => seen.length === 3);
    assert.equal(seen[2].text, "​/compact");
    // An inline bot's result he sent is that bot's text.
    bot.push(msg(OWNER, OWNER, "/compact", { via_bot: { id: 5, is_bot: true, username: "gif" } }));
    await until(() => seen.length === 4);
    assert.equal(seen[3].text, "\u200b/compact");
    // A colleague cannot claim the owner's id as sender from his own chat.
    bot.push(msg(COLLEAGUE, OWNER, "/compact"));
    await until(() => seen.length === 4);
    assert.equal(seen[3].text, "​/compact");
  } finally {
    await cleanup();
  }
  // No connected account: nothing proves who the owner is, so a paired chat stays inert.
  const bare = await setup({ account: false });
  try {
    bare.bot.push(msg(OWNER, OWNER, "/compact"));
    await until(() => bare.seen.length === 1);
    assert.equal(bare.seen[0].text, "​/compact");
  } finally {
    await bare.cleanup();
  }
});

test("the bot webhook secret cannot be computed from the integration id in its URL", async () => {
  const { integrations, added, cleanup } = await setup();
  try {
    const guessed = crypto.createHash("sha256").update(`old-bot-hook:${added.id}`).digest("hex").slice(0, 32);
    const update = msg(OWNER, OWNER, "/compact");
    const result = await integrations.handleBotWebhook(added.id, { update_id: 99, ...update }, guessed);
    assert.equal(result.status, 401);
  } finally {
    await cleanup();
  }
});

test("Saved Messages: the owner's own request is his, a forwarded one is not, and our own answer's later piece is never a request", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  let handler = null;
  let nextId = 900;
  const client = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "me" }),
    addEventHandler: (fn) => { handler = fn; },
    sendMessage: async (to, { message }) => (outbox.push(message), { id: ++nextId }),
    sendFile: async () => ({ id: ++nextId }),
    editMessage: async () => {},
    deleteMessages: async () => {},
    getEntity: async (x) => x,
    getDialogs: async () => [],
    getMessages: async () => [],
    disconnect: async () => {},
  };
  const outbox = [];
  const load = async () => ({ TelegramClient: function () { return client; }, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const received = [];
  const bridge = { receive: async (id, chat, input) => { received.push({ chat, ...input }); }, answer: async () => false, answerOwnerAsk: async () => false, isCovered: () => false, coverageName: () => null, startCoverage: async () => ({}), endCoverage: async () => null };
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge, load, log: {} });
  await channel.start();
  const saved = (id, message, extra = {}) => handler({ message: { id, out: true, chatId: 100, peerId: { userId: 100 }, message, ...extra } });
  await saved(1, "./compact");
  await until(() => received.length === 1);
  assert.deepEqual(received[0], { chat: "me", text: "/compact", forwarded: false });
  await saved(2, "./compact", { fwdFrom: { fromId: { userId: 555 } } });
  await until(() => received.length === 2);
  assert.equal(received[1].forwarded, true);
  // An answer longer than one Telegram message: a later piece starts with "." and has no MARK.
  const sentBefore = outbox.length;
  await channel.deliver("me", { text: "./compact کن\n".repeat(800) });
  const piece = outbox.slice(sentBefore + 1).find((m) => m.trim().startsWith("./compact"));
  assert.ok(piece, `a later piece starts with "./compact": ${JSON.stringify(outbox.map((m) => m.slice(0, 20)))}`);
  await saved(3, piece);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 2, "our own answer's piece did not come back as a request");
  await channel.stop?.();
});
