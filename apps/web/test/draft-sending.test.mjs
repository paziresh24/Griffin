// A message still on its way when the page closed comes back to the box.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
};
// Each import with its own query is a fresh module: a new page with nothing in flight.
const page = (n) => import(`../src/draft.js?page=${n}`);

test("a send cut by the page closing comes back once; one that landed or was answered does not", async () => {
  const storage = memoryStorage();
  const before = await page(1);
  before.holdSending(storage, "c1", "پیام اول", "k-1");
  before.holdSending(storage, "c1", "پیام دوم", "k-2");
  const answered = before.holdSending(storage, "c1", "جواب گرفت", "k-3");
  before.releaseSending(storage, "c1", answered);
  assert.equal(before.recoverSending(storage, "c1"), "", "this page still owns its sends: nothing comes back");

  const after = await page(2);
  assert.equal(after.recoverSending(storage, "c1", new Set(["k-2"])), "پیام اول", "k-2 is in the timeline (it arrived); k-3 was released");
  assert.equal(after.recoverSending(storage, "c1"), "", "returned once, then forgotten");
  assert.equal(storage.map.size, 0);
});

test("a new chat's send is held under its own key; empty text is not held", async () => {
  const storage = memoryStorage();
  const before = await page(3);
  before.holdSending(storage, null, "چت تازه");
  before.holdSending(storage, "c2", "   ");
  const after = await page(4);
  assert.equal(after.recoverSending(storage, null), "چت تازه");
  assert.equal(after.recoverSending(storage, "c2"), "");
});

test("the runtime holds each send, releases it when settled, and recovers after the timeline loads", () => {
  const src = fs.readFileSync(new URL("../src/runtime.jsx", import.meta.url), "utf8");
  assert.match(src, /holdSending\(tabStorage\(\), chatId, typed\.typed, clientId\)/, "a chat's send is held with its client id");
  assert.match(src, /settle: \(entry, outcome, error\) => \{\s*if \(entry\.held\) releaseSending/, "every settle releases it");
  assert.match(src, /releaseSending\(tabStorage\(\), boxId, held\)/, "a new chat's send is released when the POST ends");
  assert.match(src, /function tabStorage\(\) \{\s*try \{\s*return window\.sessionStorage;/, "held per tab: another tab never takes over a send this one owns");
  assert.match(src, /returnToBox\(chatId, recoverSending\(tabStorage\(\), chatId, landed\)\)/, "a lost send goes back to the box");
});
