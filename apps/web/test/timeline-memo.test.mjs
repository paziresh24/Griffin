// Switching between chats: a chat opened before is shown from memory at once, and the header
// does not flash a connection warning while its history is (re)loaded.
import test from "node:test";
import assert from "node:assert/strict";
import { connectionNotice, createTimelineMemo } from "../src/timeline-memo.js";

test("a remembered chat comes back with the revision that folded it", () => {
  const memo = createTimelineMemo();
  assert.equal(memo.recall("a"), null);
  const timeline = { messages: [{ id: "u1" }], lastEventId: 7 };
  memo.remember("a", timeline, "r1");
  assert.deepEqual(memo.recall("a"), { timeline, rev: "r1" });
  memo.forget("a");
  assert.equal(memo.recall("a"), null);
});

test("nothing is remembered without a chat or a server revision", () => {
  const memo = createTimelineMemo();
  memo.remember(null, { messages: [], lastEventId: 0 }, "r1");
  memo.remember("a", { messages: [], lastEventId: 0 }, null);
  assert.equal(memo.recall("a"), null);
});

test("only the most recently shown chats are kept", () => {
  const memo = createTimelineMemo(2);
  memo.remember("a", { lastEventId: 1 }, "r");
  memo.remember("b", { lastEventId: 2 }, "r");
  memo.remember("a", { lastEventId: 3 }, "r"); // a is shown again: newest
  memo.remember("c", { lastEventId: 4 }, "r");
  assert.equal(memo.recall("b"), null);
  assert.equal(memo.recall("a").timeline.lastEventId, 3);
  assert.equal(memo.recall("c").timeline.lastEventId, 4);
});

test("the header warns only about a broken stream, never while a chat is opening", () => {
  assert.equal(connectionNotice("live"), null);
  assert.equal(connectionNotice("idle"), null);
  assert.equal(connectionNotice("refreshing"), null);
  assert.equal(connectionNotice("connecting"), null);
  assert.deepEqual(connectionNotice("loading"), { text: "بارگذاری…", tone: "muted" });
  assert.equal(connectionNotice("reconnecting").tone, "warn");
});
