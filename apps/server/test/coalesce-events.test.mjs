// Streamed text/thinking pieces (2026-10-29: 6.7M of .46's 7.1M event rows, folded one by one on
// every cold open): new ones are held and written as one row (db.mjs appendEvent, coalesceMs), old
// ones are joined in place (compactStreamStep). Either way every chat folds exactly as before.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { foldEvents } from "@griffin/timeline";
import { compactStreamDone, compactStreamStep, openStore } from "../src/db.mjs";

function withStore(options, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-coalesce-"));
  const file = path.join(dir, "db.sqlite");
  const store = openStore(file, options);
  return Promise.resolve(fn(store, file)).finally(() => {
    try { store.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// A run as the engines stream it: thinking, text in pieces, a tool, more text.
function stream(store, chatId, runId) {
  store.appendEvent(chatId, runId, "run.started", { model: "m" });
  for (const piece of ["فکر ", "می‌کنم", "…"]) store.appendEvent(chatId, runId, "thinking", { text: piece });
  store.appendEvent(chatId, runId, "thinking.done", { durationMs: 5 });
  for (const piece of ["سل", "ام", "، "]) store.appendEvent(chatId, runId, "text", { text: piece });
  store.appendEvent(chatId, runId, "tool.started", { callId: "c1", name: "Bash", args: {} });
  store.appendEvent(chatId, runId, "tool.done", { callId: "c1", name: "Bash", args: {}, result: "ok" });
  for (const piece of ["تمام", " شد."]) store.appendEvent(chatId, runId, "text", { text: piece });
}
const shown = (store, chatId) => foldEvents(store.eventsAfter(chatId, 0)).messages;

test("held pieces become one row each stretch, in order, and fold as the pieces did", async () => {
  let plain;
  await withStore({}, (store) => {
    const chat = store.createChat({ title: "x", mode: "agent" });
    stream(store, chat.id, store.startRun(chat.id));
    store.appendEvent(chat.id, null, "run.finished", { status: "finished" });
    plain = { messages: shown(store, chat.id), rows: store.eventsAfter(chat.id, 0).length };
  });
  await withStore({ coalesceMs: 10_000 }, (store) => {
    const chat = store.createChat({ title: "x", mode: "agent" });
    const runId = store.startRun(chat.id);
    const seen = [];
    store.bus.on(`chat:${chat.id}`, (event) => seen.push(event));
    stream(store, chat.id, runId);
    // The last stretch is still held: nothing of it reached the bus yet, a read writes it first.
    assert.equal(seen.at(-1).type, "tool.done");
    const rows = store.eventsAfter(chat.id, 0);
    assert.deepEqual(rows.map((e) => e.type), ["run.started", "thinking", "thinking.done", "text", "tool.started", "tool.done", "text"]);
    assert.deepEqual(rows.filter((e) => e.type === "text").map((e) => e.data.text), ["سلام، ", "تمام شد."]);
    assert.equal(seen.at(-1).data.text, "تمام شد.", "the write reaches the stream like any event");
    store.appendEvent(chat.id, null, "run.finished", { status: "finished" });
    const messages = shown(store, chat.id).map((m) => ({ ...m, id: m.id }));
    assert.deepEqual(messages.map((m) => m.parts), plain.messages.map((m) => m.parts));
    assert.ok(rows.length < plain.rows);
    // «showed something» is set by the first held text, not when it is written.
    assert.equal(store.db.prepare("SELECT shown FROM runs WHERE id = ?").get(runId).shown, 1);
  });
});

test("a held piece is written when its time is up, and before the store closes", async () => {
  await withStore({ coalesceMs: 30 }, async (store, file) => {
    const chat = store.createChat({ title: "x", mode: "agent" });
    const runId = store.startRun(chat.id);
    const seen = [];
    store.bus.on(`chat:${chat.id}`, (event) => seen.push(event));
    store.appendEvent(chat.id, runId, "text", { text: "یک " });
    store.appendEvent(chat.id, runId, "text", { text: "دو" });
    assert.equal(seen.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].data.text, "یک دو");
    assert.ok(seen[0].id > 0);
    store.appendEvent(chat.id, runId, "text", { text: "سه" });
    store.close();
    const db = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(db.prepare("SELECT json_extract(data, '$.text') AS t FROM events WHERE type = 'text' ORDER BY id").all().map((r) => r.t), ["یک دو", "سه"]);
    db.close();
  });
});

test("pieces of different chats, runs or kinds never join; other data is never held", async () => {
  await withStore({ coalesceMs: 10_000 }, (store) => {
    const a = store.createChat({ title: "a", mode: "agent" });
    const b = store.createChat({ title: "b", mode: "agent" });
    const ra = store.startRun(a.id);
    const rb = store.startRun(b.id);
    store.appendEvent(a.id, ra, "text", { text: "a1" });
    store.appendEvent(b.id, rb, "text", { text: "b1" });
    store.appendEvent(a.id, ra, "text", { text: "a2" });
    store.appendEvent(a.id, ra, "thinking", { text: "t" });
    store.appendEvent(a.id, ra, "text", { text: "a3", extra: true });
    assert.deepEqual(store.eventsAfter(a.id, 0).map((e) => [e.type, e.data.text]), [["text", "a1a2"], ["thinking", "t"], ["text", "a3"]]);
    assert.deepEqual(store.eventsAfter(b.id, 0).map((e) => e.data.text), ["b1"]);
  });
});

test("old pieces are joined in place: same fold, fewer rows, a running run left alone", async () => {
  await withStore({}, (store) => {
    const chat = store.createChat({ title: "x", mode: "agent" });
    const done = store.startRun(chat.id);
    stream(store, chat.id, done);
    store.appendEvent(chat.id, done, "run.finished", { status: "finished" });
    store.finishRun(chat.id, done, "finished");
    const other = store.createChat({ title: "y", mode: "agent" });
    const live = store.startRun(other.id);
    stream(store, other.id, live);
    const before = { a: shown(store, chat.id), b: store.eventsAfter(other.id, 0) };
    const firstText = store.eventsAfter(chat.id, 0).find((e) => e.type === "text").id;
    // Small steps, so a stretch also meets a step's edge.
    let steps = 0;
    while (compactStreamStep(store.db, { chunk: 4 })) steps += 1;
    assert.ok(steps > 1);
    assert.equal(compactStreamDone(store.db), true);
    assert.equal(compactStreamStep(store.db), false, "nothing left once done");
    assert.deepEqual(shown(store, chat.id), before.a);
    assert.ok(store.eventsAfter(chat.id, 0).length < 14);
    assert.ok(store.eventsAfter(chat.id, 0).some((e) => e.id === firstText), "a stretch keeps its first row");
    assert.deepEqual(store.eventsAfter(other.id, 0), before.b, "the running run is untouched");
  });
});
