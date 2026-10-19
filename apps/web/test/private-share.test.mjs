// Private share in the web (src/guest.js): the guest page's address, a guest's note as its own
// labelled row, the code box, and the share menu's switch.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { foldEvents } from "@griffin/timeline";
import { codeDigits, guestMessage, guestToken } from "../src/guest.js";

const tok = "A".repeat(16) + "b_-".repeat(5) + "z";

test("guest page: only #/p/<32-char token> opens it; the public #/s/ link is a different page", () => {
  assert.equal(guestToken(`#/p/${tok}`), tok);
  assert.equal(guestToken(`#/s/${tok}`), null);
  assert.equal(guestToken(`#/p/${tok}x`), null);
  assert.equal(guestToken("#/p/short"), null);
});

test("a guest note is a labelled system row with its author, never the owner's message", () => {
  const { messages } = foldEvents([
    { id: 1, runId: null, type: "user", data: { text: "فروش؟" }, at: "2026-10-15T10:00:00Z" },
    { id: 2, runId: null, type: "guest.note", data: { text: "اینو پاک کن", from: "Alice Example" }, at: "2026-10-15T10:01:00Z" },
  ]);
  const note = messages.at(-1);
  assert.equal(note.role, "guest");
  const row = guestMessage(note);
  assert.equal(row.role, "system");
  assert.equal(row.content[0].text, "اینو پاک کن");
  assert.equal(row.metadata.custom.guest.from, "Alice Example");
  assert.equal(row.metadata.custom.note, undefined, "not a Telegram desk note");
});

test("the code box takes Persian digits and nothing else", () => {
  assert.equal(codeDigits("۱۲۳ ۴۵۶"), "123456");
  assert.equal(codeDigits("12a3456789"), "123456");
});

test("wiring: the runtime, the thread, the entry page and the share menu know the private share", () => {
  const read = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(read("runtime.jsx"), /message\.role === "guest"\) return guestMessage\(message\)/);
  assert.match(read("components/Thread.jsx"), /custom\?\.guest/);
  assert.match(read("main.jsx"), /<GuestChat token=\{guest\} \/>/);
  // The private part of the share menu shows only when the server's PRIVATE_SHARE switch is on.
  // Off, the private part shows only to close shares left from when it was on; no invite form.
  assert.match(read("components/Share.jsx"), /<PrivateShares chatId=\{chatId\} canInvite=\{privateShare\} \/>/);
  assert.match(read("components/Share.jsx"), /if \(!canInvite && !shares\?\.length\) return null;/);
  assert.match(read("api.js"), /privateShare: active\.privateShare === true/);
});
