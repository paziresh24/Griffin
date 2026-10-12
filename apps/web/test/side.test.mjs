import test from "node:test";
import assert from "node:assert/strict";
import { emptySide, quoteForChat, retryableRunId, sideReducer } from "../src/side.js";
import { createQuoteStore, withQuotes } from "../src/quotes.js";

test("quotes join the message as blockquotes with their notes, then the typed text", () => {
  assert.equal(withQuotes([{ text: "خط ۱\nخط ۲", note: "این غلطه" }, { text: "دوم" }], "حالا چی؟"), "> خط ۱\n> خط ۲\n\nاین غلطه\n\n> دوم\n\nحالا چی؟");
  assert.equal(quoteForChat("a\nb"), "> a\n> b");
  const store = createQuoteStore(null);
  const q = store.add("c1", { text: "x" });
  assert.deepEqual(store.get("c1").map((i) => i.text), ["x"]);
  assert.deepEqual(store.get("c2"), [], "per chat");
  store.remove("c1", q.id);
  assert.deepEqual(store.get("c1"), []);
});

test("side panel: closing keeps the side chat; another parent starts empty", () => {
  let s = sideReducer(emptySide("p1"), { type: "created", chat: { id: "s1" } });
  assert.equal(s.open, true);
  s = sideReducer(sideReducer(s, { type: "close" }), { type: "open" });
  assert.equal(s.activeId, "s1");
  assert.deepEqual(sideReducer(s, { type: "parent", id: "p2" }), emptySide("p2"));
});

test("retry shows under the latest undelivered run while the server keeps a message", () => {
  const runs = [
    { role: "assistant", id: "r1", status: "error", undelivered: true },
    { role: "user", id: "u2" },
    { role: "assistant", id: "r2", status: "error", undelivered: true },
  ];
  assert.equal(retryableRunId(runs, 2), "r2");
  assert.equal(retryableRunId(runs, 0), null, "nothing kept");
  assert.equal(retryableRunId([...runs, { role: "assistant", id: "r3", status: "finished", retry: true }], 1), null);
});
