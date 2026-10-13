import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import { createAsks, ownerAnswers } from "../src/asks.mjs";

// Two children c1, c2 of root r, both asking the owner at once.
function setup() {
  const chats = { r: { id: "r", caller: "owner" }, c1: { id: "c1", caller: "griffin" }, c2: { id: "c2", caller: "griffin" } };
  const events = [];
  const bus = new EventEmitter();
  const emitted = [];
  bus.on("chats", (e) => emitted.push(e));
  const store = {
    bus,
    getChat: (id) => chats[id],
    rootChatId: (id) => (id === "c1" || id === "c2" ? "r" : id),
    appendEvent: (id, run, type, data) => (events.push({ id, type, data }), { id: events.length }),
  };
  const settledInfo = [];
  const asks = createAsks({ store, log: {}, onSettled: (target, info) => settledInfo.push({ target, ...info }) });
  return { asks, events, emitted, settledInfo };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const parsed = async (p) => JSON.parse((await p).content[0].text);

it("each open question has its own id and an answer by id settles only that one", async () => {
  const { asks } = setup();
  const first = asks.tool("c1").execute({ question: "اول؟" });
  const second = asks.tool("c2").execute({ question: "دوم؟" });
  await tick();
  const list = asks.list();
  assert.equal(list.length, 2);
  assert.ok(list.every((a) => /^[a-f0-9]{8}$/.test(a.id) && a.rootChatId === "r"));
  assert.notEqual(list[0].id, list[1].id);
  const c2 = list.find((a) => a.sourceChatId === "c2");
  assert.equal(asks.answer("r", { answer: "x", askId: "deadbeef" }), false, "an unknown id settles nothing");
  assert.equal(asks.answer("r", { answer: "x", askId: c2.id }), true);
  assert.equal((await parsed(second)).answer, "x");
  assert.equal(asks.isWaiting("c1"), true, "c1's question is still open");
  let firstDone = false;
  first.then(() => (firstDone = true));
  await tick();
  assert.equal(firstDone, false);
  asks.cancel("c1");
});

it("an answer by question text settles that question, not the queue head", async () => {
  const { asks } = setup();
  const first = asks.tool("c1").execute({ question: "اول؟" });
  const second = asks.tool("c2").execute({ question: "دوم؟" });
  await tick();
  assert.equal(asks.answer("r", { answer: "y", question: "دوم؟" }), true);
  assert.equal((await parsed(second)).answer, "y");
  assert.deepEqual(asks.list().map((a) => a.sourceChatId), ["c1"]);
  assert.equal(asks.answer("r", { answer: "z", question: "نیست؟" }), false, "a text that matches nothing settles nothing");
  assert.equal(asks.isWaiting("c1"), true);
  assert.equal(asks.answer("r", { answer: "z" }), true, "no text at all: the oldest");
  assert.equal((await parsed(first)).answer, "z");
});

it("a stale card's answer never lands on another chain question (a guard approval would read it as yes)", async () => {
  const { asks } = setup();
  const stale = asks.tool("c1").execute({ question: "اولی را انجام بدهم؟", options: [{ label: "بله" }, { label: "نه" }] });
  await tick();
  asks.cancel("c1"); // c1's run stopped: its card now says an answer goes as a new message
  await stale;
  const approval = asks.confirm("c2", { question: "  kube exec روی پاد بزنم؟\n" });
  await tick();
  assert.equal(asks.answer("r", { answer: "بله", selected: ["بله"], question: "اولی را انجام بدهم؟" }), false);
  assert.equal(asks.isWaiting("r"), true, "the approval is still open");
  assert.equal(asks.answer("r", { answer: "نه", question: "kube exec روی پاد بزنم؟" }), true, "texts compare trimmed");
  assert.equal((await approval).answer, "نه");
});

it("the mirrored card opens and closes under one callId; ask.pending carries askId and via", async () => {
  const { asks, events } = setup();
  const asked = asks.tool("c1").execute({ question: "اوکیه؟" });
  const approval = asks.confirm("c2", { question: "مرج کنم؟" });
  await tick();
  const [plain, guard] = asks.list();
  asks.answer("r", { answer: "بله", askId: plain.id });
  await asked;
  const started = events.find((e) => e.type === "tool.started" && e.data.args.askId === plain.id);
  const done = events.find((e) => e.type === "tool.done" && e.data.args.askId === plain.id);
  assert.equal(started.data.callId, `peer-ask-${plain.id}`);
  assert.equal(done.data.callId, started.data.callId);
  const pendings = events.filter((e) => e.type === "ask.pending");
  assert.deepEqual(pendings.map((e) => [e.data.askId, e.data.via]), [[plain.id, null], [guard.id, "guard"]]);
  asks.cancel("c2");
  await approval;
});

it("enqueue, settle and cancel each tell the board; a partial cancel closes just that question", async () => {
  const { asks, emitted, settledInfo } = setup();
  asks.tool("c1").execute({ question: "اول؟" });
  const second = asks.tool("c2").execute({ question: "دوم؟" });
  await tick();
  assert.equal(emitted.filter((e) => e.type === "ask" && e.chatId === "r").length, 2, "one per enqueue");
  const c1 = asks.list().find((a) => a.sourceChatId === "c1");
  asks.cancel("c1");
  assert.equal(emitted.length, 3, "cancel emits");
  assert.equal(settledInfo.length, 1);
  assert.equal(settledInfo[0].cancelled, true);
  assert.equal(settledInfo[0].askId, c1.id);
  assert.equal(asks.ownerWaiting("r"), true, "c2's question is still open");
  asks.answer("r", { answer: "ok" });
  await second;
  assert.equal(emitted.length, 4, "settle emits");
  assert.equal(settledInfo.at(-1).askId !== c1.id, true);
  assert.equal(asks.ownerWaiting("r"), false);
});

it("a queue holding only a requester question is not waiting for the owner", async () => {
  const chats = { p: { id: "p", caller: "peer:ali" } };
  const store = { getChat: (id) => chats[id], rootChatId: (id) => id, appendEvent: () => ({ id: 1 }) };
  const asks = createAsks({ store, log: {} });
  const asked = asks.requesterTool("p").execute({ question: "کدام اپ؟" });
  await tick();
  assert.equal(asks.isWaiting("p"), true);
  assert.equal(asks.ownerWaiting("p"), false);
  assert.equal(asks.list()[0].audience, "requester");
  asks.cancel("p");
  await asked;
});

it("a requester question is the owner's wherever nobody else can answer it", async () => {
  const chats = {
    r: { id: "r", caller: "owner" },
    ops: { id: "ops", caller: "ops" },
    mom: { id: "mom", caller: "team" },
    team: { id: "team", caller: "team" },
    lone: { id: "lone", caller: "team" },
    p: { id: "p", caller: "peer:ali" },
  };
  const parentOf = { kid: "r", kidOps: "ops", kidMom: "mom", kidTeam: "team", kidLone: "lone", kidP: "p" };
  for (const id of Object.keys(parentOf)) chats[id] = { id, caller: "griffin" };
  const kv = { "motherof:mom": { name: "مینا" } };
  const store = {
    getChat: (id) => chats[id],
    getKv: (key) => kv[key] ?? null,
    linksForChat: (id) => (id === "team" || id === "mom" ? [{ integration_id: "i", external_chat: "1" }] : []),
    rootChatId: (id) => parentOf[id] || id,
    appendEvent: () => ({ id: 1 }),
  };
  const asks = createAsks({ store, log: {} });
  const owners = { kid: true, kidOps: true, kidMom: true, kidLone: true, kidTeam: false, kidP: false };
  const waits = Object.keys(owners).map((id) => asks.requesterTool(id).execute({ question: `${id} کدام؟` }));
  await tick();
  for (const [id, mine] of Object.entries(owners)) {
    const root = parentOf[id];
    assert.equal(asks.list().find((a) => a.sourceChatId === id).audience, "requester");
    assert.equal(ownerAnswers(store, { audience: "requester", rootChatId: root }), mine, id);
    assert.equal(asks.ownerWaiting(id), mine, `${id} waiting for the owner`);
  }
  assert.equal(ownerAnswers(store, { audience: "owner", rootChatId: "p" }), true);
  for (const id of Object.keys(owners)) asks.cancel(id);
  await Promise.all(waits);
});

it("a card answered before its own question waits for exactly that one, even while another is open", async () => {
  const { asks } = setup();
  const other = asks.tool("c1").execute({ question: "اول؟" });
  await tick();
  let woke = null;
  const waiting = asks.waitForQuestion("r", { question: "دوم؟", timeoutMs: 2_000 }).then((v) => (woke = v));
  await tick();
  assert.equal(woke, null, "the open «اول؟» does not count");
  const second = asks.tool("c2").execute({ question: "دوم؟ " }); // trailing space as the tool trims
  await waiting;
  assert.equal(woke, true);
  assert.equal(asks.answer("r", { answer: "بله", question: "دوم؟" }), true);
  assert.equal((await parsed(second)).answer, "بله");
  assert.equal(asks.isWaiting("c1"), true);
  asks.cancel("c1");
  await other;
});
