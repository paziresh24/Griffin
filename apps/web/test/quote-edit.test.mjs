import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createQuoteStore, withQuotes } from "../src/quotes.js";

// A waiting quote above the composer opens in place to edit its text and note, saved or cancelled;
// the message sent carries the edited version.
function fakeStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}
const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("quote edit: text and note change in place, and the send carries the edit", () => {
  const storage = fakeStorage();
  const store = createQuoteStore(storage);
  const a = store.add("chat-1", { text: "متن اول", note: "نظر اول" });
  const b = store.add("chat-1", { text: "بخش دوم" });
  let calls = 0;
  store.subscribe(() => (calls += 1));
  const before = store.get("chat-1");
  const edited = store.update("chat-1", a.id, { text: "  متن\nویرایش‌شده  ", note: "  نظر تازه " });
  assert.equal(calls, 1, "the composer is told");
  assert.notEqual(store.get("chat-1"), before, "a new list, so the chip re-renders");
  assert.deepEqual(edited, { id: a.id, text: "متن\nویرایش‌شده", note: "نظر تازه" });
  assert.deepEqual(store.get("chat-1").map((q) => q.id), [a.id, b.id], "same quote, same place");
  assert.equal(withQuotes(store.get("chat-1"), "ادامه"), "> متن\n> ویرایش‌شده\n\nنظر تازه\n\n> بخش دوم\n\nادامه");
  assert.deepEqual(createQuoteStore(storage).get("chat-1")[0], edited, "kept in the browser per chat");
});

test("quote edit: a note can be cleared; an empty quote, an unknown id or no change leaves the list alone", () => {
  const store = createQuoteStore(fakeStorage());
  const a = store.add("c", { text: "نقل", note: "نظر" });
  assert.equal(store.update("c", a.id, { text: "نقل", note: "   " }).note, "");
  const list = store.get("c");
  assert.equal(store.update("c", a.id, { text: "   ", note: "x" }), null, "a quote cannot be emptied");
  assert.equal(store.update("c", "missing", { text: "x" }), null, "a quote already sent is not brought back");
  store.update("c", a.id, { text: "نقل", note: "" });
  assert.equal(store.get("c"), list, "nothing changed, nothing written");
});

test("quote edit: a quote edited while its send was on the way stays for the next message", () => {
  const store = createQuoteStore(fakeStorage());
  store.add("c", { text: "نقل یک" });
  const b = store.add("c", { text: "نقل دو" });
  const sent = store.get("c");
  store.update("c", b.id, { text: "نقل دو، ویرایش‌شده" });
  store.removeSent("c", sent);
  assert.deepEqual(store.get("c").map((q) => q.text), ["نقل دو، ویرایش‌شده"]);
  assert.match(src("runtime.jsx"), /quoteStore\.removeSent\(boxId, quotes\)/, "the send removes only what it carried");
});

test("quote edit: the chip opens an editor; leaving it keeps the edit, cancel does not, Esc is the editor's", () => {
  const chip = src("components/QuoteChip.jsx");
  assert.match(src("components/Thread.jsx"), /<QuoteChip key=\{q\.id\}/);
  assert.match(chip, /aria-label=\{t\("ویرایش این نقل‌قول: \{text\}", \{ text: quotePreview\(quote\.text\) \}\)\}/, "the chip's label keeps the quote text");
  assert.match(chip, /aria-label=\{t\("متن نقل‌قول"\)\}/);
  assert.match(chip, /aria-label=\{t\("نظر دربارهٔ این بخش"\)\}/);
  assert.match(chip, /dir=\{isRtl \? "rtl" : "ltr"\} onBlur=\{leave\}/, "focus leaving the editor saves it");
  assert.match(chip, /if \(!document\.hasFocus\(\)\) return;\s*if \(closing\.current \|\| event\.currentTarget\.contains\(event\.relatedTarget\)\) return;\s*if \(draft\.text\.trim\(\)\) quoteStore\.update\(/);
  assert.match(chip, /closing\.current = true;\s*setDraft\(null\);\s*onDone\?\.\(\);/, "cancel's focus return does not save");
  assert.match(chip, /event\.key === "Escape"\) \{[\s\S]{0,160}event\.stopPropagation\(\);/);
});
