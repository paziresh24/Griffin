import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { createAsks } from "../src/asks.mjs";
import { openStore } from "../src/db.mjs";
import { addOwnerTask, buildInbox, todoSummary } from "../src/inbox.mjs";

function setup() {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-inbox-")), "db.sqlite"));
  const asks = createAsks({ store, log: {} });
  const sent = [];
  const runner = { isActive: () => false, activeCount: () => 0, send: async (chatId, input) => (sent.push({ chatId, ...input }), { delivered: "run" }) };
  const app = createApp({ store, runner, asks });
  return { store, asks, app, sent };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const post = (app, url, body) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("buildInbox: every kind, in order, without what is not the owner's to act on", async () => {
  const { store, asks } = setup();
  const root = store.createChat({ title: "دسترسی لاگ" });
  const child = store.createChat({ title: "زیرکار", parentChatId: root.id, caller: "griffin", agent: "platform" });
  const peer = store.createChat({ title: "درخواست همکار", caller: "peer:ali" });
  const rehearsal = store.createChat({ title: "شبیه‌سازی", sim: true });
  const question = asks.tool(root.id).execute({ question: "کدام کلاستر؟", options: [{ label: "cluster-1" }] });
  const approval = asks.confirm(child.id, { question: "مرج کنم؟" });
  const clarification = asks.requesterTool(peer.id).execute({ question: "کدام اپ؟" });
  const simAsk = asks.tool(rehearsal.id).execute({ question: "تمرینی؟" });
  await tick();

  const talk = store.createChat({ title: "تلگرام" });
  const gone = store.createChat({ title: "پاک‌شده" });
  const failedTg = store.createChat({ title: "شکست تلگرام", caller: "team" });
  store.setKv(`motherof:${failedTg.id}`, { integrationId: "i", key: "2", personId: "p2", name: "خانم احمدی" });
  store.setKv("tgwaiting", [
    { id: "w1", kind: "draft", op: "edit", reason: null, personId: "p1", name: "آقای کریمی", chatId: talk.id, text: "سلام", at: "2026-10-12T10:00:00.000Z" },
    { id: "w2", kind: "failed", personId: "p2", name: "خانم احمدی", chatId: failedTg.id, text: "x", at: "2026-10-12T10:01:00.000Z" },
  ]);
  store.setKv(`kept:${talk.id}`, [{ id: "k1", message: { text: "نرسید" }, fails: 0 }, { id: "k2", message: { text: "دوم" }, fails: 0 }]);
  store.setKv(`kept:${failedTg.id}`, [{ id: "k3", message: { text: "تکراری" }, fails: 0 }]);
  store.setKv(`kept:${gone.id}`, [{ id: "k4", message: { text: "یتیم" }, fails: 0 }]);
  store.deleteChat(gone.id);
  const note = store.createNote({ text: "بعداً بپرس", chatId: talk.id });
  store.claimNote(note.id);
  store.finishNote(note.id, { error: "engine down" });
  const chore = addOwnerTask(store, { title: "توکن Cursor را عوض کن", detail: "در لاگ Z.ai دیده شد", chatId: root.id, agent: "griffin" });
  store.setKv(`todo:${root.id}`, { todos: [{ content: "الف", status: "completed" }, { content: "ب", status: "in_progress" }, { content: "ج", status: "pending" }], at: "x" });

  const inbox = buildInbox({ store, asks });
  assert.deepEqual(inbox.items.map((i) => i.kind), ["approval", "question", "telegram", "telegram", "kept", "note", "chore"]);
  assert.equal(inbox.count, 7);
  const [a, q, tg, , kept, n, c] = inbox.items;
  assert.equal(a.chatId, root.id, "an approval from a sub-agent lands on its root");
  assert.equal(a.sourceChatId, child.id);
  assert.equal(a.agent, "platform");
  assert.equal(a.title, "دسترسی لاگ");
  assert.match(a.id, /^ask:[a-f0-9]{8}$/);
  assert.deepEqual(q.options, [{ label: "cluster-1" }]);
  assert.deepEqual([tg.waitingKind, tg.op, tg.name], ["draft", "edit", "آقای کریمی"]);
  assert.deepEqual([kept.chatId, kept.keptId, kept.count, kept.text], [talk.id, "k1", 2, "نرسید"]);
  assert.deepEqual([n.noteId, n.error, n.chatTitle], [note.id, "engine down", "تلگرام"]);
  assert.deepEqual([c.id, c.choreId, c.title, c.detail, c.chatId], [`chore:${chore.id}`, chore.id, "توکن Cursor را عوض کن", "در لاگ Z.ai دیده شد", root.id]);
  assert.deepEqual(inbox.todos, { [root.id]: { done: 1, total: 3, current: "ب" } });

  for (const id of [root.id, child.id, peer.id, rehearsal.id]) asks.cancel(id);
  await Promise.all([question, approval, clarification, simAsk]);
});

test("todoSummary: done counts cancelled too; current falls back to the first pending step", () => {
  assert.equal(todoSummary(null), null);
  assert.equal(todoSummary({ todos: [] }), null);
  assert.deepEqual(todoSummary({ todos: [{ content: "a", status: "cancelled" }, { content: "b", status: "pending" }] }), { done: 1, total: 2, current: "b" });
});

test("owner chores: trimmed, masked, capped at the newest 100", () => {
  const { store } = setup();
  assert.equal(addOwnerTask(store, { title: "  " }), null);
  const long = addOwnerTask(store, { title: "x".repeat(200), detail: "y".repeat(900) });
  assert.equal(long.title.length, 120);
  assert.equal(long.detail.length, 600);
  for (let i = 0; i < 105; i += 1) addOwnerTask(store, { title: `کار ${i}` });
  const list = store.getKv("ownertasks");
  assert.equal(list.length, 100);
  assert.equal(list.at(-1).title, "کار 104");
});

test("GET /api/inbox, chores cleared from the board, and an answer for a question that is gone", async () => {
  const { store, asks, app, sent } = setup();
  const chat = store.createChat({ title: "گفتگو" });
  const asked = asks.tool(chat.id).execute({ question: "ادامه بدهم؟" });
  await tick();
  const chore = addOwnerTask(store, { title: "با آقای رضایی صحبت کن", chatId: chat.id });

  const inbox = await (await app.request("/api/inbox")).json();
  assert.deepEqual(Object.keys(inbox).sort(), ["count", "items", "todos"]);
  assert.equal(inbox.count, 2);
  const askId = inbox.items[0].askId;

  const stale = await post(app, `/api/chats/${chat.id}/answer`, { askId: "deadbeef", text: "ok" });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).gone, true);
  assert.equal(sent.length, 0, "a stale card never becomes a message");
  assert.equal(asks.isWaiting(chat.id), true);

  const ok = await post(app, `/api/chats/${chat.id}/answer`, { askId, text: "بله" });
  assert.deepEqual(await ok.json(), { delivered: "tool" });
  assert.equal(JSON.parse((await asked).content[0].text).answer, "بله");

  assert.equal((await post(app, `/api/inbox/chores/${chore.id}`, { action: "later" })).status, 400);
  assert.equal((await post(app, `/api/inbox/chores/${chore.id}`, { action: "done" })).status, 200);
  assert.equal((await post(app, `/api/inbox/chores/${chore.id}`, { action: "dismiss" })).status, 404, "already gone");
  assert.equal((await (await app.request("/api/inbox")).json()).count, 0);
});

test("the store tells the board only about the keys and notes it shows", () => {
  const { store } = setup();
  let n = 0;
  store.bus.on("inbox", () => (n += 1));
  store.setKv("todo:x", { todos: [] });
  store.setKv("kept:x", []);
  store.setKv("tgwaiting", []);
  store.setKv("ownertasks", []);
  store.deleteKv("kept:x");
  assert.equal(n, 5);
  store.setKv("other", 1);
  store.setKv("tgwaiting2", 1);
  store.deleteKv("other");
  assert.equal(n, 5);
  const note = store.createNote({ text: "x" });
  store.claimNote(note.id);
  assert.equal(n, 6);
  store.finishNote(note.id, { error: "boom" });
  assert.equal(n, 7);
  store.deleteNote(note.id);
  assert.equal(n, 8);
});

test("buildInbox: requester questions nobody but the owner answers, kept rows that need nothing of him, a chore's origin", async () => {
  const { store, asks } = setup();
  // Requester questions from delegated children: an owner root, a mother root, a linked team root, a peer root.
  const ownerRoot = store.createChat({ title: "کار خودم" });
  const mother = store.createChat({ title: "👤 مینا", caller: "team" });
  store.setKv(`motherof:${mother.id}`, { integrationId: "i", key: "1", personId: null, name: "مینا" });
  const coverage = store.createChat({ title: "پوشش", caller: "team" });
  const bot = store.createIntegration({ kind: "telegram_bot", name: "b", secret: "x" });
  store.linkChat(bot.id, "42", coverage.id);
  const peer = store.createChat({ title: "همتا", caller: "peer:ali" });
  const kid = (root) => store.createChat({ title: "زیرکار", parentChatId: root.id, caller: "griffin", agent: "platform" });
  const kids = [ownerRoot, mother, coverage, peer].map(kid);
  const waits = kids.map((k) => asks.requesterTool(k.id).execute({ question: `کدام برنچ؟ ${k.id.slice(0, 4)}` }));
  await tick();
  const asked = buildInbox({ store, asks }).items.filter((i) => i.kind === "question");
  assert.deepEqual(asked.map((i) => i.chatId).sort(), [ownerRoot.id, mother.id].sort(), "the owner's chain and the mother's, not the colleague's");
  assert.equal(asks.ownerWaiting(ownerRoot.id), true);
  assert.equal(asks.ownerWaiting(mother.id), true);
  assert.equal(asks.ownerWaiting(coverage.id), false);
  for (const k of kids) asks.cancel(k.id);
  await Promise.all(waits);

  // Kept messages: a mother's (the desk owns it, even after «ولش کن»), a rehearsal's, one waiting
  // for the plan limit to reset, and a plain one that needs him.
  const rehearsal = store.createChat({ title: "شبیه‌سازی", sim: true });
  const rehearsalKid = store.createChat({ title: "زیرکار تمرین", parentChatId: rehearsal.id, caller: "griffin" });
  const limited = store.createChat({ title: "سقف" });
  const plain = store.createChat({ title: "ساده" });
  for (const chat of [mother, rehearsal, rehearsalKid, limited, plain]) store.setKv(`kept:${chat.id}`, [{ id: `k-${chat.id}`, message: { text: "نرسید" }, fails: 0 }]);
  store.setKv("limit-resume", { [limited.id]: { at: Date.now() + 60_000, tries: 0 } });
  assert.deepEqual(buildInbox({ store, asks }).items.filter((i) => i.kind === "kept").map((i) => i.chatId), [plain.id]);

  // A chore keeps the chain it came from: a colleague's agent can make the assistant write one.
  store.createPeerUser({ id: "ali", label: "آقای علوی" });
  const fromPeer = addOwnerTask(store, { title: "به گروه X اضافه‌اش کن", chatId: kids[3].id });
  const fromMother = addOwnerTask(store, { title: "با خانم احمدی حرف بزن", chatId: mother.id });
  const own = addOwnerTask(store, { title: "توکن را عوض کن", chatId: ownerRoot.id });
  const chores = Object.fromEntries(buildInbox({ store, asks }).items.filter((i) => i.kind === "chore").map((i) => [i.choreId, i.who]));
  assert.equal(chores[fromPeer.id], "آقای علوی", "a sub-agent's chore names the root's colleague");
  assert.equal(chores[fromMother.id], null, "a mother chat names its colleague through the person, absent here");
  assert.equal(chores[own.id], null);
});

test("POST /answer: a stale card's text, with another question open on the chain, is a follow-up message — never held", async () => {
  const { store, asks } = setup();
  const sent = [];
  let held = 0;
  const realHold = asks.holdEarly;
  asks.holdEarly = (...args) => ((held += 1), realHold(...args));
  const runner = { isActive: () => true, activeCount: () => 1, send: async (chatId, input) => (sent.push({ chatId, ...input }), { delivered: "queued" }) };
  const app = createApp({ store, runner, asks });
  const root = store.createChat({ title: "ریشه" });
  const child = store.createChat({ title: "زیرکار", parentChatId: root.id, caller: "griffin", agent: "platform" });
  const approval = asks.confirm(child.id, { question: "kube exec بزنم؟" });
  await tick();
  const res = await post(app, `/api/chats/${root.id}/answer`, { question: "اولی را انجام بدهم؟", selected: ["بله"] });
  assert.equal(res.status, 202);
  assert.equal(held, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].intent, "queue");
  assert.match(sent[0].text, /اولی را انجام بدهم؟/);
  assert.equal(asks.isWaiting(root.id), true, "the approval is untouched");
  asks.cancel(child.id);
  assert.equal((await approval).answered, false);
});
