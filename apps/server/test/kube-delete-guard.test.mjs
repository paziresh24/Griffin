import test from "node:test";
import assert from "node:assert/strict";
import { deleteGuard, forgetDecisions } from "../src/guard.mjs";
import { createAsks } from "../src/asks.mjs";

// 2026-10-29, after !352: kube_delete's own fence holds in every chain, full access included.
function setup(caller, { personId = null } = {}) {
  forgetDecisions();
  const kv = new Map();
  const rows = [];
  const store = {
    rows,
    rootChatId: () => "r1",
    getChat: () => ({ id: "r1", caller, title: "حذف", person_id: personId }),
    getKv: (k) => kv.get(k) ?? null,
    setKv: (k, v) => kv.set(k, v),
    recordApproval: (row) => rows.push(row),
    appendEvent: () => {},
  };
  const asks = createAsks();
  const ran = [];
  const tools = { kube_delete: { inputSchema: { type: "object", properties: {} }, async execute(args) { ran.push(args.name); return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] }; } } };
  const guarded = deleteGuard(tools, { chatId: "r1", asks, store, caller });
  return { store, kv, asks, ran, guarded };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
const call = (over = {}) => ({ cluster: "east", namespace: "akazemi", kind: "CronJob", name: "a", ...over });

test("a colleague chain with full access deletes only in its own namespace", async () => {
  const { guarded, ran, asks } = setup("peer:akazemi");
  const out = await guarded.kube_delete.execute(call({ namespace: "sara-jafari" }));
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /sara-jafari[\s\S]*نه درخواست‌کننده/);
  assert.equal(asks.isWaiting("r1"), false, "refused, nobody asked");
  await guarded.kube_delete.execute(call());
  assert.deepEqual(ran, ["a"], "its own namespace runs");
  forgetDecisions();
});

test("a Telegram colleague with no mapped namespace deletes nothing; a mapped one deletes in it", async () => {
  const { guarded, ran, kv } = setup("team", { personId: "p1" });
  assert.equal((await guarded.kube_delete.execute(call())).isError, true);
  kv.set("peer-owner", { "person:p1": "akazemi" });
  await guarded.kube_delete.execute(call());
  assert.deepEqual(ran, ["a"]);
  forgetDecisions();
});

test("the 4th delete in an hour asks the owner, even in the owner's own chat on «بدون پرسیدن»", async () => {
  const { guarded, ran, asks } = setup("owner");
  for (const name of ["a", "b", "c"]) await guarded.kube_delete.execute(call({ name }));
  assert.equal(asks.isWaiting("r1"), false);
  const pending = guarded.kube_delete.execute(call({ name: "d" }));
  await tick();
  assert.equal(asks.isWaiting("r1"), true, "the 4th waits on the owner");
  assert.match(asks.list()[0].question, /شمارهٔ 4 در یک ساعت/);
  asks.answer("r1", { answer: "بله", selected: ["بله"] });
  await pending;
  assert.deepEqual(ran, ["a", "b", "c", "d"]);
  // A failed delete does not use up the cap.
  forgetDecisions();
  const fresh = setup("owner");
  fresh.guarded.kube_delete = deleteGuard({ kube_delete: { async execute() { return { isError: true, content: [{ type: "text", text: "{}" }] }; } } }, { chatId: "r1", asks: fresh.asks, store: fresh.store }).kube_delete;
  for (let i = 0; i < 5; i++) await fresh.guarded.kube_delete.execute(call({ name: `x${i}` }));
  assert.equal(fresh.asks.isWaiting("r1"), false);
  forgetDecisions();
});

test("a Deployment or StatefulSet delete asks the owner on every call, even with full access", async () => {
  const { guarded, ran, asks } = setup("peer:akazemi");
  const pending = guarded.kube_delete.execute(call({ kind: "Deployment", name: "web" }));
  await tick();
  assert.equal(asks.isWaiting("r1"), true);
  assert.match(asks.list()[0].question, /Deployment است: حذفش/);
  asks.answer("r1", { answer: "نه", selected: ["نه"] });
  assert.equal((await pending).isError, true);
  assert.deepEqual(ran, []);
  const second = guarded.kube_delete.execute(call({ kind: "StatefulSet", name: "db" }));
  await tick();
  assert.equal(asks.isWaiting("r1"), true);
  asks.answer("r1", { answer: "بله", selected: ["بله"] });
  await second;
  assert.deepEqual(ran, ["db"]);
  forgetDecisions();
});

test("where the inner gate refuses anyway (a colleague on «بپرس»), nothing is asked; the namespace rule still holds", async () => {
  forgetDecisions();
  const asks = createAsks();
  const store = { rootChatId: () => "r1", getChat: () => ({ id: "r1", caller: "peer:akazemi" }), getKv: () => null, setKv: () => {}, recordApproval: () => {} };
  const ran = [];
  const guarded = deleteGuard({ kube_delete: { async execute(a) { ran.push(a.kind); return { isError: true, content: [] }; } } }, { chatId: "r1", asks, store, passThrough: true });
  await guarded.kube_delete.execute(call({ kind: "Deployment" }));
  assert.equal(asks.isWaiting("r1"), false);
  assert.deepEqual(ran, ["Deployment"]);
  assert.equal((await guarded.kube_delete.execute(call({ namespace: "sara-jafari" }))).isError, true);
  assert.deepEqual(ran, ["Deployment"]);
});
