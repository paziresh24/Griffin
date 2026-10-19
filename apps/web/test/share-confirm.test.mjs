// Private share (a review finding): people Telegram's own search found are strangers to the
// owner — marked apart from the owner's own chats, and invited only after the owner types their
// exact @username.
import test from "node:test";
import assert from "node:assert/strict";
import { afterRefusal, confirmMatches, needsConfirm, sourceLabel } from "../src/share-confirm.js";

const recent = { peerId: "1", title: "Sara", username: "sara", source: "contact" };
const chat = { peerId: "4", title: "Writer", username: "writer", source: "chat" };
const stranger = { peerId: "2", title: "Sara R", username: "SaraR", source: "telegram" };

test("share: each result says where it came from", () => {
  assert.equal(sourceLabel(recent), "از مخاطبانِ شما");
  assert.equal(sourceLabel(chat), "در گفتگوهای شما، نه در مخاطبان");
  assert.equal(sourceLabel(stranger), "پیداشده در تلگرام");
  assert.equal(sourceLabel({ peerId: "3" }), "پیداشده در تلگرام", "unknown source is treated as a stranger");
});

test("share: only a stranger needs the exact @username typed", () => {
  assert.equal(needsConfirm(recent), false);
  assert.equal(needsConfirm(chat), true, "someone who only wrote first needs the confirmation too");
  assert.equal(needsConfirm(stranger), true);
  assert.equal(confirmMatches(stranger, ""), false);
  assert.equal(confirmMatches(stranger, "@sara"), false);
  assert.equal(confirmMatches(stranger, " @sarar "), true);
  assert.equal(confirmMatches(stranger, "SARAR"), true);
  assert.equal(confirmMatches({ ...stranger, username: null }, ""), false, "no username: never confirmable");
});

test("share: when the server asks for the @username, the field opens instead of an error", () => {
  const refused = Object.assign(new Error("confirm"), { status: 409, body: { confirm: { username: "Writer2", title: "W" } } });
  const next = afterRefusal(recent, refused);
  assert.equal(needsConfirm(next), true);
  assert.equal(next.username, "Writer2");
  assert.equal(next.peerId, "1");
  assert.equal(afterRefusal(recent, Object.assign(new Error("x"), { status: 502 })), null, "any other error stays an error");
  assert.equal(afterRefusal(recent, Object.assign(new Error("x"), { status: 409, body: {} })), null);
});

test("share: an API error keeps the server's answer for the caller", async () => {
  const { ApiError } = await import("../src/api.js");
  const e = new ApiError(409, { error: "x", confirm: { username: "u" } });
  assert.deepEqual(e.body.confirm, { username: "u" });
});

test("share: an invite removed after it failed is told to the owner", async () => {
  const { failedInviteNotes } = await import("../src/share-confirm.js");
  assert.deepEqual(failedInviteNotes({ failedInvites: [{ grantee: "سارا" }] }), ["دعوتِ سارا در تلگرام نرسید و اشتراکش برداشته شد؛ دوباره دعوت کنید."]);
  assert.deepEqual(failedInviteNotes({}), []);
});
