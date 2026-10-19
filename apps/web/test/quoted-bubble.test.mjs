import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuoted, withQuotes } from "../src/quotes.js";

test("a plain message has nothing to fold", () => {
  assert.equal(parseQuoted("سلام\nخوبی؟"), null);
});

test("quotes, their notes and the typed text come back in order", () => {
  const text = withQuotes([{ text: "خط اول\n\nخط دوم", note: "این غلطه" }, { text: "دومی" }], "کلی");
  assert.deepEqual(parseQuoted(text), [
    { type: "quote", text: "خط اول\n\nخط دوم" },
    { type: "text", text: "این غلطه" },
    { type: "quote", text: "دومی" },
    { type: "text", text: "کلی" },
  ]);
});

test("«به چت جدید»: the origin line becomes a link to that chat", () => {
  const text = withQuotes([{ text: "متن", note: "بررسی کن" }], "این بخش از گفتگوی «تست» (شناسهٔ ab12-cd) است؛ اگر زمینهٔ بیشتری لازم شد، آن گفتگو را با chat_read بخوان.");
  assert.deepEqual(parseQuoted(text), [
    { type: "quote", text: "متن" },
    { type: "text", text: "بررسی کن" },
    { type: "origin", chatId: "ab12-cd", title: "تست" },
  ]);
});
