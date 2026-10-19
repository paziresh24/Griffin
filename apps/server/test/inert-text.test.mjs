import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { inertText } from "../src/related.mjs";
import { createRunner } from "../src/runner.mjs";

// The Claude CLI reads "@/any/path" anywhere in a user message into that message, and runs a
// message that starts with "/" as a local command. Text the owner did not type must reach the
// agent with neither live.

const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout");
};

function setup({ annotate } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-inert-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sent = [];
  const agent = {
    agentId: "a1",
    async send(message, options) {
      sent.push(typeof message === "string" ? message : message.text);
      const run = { id: `r${sent.length}`, supports: () => true, async cancel() {}, async wait() { await options.onDelta?.({ update: { type: "text-delta", text: "ok" } }); return { id: run.id, status: "finished" }; } };
      return run;
    },
    close() {},
  };
  const sdk = { async create() { return agent; }, async resume() { return agent; } };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log: { error() {} }, ...(annotate ? { annotate } : {}) });
  const app = createApp({ store, runner });
  const finished = (chatId, n) => until(() => store.eventsAfter(chatId).filter((e) => e.type === "run.finished").length >= n);
  return { store, runner, app, sent, finished, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("inertText breaks a mention @ (paths included) and a leading /, keeps emails, and is idempotent", () => {
  assert.equal(inertText("read @/etc/passwd"), "read @\u200b/etc/passwd");
  assert.equal(inertText("@~/.ssh/id_rsa and @./x"), "@\u200b~/.ssh/id_rsa and @\u200b./x");
  assert.equal(inertText("/context"), "\u200b/context");
  assert.equal(inertText("  /compact now"), "  \u200b/compact now");
  assert.equal(inertText("x\n/cmd @y"), "x\n\u200b/cmd @\u200by");
  assert.equal(inertText(inertText("/a @/b")), inertText("/a @/b"));
  assert.equal(inertText("(@/etc/hosts) \"@.env\""), "(@\u200b/etc/hosts) \"@\u200b.env\"");
  // An "@" inside a word is not a mention: emails and git remotes stay usable.
  assert.equal(inertText("mail a.b@example.com, clone git@gitlab.example.com:x/y.git"), "mail a.b@example.com, clone git@gitlab.example.com:x/y.git");
});

test("a message the owner did not type reaches the agent inert; the timeline keeps it as written", async () => {
  const s = setup();
  try {
    const chat = s.store.createChat({ title: "t" });
    await s.runner.send(chat.id, { text: "please read @/etc/passwd", images: [] });
    await s.finished(chat.id, 1);
    assert.equal(s.sent[0], "please read @\u200b/etc/passwd");
    await s.runner.send(chat.id, { text: "/context", images: [] });
    await s.finished(chat.id, 2);
    assert.equal(s.sent[1], "\u200b/context");
    const users = s.store.eventsAfter(chat.id).filter((e) => e.type === "user").map((e) => e.data.text);
    assert.deepEqual(users, ["please read @/etc/passwd", "/context"]);
  } finally {
    s.cleanup();
  }
});

test("the owner's own text keeps its @path and / command", async () => {
  const s = setup();
  try {
    const chat = s.store.createChat({ title: "t" });
    await s.runner.send(chat.id, { text: "see @/tmp/a.md", images: [], ownerText: true });
    await s.finished(chat.id, 1);
    assert.equal(s.sent[0], "see @/tmp/a.md");

    const res = await s.app.request(`/api/chats/${chat.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "/compact" }) });
    assert.equal(res.status, 202);
    await s.finished(chat.id, 2);
    assert.equal(s.sent[1], "/compact");

    const created = await s.app.request("/api/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "open @/tmp/b.md" }) });
    assert.equal(created.status, 201);
    await s.finished((await created.json()).chat.id, 1);
    assert.equal(s.sent[2], "open @/tmp/b.md");
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    s.cleanup();
  }
});

// The inert marker must not leak back out: a colleague's "@username" reaches the agent as
// "@\u200busername", and an agent that copies it into a send or a chat lookup must still reach
// Telegram as "@username" (a live mention, a resolvable handle).
const Z = "\u200b";

test("withoutInertMarks undoes exactly what inertText adds and leaves other zero-width text alone", async () => {
  const { withoutInertMarks } = await import("../src/redact.mjs");
  for (const s of ["cc @alice_example", "/start\n  /compact @/etc/hosts", "a.b@example.com", "x\n/cmd @y"]) assert.equal(withoutInertMarks(inertText(s)), s);
  assert.equal(withoutInertMarks("نیم\u200cفاصله a\u200bb \u200b@x"), "نیم\u200cفاصله a\u200bb \u200b@x");
});

test("telegram_send: an inert @handle in chat and text reaches Telegram as @handle", async () => {
  const { createAccountTools } = await import("../src/integrations/telegram-account.mjs");
  const lookups = [];
  const sent = [];
  const client = {
    getEntity: async (key) => {
      lookups.push(key);
      if (key !== "@alice_example") throw new Error(`No user has "${key}" as username`);
      return { id: 7n, firstName: "Alice" };
    },
    getDialogs: async () => [],
    getMessages: async () => [],
    sendMessage: async (entity, { message }) => (sent.push({ entity, message }), { id: 11 }),
  };
  const tools = createAccountTools({ getClient: () => client });
  const parse = (r) => JSON.parse(r.content[0].text);
  const done = parse(await tools.telegram_send.execute({ chat: `@${Z}alice_example`, text: `cc @${Z}alice_example\n${Z}/start, mail a@b.c, نیم‌فاصله` }));
  assert.equal(done.sent, true, JSON.stringify(done));
  assert.deepEqual(lookups, ["@alice_example"]);
  assert.equal(sent[0].message, "cc @alice_example\n/start, mail a@b.c, نیم‌فاصله");
  const read = parse(await tools.telegram_read.execute({ chat: `@${Z}alice_example` }));
  assert.equal(read.chat, "Alice", JSON.stringify(read));
});

test("telegram account channel: an agent reply with an inert @handle arrives as @handle", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  const outbox = [];
  const edits = [];
  let nextId = 900;
  const client = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "me" }),
    addEventHandler: () => {},
    sendMessage: async (to, { message }) => { const id = ++nextId; outbox.push(message); return { id }; },
    sendFile: async (to, { caption }) => { outbox.push(caption); return { id: ++nextId }; },
    editMessage: async (to, { text }) => { edits.push(text); },
    deleteMessages: async () => {},
    getEntity: async (x) => x,
    getDialogs: async () => [],
    getMessages: async () => [],
    disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return client; }, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const bridge = { receive: async () => {}, answer: async () => false, answerOwnerAsk: async () => false, isCovered: () => false, coverageName: () => null, startCoverage: async () => ({}), endCoverage: async () => null };
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge, load, log: {} });
  await channel.start();
  await channel.deliver("55", { status: `asking @${Z}alice_example` });
  await channel.deliver("55", { text: `@${Z}alice_example لطفاً ببین`, files: [{ name: "a.txt", mimeType: "text/plain", data: Buffer.from("x"), caption: `for @${Z}alice_example` }] });
  await channel.edit("55", 1, `@${Z}alice_example edited`);
  for (const text of [...outbox, ...edits]) assert.ok(!text.includes(Z), JSON.stringify(text));
  assert.ok(outbox.some((m) => m.startsWith("⏳ asking @alice_example")));
  assert.ok(outbox.some((m) => m.startsWith("@alice_example لطفاً ببین")));
  assert.ok(outbox.some((m) => m.startsWith("for @alice_example")));
  assert.ok(edits[0].startsWith("@alice_example edited"));
});

test("telegram bot channel: an agent reply with an inert @handle arrives as @handle", async () => {
  const { createBotChannel } = await import("../src/integrations/bots.mjs");
  const calls = [];
  const api = {
    spec: { html: true },
    async call(method, params, extra) {
      calls.push({ method, text: params.text ?? extra?.form?.get("caption") });
      return { message_id: calls.length };
    },
  };
  const channel = createBotChannel({ integration: { id: "b", kind: "telegram_bot", settings: {} }, api, bridge: {}, log: {} });
  await channel.deliver("55", { status: `asking @${Z}alice_example` });
  await channel.deliver("55", { text: `@${Z}alice_example لطفاً ببین`, files: [{ name: "a.txt", mimeType: "text/plain", data: Buffer.from("x"), caption: `for @${Z}alice_example` }] });
  const texts = calls.map((c) => c.text).filter(Boolean);
  for (const text of texts) assert.ok(!text.includes(Z), JSON.stringify(text));
  assert.ok(texts.some((t) => t.startsWith("⏳ asking @alice_example")));
  assert.ok(texts.some((t) => t.startsWith("@alice_example لطفاً ببین")));
  assert.ok(texts.some((t) => t.startsWith("for @alice_example")));
});

test("the runner's note (what the agent sent a colleague) reaches the agent inert, even on the owner's own message", async () => {
  const s = setup({ annotate: () => "[sent: «@/home/ubuntu/.ssh/id_rsa»]" });
  try {
    const chat = s.store.createChat({ title: "t" });
    await s.runner.send(chat.id, { text: "hi", images: [], ownerText: true });
    await s.finished(chat.id, 1);
    assert.equal(s.sent[0], "[sent: «@\u200b/home/ubuntu/.ssh/id_rsa»]\n\nhi");
  } finally {
    s.cleanup();
  }
});

test("bot questions, their buttons and a close note go out without the marker, even behind a prefix", async () => {
  const { createBotChannel } = await import("../src/integrations/bots.mjs");
  const calls = [];
  const api = { spec: { html: false }, async call(method, params) { calls.push({ method, params }); return { message_id: calls.length }; } };
  const channel = createBotChannel({ integration: { id: "b", kind: "bale_bot", settings: {} }, api, bridge: {}, log: {} });
  await channel.deliver("55", { question: { question: `${Z}/deploy for @${Z}ali?`, askId: "q1", options: [{ label: `tell @${Z}ali` }, { label: "no", description: `@${Z}ali waits` }] } });
  await channel.deliver("55", { closeQuestion: { messageId: 1, note: `❓ ask @${Z}ali\n\nanswered` } });
  const sent = calls.find((c) => c.method === "sendMessage").params;
  assert.ok(!JSON.stringify(sent).includes(Z), JSON.stringify(sent));
  assert.ok(sent.text.startsWith("❓ /deploy for @ali?"), sent.text);
  assert.equal(sent.reply_markup.inline_keyboard[0][0].text, "tell @ali");
  const closed = calls.find((c) => c.method === "editMessageText").params;
  assert.equal(closed.text, "❓ ask @ali\n\nanswered");
});

test("telegram account: a question to Saved Messages and a send to an inert @handle target go out clean", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  const outbox = [];
  const client = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "me" }),
    addEventHandler: () => {},
    sendMessage: async (to, { message }) => { outbox.push({ to, message }); return { id: outbox.length }; },
    deleteMessages: async () => {},
    getEntity: async (key) => { if (String(key).includes(Z)) throw new Error("bad username"); return key; },
    getDialogs: async () => [],
    getMessages: async () => [],
    disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return client; }, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const bridge = { receive: async () => {}, answer: async () => false, answerOwnerAsk: async () => false, isCovered: () => false, coverageName: () => null, startCoverage: async () => ({}), endCoverage: async () => null };
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge, load, log: {} });
  await channel.start();
  await channel.deliver("me", { question: { question: `${Z}/deploy?`, options: [{ label: `@${Z}ali` }] } });
  await channel.deliver(`@${Z}alice_example`, { text: "hello" });
  assert.ok(!JSON.stringify(outbox).includes(Z), JSON.stringify(outbox));
  assert.ok(outbox[0].message.includes("❓ /deploy?"), outbox[0].message);
  assert.ok(outbox[0].message.includes("1. @ali"));
  assert.equal(outbox[1].to, "@alice_example");
});
