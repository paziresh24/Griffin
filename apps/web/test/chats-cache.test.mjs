import test from "node:test";
import assert from "node:assert/strict";
import { readChatsCache, writeChatsCache } from "../src/chats-cache.js";

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
