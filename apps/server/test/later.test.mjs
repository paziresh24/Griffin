import test from "node:test";
import assert from "node:assert/strict";
import { isReminder, laterTool, parseIn, reminderMessage } from "../src/later.mjs";

test("later writes a timed reminder into the same chat; it comes back framed as the agent's own", async () => {
  assert.equal(parseIn("2h"), 7_200_000);
  assert.ok(Number.isNaN(parseIn("soon")));
  const notes = [];
  const store = { listNotes: () => notes, createNote: (n) => { const row = { id: "n1", chat_id: n.chatId, status: "open", text: n.text, options: JSON.stringify(n.options), run_at: n.runAt, created_at: "t" }; notes.push(row); return row; } };
  const tool = laterTool({ store, chatId: "c1", now: () => Date.parse("2026-10-21T10:00:00Z") });
  const out = JSON.parse((await tool.execute({ in: "90m", text: "به آقای حسینی نتیجهٔ بکاپ را بگو" })).content[0].text);
  assert.equal(out.runAt, "2026-10-21T11:30:00.000Z");
  assert.match(reminderMessage(notes[0]), /حرف Owner نیست[\s\S]*آقای حسینی/);
  assert.equal(reminderMessage({ options: null, text: "x" }), null);
  assert.equal(isReminder(notes[0]), true, "the web keeps it in its chat, out of the sidebar and the inbox");
  assert.equal(isReminder({ options: "{}" }), false);
  assert.equal(isReminder({ options: "not json" }), false);
  assert.equal((await tool.execute({ in: "40d", text: "x" })).isError, true);
});

test("a chat with a reminder still to run carries its time for the sidebar's clock", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { openStore } = await import("../src/db.mjs");
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-later-")), "db.sqlite"));
  const chat = store.createChat({ title: "یادآور" });
  assert.equal(store.nextNoteAt(chat.id), null);
  store.createNote({ text: "بی‌زمان", chatId: chat.id });
  assert.equal(store.nextNoteAt(chat.id), null, "an untimed note is no reminder");
  store.createNote({ text: "دیرتر", chatId: chat.id, runAt: "2026-10-25T10:00:00.000Z", options: { reminder: true } });
  const first = store.createNote({ text: "زودتر", chatId: chat.id, runAt: "2026-10-24T10:00:00.000Z" });
  assert.equal(store.nextNoteAt(chat.id), "2026-10-24T10:00:00.000Z");
  store.claimNote(first.id);
  assert.equal(store.nextNoteAt(chat.id), "2026-10-25T10:00:00.000Z", "one that ran is gone from the clock");
});
