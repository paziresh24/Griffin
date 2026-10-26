// The live Telegram conversation (telegram-chat.mjs): a gramjs message as the page reads it.
import test from "node:test";
import assert from "node:assert/strict";
import { mediaOf, rowOf } from "../src/telegram-chat.mjs";

const date = Date.UTC(2026, 9, 24, 8, 0) / 1000;

test("a message keeps Telegram's extras and who sent it here", () => {
  const index = { byId: new Map([["7", { data: { by: "assistant", chatId: "m1" } }]]), outs: [{ direction: "out", text: "از چت", at: new Date(date * 1000).toISOString(), data: { by: "chat", fromChat: "c1", fromTitle: "مانیتورینگ" } }] };
  const mine = rowOf({ id: 7, out: true, message: "سلام", date, replyTo: { replyToMsgId: 5 }, editDate: date + 9, reactions: { results: [{ reaction: { emoticon: "👍" }, count: 2, chosenOrder: 0 }, { reaction: {}, count: 1 }] } }, { index, readOutboxMaxId: 7 });
  assert.deepEqual(mine.data, { msgId: 7, replyTo: 5, by: "assistant", chatId: "m1" });
  assert.equal(mine.direction, "out");
  assert.equal(mine.edited, true);
  assert.equal(mine.read, true);
  assert.deepEqual(mine.reactions, [{ emoji: "👍", count: 2, mine: true }]);
  const chat = rowOf({ id: 8, out: true, message: "از چت ", date: date + 30 }, { index, readOutboxMaxId: 7 });
  assert.deepEqual(chat.data, { msgId: 8, by: "chat", fromChat: "c1", fromTitle: "مانیتورینگ" });
  assert.equal(chat.read, false);
  const own = rowOf({ id: 9, out: true, message: "دستی", date }, { index });
  assert.equal(own.data.by, "owner");
  const inGroup = rowOf({ id: 10, out: false, message: "", date, sender: { firstName: "علی", lastName: "نوری" }, fwdFrom: { fromName: "کانال" }, photo: {}, media: { className: "MessageMediaPhoto" } }, { group: true });
  assert.equal(inGroup.data.from, "علی نوری");
  assert.equal(inGroup.fwd, "کانال");
  assert.equal(inGroup.media.kind, "photo");
  assert.equal("read" in inGroup, false);
});

test("media kinds", () => {
  const doc = (attributes, extra = {}) => ({ media: { className: "MessageMediaDocument" }, document: { attributes, size: 1234, mimeType: "application/pdf" }, ...extra });
  assert.equal(mediaOf({}), null);
  assert.equal(mediaOf({ media: { className: "MessageMediaWebPage" } }), null);
  assert.deepEqual(mediaOf(doc([{ className: "DocumentAttributeFilename", fileName: "a.pdf" }])), { kind: "file", name: "a.pdf", size: 1234, mime: "application/pdf", seconds: null, emoji: null });
  assert.equal(mediaOf(doc([{ className: "DocumentAttributeAudio", duration: 12 }], { voice: true })).seconds, 12);
  assert.equal(mediaOf(doc([{ className: "DocumentAttributeSticker", alt: "😀" }], { sticker: true })).emoji, "😀");
});
