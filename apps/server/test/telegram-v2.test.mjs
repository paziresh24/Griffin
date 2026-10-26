import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { openStore } from "../src/db.mjs";
import { createIntegrations, integrationRoutes } from "../src/integrations/manager.mjs";
import { createAccountChannel, createAccountTools } from "../src/integrations/telegram-account.mjs";
import { createMotherTools, ensureMother, migrateTelegramV2 } from "../src/integrations/mother.mjs";
import { agentFooter } from "../src/integrations/format.mjs";
import { createPeerAuth } from "../src/peer-auth.mjs";
import { createPeerChatTools, lastHop, thirdPartyKey } from "../src/related.mjs";
import { createRunner } from "../src/runner.mjs";

// Telegram v2 (the Telegram section, rebuilt so the owner can follow it). A mother
// chat never speaks by itself; only send_to_person reaches a colleague, and every outcome is recorded.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error("timeout");
};

function setup({ account = null, burstMs = 0, caughtUp = true, network = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tg2-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sends = [];
  const cancels = [];
  const runner = {
    isActive: () => false,
    send: async (chatId, input) => {
      sends.push({ chatId, ...input });
      store.appendEvent(chatId, null, "user", { text: input.text, ...(input.from ? { from: input.from } : {}) }); // as the runner does
      return { delivered: "run" };
    },
    cancel: async (chatId) => cancels.push(chatId),
    retry: () => ({ status: "nothing-kept" }),
  };
  const delivered = [];
  const picked = [];
  const changes = [];
  const reactions = [];
  let nextId = 0;
  const fake = {
    kind: "telegram_account", status: { state: "polling" }, start() {}, stop() {},
    deliver: async (chat, message) => (delivered.push({ chat, ...message }), ++nextId),
    edit: async (chat, id, text) => changes.push(["edit", chat, id, text]),
    remove: async (chat, id) => changes.push(["remove", chat, id]),
    react: async (chat, id, emoji) => reactions.push([chat, id, emoji]),
    picked: (key, id) => picked.push([key, id]),
  };
  const acc = store.createIntegration({ kind: "telegram_account", name: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} });
  const integrations = createIntegrations({ store, runner, asks: null, channelFactories: { telegram_account: account || (() => fake) }, burstMs, network, log: {} });
  integrations.startAll();
  if (caughtUp) integrations.desk.caughtUp(acc.id); // the real account reports this after its catch-up
  const app = new Hono();
  integrationRoutes(app, integrations);
  const watched = (key, name, access = { watch: true }) => {
    const p = store.upsertPerson({ integrationId: acc.id, externalId: key, name, data: { platform: "telegram" } });
    return store.updatePerson(p.id, { access });
  };
  const notes = (chatId, kind = null) => [...store.allEvents(chatId)].filter((e) => e.type === "tg.note" && (!kind || e.data.kind === kind)).map((e) => e.data);
  const cleanup = () => {
    integrations.stopAll();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, runner, sends, cancels, delivered, picked, changes, reactions, acc, integrations, desk: integrations.desk, app, watched, notes, cleanup };
}

// A mother turn as the runner would record it; `during` runs while it is going.
async function motherTurn(store, chatId, { text = "گزارش", status = "finished", during = async () => {} } = {}) {
  const runId = store.startRun(chatId);
  store.appendEvent(chatId, runId, "run.started", {});
  await during();
  store.appendEvent(chatId, runId, "text", { text });
  store.finishRun(chatId, runId, status, null);
  store.appendEvent(chatId, runId, "run.finished", { status });
}
const parse = (result) => JSON.parse(result.content[0].text);

test("1: a mother run never delivers by itself; send_to_person does exactly one, recorded everywhere", async () => {
  const { store, runner, sends, delivered, picked, acc, desk, watched, notes, cleanup } = setup();
  try {
    const karimi = watched("1001", "کریمی");
    assert.equal(await desk.colleague(acc.id, "1001", { person: karimi, text: "دیتابیس وصل نمیشه", messageId: 55 }), "run");
    const mother = sends[0].chatId;
    assert.deepEqual(sends[0].from, { kind: "colleague", name: "کریمی", personId: karimi.id, msgId: 55 });
    assert.equal(sends[0].text, "«کریمی» (#55): دیتابیس وصل نمیشه");
    assert.deepEqual(picked, [["1001", 55]], "👀 and the reply target on the picked message");
    assert.equal(store.getKv(`tgstate:${karimi.id}`).state, "working");

    const tools = createMotherTools({ store, runner, chatId: mother, name: "کریمی", sendToPerson: (t) => desk.sendToPerson(mother, t) });
    await motherTurn(store, mother, {
      text: "کریمی پرسید دیتابیس؛ گفتم دارم بررسی می‌کنم.",
      during: async () => assert.deepEqual(parse(await tools.send_to_person.execute({ text: "دارم بررسی می‌کنم 🙂" })), { sent: true, id: 1 }),
    });
    await until(() => store.getKv(`tgstate:${karimi.id}`)?.state === "sent");
    await sleep(30);
    assert.deepEqual(delivered, [{ chat: "1001", text: "دارم بررسی می‌کنم" }], "one deliver, no status line, no final text");
    assert.equal(store.getKv("tgfeed").at(-1).state, "sent");
    const report = notes(store.getKv("tg:global"), "report").at(-1);
    assert.equal(report.text, "کریمی پرسید دیتابیس؛ گفتم دارم بررسی می‌کنم.");
    assert.deepEqual(report.sent, ["دارم بررسی می‌کنم"]);
    assert.equal(store.getPerson(karimi.id).history.at(-1).data.by, "assistant");

    // A turn that sends nothing says nothing, and is recorded as such.
    await motherTurn(store, mother, { text: "پیام خودمانی بود، جواب ندادم" });
    await until(() => store.getKv(`tgstate:${karimi.id}`)?.state === "no_reply");
    assert.equal(delivered.length, 1);
  } finally {
    cleanup();
  }
});

test("2: the owner writes during a mother turn → the send is held as a draft; «بفرست» delivers it", async () => {
  const { store, runner, sends, delivered, acc, desk, app, watched, notes, cleanup } = setup();
  try {
    const rezaei = watched("1002", "رضایی");
    await desk.colleague(acc.id, "1002", { person: rezaei, text: "پایپ‌لاین فیله", messageId: 7 });
    const mother = sends[0].chatId;
    const tools = createMotherTools({ store, runner, chatId: mother, name: "رضایی", sendToPerson: (t) => desk.sendToPerson(mother, t) });
    let held = null;
    await motherTurn(store, mother, {
      during: async () => {
        await sleep(5);
        desk.ownerLine(acc.id, "1002", { text: "خودم درستش کردم", by: "owner" });
        held = parse(await tools.send_to_person.execute({ text: "رانر خراب بود، درست شد" }));
      },
    });
    assert.equal(held.held, true);
    assert.equal(held.reason, "owner_replied");
    assert.equal(delivered.length, 0, "nothing reached him while the owner was talking");
    assert.equal(notes(mother, "owner_line")[0].text, "خودم درستش کردم", "the owner's line shows in the mother chat");
    await until(() => store.getKv(`tgstate:${rezaei.id}`)?.state === "waiting");

    const feed = await (await app.request("/api/telegram/feed")).json();
    assert.equal(feed.globalChatId, store.getKv("tg:global"));
    assert.equal(feed.waiting.length, 1);
    assert.equal(feed.waiting[0].kind, "draft");
    assert.equal(feed.waiting[0].text, "رانر خراب بود، درست شد");
    const sent = await app.request(`/api/telegram/waiting/${feed.waiting[0].id}`, { method: "POST", body: JSON.stringify({ action: "send" }), headers: { "content-type": "application/json" } });
    assert.equal(sent.status, 200);
    assert.deepEqual(delivered, [{ chat: "1002", text: "رانر خراب بود، درست شد" }]);
    assert.equal((await (await app.request("/api/telegram/feed")).json()).waiting.length, 0);
    assert.equal(store.getKv(`tgstate:${rezaei.id}`).state, "sent");
    assert.equal((await app.request("/api/telegram/waiting/nope", { method: "POST", body: JSON.stringify({ action: "send" }) })).status, 404);
  } finally {
    cleanup();
  }
});

test("3: a colleague right after the owner's line waits 10 minutes; the drain drops it if he answered meanwhile", async () => {
  const { store, sends, acc, desk, watched, notes, cleanup } = setup();
  try {
    const a = watched("1003", "احمدی");
    desk.ownerLine(acc.id, "1003", { text: "الان چک می‌کنم" });
    const ownerAt = store.getKv(`tgowner:${acc.id}:1003`).at;
    await sleep(3);
    assert.equal(await desk.colleague(acc.id, "1003", { person: a, text: "هنوز بالا نیومده", messageId: 1 }), "queued");
    assert.equal(sends.length, 0, "no run while the owner is in the conversation");
    assert.equal(store.getKv(`pickup:${acc.id}`)["1003"].due, ownerAt + 10 * 60_000);
    assert.equal(store.getKv(`tgstate:${a.id}`).state, "queued");
    await sleep(3);
    desk.ownerLine(acc.id, "1003", { text: "حل شد" });
    await desk.drain(Date.now() + 11 * 60_000);
    assert.equal(sends.length, 0, "the owner answered after her last message: dropped");
    assert.equal(store.getKv(`tgstate:${a.id}`).state, "owner");
    assert.match(notes(store.getKv("tg:global"), "report").at(-1).text, /خودتان جواب دادید/);

    // The owner did not write after it: it runs with his lines in front.
    const b = watched("1004", "موسوی");
    desk.ownerLine(acc.id, "1004", { text: "یه لحظه" });
    await sleep(3);
    await desk.colleague(acc.id, "1004", { person: b, text: "باشه", messageId: 2 });
    await desk.drain(Date.now() + 11 * 60_000);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].text, "«صاحب‌کار در تلگرام به موسوی»: یه لحظه\n«موسوی» (#2): باشه");
    assert.deepEqual(store.getKv(`tgowner:${acc.id}:1004`).lines, [], "his lines are passed once");
    assert.equal(store.getKv(`pickup:${acc.id}`)["1004"], undefined);
  } finally {
    cleanup();
  }
});

test("4: past 20 runs an hour a person's messages wait 15 minutes and the owner sees it — nothing dropped", async () => {
  const { store, sends, acc, desk, app, watched, cleanup } = setup();
  try {
    const p = watched("1005", "حسینی");
    const results = [];
    for (let i = 0; i < 21; i += 1) results.push(await desk.colleague(acc.id, "1005", { person: p, text: `پیام ${i}`, messageId: i }));
    assert.equal(results.filter((r) => r === "run").length, 20);
    assert.equal(results.at(-1), "brake");
    assert.equal(sends.length, 20);
    const batch = store.getKv(`pickup:${acc.id}`)["1005"];
    assert.deepEqual(batch.items.map((i) => i.text), ["پیام 20"]);
    assert.ok(batch.due > Date.now() + 14 * 60_000);
    const { waiting } = await (await app.request("/api/telegram/feed")).json();
    assert.deepEqual(waiting.map((w) => [w.kind, w.personId]), [["brake", p.id]]);
    // «بفرست» runs it now, past the brake.
    await app.request(`/api/telegram/waiting/${waiting[0].id}`, { method: "POST", body: JSON.stringify({ action: "send" }) });
    assert.equal(sends.length, 21);
    assert.equal(sends.at(-1).text, "«حسینی» (#20): پیام 20");
  } finally {
    cleanup();
  }
});

test("5: linksForChat ignores closed thread memberships", () => {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tg2-")), "db.sqlite"));
  const acc = store.createIntegration({ kind: "telegram_account", name: "acc", secret: "{}", settings: {} });
  const chat = store.createChat({ title: "legacy", caller: "team" });
  const row = store.db.prepare("INSERT INTO thread_links (chat_id, integration_id, external_chat, person_id, closed_at, created_at) VALUES (?, ?, ?, NULL, ?, 'x')");
  row.run(chat.id, acc.id, "open", null);
  row.run(chat.id, acc.id, "closed", "2026-10-12T00:00:00Z");
  store.linkChat(acc.id, "pointer", chat.id);
  assert.deepEqual(store.linksForChat(chat.id).map((l) => l.external_chat).sort(), ["open", "pointer"]);
  store.close();
});

test("6: the migration closes idle legacy threads, keeps live ones, drops empty mothers; once", () => {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tg2-")), "db.sqlite"));
  store.createIntegration({ kind: "telegram_account", name: "acc", secret: "{}", settings: {} });
  const member = store.db.prepare("INSERT INTO thread_links (chat_id, integration_id, external_chat, person_id, closed_at, created_at) VALUES (?, 'acc', ?, NULL, NULL, 'x')");
  const legacy = (title, key) => {
    const chat = store.createChat({ title, caller: "team" });
    member.run(chat.id, key);
    return chat.id;
  };
  const idle = legacy("idle", "1");
  const running = legacy("running", "2");
  const delegating = legacy("delegating", "3");
  const asking = legacy("asking", "4");
  const child = store.createChat({ title: "sub", caller: "griffin", parentChatId: delegating });
  store.setKv(`delegate:${child.id}`, { parent: delegating, state: "running" });
  const talked = ensureMother(store, { integrationId: "acc", key: "5", name: "کریمی", agent: "griffin" });
  store.appendEvent(talked, null, "user", { text: "«کریمی»: سلام" });
  member.run(talked, "5");
  const empty = ensureMother(store, { integrationId: "acc", key: "6", name: "رضایی", agent: "griffin" });

  const options = { isActive: (id) => id === running, isWaiting: (id) => id === asking };
  assert.equal(migrateTelegramV2(store, options), true);
  const open = (id) => store.db.prepare("SELECT COUNT(*) AS n FROM thread_links WHERE chat_id = ? AND closed_at IS NULL").get(id).n;
  assert.equal(open(idle), 0);
  assert.equal(store.getChat(idle).archived, 1);
  for (const id of [running, delegating, asking]) {
    assert.equal(open(id), 1, store.getChat(id).title);
    assert.equal(store.getChat(id).archived, 0);
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM thread_links WHERE chat_id = ?").get(talked).n, 0, "a mother keeps only its pointer");
  assert.ok(store.getChat(talked));
  assert.equal(store.getChat(empty), null);
  assert.equal(store.getKv(`motherof:${empty}`), null);
  assert.equal(store.getKv("mother:acc:6"), null);
  const global = store.getKv("tg:global");
  assert.ok(store.getChat(global));

  member.run(idle, "9"); // anything after: a second run changes nothing
  assert.equal(migrateTelegramV2(store, { isActive: () => false }), false);
  assert.equal(open(idle), 1);
  assert.equal(store.getKv("tg:global"), global);
  store.close();
});

// A Telegram account over a fake gramjs client, on the real store and bridge.
function accountHarness() {
  let handler = null;
  const outbox = [];
  let nextId = 900;
  const client = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "owner" }),
    addEventHandler: (fn) => { handler = fn; },
    sendMessage: async (to, opts) => { outbox.push({ to: String(to), message: opts.message, replyTo: opts.replyTo || null }); return { id: ++nextId }; },
    editMessage: async () => {}, deleteMessages: async () => {},
    getEntity: async () => ({ firstName: "Rezaei", username: "rezaei" }),
    getDialogs: async () => [], getMessages: async () => [], disconnect: async () => {}, invoke: async () => {},
    downloadProfilePhoto: async () => null,
  };
  const Api = { messages: { SendReaction: function (o) { Object.assign(this, o); } }, ReactionEmoji: function (o) { Object.assign(this, o); } };
  const load = async () => ({ TelegramClient: function () { return client; }, Api, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const env = setup({ account: (integration, bridge) => createAccountChannel({ integration, bridge, load, log: {} }) });
  const dm = (id, text, extra = {}) => handler({ message: { out: false, chatId: 555000111n, peerId: { userId: 555000111n }, id, message: text, ...extra } });
  const owner = (id, text, extra = {}) => handler({ message: { out: true, chatId: 555000111n, peerId: { userId: 555000111n }, id, message: text, ...extra } });
  // The account comes back (deploy, dead session): its catch-ups run against what the client returns.
  const restart = async () => {
    const channel = env.integrations.get(env.acc.id);
    channel.stop();
    await channel.start();
    await sleep(30);
  };
  const chatWith = (messages) => {
    client.getDialogs = async () => [{ isUser: true, isSelf: false, id: 555000111n, entity: { id: 555000111n } }];
    client.getMessages = async () => messages;
  };
  return { ...env, client, outbox, dm, owner, restart, chatWith, ready: () => until(() => handler) };
}

test("7: /agent on a message turns the watcher on and answers it; /agent off → the next message starts no run", async () => {
  const h = accountHarness();
  try {
    await h.ready();
    await h.dm(1, "پوش با توکن کار نمیکنه");
    assert.equal(h.sends.length, 0, "not watched yet");
    await h.owner(2, "/agent", { replyTo: { replyToMsgId: 1 }, getReplyMessage: async () => ({ id: 1, message: "پوش با توکن کار نمیکنه" }) });
    const person = h.store.findPerson("555000111");
    assert.equal(person.access.watch, true);
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0].text, "«Rezaei» (#1): پوش با توکن کار نمیکنه");
    assert.ok(h.outbox.some((m) => m.to === "me" && /واچر «Rezaei» روشن شد/.test(m.message)), JSON.stringify(h.outbox));
    // send_to_person replies to the message /agent pointed at.
    await h.desk.sendToPerson(h.sends[0].chatId, "دارم بررسی می‌کنم");
    assert.ok(h.outbox.some((m) => m.replyTo === 1 && /دارم بررسی می‌کنم/.test(m.message)), "a reply to the message /agent pointed at");

    await h.dm(3, "لاگش رو هم ببین");
    assert.equal(h.sends.length, 2, "watched: the mother hears it");
    await h.owner(4, "/agent off");
    assert.equal(h.store.findPerson("555000111").access.watch, false);
    await h.dm(5, "سلام؟");
    assert.equal(h.sends.length, 2, "/agent off: no run");
  } finally {
    h.cleanup();
  }
});

test("8: an unwatched DM starts no run and tells the global chat once an hour; the owner's line is his presence", async () => {
  const h = accountHarness();
  try {
    await h.ready();
    await h.dm(1, "سلام، یه سؤال داشتم");
    await h.dm(2, "هستید؟");
    assert.equal(h.sends.length, 0);
    const unwatched = h.notes(h.store.getKv("tg:global"), "unwatched");
    assert.equal(unwatched.length, 1);
    assert.match(unwatched[0].text, /یه سؤال داشتم/);

    // His own line in Telegram: recorded with who wrote it, and the next colleague message waits.
    const person = h.store.findPerson("555000111");
    h.store.updatePerson(person.id, { access: { watch: true } });
    await h.owner(3, "بله بفرمایید");
    assert.equal(h.store.getKv(`tgowner:${h.acc.id}:555000111`).lines[0].text, "بله بفرمایید");
    assert.equal(h.store.findPerson("555000111").history.at(-1).data.by, "owner");
    await h.dm(4, "دیتابیس وصل نمیشه");
    assert.equal(h.sends.length, 0, "queued behind the owner");
    assert.equal(h.store.getKv(`pickup:${h.acc.id}`)["555000111"].items.length, 1);
    // A line that hands work over runs the mother right away, with what was waiting behind him.
    await h.owner(5, "گریفین کمکتون میکنه");
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0].text, "«صاحب‌کار در تلگرام به Rezaei»: بله بفرمایید\n«Rezaei» (#4): دیتابیس وصل نمیشه\n«صاحب‌کار در تلگرام به Rezaei»: گریفین کمکتون میکنه");
    assert.equal(h.store.getKv(`pickup:${h.acc.id}`)["555000111"], undefined);
  } finally {
    h.cleanup();
  }
});

test("9: /api/telegram/people never reads message history", async () => {
  const { store, acc, desk, app, watched, cleanup } = setup();
  try {
    const p = watched("1007", "جعفری");
    await desk.colleague(acc.id, "1007", { person: p, text: "سرور کنده" });
    store.db.prepare("UPDATE persons SET history_json = 'not json' WHERE id = ?").run(p.id); // parsing it would throw
    const group = store.upsertPerson({ externalId: "-100123", name: "Alerts", data: { platform: "telegram" } });
    const res = await app.request("/api/telegram/people");
    assert.equal(res.status, 200);
    const { people } = await res.json();
    const row = people.find((x) => x.id === p.id);
    assert.equal(row.watch, true);
    assert.equal(row.state.state, "working");
    assert.ok(row.chatId);
    assert.deepEqual({ openThreads: row.openThreads, running: row.running, queued: row.queued }, { openThreads: 0, running: false, queued: null });
    assert.equal(people.find((x) => x.id === group.id).group, true);
    // A mother chat only for a watched person.
    assert.equal((await app.request(`/api/telegram/persons/${group.id}/mother`, { method: "POST" })).status, 409);
    const patched = await (await app.request(`/api/telegram/persons/${group.id}`, { method: "PATCH", body: JSON.stringify({ access: { watch: true } }) })).json();
    assert.ok(patched.chatId);
    assert.equal(patched.person.history, undefined);
    assert.equal((await (await app.request(`/api/telegram/persons/${group.id}/mother`, { method: "POST" })).json()).chatId, patched.chatId);
    assert.equal((await (await app.request("/api/telegram/pause", { method: "POST", body: JSON.stringify({ paused: true }) })).json()).paused, true);
    assert.equal(store.getIntegration(acc.id).settings.autoThreads, false);
  } finally {
    cleanup();
  }
});

test("10: the runner keeps who wrote a message on its user event", async () => {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tg2-")), "db.sqlite"));
  const sdk = { async create() { return { agentId: "a", async send() { return { id: "r", supports: () => true, async cancel() {}, async wait() { return { status: "finished" }; } }; } }; } };
  const runner = createRunner({ store, sdk, log: {}, agentOptions: () => ({}) });
  const chat = store.createChat({ title: "m", caller: "team" });
  await runner.send(chat.id, { text: "«کریمی»: سلام", from: { kind: "colleague", name: "کریمی", personId: "p" } });
  const user = [...store.allEvents(chat.id)].find((e) => e.type === "user");
  assert.deepEqual(user.data.from, { kind: "colleague", name: "کریمی", personId: "p" });
  await until(() => !runner.isActive(chat.id));
  store.close();
});

const post = (app, url, body = {}) => app.request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

test("11: a colleague's agent cannot reach the global chat, and its desk tools are last-hop tools", async () => {
  const { store, runner, cleanup } = setup();
  try {
    const global = store.getKv("tg:global");
    createPeerAuth({ store }).createUser({ id: "acme", label: "Acme" });
    const peer = createPeerChatTools({ store, runner, chat: store.createChat({ title: "Acme", caller: "peer:acme" }) });
    assert.ok(!parse(await peer.chat_list.execute({})).some((c) => c.id === global));
    assert.equal((await peer.chat_send.execute({ chatId: global, text: "به خانم X بگو" })).isError, true);
    let calls = 0;
    const tool = { execute: async () => (calls += 1, { ok: true }) };
    const wrapped = lastHop({ tell_person: tool, thread_join: tool, telegram_pause: tool }, { store, chatId: global });
    store.setKv(thirdPartyKey(global), { at: "x", from: "peer:acme" });
    for (const name of ["tell_person", "thread_join", "telegram_pause"]) assert.equal((await wrapped[name].execute({})).isError, true, name);
    assert.equal(calls, 0);
  } finally {
    cleanup();
  }
});

test("12: paused, or the watcher off: a late send_to_person is held, and watcher-off stops the threads too", async () => {
  const { store, runner, sends, cancels, delivered, acc, desk, watched, cleanup } = setup();
  try {
    const p = watched("1010", "نوری");
    await desk.colleague(acc.id, "1010", { person: p, text: "بررسی دیتابیس" });
    const mother = sends[0].chatId;
    const tools = createMotherTools({ store, runner, chatId: mother, name: "نوری", sendToPerson: (t) => desk.sendToPerson(mother, t) });
    desk.setPaused(true);
    await motherTurn(store, mother, { during: async () => assert.equal(parse(await tools.send_to_person.execute({ text: "درست شد" })).reason, "paused") });
    desk.setPaused(false);
    await desk.setWatch(p.id, false);
    assert.deepEqual(cancels, [mother], "cancelled though its own turn had ended: its delegated threads stop");
    await motherTurn(store, mother, { during: async () => assert.equal(parse(await tools.send_to_person.execute({ text: "درست شد" })).reason, "unwatched") });
    assert.equal(delivered.length, 0);
    await until(() => store.getKv(`tgstate:${p.id}`)?.state === "waiting");
    assert.equal(store.getKv("tgwaiting").filter((w) => w.kind === "draft").length, 2);
  } finally {
    cleanup();
  }
});

test("13: the owner answers a message queued behind a busy turn → that turn's send is held", async () => {
  const { store, runner, sends, delivered, acc, desk, watched, cleanup } = setup();
  try {
    const p = watched("1011", "صادقی");
    await desk.colleague(acc.id, "1011", { person: p, text: "دسترسی می‌خوام" }); // handed over now, runs later
    const mother = sends[0].chatId;
    await sleep(3);
    desk.ownerLine(acc.id, "1011", { text: "دادم" }); // before the turn starts
    await sleep(3);
    const tools = createMotherTools({ store, runner, chatId: mother, name: "صادقی", sendToPerson: (t) => desk.sendToPerson(mother, t) });
    let result = null;
    await motherTurn(store, mother, { during: async () => (result = parse(await tools.send_to_person.execute({ text: "دسترسی دادم" }))) });
    assert.deepEqual([result.held, result.reason], [true, "owner_replied"]);
    assert.equal(delivered.length, 0);
  } finally {
    cleanup();
  }
});

test("14: telegram_send from any chat counts as the owner in that conversation", async () => {
  const { store, acc, integrations, cleanup } = setup();
  try {
    const seen = [];
    const client = { getEntity: async () => ({ id: 1012n, firstName: "Karimi" }), sendMessage: async () => ({ id: 77 }), getPeerId: async () => "1012" };
    const tools = createAccountTools({ getClient: () => client, onSent: (peer, text) => (seen.push([peer, text]), integrations.ownerWrote(peer, text)) });
    assert.equal(parse(await tools.telegram_send.execute({ chat: "1012", text: "فردا میام" })).sent, true);
    assert.deepEqual(seen, [["1012", "فردا میام"]]);
    assert.deepEqual(store.getKv(`tgowner:${acc.id}:1012`).lines.map((l) => [l.text, l.by]), [["فردا میام", "session"]]);
    client.sendMessage = async () => {
      throw new Error("FLOOD");
    };
    await tools.telegram_send.execute({ chat: "1012", text: "دوباره" });
    assert.equal(seen.length, 1, "nothing went out, nothing recorded");
  } finally {
    cleanup();
  }
});

test("15: after a restart, catch-up never answers an /agent again that was applied live", async () => {
  const h = accountHarness();
  try {
    await h.ready();
    await h.dm(1, "پوش کار نمیکنه");
    const reply = { replyTo: { replyToMsgId: 1 }, getReplyMessage: async () => ({ id: 1, message: "پوش کار نمیکنه" }) };
    await h.owner(2, "/agent", reply);
    assert.equal(h.sends.length, 1);
    h.chatWith([{ out: true, id: 2, date: Math.floor(Date.now() / 1000), message: "/agent", ...reply }]);
    await h.restart();
    assert.equal(h.sends.length, 1, "no second answer");
    assert.equal(h.outbox.filter((m) => /روشن شد/.test(m.message)).length, 1);
  } finally {
    h.cleanup();
  }
});

test("16: a missed /agent off is caught up, but never over the owner's later switch on the web", async () => {
  const h = accountHarness();
  try {
    await h.ready();
    const p = h.watched("555000111", "Rezaei");
    h.chatWith([{ out: true, id: 7, date: Math.floor(Date.now() / 1000) - 60, message: "/agent off" }]);
    await h.restart();
    await until(() => h.store.findPerson("555000111").access.watch === false);
    await h.app.request(`/api/telegram/persons/${p.id}`, { method: "PATCH", body: JSON.stringify({ access: { watch: true } }) });
    await h.restart();
    assert.equal(h.store.findPerson("555000111").access.watch, true, "the web switch is later than the command");
  } finally {
    h.cleanup();
  }
});

test("17: catch-up takes the owner's own replies typed meanwhile: what he answered is not answered again", async () => {
  const h = accountHarness();
  try {
    await h.ready();
    const p = h.watched("555000111", "Rezaei");
    const t = Math.floor(Date.now() / 1000);
    const dm = { chatId: 555000111n, peerId: { userId: 555000111n } };
    h.chatWith([
      { out: true, id: 12, date: t - 100, message: `قبلاً گفتم\n\n${agentFooter()}`, ...dm },
      { out: true, id: 11, date: t - 200, message: "خودم درستش کردم", ...dm },
      { out: false, id: 10, date: t - 300, message: "دیتابیس وصل نمیشه", ...dm },
    ]);
    await h.restart();
    assert.equal(h.sends.length, 0, "he answered it by hand");
    assert.equal(h.store.getKv(`tgstate:${p.id}`).state, "owner");
    assert.deepEqual(h.store.getKv(`tgowner:${h.acc.id}:555000111`).lines.map((l) => [l.text, l.at]), [["خودم درستش کردم", (t - 200) * 1000]], "his line, not the assistant's signed one");
    assert.equal(h.store.findPerson("555000111").history.find((x) => x.id === 11).data.by, "owner");
  } finally {
    h.cleanup();
  }
});

test("18: queued messages of a person whose watcher goes off are recorded as unanswered, never dropped silently", async () => {
  const { store, acc, desk, app, watched, cleanup } = setup();
  try {
    const p = watched("1013", "حسینی");
    for (let i = 0; i < 21; i += 1) await desk.colleague(acc.id, "1013", { person: p, text: `پیام ${i}`, messageId: i });
    assert.equal((await (await app.request("/api/telegram/feed")).json()).waiting[0].kind, "brake");
    await desk.setWatch(p.id, false);
    assert.equal(store.getKv(`pickup:${acc.id}`)["1013"], undefined);
    assert.equal((await (await app.request("/api/telegram/feed")).json()).waiting.length, 0, "no stale brake item");
    assert.equal(store.getKv(`tgstate:${p.id}`).state, "paused");
    assert.match(store.getKv("tgfeed").at(-1).text, /پیام 20/);

    // Turned off another way, found at drain time: the same.
    const q = watched("1014", "موسوی", { watch: true, pickupEvery: 30 });
    assert.equal(await desk.colleague(acc.id, "1014", { person: q, text: "سرور کنده" }), "queued");
    store.updatePerson(q.id, { access: { watch: false } });
    await desk.drain(Date.now() + 31 * 60_000);
    assert.equal(store.getKv(`tgstate:${q.id}`).state, "paused");
    assert.match(store.getKv("tgfeed").at(-1).text, /سرور کنده/);
  } finally {
    cleanup();
  }
});

test("19: tell_person by part of a name that fits several watched people asks instead of guessing", async () => {
  const { sends, desk, watched, cleanup } = setup();
  try {
    watched("1015", "علی کاظمی");
    watched("-100777", "تیم کاظمی");
    watched("1016", "رضا کاظمی", { watch: false });
    const tools = desk.globalTools();
    const out = parse(await tools.tell_person.execute({ person: "کاظمی", text: "فردا سرور خاموش است" }));
    assert.match(out.error, /علی کاظمی/);
    assert.match(out.error, /تیم کاظمی/);
    assert.equal(sends.length, 0);
    assert.equal(parse(await tools.tell_person.execute({ person: "علی کاظمی", text: "فردا سرور خاموش است" })).told, "علی کاظمی");
    assert.equal(parse(await tools.tell_person.execute({ person: "رضا", text: "x" })).error.includes("واچر"), true, "one hit: that one");
  } finally {
    cleanup();
  }
});

test("20: a turn that sent and then broke is recorded as sent, with no retry that would send twice", async () => {
  const { store, runner, sends, acc, desk, app, watched, cleanup } = setup();
  try {
    const p = watched("1017", "احمدی");
    await desk.colleague(acc.id, "1017", { person: p, text: "سرور کنده" });
    const mother = sends[0].chatId;
    const tools = createMotherTools({ store, runner, chatId: mother, name: "احمدی", sendToPerson: (t) => desk.sendToPerson(mother, t) });
    await motherTurn(store, mother, { status: "error", during: async () => tools.send_to_person.execute({ text: "سلام، بفرمایید" }) });
    await until(() => store.getKv(`tgstate:${p.id}`)?.state === "sent");
    assert.equal((await (await app.request("/api/telegram/feed")).json()).waiting.length, 0);
  } finally {
    cleanup();
  }
});

test("21: dismissing a held draft clears the person's «waiting»", async () => {
  const { store, runner, sends, acc, desk, app, watched, cleanup } = setup();
  try {
    const p = watched("1018", "رضایی");
    await desk.colleague(acc.id, "1018", { person: p, text: "سرور کنده" });
    const mother = sends[0].chatId;
    const tools = createMotherTools({ store, runner, chatId: mother, name: "رضایی", sendToPerson: (t) => desk.sendToPerson(mother, t) });
    await motherTurn(store, mother, { during: async () => (desk.ownerLine(acc.id, "1018", { text: "الان خودم نگاه می‌کنم" }), tools.send_to_person.execute({ text: "سلام" })) });
    await until(() => store.getKv(`tgstate:${p.id}`)?.state === "waiting");
    const [draft] = (await (await app.request("/api/telegram/feed")).json()).waiting;
    assert.equal((await post(app, `/api/telegram/waiting/${draft.id}`, { action: "dismiss" })).status, 200);
    assert.notEqual(store.getKv(`tgstate:${p.id}`).state, "waiting");
  } finally {
    cleanup();
  }
});

test("22: no Telegram account channel → feed.account is null (not a dropped connection)", async () => {
  const { acc, integrations, app, cleanup } = setup();
  try {
    assert.equal((await (await app.request("/api/telegram/feed")).json()).account.state, "polling");
    integrations.update(acc.id, { enabled: false });
    assert.equal((await (await app.request("/api/telegram/feed")).json()).account, null);
  } finally {
    cleanup();
  }
});

test("23: a hand-off carries the colleague's words, so it is not shown as the owner's private note", async () => {
  const { sends, acc, desk, watched, cleanup } = setup();
  try {
    const p = watched("1019", "کریمی");
    await desk.handOff(acc.id, "1019", { person: p, text: "گریفین کمکتون می‌کنه" });
    assert.deepEqual(sends[0].from, { kind: "colleague", name: "کریمی", personId: p.id, forced: true });
  } finally {
    cleanup();
  }
});

test("24: a person's legacy threads list without the mother chat; closing one archives it for good", async () => {
  const { store, acc, app, watched, cleanup } = setup();
  try {
    const p = watched("1020", "موسوی");
    const mother = ensureMother(store, { integrationId: acc.id, key: "1020", person: p, name: "موسوی", agent: "griffin" });
    const legacy = store.createChat({ title: "🧵 موسوی: VPN", caller: "team", personId: p.id });
    store.db.prepare("INSERT INTO thread_links (chat_id, integration_id, external_chat, person_id, closed_at, created_at) VALUES (?, ?, '1020', ?, NULL, 'x')").run(legacy.id, acc.id, p.id);
    const list = async () => (await (await app.request(`/api/telegram/persons/${p.id}/threads`)).json()).threads;
    assert.deepEqual((await list()).map((t) => [t.id, t.closed]), [[legacy.id, false]]);
    assert.ok(!(await list()).some((t) => t.id === mother));
    await post(app, `/api/telegram/threads/${legacy.id}/close`);
    assert.equal(store.getChat(legacy.id).archived, 1);
    assert.deepEqual((await list()).map((t) => [t.id, t.closed]), [[legacy.id, true]]);
  } finally {
    cleanup();
  }
});

test("25: the owner's own request is never held from him: a web note after his Telegram line, a hand-off while paused", async () => {
  const { store, runner, sends, delivered, acc, desk, watched, cleanup } = setup();
  try {
    const p = watched("1021", "احمدی");
    await desk.colleague(acc.id, "1021", { person: p, text: "لاگ‌ها رو می‌خوام" });
    const mother = sends[0].chatId;
    const tools = createMotherTools({ store, runner, chatId: mother, name: "احمدی", sendToPerson: (t) => desk.sendToPerson(mother, t) });
    await sleep(3);
    desk.ownerLine(acc.id, "1021", { text: "الان می‌فرستم" });
    store.appendEvent(mother, null, "user", { text: "بهش بگو لاگ‌ها در Grafana است", from: { kind: "owner_web" } });
    let result = null;
    await motherTurn(store, mother, { during: async () => (result = parse(await tools.send_to_person.execute({ text: "لاگ‌ها در Grafana است" }))) });
    assert.deepEqual(result, { sent: true, id: 1 });

    desk.setPaused(true);
    await desk.handOff(acc.id, "1021", { person: p, text: "گریفین کمکتون می‌کنه" });
    await motherTurn(store, mother, { during: async () => (result = parse(await tools.send_to_person.execute({ text: "سلام، من پیگیری می‌کنم" }))) });
    assert.equal(result.sent, true, "he handed it over himself");
    assert.equal(delivered.length, 2);
  } finally {
    cleanup();
  }
});

test("26: a held draft says why it was held", async () => {
  const { store, runner, sends, acc, desk, app, watched, cleanup } = setup();
  try {
    const p = watched("1022", "موسوی");
    await desk.colleague(acc.id, "1022", { person: p, text: "باکت پر شده" });
    const mother = sends[0].chatId;
    const tools = createMotherTools({ store, runner, chatId: mother, name: "موسوی", sendToPerson: (t) => desk.sendToPerson(mother, t) });
    desk.setPaused(true);
    await motherTurn(store, mother, { during: async () => tools.send_to_person.execute({ text: "بررسی می‌کنم" }) });
    const feed = await (await app.request("/api/telegram/feed")).json();
    assert.equal(feed.waiting[0].reason, "paused");
  } finally {
    cleanup();
  }
});

test("27: changing only the pickup time is not a watcher decision", async () => {
  const { store, app, watched, cleanup } = setup();
  try {
    const p = watched("1023", "کاظمی");
    const patch = (access) => app.request(`/api/telegram/persons/${p.id}`, { method: "PATCH", body: JSON.stringify({ access }) });
    await patch({ watch: true, pickupEvery: 30 });
    assert.equal(store.getKv(`tgwatch:${p.id}`), null);
    await patch({ watch: false, pickupEvery: 30 });
    assert.equal(store.getKv(`tgwatch:${p.id}`).on, false);
  } finally {
    cleanup();
  }
});

test("28: catch-up does not take a line another session already sent as the owner's line again", async () => {
  const h = accountHarness();
  try {
    await h.ready();
    const p = h.watched("555000111", "Rezaei");
    const t = Math.floor(Date.now() / 1000);
    const dm = { chatId: 555000111n, peerId: { userId: 555000111n } };
    h.store.addPersonMessage({ personId: p.id, direction: "out", text: "ایمیج رو دوباره بیلد کردم", data: { chatId: "555000111", by: "session" } });
    h.chatWith([
      { out: true, id: 21, date: t - 100, message: "ایمیج رو دوباره بیلد کردم", ...dm },
      { out: false, id: 20, date: t - 300, message: "بیلد فیل شد", ...dm },
    ]);
    await h.restart();
    const lines = h.store.getKv(`tgowner:${h.acc.id}:555000111`)?.lines || [];
    assert.equal(lines.filter((l) => l.text === "ایمیج رو دوباره بیلد کردم").length, 0);
    assert.equal(h.store.findPerson("555000111").history.filter((x) => x.text === "ایمیج رو دوباره بیلد کردم").length, 1);
  } finally {
    h.cleanup();
  }
});

test("29: the assistant sees what it sent and they have not answered, and edits or takes it back itself — nothing is capped", async () => {
  const { store, runner, sends, delivered, changes, acc, desk, watched, notes, cleanup } = setup();
  try {
    const p = watched("1031", "حسینی");
    await desk.colleague(acc.id, "1031", { person: p, text: "کش سایت پاک نمیشه" });
    store.addPersonMessage({ personId: p.id, direction: "in", text: "کش سایت پاک نمیشه", data: {} });
    const mother = sends[0].chatId;
    const tools = createMotherTools({
      store, runner, chatId: mother, name: "حسینی",
      sendToPerson: (t) => desk.sendToPerson(mother, t),
      editSent: (id, t) => desk.editSent(mother, id, t),
      deleteSent: (id) => desk.deleteSent(mother, id),
    });
    assert.equal(desk.annotate(mother), null, "nothing of its own is unanswered yet");
    await sleep(3); // its send comes after their message, not in the same millisecond
    await motherTurn(store, mother, { during: async () => tools.send_to_person.execute({ text: "دارم بررسی می‌کنم" }) });
    assert.match(desk.annotate(mother), /#1 .*«دارم بررسی می‌کنم»/);

    // A thread reports back: the result goes as a new message, the stale interim line is taken back.
    let result = null;
    await motherTurn(store, mother, {
      during: async () => {
        result = parse(await tools.send_to_person.execute({ text: "پاک شد، الان درست است" }));
        assert.deepEqual(result.unansweredBefore, [{ id: 1, text: "دارم بررسی می‌کنم" }]);
        assert.deepEqual(parse(await tools.delete_sent.execute({ id: 1 })), { deleted: true, id: 1 });
        assert.deepEqual(parse(await tools.edit_sent.execute({ id: "#2", text: "پاک شد؛ از سمت شما هم چک کنید 🙂" })), { edited: true, id: 2 }, "«#2» as shown works");
        assert.equal(parse(await tools.edit_sent.execute({ id: "2", text: "پاک شد؛ از سمت شما هم چک کنید" })).unchanged, true, "the same text again is no edit");
        assert.match(parse(await tools.edit_sent.execute({ id: 99, text: "x" })).error, /not a message you sent/);
      },
    });
    assert.equal(delivered.length, 2, "no send was blocked by a count");
    assert.deepEqual(changes, [["remove", "1031", 1], ["edit", "1031", 2, "پاک شد؛ از سمت شما هم چک کنید"]]);
    assert.doesNotMatch(desk.annotate(mother), /#1 /, "a deleted message is gone from her list");
    assert.match(desk.annotate(mother), /#2 \([^)]*ویرایش‌شده\)/);
    assert.match(store.getKv(`tgstate:${p.id}`).line, /#1 را برداشت/);

    // They answer: nothing of its own is pending any more.
    await sleep(3);
    store.addPersonMessage({ personId: p.id, direction: "in", text: "مرسی", data: {} });
    assert.equal(desk.annotate(mother), null);

    // While the owner is talking to them, an edit is held like a send: a draft he can apply.
    await desk.colleague(acc.id, "1031", { person: p, text: "یه چیز دیگه" });
    await motherTurn(store, mother, {
      during: async () => {
        await sleep(3);
        desk.ownerLine(acc.id, "1031", { text: "خودم جواب میدم" });
        assert.equal(parse(await tools.edit_sent.execute({ id: 2, text: "عدد درست ۵۰ است" })).held, true);
      },
    });
    assert.equal(changes.length, 2);
    await until(() => store.getKv(`tgstate:${p.id}`)?.state === "waiting");
    const held = store.getKv("tgwaiting").find((w) => w.op === "edit");
    assert.deepEqual([held.msgId, held.text], [2, "عدد درست ۵۰ است"]);
    assert.equal((await desk.act(held.id, "send")).ok, true);
    assert.deepEqual(changes.at(-1), ["edit", "1031", 2, "عدد درست ۵۰ است"]);
    assert.equal(store.getKv(`tgstate:${p.id}`).state, "edited");

    // One Telegram message: a text that would split is refused, not half-tracked.
    assert.match((await desk.sendToPerson(mother, "ا".repeat(3900))).error, /too long/);
  } finally {
    cleanup();
  }
});

test("30: the runner gives the model the annotate line before the message, the event keeps the message alone", async () => {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tg2-")), "db.sqlite"));
  let seen = null;
  const sdk = { async create() { return { agentId: "a", async send(message) { seen = message; return { id: "r", supports: () => true, async cancel() {}, async wait() { return { status: "finished" }; } }; } }; } };
  const runner = createRunner({ store, sdk, log: {}, agentOptions: () => ({}), annotate: (id) => `[note for ${id.slice(0, 4)}]` });
  const chat = store.createChat({ title: "m", caller: "team" });
  await runner.send(chat.id, { text: "«کریمی»: سلام" });
  await until(() => seen != null);
  assert.equal(String(seen.text ?? seen), `[note for ${chat.id.slice(0, 4)}]\n\n«کریمی»: سلام`);
  assert.equal([...store.allEvents(chat.id)].find((e) => e.type === "user").data.text, "«کریمی»: سلام");
  await until(() => !runner.isActive(chat.id));
  store.close();
});

test("31: a burst of messages becomes one turn; an explicit call does not wait; the wait is capped", async () => {
  const { store, sends, acc, desk, watched, cleanup } = setup({ burstMs: 45_000 });
  try {
    const p = watched("1032", "رضایی");
    assert.equal(await desk.colleague(acc.id, "1032", { person: p, text: "سلام" }), "queued");
    assert.equal(await desk.colleague(acc.id, "1032", { person: p, text: "پایپ‌لاین استیجینگ فیل شده" }), "queued");
    assert.equal(sends.length, 0);
    assert.equal(store.getKv(`tgstate:${p.id}`).state, "queued");
    await desk.drain(Date.now() + 46_000);
    assert.equal(sends.length, 1, "one turn for the burst");
    assert.match(sends[0].text, /سلام[\s\S]*پایپ‌لاین استیجینگ فیل شده/);

    const q = watched("1033", "موسوی");
    assert.equal(await desk.colleague(acc.id, "1033", { person: q, text: "گریفین باکت پر شده", called: true }), "run", "a group mention / explicit call runs now");

    // A photo runs now, with the message that waited before it, in order.
    const img = { data: "aGk=", mimeType: "image/png" };
    await desk.colleague(acc.id, "1032", { person: p, text: "یه خطا" });
    assert.equal(await desk.colleague(acc.id, "1032", { person: p, text: "این", images: [img] }), "run");
    assert.deepEqual(sends.at(-1).images, [img]);
    assert.match(sends.at(-1).text, /یه خطا[\s\S]*این/);
    // A call word likewise takes what waited before it — no later second turn.
    await desk.colleague(acc.id, "1032", { person: p, text: "دیتابیس فروش از دیشب کنده" });
    await desk.colleague(acc.id, "1032", { person: p, text: "گریفین میتونی چک کنی؟" });
    assert.match(sends.at(-1).text, /دیتابیس فروش[\s\S]*چک کنی/);
    const before = sends.length;
    await desk.drain(Date.now() + 200_000);
    assert.equal(sends.length, before, "nothing left to run twice");

    // Someone who keeps typing: the batch still runs at most four windows after it opened — counted
    // from when it opened, so a caught-up message written minutes ago still waits for the rest.
    const r = watched("1034", "احمدی");
    const all = () => store.getKv(`pickup:${acc.id}`)["1034"];
    await desk.colleague(acc.id, "1034", { person: r, text: "یک", at: Date.now() - 170_000 });
    await desk.colleague(acc.id, "1034", { person: r, text: "دو" });
    assert.ok(all().due > Date.now() && all().due <= all().opened + 4 * 45_000);
    // The one caught up minutes late tells the mother it came while she was updating; the fresh one does not.
    await desk.drain(Date.now() + 200_000);
    assert.match(sends.at(-1).text, /«احمدی» \(3 دقیقه پیش وقتی در حال آپدیت بودی رسید\): یک/);
    assert.match(sends.at(-1).text, /«احمدی»: دو/);

    // The owner's /agent on a waiting message: it runs once, in the order it was written.
    const s2 = watched("1035", "حسینی");
    await desk.colleague(acc.id, "1035", { person: s2, text: "پیام اول", messageId: 71 });
    await sleep(3);
    await desk.colleague(acc.id, "1035", { person: s2, text: "پیام دوم", messageId: 72 });
    await desk.colleague(acc.id, "1035", { person: s2, text: "پیام اول", messageId: 71, byOwner: true });
    assert.match(sends.at(-1).text, /پیام اول[\s\S]*پیام دوم/);
    assert.equal(sends.at(-1).text.match(/پیام اول/g).length, 1);
  } finally {
    cleanup();
  }
});

test("32: the supervisor notes a flood, a stuck conversation, old drafts and the same issue from two people — once", async () => {
  const { store, acc, desk, watched, notes, cleanup } = setup();
  try {
    const a = watched("1041", "کریمی");
    const b = watched("1042", "یوسفی");
    await desk.colleague(acc.id, "1041", { person: a, text: "رانر گیت‌لب خطا میده پایپ‌لاین بیلد نمیشه" });
    await desk.colleague(acc.id, "1042", { person: b, text: "پایپ‌لاین بیلد گیت‌لب فیل میشه رانر خطا میده" });
    store.addPersonMessage({ personId: a.id, direction: "in", text: "رانر گیت‌لب خطا میده", data: {} });
    // Well past that message: the sends below are stamped up to 5 ms before now.
    await sleep(30);
    const t = Date.now();
    // Four visible messages after their last one (the fifth was taken back: not counted).
    store.setKv(`tgsent:${a.id}`, [1, 2, 3, 4, 5].map((id) => ({ id, at: t - id, text: `پیام ${id}`, chatId: "m", deleted: id === 5 })));
    store.setKv(`tgstate:${b.id}`, { state: "working", line: "در حال بررسی", at: new Date(t - 40 * 60_000).toISOString() });
    store.setKv("tgwaiting", [{ id: "d1", kind: "draft", name: "کریمی", personId: a.id, chatId: "m", text: "x", at: new Date(t - 30 * 60_000).toISOString() }]);
    const found = desk.sweep();
    assert.deepEqual(found.map((f) => f.kind).sort(), ["drafts", "flood", "same_issue", "stale"]);
    const watch = notes(store.getKv("tg:global"), "watch");
    assert.equal(watch.length, 4);
    assert.match(watch.find((n) => n.finding === "flood").text, /کریمی.*۴ پیام/);
    assert.deepEqual(desk.sweep(), [], "the same findings are not noted again");
    // They answer: four sends are not a flood any more (and it was noted once anyway).
    store.addPersonMessage({ personId: a.id, direction: "in", text: "ok", data: {} });
    assert.deepEqual(desk.sweep(), []);
  } finally {
    cleanup();
  }
});

test("33: closing the last thread by hand leaves the person not «working» (no stuck note for it)", async () => {
  const { store, sends, acc, desk, app, watched, cleanup } = setup();
  try {
    const p = watched("1051", "رحیمی");
    await desk.colleague(acc.id, "1051", { person: p, text: "nocodb کند شده" });
    const mother = sends[0].chatId;
    const child = store.createChat({ title: "🧵 nocodb", caller: "griffin", parentChatId: mother });
    store.setKv(`delegate:${child.id}`, { parent: mother, state: "running" });
    store.setKv(`tgstate:${p.id}`, { state: "working", line: "رشته در کار است", at: new Date(Date.now() - 40 * 60_000).toISOString() });
    assert.equal((await post(app, `/api/telegram/threads/${child.id}/close`)).status, 200);
    assert.equal(store.getKv(`tgstate:${p.id}`).state, "no_reply");
    assert.deepEqual(desk.sweep().filter((f) => f.kind === "stale"), []);
  } finally {
    cleanup();
  }
});

test("34: at boot, queued batches wait for the account's catch-up (the owner's offline answers count first)", async () => {
  const { store, sends, acc, desk, watched, cleanup } = setup({ burstMs: 45_000, caughtUp: false });
  try {
    const p = watched("1061", "موسوی");
    await desk.colleague(acc.id, "1061", { person: p, text: "سرور کنده" });
    await desk.drain(Date.now() + 60_000);
    assert.equal(sends.length, 0, "catch-up has not reported yet");
    await sleep(3);
    desk.ownerLine(acc.id, "1061", { text: "درست شد" }); // caught up: he answered while the app was down
    desk.caughtUp(acc.id);
    await desk.drain(Date.now() + 60_000);
    assert.equal(store.getKv(`tgstate:${p.id}`)?.state, "owner");
    assert.equal(sends.length, 0, "his answer stands; the assistant does not answer it again");
  } finally {
    cleanup();
  }
});

test("35: the mother tools' id field works through the Claude tool schema (a string, with or without #)", async () => {
  const { z } = await import("zod");
  const { jsonSchemaToZodShape } = await import("../src/providers/json-schema-zod.mjs");
  const tools = createMotherTools({ store: null, runner: null, chatId: "m", name: "x", sendToPerson: async () => ({}) });
  for (const name of ["edit_sent", "delete_sent"]) {
    const shape = z.object(jsonSchemaToZodShape(tools[name].inputSchema));
    assert.equal(shape.safeParse({ id: "812", text: "x" }).success, true, name);
    assert.equal(shape.safeParse({ id: "#812", text: "x" }).success, true, name);
  }
  const union = z.object(jsonSchemaToZodShape({ type: "object", properties: { id: { type: ["integer", "string"] } } }));
  assert.equal(union.safeParse({ id: 812 }).success && union.safeParse({ id: "812" }).success, true, "a type list is one of its types");
});

test("36: a kept message run again carries one fresh note, not the old one too", async () => {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tg2-")), "db.sqlite"));
  const seen = [];
  let n = 0;
  let fail = true;
  const sdk = { async create() { return { agentId: "a", async send(message) { seen.push(String(message.text ?? message)); return { id: "r", supports: () => true, async cancel() {}, async wait() { if (fail) { fail = false; return { status: "error", error: { message: "engine down" } }; } return { status: "finished" }; } }; } }; } };
  const runner = createRunner({ store, sdk, log: {}, agentOptions: () => ({}), annotate: () => `[note ${++n}]` });
  const chat = store.createChat({ title: "m", caller: "team" });
  await runner.send(chat.id, { text: "سلام" });
  await until(() => !runner.isActive(chat.id));
  runner.retry(chat.id);
  await until(() => seen.length === 2 && !runner.isActive(chat.id));
  assert.deepEqual(seen, ["[note 1]\n\nسلام", "[note 2]\n\nسلام"]);
  store.close();
});

test("37: dismissing a failed turn lets go of the message the runner kept for it", async () => {
  const { store, runner, sends, acc, desk, app, watched, cleanup } = setup();
  try {
    const p = watched("1040", "موسوی");
    await desk.colleague(acc.id, "1040", { person: p, text: "سرور کنده" });
    const mother = sends[0].chatId;
    store.setKv(`kept:${mother}`, [{ id: "k1", message: { text: "سلام" }, ids: [], fails: 0 }]); // as the runner keeps an errored turn
    const dropped = [];
    runner.dropKept = (chatId, id) => (dropped.push([chatId, id]), true);
    await motherTurn(store, mother, { status: "error" });
    await until(() => store.getKv(`tgstate:${p.id}`)?.state === "failed");
    const [failed] = (await (await app.request("/api/telegram/feed")).json()).waiting;
    assert.equal(failed.kind, "failed");
    assert.equal((await post(app, `/api/telegram/waiting/${failed.id}`, { action: "dismiss" })).status, 200);
    assert.deepEqual(dropped, [[mother, "k1"]], "not back as «پیام نرسید», not retried later");
  } finally {
    cleanup();
  }
});

test("38: a turn that goes through clears the chat's «ارسال نشد»; «دوباره» on a stale one does not replay the old message", async () => {
  const { store, sends, acc, desk, app, watched, cleanup } = setup();
  try {
    const p = watched("1041", "صالحی");
    await desk.colleague(acc.id, "1041", { person: p, text: "سرور کنده" });
    const mother = sends[0].chatId;
    const waiting = async () => (await (await app.request("/api/telegram/feed")).json()).waiting;
    await motherTurn(store, mother, { status: "error" });
    await until(() => store.getKv(`tgstate:${p.id}`)?.state === "failed");
    assert.equal((await waiting()).length, 1);
    await motherTurn(store, mother);
    await until(() => store.getKv(`tgstate:${p.id}`)?.state === "no_reply");
    assert.equal((await waiting()).length, 0, "the later turn answered it");

    // A card pressed after its chat went through some other way (its finish not seen): no replay.
    await motherTurn(store, mother, { status: "error" });
    await until(async () => (await waiting()).length === 1);
    const [stale] = await waiting();
    await sleep(5);
    store.finishRun(mother, store.startRun(mother), "finished");
    const before = sends.length;
    assert.equal((await post(app, `/api/telegram/waiting/${stale.id}`, { action: "send" })).status, 200);
    assert.equal(sends.length, before, "the old prompt is not sent again");
    assert.equal((await waiting()).length, 0);
  } finally {
    cleanup();
  }
});

test("39: a note the owner took back from the queue is not the input of the next turn: the send is held while paused", async () => {
  const { store, runner, sends, delivered, acc, desk, watched, cleanup } = setup();
  try {
    const p = watched("1042", "جعفری");
    await desk.colleague(acc.id, "1042", { person: p, text: "سرویس بالا نمیاد" });
    const mother = sends[0].chatId;
    const tools = createMotherTools({ store, runner, chatId: mother, name: "جعفری", sendToPerson: (t) => desk.sendToPerson(mother, t) });
    await sleep(3);
    // His note, queued behind the colleague's batch, then removed from the peek (or still waiting).
    const removed = store.appendEvent(mother, null, "user", { text: "بهش بگو ریستارت کردم", intent: "queue", tracked: true }).id;
    store.appendEvent(mother, null, "user.queue", { userEventId: removed, state: "removed" });
    await sleep(3);
    desk.setPaused(true);
    let result = null;
    await motherTurn(store, mother, { during: async () => (result = parse(await tools.send_to_person.execute({ text: "دارم نگاه می‌کنم" }))) });
    assert.deepEqual([result.held, result.reason], [true, "paused"], "the colleague's turn, not his");

    store.appendEvent(mother, null, "user", { text: "هنوز در صف", intent: "queue", tracked: true });
    await sleep(3);
    await motherTurn(store, mother, { during: async () => (result = parse(await tools.send_to_person.execute({ text: "باز هم" }))) });
    assert.equal(result.held, true, "a note still waiting is no turn's input either");

    // A note the turn did take (started) is his request: never held.
    const taken = store.appendEvent(mother, null, "user", { text: "بگو درست شد", intent: "queue", tracked: true }).id;
    await sleep(3);
    await motherTurn(store, mother, {
      during: async () => {
        store.appendEvent(mother, null, "user.queue", { userEventId: taken, state: "started" });
        result = parse(await tools.send_to_person.execute({ text: "درست شد" }));
      },
    });
    assert.equal(result.sent, true);
    assert.equal(delivered.length, 1);
  } finally {
    cleanup();
  }
});

test("40: «اجرا کن» on a failed turn re-sends the colleague's input as theirs, not a removed note as the owner's", async () => {
  const { store, sends, acc, desk, app, watched, cleanup } = setup();
  try {
    const p = watched("1043", "نوری");
    await desk.colleague(acc.id, "1043", { person: p, text: "دیپلوی فیل شد" });
    const mother = sends[0].chatId;
    await sleep(3);
    const removed = store.appendEvent(mother, null, "user", { text: "یادداشت پس‌گرفته", intent: "queue", tracked: true }).id;
    store.appendEvent(mother, null, "user.queue", { userEventId: removed, state: "removed" });
    store.appendEvent(mother, null, "user", { text: "یادداشت هنوز در صف", intent: "queue", tracked: true });
    await motherTurn(store, mother, { status: "error" });
    await until(() => store.getKv(`tgstate:${p.id}`)?.state === "failed");
    const [failed] = (await (await app.request("/api/telegram/feed")).json()).waiting;
    assert.equal((await post(app, `/api/telegram/waiting/${failed.id}`, { action: "send" })).status, 200);
    assert.equal(sends.at(-1).text, "«نوری»: دیپلوی فیل شد");
    assert.deepEqual(sends.at(-1).from, { kind: "colleague", name: "نوری", personId: p.id, forced: true });
  } finally {
    cleanup();
  }
});

test("41: a watched person still blocked by the old «دسترسی» flag is answered again (migration + the watcher switch)", async () => {
  const { store, desk, watched, cleanup } = setup();
  try {
    const a = watched("1071", "احمدی", { watch: true, enabled: false });
    const b = watched("1072", "موسوی", { watch: false, enabled: false });
    const { migrateWatchEnables } = await import("../src/integrations/mother.mjs");
    store.deleteKv("migr:watch-enables"); // setup already ran it on an empty store
    assert.equal(migrateWatchEnables(store), 1);
    assert.equal(store.getPerson(a.id).access.enabled, true, "watched: unblocked");
    assert.equal(store.getPerson(b.id).access.enabled, false, "not watched: left as it was");
    assert.equal(migrateWatchEnables(store), 0, "once");
    // Turning the watcher on lifts the flag too, even when the watcher was already on.
    store.updatePerson(a.id, { access: { ...store.getPerson(a.id).access, enabled: false } });
    await desk.setWatch(a.id, true, { decided: true });
    assert.equal(store.getPerson(a.id).access.enabled, true);
  } finally {
    cleanup();
  }
});

// Small talk is answered only together with a later message that can start a thread.
test("42: small talk alone gets no turn; it goes with the next real message, or lapses unanswered", async () => {
  const { smallTalk } = await import("../src/integrations/threads.mjs");
  for (const t of ["سلام", "سلام، وقت بخیر 🌹", "صبح به خیر", "خسته‌نباشید", "ممنون", "مرسی 🙏", "[استیکر]", "@someone سلام", "گریفین سلام"]) assert.equal(smallTalk(t), true, t);
  // Answers to something the assistant asked are never held: a no, an ok, a number, a thumbs-up.
  for (const t of ["سلام، پایپ‌لاین فیل شده", "بله", "اوکی", "خیر", "خیر، ممنون", "خوبه", "۲ ممنون", "802798 ممنون", "ممنون 👍", "👍", "", "ممنون، حل شد"]) assert.equal(smallTalk(t), false, t);

  const { store, sends, acc, desk, watched, cleanup } = setup({ burstMs: 45_000 });
  try {
    const p = watched("1071", "نوری");
    await desk.colleague(acc.id, "1071", { person: p, text: "سلام، وقت بخیر" });
    assert.equal(store.getKv(`tgstate:${p.id}`).state, "greeting");
    await desk.drain(Date.now() + 10 * 60_000);
    assert.equal(sends.length, 0, "a greeting alone is not answered");
    // The real message, minutes later: one turn with both, after its own burst wait.
    await desk.colleague(acc.id, "1071", { person: p, text: "ربات مانیتور لاگین ساکت شده" });
    assert.equal(store.getKv(`tgstate:${p.id}`).state, "queued");
    const due = store.getKv(`pickup:${acc.id}`)["1071"].due;
    assert.ok(due > Date.now() && due <= Date.now() + 45_000, "the greeting's long wait does not delay the real message");
    await desk.drain(Date.now() + 46_000);
    assert.equal(sends.length, 1);
    assert.match(sends[0].text, /وقت بخیر[\s\S]*ربات مانیتور لاگین/);

    // A call word or a mention does not make a greeting a request.
    const q = watched("1072", "کاظمی");
    await desk.colleague(acc.id, "1072", { person: q, text: "گریفین سلام", called: true });
    assert.equal(sends.length, 1);
    // A photo, or the owner's /agent, runs now and takes the greeting along.
    const img = { data: "aGk=", mimeType: "image/png" };
    assert.equal(await desk.colleague(acc.id, "1072", { person: q, text: "", images: [img] }), "run");
    assert.match(sends.at(-1).text, /گریفین سلام/);

    // A greeting joining a waiting real message leaves its time alone.
    const r = watched("1073", "جعفر");
    await desk.colleague(acc.id, "1073", { person: r, text: "باکت پر شده" });
    const before = store.getKv(`pickup:${acc.id}`)["1073"].due;
    await desk.colleague(acc.id, "1073", { person: r, text: "ممنون" });
    assert.equal(store.getKv(`pickup:${acc.id}`)["1073"].due, before);
    await desk.drain(Date.now() + 46_000);
    assert.match(sends.at(-1).text, /باکت پر شده[\s\S]*ممنون/);

    // A sticker carries its preview frame, but its label is all it says: held too.
    const u = watched("1075", "مرادی");
    assert.equal(await desk.colleague(acc.id, "1075", { person: u, text: "[استیکر]", images: [img] }), "queued");
    assert.equal(store.getKv(`tgstate:${u.id}`).state, "greeting");
    // A photo captioned «سلام» is content: queued behind the owner's line, it still runs.
    const v = watched("1076", "سلیمی");
    desk.ownerLine(acc.id, "1076", { text: "الان میام" });
    await sleep(3);
    await desk.colleague(acc.id, "1076", { person: v, text: "سلام", images: [img] });
    const ran = sends.length;
    await desk.drain(Date.now() + 11 * 60_000);
    assert.equal(sends.length, ran + 1, "the photo's turn is not dropped as small talk");

    // Nothing after it for 12 hours: it lapses, recorded, never answered.
    const s2 = watched("1074", "احمدی");
    await desk.colleague(acc.id, "1074", { person: s2, text: "سلام خوبی؟" });
    const count = sends.length;
    await desk.drain(Date.now() + 13 * 3_600_000);
    assert.equal(sends.length, count);
    assert.equal(store.getKv(`tgstate:${s2.id}`).state, "no_reply");
    assert.equal(store.getKv(`pickup:${acc.id}`)["1074"], undefined);
  } finally {
    cleanup();
  }
});

// The mother can react to, reply to and edit its messages, not only send new ones.
test("43: the mother reacts instead of writing, and replies to a chosen message; the owner in the chat stops both", async () => {
  const { store, sends, delivered, reactions, acc, desk, watched, cleanup } = setup();
  try {
    const p = watched("1081", "رحیمی");
    await desk.colleague(acc.id, "1081", { person: p, text: "استیجینگ بالا اومد", messageId: 501 });
    const mother = sends[0].chatId;
    assert.match(sends[0].text, /«رحیمی» \(#501\): استیجینگ بالا اومد/, "their line carries its id");

    await motherTurn(store, mother, {
      during: async () => {
        assert.deepEqual(await desk.reactTo(mother, null, "👍"), { reacted: true, id: 501, emoji: "👍" }, "default: the message this turn answers");
        assert.equal((await desk.reactTo(mother, "#499", "❤️")).reacted, true, "an emoji's variation selector is fine");
        assert.match((await desk.reactTo(mother, null, "🍌")).error, /does not take/);
      },
    });
    await sleep(10);
    assert.deepEqual(reactions, [["1081", 501, "👍"], ["1081", 499, "❤"]]);
    assert.equal(delivered.length, 0, "a reaction is not a message");
    assert.equal(store.getKv(`tgstate:${p.id}`).state, "reacted");

    const sent = await desk.sendToPerson(mother, "کدوم سرویس؟", { replyTo: "#499" });
    assert.equal(sent.sent, true);
    assert.equal(delivered.at(-1).replyTo, 499);
    assert.match((await desk.sendToPerson(mother, "x", { replyTo: "دیروزی" })).error, /replyTo must be/);

    // The default is the message the turn started from: a follow-up queued behind it is not it,
    // and a turn that answers none of theirs (a thread report) has no default at all.
    store.appendEvent(mother, null, "user", { text: "«رحیمی» (#502): یه چیز دیگه", from: { kind: "colleague", name: "رحیمی", personId: p.id, msgId: 502 }, intent: "queue", tracked: true });
    await motherTurn(store, mother, { during: async () => assert.equal((await desk.reactTo(mother, null, "👌")).id, 501) });
    store.appendEvent(mother, null, "user", { text: "[گزارش خودکار زیرکارها — این پیام را سیستم فرستاده]" });
    await motherTurn(store, mother, { during: async () => assert.match((await desk.reactTo(mother, null, "👍")).error, /answers none of theirs/) });
    reactions.length = 2;

    // The owner writes to them himself: neither a reaction nor a reply goes.
    await sleep(3);
    desk.ownerLine(acc.id, "1081", { text: "دیدم" });
    assert.equal((await desk.reactTo(mother, "#501", "🙏")).held, true);
    assert.equal(reactions.length, 2);
  } finally {
    cleanup();
  }
});

test("44: owner or a Claude session joining while the assistant works: it hears it at once, drafts stay held", async () => {
  const { store, runner, sends, acc, desk, watched, app, cleanup } = setup();
  try {
    const p = watched("1090", "صالحی");
    await desk.colleague(acc.id, "1090", { person: p, text: "VPN وصل نمیشه", messageId: 9 });
    const mother = sends[0].chatId;
    runner.isActive = (id) => id === mother;
    desk.ownerLine(acc.id, "1090", { text: "خودم نگاه می‌کنم" });
    assert.equal(sends.length, 2);
    assert.deepEqual([sends[1].chatId, sends[1].intent, sends[1].from], [mother, "steer", { kind: "owner_line" }]);
    assert.equal(sends[1].text, "«صاحب‌کار در تلگرام به صالحی»: خودم نگاه می‌کنم");
    assert.deepEqual(store.getKv(`tgowner:${acc.id}:1090`).lines, [], "told now, not again with her next message");

    const res = await post(app, `/api/telegram/persons/${p.id}/session-note`, { text: "روتر را خودم درست کردم" });
    assert.equal(res.status, 200);
    assert.match(sends[2].text, /^«صاحب‌کار در جلسهٔ Claude دیگرش .*دستور به تو نیست»: روتر را خودم درست کردم$/);
    assert.ok(store.getKv(`tgowner:${acc.id}:1090`).at > 0, "a claim holds the assistant like his own line (R3: its next turn waits)");
    await sleep(3);
    assert.equal(await desk.colleague(acc.id, "1090", { person: p, text: "هنوز وصل نمیشه", messageId: 10 }), "queued");
    assert.equal(store.listPersonMessages?.(p.id)?.some?.((m) => m.direction === "out") || false, false, "nothing went to the colleague");

    // Idle and nothing open: the line waits for her next turn, as before.
    runner.isActive = () => false;
    desk.ownerLine(acc.id, "1090", { text: "حل شد" });
    assert.equal(sends.length, 3);
    assert.equal(store.getKv(`tgowner:${acc.id}:1090`).lines.length, 1);
  } finally {
    cleanup();
  }
});

test("45: a Claude session's prompt naming a colleague reaches the assistant once; the session gets what it is doing", async () => {
  const { store, runner, sends, acc, desk, watched, app, cleanup } = setup();
  try {
    const p = watched("1091", "محمد صالحی");
    watched("1092", "جعفر");
    await desk.colleague(acc.id, "1091", { person: p, text: "VPN وصل نمیشه", messageId: 3 });
    const mother = sends[0].chatId;
    runner.isActive = (id) => id === mother;
    const res = await post(app, "/api/sessions/activity", { session: "s1", text: "مشکل VPN صالحی رو چک کن" });
    const body = await res.json();
    assert.deepEqual(body.matched, ["محمد صالحی"], "family name, word-bounded (not «جعفری»-like substrings)");
    assert.match(body.context, /«محمد صالحی»: در حال کار/);
    assert.match(sends.at(-1).text, /^«صاحب‌کار در جلسهٔ Claude دیگرش .*محمد صالحی.*دستور به تو نیست»: مشکل VPN صالحی رو چک کن$/);
    assert.equal(store.getKv(`tgowner:${acc.id}:1091`).at, 0, "a session's note holds no draft: the assistant decides");
    const before = sends.length;
    await post(app, "/api/sessions/activity", { session: "s1", text: "صالحی دوباره" });
    assert.equal(sends.length, before, "once per session and person in 30 minutes");
    assert.deepEqual((await (await post(app, "/api/sessions/activity", { session: "s2", text: "جعفری را ببین" })).json()).matched, []);
    const n = sends.length;
    const harness = await (await post(app, "/api/sessions/activity", { session: "s3", text: "<task-notification>\n<event>MSG از صالحی دربارهٔ VPN</event>" })).json();
    assert.deepEqual(harness.matched, [], "a monitor's notification is not something he typed");
    assert.equal(sends.length, n, "and it never reaches a mother");
  } finally {
    cleanup();
  }
});

test("46: a colleague's bot turn sees what the owner's sessions work on; a session sees the assistant's runs and can tell any of its chats", async () => {
  const { store, runner, sends, desk, app, cleanup } = setup();
  try {
    await post(app, "/api/sessions/activity", { session: "sess-upload-1", text: "مشکل آپلود فایل فروشگاه: S3 شرق پر شده، چک کن" });
    const bot = store.createChat({ title: "🤖 آقای سلیمی: S3", caller: "peer:bob", agent: "griffin" });
    const note = desk.annotate(bot.id);
    assert.match(note, /جلسه‌های Claude خود Owner/);
    assert.match(note, /S3 شرق پر شده/);
    assert.equal(desk.annotate(store.createChat({ title: "mine", caller: "owner" }).id), null, "the owner's own chats: no block");

    const sub = store.createChat({ title: "← گریفین: S3 شرق", caller: "griffin", agent: "platform" });
    store.startRun(sub.id);
    const ctx = (await (await post(app, "/api/sessions/activity", { session: "sess-upload-1", text: "ادامه" })).json()).context;
    assert.match(ctx, new RegExp(`در حال کار \\(${sub.id}\\): ← گریفین: S3 شرق`));
    store.finishRun(bot.id, store.startRun(bot.id), "finished", null);
    assert.match((await (await post(app, "/api/sessions/activity", { session: "sess-upload-1", text: "و؟" })).json()).context, new RegExp(`تمام شد .* \\(${bot.id}\\): 🤖 آقای سلیمی`), "its finished bot reply shows too");

    assert.equal((await post(app, "/api/sessions/note", { chatId: bot.id, text: "S3 را من دارم" })).status, 200);
    assert.deepEqual([sends.at(-1).chatId, sends.at(-1).from], [bot.id, { kind: "owner_line" }]);
    assert.match(sends.at(-1).text, /جلسهٔ Claude دیگرش.*S3 را من دارم/);
    assert.equal((await post(app, "/api/sessions/note", { chatId: "nope", text: "x" })).status, 404);
  } finally {
    cleanup();
  }
});

// Private share (private-share.mjs): an invite or a code sent from the owner's account is not the owner
// talking to that person — not live, and not when a reconnect's catch-up reads the dialog again.
test("47: a private-share invite is never the owner's line — its live echo, and catch-up after a restart", async () => {
  const { telegramForShares } = await import("../src/private-share.mjs");
  const { rememberShareSend } = await import("../src/integrations/share-sends.mjs");
  const h = accountHarness();
  try {
    await h.ready();
    const p = h.watched("555000111", "Rezaei");
    const invite = "گفتگوی «فروش» را با شما به اشتراک گذاشتم:\nhttps://g.example/#/p/abc";
    const tg = telegramForShares(h.client, { store: h.store, markSent: (id) => h.integrations.markAccountSent(id) });
    await tg.send("555000111", invite);
    const sentId = 901; // the harness numbers sends from 901
    // The live echo, shaped like gramjs's (bigint ids).
    await h.owner(sentId, invite);
    const ownerLines = () => (h.store.getKv(`tgowner:${h.acc.id}:555000111`)?.lines || []).filter((l) => l.text.includes("#/p/"));
    const ownerHistory = () => h.store.findPerson("555000111").history.filter((x) => String(x.text || "").includes("#/p/"));
    assert.equal(ownerLines().length, 0, "live: not an owner line");
    assert.equal(ownerHistory().length, 0, "live: not in the person's history as the owner's words");

    // A new process: only what is stored survives. The code sent before the restart comes back in catch-up.
    const t = Math.floor(Date.now() / 1000);
    const dm = { chatId: 555000111n, peerId: { userId: 555000111n } };
    const code = "کد ورود به گفتگوی «فروش»: 123456\nده دقیقه اعتبار دارد. https://g.example/#/p/abc";
    rememberShareSend(h.store, "555000111", 77);
    h.chatWith([
      { out: true, id: 77, date: t - 60, message: code, ...dm },
      { out: false, id: 76, date: t - 300, message: "سلام، یه سوال داشتم", ...dm },
    ]);
    await h.restart();
    assert.equal(ownerLines().length, 0, "catch-up: the code is not an owner line on the desk");
    assert.equal(ownerHistory().length, 0, "catch-up: not in the history as the owner's words");
    assert.ok(p);
  } finally {
    h.cleanup();
  }
});

// Telegram can deliver the echo of an outgoing message before sendMessage resolves: the id is not
// known yet (markSent has not run), so only the text registered before the send (takeQuiet) keeps it out.
test("48: a private-share code whose echo arrives before the send resolves is not the owner's line", async () => {
  const { telegramForShares } = await import("../src/private-share.mjs");
  const h = accountHarness();
  try {
    await h.ready();
    h.watched("555000111", "Rezaei");
    const send = h.client.sendMessage;
    let echoed = false;
    h.client.sendMessage = async (to, opts) => {
      await h.owner(950, opts.message); // the echo, first
      echoed = true;
      const sent = await send(to, opts);
      return { ...sent, id: 950 };
    };
    const code = "کد ورود به گفتگوی «فروش»: 654321\nده دقیقه اعتبار دارد. https://g.example/#/p/abc";
    const tg = telegramForShares(h.client, { store: h.store, markSent: (id) => h.integrations.markAccountSent(id) });
    await tg.send("555000111", code);
    assert.ok(echoed, "the echo came before the send resolved");
    const lines = (h.store.getKv(`tgowner:${h.acc.id}:555000111`)?.lines || []).filter((l) => l.text.includes("654321"));
    const history = h.store.findPerson("555000111").history.filter((x) => String(x.text || "").includes("654321"));
    assert.equal(lines.length, 0, "not an owner line on the desk");
    assert.equal(history.length, 0, "not in the person's history as the owner's words");
  } finally {
    h.cleanup();
  }
});
test("paused: a person an owner chat wrote to is not answered either — the pause stops every chat", async () => {
  const { store, sends, acc, desk, watched, cleanup } = setup();
  try {
    const p = watched("1303", "کریمی");
    const own = store.createChat({ title: "درخواست‌ها", agent: "griffin" });
    desk.askedBy(acc.id, "1303", own.id, "شمارهٔ درخواست را بفرستید");
    assert.equal(desk.hasAskers(acc.id, "1303"), true);
    desk.setPaused(true);
    const before = sends.length;
    assert.equal(await desk.colleague(acc.id, "1303", { person: p, text: "شماره‌اش ۸۱۹۶۷۴ است", messageId: 11 }), "paused");
    assert.equal(sends.length, before, "no run in the mother, nothing forwarded to the asking chat");
    desk.setPaused(false);
    assert.equal(await desk.colleague(acc.id, "1303", { person: p, text: "پیدا شد؟", messageId: 12 }), "run");
  } finally {
    cleanup();
  }
});
test("a line an owner chat sent to someone whose auto-reply is off is in their history, naming that chat — a «سلام» too", async () => {
  const { store, acc, desk, watched, cleanup } = setup();
  try {
    watched("1304", "خانی‌زاده", { watch: false });
    const own = store.createChat({ title: "هماهنگی جلسه", agent: "griffin" });
    desk.ownerLine(acc.id, "1304", { text: "سلام", by: "session", from: { chatId: own.id, title: "هماهنگی جلسه" } });
    desk.ownerLine(acc.id, "1304", { text: "فردا ساعت ۱۰ وقت دارید؟", by: "session" });
    const out = store.findPerson("1304").history.filter((m) => m.direction === "out");
    assert.deepEqual(out.map((m) => [m.text, m.data.by, m.data.fromChat || null, m.data.fromTitle || null]), [
      ["سلام", "chat", own.id, "هماهنگی جلسه"],
      ["فردا ساعت ۱۰ وقت دارید؟", "session", null, null],
    ]);
  } finally {
    cleanup();
  }
});
test("an owner chat that wrote to a person is one of their threads: the mother hears the reply and forwards it", async () => {
  const { store, runner, sends, acc, desk, watched, cleanup } = setup();
  try {
    const off = watched("1302", "ناظر", { watch: false });
    const own = store.createChat({ title: "کار من", agent: "griffin" });
    // His chat's own send counts as him in the conversation; that must not hold their reply.
    desk.ownerLine(acc.id, "1302", { text: "لاگ رو بفرستید", by: "session" });
    desk.askedBy(acc.id, "1302", own.id, "لاگ رو بفرستید");
    assert.equal(desk.hasAskers(acc.id, "1302"), true);

    assert.equal(await desk.colleague(acc.id, "1302", { person: off, text: "اینم لاگ: timeout", messageId: 9 }), "run");
    const mother = sends.at(-1).chatId;
    assert.notEqual(mother, own.id, "the mother decides; nothing is reserved");
    assert.match(desk.annotate(mother), new RegExp(`chat ${own.id} «کار من»`));

    const tools = createMotherTools({ store, runner, chatId: mother, name: "ناظر", sendToPerson: () => ({}), forwardToChat: (c, n) => desk.forwardToChat(mother, c, n) });
    assert.ok(parse(await tools.forward_to_chat.execute({ chat: "nope" })).error);
    assert.deepEqual(parse(await tools.forward_to_chat.execute({ chat: own.id })), { forwarded: true, chat: own.id, title: "کار من" });
    const forwarded = sends.at(-1);
    assert.equal(forwarded.chatId, own.id);
    assert.equal(forwarded.from.kind, "colleague");
    assert.match(forwarded.text, /timeout/);

    // An archived chat is no thread any more; an unwatched person is then silent again.
    store.updateChat(own.id, { archived: true });
    assert.equal(desk.hasAskers(acc.id, "1302"), false);
    assert.equal(desk.annotate(mother), null);
  } finally {
    cleanup();
  }
});

test("a chat of his that never wrote to the person is still a candidate: the mother sees its topic and can hand the message over", async () => {
  const { store, runner, sends, acc, desk, watched, cleanup } = setup();
  try {
    const mahla = watched("1401", "مهلا");
    const setupChat = store.createChat({ title: "راه‌اندازی پنل", agent: "griffin" });
    store.appendEvent(setupChat.id, null, "user", { text: "پنل مالی را هم مثل بقیه راه بنداز", ownerText: true });
    const other = store.createChat({ title: "بررسی دیسک", agent: "griffin" });
    store.appendEvent(other.id, null, "user", { text: "دیسک db1 را ببین", ownerText: true });

    assert.equal(desk.hasAskers(acc.id, "1401"), false, "recent chats alone do not open the gates");
    assert.equal(await desk.colleague(acc.id, "1401", { person: mahla, text: "ایمیل من mahla@example.com است", messageId: 4 }), "run");
    const mother = sends.at(-1).chatId;
    const note = desk.annotate(mother);
    assert.match(note, new RegExp(`chat ${setupChat.id} «راه‌اندازی پنل».*پنل مالی را هم مثل بقیه راه بنداز`));
    assert.match(note, new RegExp(`chat ${other.id} «بررسی دیسک»`));
    assert.doesNotMatch(note, new RegExp(`chat ${mother}\\b`), "the mother chat itself is not a candidate");

    const tools = createMotherTools({ store, runner, chatId: mother, name: "مهلا", sendToPerson: () => ({}), forwardToChat: (c, n) => desk.forwardToChat(mother, c, n) });
    assert.deepEqual(parse(await tools.forward_to_chat.execute({ chat: setupChat.id })), { forwarded: true, chat: setupChat.id, title: "راه‌اندازی پنل" });
    assert.equal(sends.at(-1).chatId, setupChat.id);
    assert.match(sends.at(-1).text, /mahla@example\.com/);
    assert.equal(desk.hasAskers(acc.id, "1401"), true, "after the hand-over their next messages keep reaching the mother");
    assert.ok(parse(await tools.forward_to_chat.execute({ chat: "no-such" })).error);
  } finally {
    cleanup();
  }
});

test("a hand-over to a chat at work arrives mid-turn (steer), saying whose words they are and how to answer them", async () => {
  const { store, runner, sends, acc, desk, watched, cleanup } = setup();
  try {
    const p = watched("1501", "کاظمی");
    const own = store.createChat({ title: "کندی جستجو", agent: "griffin" });
    store.appendEvent(own.id, null, "user", { text: "چرا جستجو کنده؟", ownerText: true });
    assert.equal(await desk.colleague(acc.id, "1501", { person: p, text: "الان هم کنده", messageId: 7 }), "run");
    const mother = sends.at(-1).chatId;
    runner.isActive = (id) => id === own.id;
    assert.equal((await desk.forwardToChat(mother, own.id)).forwarded, true);
    const sent = sends.at(-1);
    assert.equal(sent.chatId, own.id);
    assert.equal(sent.intent, "steer", "a chat already awake gets it now, not after its turn");
    assert.match(sent.text, /«کاظمی»/);
    assert.match(sent.text, /نه /, "the head says it is not the owner");
    assert.match(sent.text, /خودت به «کاظمی» پیام نده/);
    assert.match(sent.text, /الان هم کنده/);
    runner.isActive = () => false;
    await desk.forwardToChat(mother, own.id);
    assert.equal(sends.at(-1).intent, "send", "an idle chat is woken");
  } finally {
    cleanup();
  }
});

test("a shared thread is in the main list, offered to every mother, and whoever hands it a message gets its result", async () => {
  const { store, runner, sends, acc, desk, watched, cleanup } = setup();
  try {
    const a = watched("1601", "علی");
    const b = watched("1602", "بهار");
    assert.equal(await desk.colleague(acc.id, "1601", { person: a, text: "گیت‌لب بالا نمیاد", messageId: 1 }), "run");
    const motherA = sends.at(-1).chatId;
    // What delegate {shared:true} leaves behind (peers.mjs).
    const thread = store.createChat({ title: "🧵 قطعی گیت‌لب", agent: "platform", caller: "griffin", parentChatId: motherA });
    store.setKv(`delegate:${thread.id}`, { parent: motherA, agent: "platform", state: "running" });
    store.setKv(`sharedthread:${thread.id}`, { by: "علی", motherChat: motherA });
    assert.ok(store.listChatsBySource().some((c) => c.id === thread.id && c.source === "manual"), "listed in the main sidebar");

    assert.equal(await desk.colleague(acc.id, "1602", { person: b, text: "گیت‌لب برای منم باز نمیشه", messageId: 2 }), "run");
    const motherB = sends.at(-1).chatId;
    assert.match(desk.annotate(motherB), new RegExp(`chat ${thread.id} «🧵 قطعی گیت‌لب».*رشتهٔ عمومی`));
    assert.doesNotMatch(desk.annotate(motherA) || "", new RegExp(`chat ${thread.id}`), "not offered back to its own mother");

    const tools = createMotherTools({ store, runner, chatId: motherB, name: "بهار", sendToPerson: () => ({}), forwardToChat: (c, n) => desk.forwardToChat(motherB, c, n) });
    assert.equal(parse(await tools.forward_to_chat.execute({ chat: thread.id })).forwarded, true);
    assert.match(sends.at(-1).text, /گزارش نهایی همین رشته/);
    assert.deepEqual(store.getKv(`threadsubs:${thread.id}`), [motherB], "its result reaches بهار too");
  } finally {
    cleanup();
  }
});

test("a colleague reporting what an open incident shows goes to the ops room for that incident, once an hour", async () => {
  const { store, runner, sends, acc, desk, watched, cleanup } = setup();
  try {
    const { createIncidentStore } = await import("../src/incidents/index.mjs");
    const { createOpsRoom } = await import("../src/incidents/opsroom.mjs");
    const incidents = createIncidentStore(store.db);
    const opsRoom = createOpsRoom({ store, runner, incidents, mode: "critical" });
    desk.setOps({ open: () => incidents.open(), isAcked: (r) => incidents.isAcked(r), log: (...a) => incidents.log(...a), relay: (m) => opsRoom.relay(m), roomId: () => opsRoom.roomId() });
    const inc = incidents.insert({ key: "east|PublicAppEndpointDown|www", cluster: "east", alertname: "PublicAppEndpointDown", scope: "www", severity: "critical", summary: "www.example.com 503", members: ["www"], seenFrom: ["east"] });
    incidents.insert({ key: "west|KubePodNotReady|x", cluster: "west", alertname: "KubePodNotReady", severity: "warning", summary: "noise", members: ["x"], seenFrom: ["west"] });

    const p = watched("1701", "رضایی");
    assert.equal(await desk.colleague(acc.id, "1701", { person: p, text: "سایت باز نمیشه برای بیمارا", messageId: 3 }), "run");
    const mother = sends.at(-1).chatId;
    const note = desk.annotate(mother);
    const ref = `incident:${inc.id.slice(0, 8)}`;
    assert.match(note, new RegExp(`${ref} «PublicAppEndpointDown · east · www» \\(critical\\)`));
    assert.doesNotMatch(note, /KubePodNotReady/, "an untriaged warning is not offered");

    const tools = createMotherTools({ store, runner, chatId: mother, name: "رضایی", sendToPerson: () => ({}), forwardToChat: (c, n) => desk.forwardToChat(mother, c, n) });
    const out = parse(await tools.forward_to_chat.execute({ chat: ref }));
    assert.equal(out.forwarded, true);
    assert.match(out.next, /one short line/);
    const room = opsRoom.roomId();
    assert.ok(room);
    assert.equal(sends.at(-1).chatId, room);
    assert.match(sends.at(-1).text, /اتاق عملیات — حالت سایه/, "a fresh room gets its charter first");
    assert.match(sends.at(-1).text, /«رضایی».*حادثهٔ/);
    assert.match(sends.at(-1).text, /سایت باز نمیشه/);
    assert.ok(incidents.logs(inc.id).some((l) => l.kind === "reported" && l.data.name === "رضایی"));

    const before = sends.length;
    assert.equal(parse(await tools.forward_to_chat.execute({ chat: ref })).forwarded, true);
    assert.equal(sends.length, before, "the same person's next report this hour is only logged");
    assert.ok(parse(await tools.forward_to_chat.execute({ chat: "incident:ffffffff" })).error);
  } finally {
    cleanup();
  }
});

test("a hand-over the chat calls unrelated comes back to the mother, which handles it itself", async () => {
  const { store, sends, acc, desk, watched, cleanup } = setup();
  try {
    const p = watched("1801", "کاظمی");
    const own = store.createChat({ title: "آپدیت نصب‌ها", agent: "griffin" });
    store.appendEvent(own.id, null, "user", { text: "همهٔ نصب‌ها را آپدیت کن", ownerText: true });
    assert.equal(await desk.colleague(acc.id, "1801", { person: p, text: "پنل سلیمی ۵۰۲ می‌دهد", messageId: 9 }), "run");
    const mother = sends.at(-1).chatId;
    assert.match(desk.annotate(mother), /با ایشان کاری نداشته/, "a chat that never wrote to them is labelled so");
    assert.equal((await desk.forwardToChat(mother, own.id, "", "آپدیت نصب‌ها")).forwarded, true);
    assert.match(sends.at(-1).text, /به گمان .*آپدیت نصب‌ها/);
    assert.match(sends.at(-1).text, /ربطی نداشت/, "the head says how to decline");
    const before = sends.length;
    await motherTurn(store, own.id, { text: "آپدیت تمام شد. پیام «کاظمی» به این گفتگو ربطی نداشت." });
    await until(() => sends.length > before);
    assert.equal(sends.at(-1).chatId, mother);
    assert.match(sends.at(-1).text, /ربطی نداشت/);
    assert.match(sends.at(-1).text, /سلیمی/);
    assert.equal(desk.hasAskers(acc.id, "1801"), false, "that chat is no longer one of their threads");
  } finally {
    cleanup();
  }
});

test("a colleague's agent is answered on the agents' network, not in Telegram; with no network path Telegram needs a stated reason", async () => {
  const said = [];
  const network = {
    list: () => [{ id: "griffin-karimi-example-org", owner: "ابوالفضل کریمی", connected: true }],
    say: async (id, text, opts) => (said.push({ id, text, chatId: opts.chatId }), { state: "completed", answer: "دریافت شد" }),
  };
  const { store, runner, sends, delivered, acc, desk, watched, cleanup } = setup({ network });
  try {
    const bot = watched("10000001", "ابوالفضل کریمی", { watch: true, peerAgent: { user: "akarimibot" } });
    await desk.colleague(acc.id, "10000001", { person: bot, text: "سلام، فضای S3 چطوره؟", messageId: 9 });
    const mother = sends[0].chatId;
    const tools = createMotherTools({ store, runner, chatId: mother, name: "ابوالفضل کریمی", sendToPerson: (t, o) => desk.sendToPerson(mother, t, o) });
    const r = parse(await tools.send_to_person.execute({ text: "فضا ۶۵ گیگ مانده" }));
    assert.equal(r.sent, true);
    assert.equal(r.via, "network");
    assert.equal(r.agent, "griffin-karimi-example-org");
    assert.deepEqual(said, [{ id: "griffin-karimi-example-org", text: "فضا ۶۵ گیگ مانده", chatId: mother }]);
    assert.equal(delivered.length, 0, "nothing went to Telegram");

    // An assistant that signs, but whose install is not on the network: stopped, then allowed with a reason.
    const other = watched("777", "علی ناشناس", { watch: true, peerAgent: { user: "ali-bot" } });
    await desk.colleague(acc.id, "777", { person: other, text: "پایپ‌لاین فیل شده، لطفاً نگاه کنید", messageId: 3 });
    const motherB = sends.at(-1).chatId;
    const toolsB = createMotherTools({ store, runner, chatId: motherB, name: "علی ناشناس", sendToPerson: (t, o) => desk.sendToPerson(motherB, t, o) });
    const stopped = parse(await toolsB.send_to_person.execute({ text: "جواب" }));
    assert.equal(stopped.sent, false);
    assert.match(stopped.error, /network_connect/);
    assert.equal(delivered.length, 0);
    const forced = parse(await toolsB.send_to_person.execute({ text: "جواب", telegram_because: "network_agents has none under his name; network_connect found no install" }));
    assert.equal(forced.sent, true);
    assert.equal(delivered.length, 1);

    // A human is never touched by this.
    const human = watched("888", "امیرحسین توکلی");
    await desk.colleague(acc.id, "888", { person: human, text: "شمارهٔ سرور قدیمی رو می‌خوام", messageId: 4 });
    const motherC = sends.at(-1).chatId;
    const toolsC = createMotherTools({ store, runner, chatId: motherC, name: "امیرحسین توکلی", sendToPerson: (t, o) => desk.sendToPerson(motherC, t, o) });
    assert.equal(parse(await toolsC.send_to_person.execute({ text: "شمارهٔ سرور رو فرستادم" })).sent, true);
    assert.equal(delivered.length, 2);
    assert.equal(said.length, 1);
  } finally {
    cleanup();
  }
});
