import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { BusyError } from "../src/runner.mjs";

function setup({ asks = null, send = null, file = null } = {}) {
  const dbFile = file || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-notes-")), "db.sqlite");
  const store = openStore(dbFile);
  const sent = [];
  const told = [];
  const runner = {
    isActive: () => false,
    activeCount: () => 0,
    send: async (chatId, input) => {
      if (send) return send(chatId, input);
      sent.push({ chatId, ...input });
      return { delivered: "run" };
    },
  };
  const app = createApp({ store, runner, asks, isValidRepo: (r) => r === "app-repo", defaultRepo: () => "app-repo", onNoteRun: (note, outcome) => told.push({ note, ...outcome }) });
  return { store, app, sent, told, dbFile };
}
const json = (app, url, method, body) =>
  app.request(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const make = async (app, body) => (await json(app, "/api/notes", "POST", body)).json();
const soon = () => new Date(Date.now() + 15 * 60_000).toISOString();

test("a note into a chat is queued through the runner, never as the answer to an open question", async () => {
  let answered = 0;
  const asks = { isWaiting: () => true, answer: () => (answered += 1, true) };
  const { store, app, sent } = setup({ asks });
  const chat = store.createChat({ title: "گفتگو" });
  const { note } = await make(app, { text: "بعداً بپرس", chatId: chat.id });
  assert.equal(note.status, "open");
  assert.equal(note.chatTitle, "گفتگو");
  const res = await json(app, `/api/notes/${note.id}/run`, "POST");
  assert.equal(res.status, 201);
  assert.equal(answered, 0, "a note is not the owner typing now");
  assert.deepEqual(sent.map((s) => [s.chatId, s.text, s.intent]), [[chat.id, "بعداً بپرس", "queue"]]);
  assert.deepEqual((await (await app.request("/api/notes")).json()).notes, [], "a started note leaves the list");
  assert.equal((await json(app, `/api/notes/${note.id}/run`, "POST")).status, 409, "runs once");
});

test("a note without a chat starts a new one with the composer's settings", async () => {
  const { app, store, sent } = setup();
  assert.equal((await json(app, "/api/notes", "POST", { text: "x", options: { repo: "../etc" } })).status, 400, "a wrong choice is refused at once");
  const { note } = await make(app, { text: "سلام از گذشته", options: { mode: "plan", repo: "", agent: "griffin" } });
  const { chat } = await (await json(app, `/api/notes/${note.id}/run`, "POST")).json();
  assert.equal(chat.mode, "plan");
  assert.equal(store.getChat(chat.id).repo, null);
  assert.deepEqual(sent.map((s) => [s.chatId, s.text]), [[chat.id, "سلام از گذشته"]]);
});

test("due notes run on the tick, survive a restart, and a timed run is told", async () => {
  const first = setup();
  const chat = first.store.createChat({ title: "t" });
  const { note } = await make(first.app, { text: "ساعت ۹", chatId: chat.id, runAt: soon() });
  await make(first.app, { text: "بی‌زمان", chatId: chat.id });
  assert.deepEqual(await first.app.notes.runDue(), [], "not yet");
  first.store.db.close();
  const again = setup({ file: first.dbFile });
  assert.deepEqual(await again.app.notes.runDue(Date.now() + 16 * 60_000), [note.id]);
  assert.deepEqual(again.sent.map((s) => s.text), ["ساعت ۹"]);
  assert.equal(again.told.length, 1);
  assert.equal(again.told[0].chat.id, chat.id);
  assert.deepEqual(await again.app.notes.runDue(Date.now() + 16 * 60_000), [], "once");
});

test("a failure is told, keeps the note retryable, and leaves no chat behind", async () => {
  let fail = true;
  const { app, store, told } = setup({ send: async () => { if (fail) throw new Error("موتور در دسترس نیست"); return { delivered: "run" }; } });
  const { note } = await make(app, { text: "یک کار", options: {}, runAt: new Date(Date.now() - 30_000).toISOString() });
  const chatsBefore = (await (await app.request("/api/chats")).json()).chats.length;
  assert.deepEqual(await app.notes.runDue(), [note.id]);
  const failed = store.getNote(note.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /موتور/);
  assert.equal((await (await app.request("/api/chats")).json()).chats.length, chatsBefore, "the new chat went with the attempt");
  assert.match(told[0].error, /موتور/);
  // Editing a failed note drops its past time: the next tick does not fire it before «دوباره اجرا».
  await json(app, `/api/notes/${note.id}`, "PATCH", { text: "یک کار، دقیق‌تر" });
  assert.equal(store.getNote(note.id).run_at, null);
  assert.equal(store.getNote(note.id).status, "open");
  fail = false;
  const res = await json(app, `/api/notes/${note.id}/run`, "POST");
  assert.equal(res.status, 201);
  assert.equal((await (await app.request("/api/chats")).json()).chats.length, chatsBefore + 1, "exactly one chat");
});

test("editing an open note keeps its time; a busy chat fails the note, not the server", async () => {
  const { app, store } = setup({ send: async () => { throw new BusyError(); } });
  const chat = store.createChat({ title: "t" });
  const at = soon();
  const { note } = await make(app, { text: "x", chatId: chat.id, runAt: at });
  await json(app, `/api/notes/${note.id}`, "PATCH", { text: "y" });
  assert.equal(store.getNote(note.id).run_at, at);
  assert.equal((await json(app, `/api/notes/${note.id}`, "PATCH", { runAt: "2001-01-01T00:00:00Z" })).status, 400);
  const res = await json(app, `/api/notes/${note.id}/run`, "POST");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).note.status, "failed");
});

test("a note deleted while it runs stays deleted; a deleted target chat fails the note", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { app, store } = setup({ send: async () => { await gate; return { delivered: "run" }; } });
  const chat = store.createChat({ title: "t" });
  const { note } = await make(app, { text: "x", chatId: chat.id });
  const running = json(app, `/api/notes/${note.id}/run`, "POST");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await json(app, `/api/notes/${note.id}/run`, "POST")).status, 409, "claimed once");
  assert.equal((await json(app, `/api/notes/${note.id}`, "DELETE")).status, 200);
  release();
  await running;
  assert.equal(store.getNote(note.id), null);

  const other = store.createChat({ title: "رفته" });
  const { note: orphan } = await make(app, { text: "y", chatId: other.id });
  store.deleteChat(other.id);
  assert.equal((await json(app, `/api/notes/${orphan.id}/run`, "POST")).status, 404);
  assert.equal(store.getNote(orphan.id).status, "failed");
});
