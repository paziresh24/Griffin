// Private-share guest page (F7): a poll says what it already holds, and an unchanged chat costs
// one line instead of the whole timeline.
import test from "node:test";
import assert from "node:assert/strict";
import { pollQuery, pollDelay } from "../src/guest-poll.js";

test("guest poll: the first poll asks for everything; later ones send what they hold", () => {
  assert.equal(pollQuery(null), "");
  assert.equal(pollQuery({ timeline: { lastEventId: 42 }, rev: "a b" }), "?have=42&rev=a%20b");
  assert.equal(pollQuery({ timeline: { lastEventId: 42 } }), "", "no revision: ask for everything");
});

test("guest poll: a running reply is polled faster", () => {
  assert.equal(pollDelay({ messages: [{ role: "assistant", status: "running" }] }), 4000);
  assert.equal(pollDelay({ messages: [{ role: "assistant", status: "done" }] }), 20000);
  assert.equal(pollDelay(null), 20000);
});
