import test from "node:test";
import assert from "node:assert/strict";
import { keepSameRows, readChatsCache, writeChatsCache } from "../src/chats-cache.js";

const memory = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
};

test("the chat list written is the one read back, capped", () => {
  const storage = memory();
  const chats = Array.from({ length: 300 }, (_, i) => ({ id: `c${i}` }));
  writeChatsCache(chats, [{ id: "g" }], storage);
  const back = readChatsCache(storage);
  assert.equal(back.chats.length, 120);
  assert.deepEqual(back.groups, [{ id: "g" }]);
});

test("nothing stored, broken storage or junk is no cache", () => {
  assert.equal(readChatsCache(memory()), null);
  assert.equal(readChatsCache({ getItem: () => "{not json" }), null);
  assert.equal(readChatsCache({ getItem: () => JSON.stringify({ chats: "x" }) }), null);
  assert.doesNotThrow(() => writeChatsCache([], [], { setItem: () => { throw new Error("full"); } }));
});

test("keepSameRows: unchanged rows keep their objects; an unchanged list keeps its array", () => {
  const a = { id: "a", title: "A", children: [{ id: "k" }] };
  const b = { id: "b", title: "B" };
  const before = [a, b];
  assert.equal(keepSameRows(before, [{ id: "a", title: "A", children: [{ id: "k" }] }, { id: "b", title: "B" }]), before, "nothing changed: the same array, no redraw");
  const changed = keepSameRows(before, [{ id: "a", title: "A", children: [{ id: "k" }] }, { id: "b", title: "B2" }]);
  assert.equal(changed[0], a, "the unchanged row is the same object");
  assert.equal(changed[1].title, "B2");
  const moved = keepSameRows(before, [{ id: "b", title: "B" }, { id: "a", title: "A", children: [{ id: "k" }] }]);
  assert.notEqual(moved, before, "a new order is a new list");
  assert.deepEqual([moved[0], moved[1]], [b, a], "of the same rows");
  assert.deepEqual(keepSameRows(before, [b]), [b], "a row gone");
  assert.notEqual(keepSameRows([], [a]), undefined);
});
