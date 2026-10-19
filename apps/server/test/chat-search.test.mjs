// The sidebar search finds words inside a chat's messages, not only its title (from Karsara),
// behind CHAT_SEARCH_MESSAGES (off by default, so other installs search titles as before and their
// database gets no index at all).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-search-")), "db.sqlite");
const searchable = (file = tempFile()) => {
  const store = openStore(file);
  assert.equal(store.enableSearch(), true);
  return store;
};
const objects = (file) => {
  const db = new DatabaseSync(file);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'events_fts%' OR name = 'events_run_text'").all().map((r) => r.name);
  db.close();
  return names;
};

// An answer as Griffin stores it: streamed pieces under one run, then run.finished.
function answer(store, chatId, runId, pieces) {
  for (const text of pieces) store.appendEvent(chatId, runId, "text", { text });
  store.appendEvent(chatId, runId, "run.finished", { status: "finished" });
}

// As a database looks before the index existed (or after it was dropped): events, no index, no cursor.
function oldDb(file, fill) {
  const store = openStore(file);
  const chat = store.createChat({ title: "قدیمی", model: "m", mode: "agent" });
  store.close();
  const db = new DatabaseSync(file);
  const insert = db.prepare("INSERT INTO events (chat_id, run_id, type, data, at) VALUES (?, ?, ?, ?, 'x')");
  fill((runId, type, data) => insert.run(chat.id, runId, type, JSON.stringify(data)));
  db.close();
  return chat;
}

test("off (the default) makes nothing: no index, no triggers, no cursor — opening and writing cost what they did", () => {
  const file = tempFile();
  const store = openStore(file);
  try {
    const chat = store.createChat({ title: "x", model: "m", mode: "agent" });
    answer(store, chat.id, "r", ["سلام"]);
    assert.deepEqual(objects(file), []);
    assert.equal(store.getKv("search:ceiling"), null);
    assert.deepEqual(store.searchChatIds("سلام"), [], "nothing to search");
    assert.equal(store.indexSearchBatch(), false);
  } finally {
    store.close();
  }
});

test("new messages are searchable at once; quotes and FTS syntax are taken literally; delete forgets", () => {
  const store = searchable();
  try {
    const a = store.createChat({ title: "گفتگو", model: "m", mode: "agent" });
    const b = store.createChat({ title: "دیگری", model: "m", mode: "agent" });
    const c = store.createChat({ title: "سوم", model: "m", mode: "agent" });
    store.appendEvent(a.id, null, "user", { text: "کلاستر مبین کند شده" });
    answer(store, b.id, "r1", ["پرداخت ویزیت آنلاین"]);
    store.appendEvent(b.id, null, "tool.done", { text: "مبین", name: "x" });
    store.appendEvent(c.id, null, "user", { text: 'گفت "مبین OR کلاستر" را بنویس' });
    assert.deepEqual(store.searchChatIds("مبین").sort(), [a.id, c.id].sort(), "user messages match; a tool result does not");
    assert.deepEqual(store.searchChatIds("ویزیت آنلاین"), [b.id], "an answer's text matches as a phrase");
    assert.deepEqual(store.searchChatIds("آنلاین ویزیت"), [], "a phrase, not loose words");
    // Read as FTS syntax, «مبین OR کلاستر» would match chat a too; taken literally it is c's phrase only.
    assert.deepEqual(store.searchChatIds('"مبین OR کلاستر"'), [c.id], "quotes and OR are text, not a query");
    assert.deepEqual(store.searchChatIds("..."), [], "punctuation alone finds nothing and does not throw");
    store.deleteChat(a.id);
    assert.deepEqual(store.searchChatIds("کند شده"), [], "a deleted chat's words leave the index");
  } finally {
    store.close();
  }
});

test("an answer is one row: pieces streamed back to back join as they are, pieces around a tool call stay apart", () => {
  const file = tempFile();
  const store = searchable(file);
  try {
    const chat = store.createChat({ title: "بی‌عنوان", model: "m", mode: "agent" });
    store.appendEvent(chat.id, "r1", "text", { text: "مشکل پرد" });
    store.appendEvent(chat.id, "r1", "text", { text: "اخت را می‌خوانم" });
    store.appendEvent(chat.id, "r1", "tool.started", { name: "Bash" });
    store.appendEvent(chat.id, "r1", "tool.done", { name: "Bash" });
    store.appendEvent(chat.id, "r1", "text", { text: "مشکل در پورت است" });
    store.appendEvent(chat.id, "r1", "run.finished", { status: "finished" });
    assert.deepEqual(store.searchChatIds("پرداخت"), [chat.id], "a word split between two pieces");
    assert.deepEqual(store.searchChatIds("مشکل در پورت"), [chat.id], "the text after a tool call is its own words");
    // The owner types the next message while the answer streams; a side run writes too.
    const other = store.createChat({ title: "دیگر", model: "m", mode: "agent" });
    store.appendEvent(other.id, "r2", "text", { text: "ورود به سا" });
    store.appendEvent(other.id, null, "user", { text: "یک پیام وسط" });
    store.appendEvent(other.id, "side", "text", { text: "متنِ دیگر" });
    store.appendEvent(other.id, "r2", "text", { text: "مانه شد" });
    store.appendEvent(other.id, "r2", "run.finished", { status: "finished" });
    assert.deepEqual(store.searchChatIds("سامانه"), [other.id], "events of others in between do not split the word");
    const check = new DatabaseSync(file);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM events_fts WHERE chat_id = ?").get(chat.id).n, 1, "one row for the whole answer");
    check.close();
  } finally {
    store.close();
  }
});

test("Arabic yeh and kaf match the Persian letters, both ways; the last word matches as a prefix", () => {
  const store = searchable();
  try {
    const a = store.createChat({ title: "x", model: "m", mode: "agent" });
    const b = store.createChat({ title: "y", model: "m", mode: "agent" });
    store.appendEvent(a.id, null, "user", { text: "پيام كوتاه" }); // ي and ك
    store.appendEvent(b.id, null, "user", { text: "نوبت‌دهی پزشک" });
    assert.deepEqual(store.searchChatIds("پیام کوتاه"), [a.id]);
    assert.deepEqual(store.searchChatIds("پزشك"), [b.id]);
    assert.deepEqual(store.searchChatIds("پیا"), [a.id], "a prefix of a word");
    assert.deepEqual(store.searchChatIds("پیام کوت"), [a.id], "a phrase whose last word is cut");
  } finally {
    store.close();
  }
});

test("one letter finds nothing; a one-letter last word is matched whole, not as a prefix; a common word reads at most `scan` rows", () => {
  const store = searchable();
  try {
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const c = store.createChat({ title: `c${i}`, model: "m", mode: "agent" });
      store.appendEvent(c.id, null, "user", { text: "سلام مبین" });
      ids.push(c.id);
    }
    const x = store.createChat({ title: "x", model: "m", mode: "agent" });
    store.appendEvent(x.id, null, "user", { text: "سرور م کار نمی‌کند" });
    assert.deepEqual(store.searchChatIds("س"), []);
    assert.deepEqual(store.searchChatIds("سرور م"), [x.id], "«م» as a whole word");
    assert.deepEqual(store.searchChatIds("سلام م"), [], "as a prefix «م» would match «مبین» in all ten chats");
    assert.equal(store.searchChatIds("سلام").length, 10);
    assert.deepEqual(store.searchChatIds("سلام", { scan: 3 }), ids.slice(-3).reverse(), "the newest rows only");
  } finally {
    store.close();
  }
});

test("switched on over an old DB: indexed one short transaction per step, answers joined, new messages not doubled", () => {
  const file = tempFile();
  const chat = oldDb(file, (put) => {
    for (let i = 0; i < 25; i++) put(null, "user", { text: `پیام شماره${i}` });
    put("old", "text", { text: "کلاس" });
    put("old", "text", { text: "تر یزد" });
    put("old", "run.finished", { status: "finished" });
  });
  const store = searchable(file);
  try {
    assert.deepEqual(store.searchChatIds("شماره3"), [], "not indexed yet");
    store.appendEvent(chat.id, null, "user", { text: "پیام تازه" });
    let steps = 1;
    while (store.indexSearchBatch({ chunk: 10 })) steps += 1;
    assert.equal(steps, 3, "28 old events, 10 per step");
    assert.equal(store.indexSearchBatch(), false, "nothing left");
    assert.deepEqual(store.searchChatIds("شماره24"), [chat.id]);
    assert.deepEqual(store.searchChatIds("کلاستر"), [chat.id], "an old answer's pieces were joined");
    assert.deepEqual(store.searchChatIds("تازه"), [chat.id]);
    const check = new DatabaseSync(file);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM events_fts").get().n, 27, "each message and the answer indexed once");
    check.close();
  } finally {
    store.close();
  }
});

// An earlier schema's shape: a row per streamed piece, a delete trigger blind to run.finished,
// no prefix index.
const EARLIER = `
  CREATE VIRTUAL TABLE events_fts USING fts5(chat_id UNINDEXED, body);
  CREATE TRIGGER events_fts_ai AFTER INSERT ON events WHEN NEW.type IN ('user', 'text') AND json_extract(NEW.data, '$.text') IS NOT NULL
  BEGIN INSERT INTO events_fts (rowid, chat_id, body) VALUES (NEW.id, NEW.chat_id, json_extract(NEW.data, '$.text')); END;
  CREATE TRIGGER events_fts_ad AFTER DELETE ON events WHEN OLD.type IN ('user', 'text')
  BEGIN DELETE FROM events_fts WHERE rowid = OLD.id; END;`;

test("a DB that ran the earlier shape loses it on open (search on or off), and is indexed anew when switched on", () => {
  const file = tempFile();
  const chat = oldDb(file, (put) => put(null, "user", { text: "پیام قدیمی" }));
  const db = new DatabaseSync(file);
  db.exec(EARLIER);
  db.prepare("INSERT INTO events_fts (rowid, chat_id, body) VALUES (999999, ?, 'تکه')").run(chat.id);
  db.close();
  let store = openStore(file);
  try {
    assert.deepEqual(objects(file), [], "off: the earlier index and both its triggers are gone");
    store.appendEvent(chat.id, null, "user", { text: "پس از باز شدن" });
    assert.deepEqual(objects(file), [], "and nothing writes an index while off");
  } finally {
    store.close();
  }
  store = searchable(file);
  try {
    while (store.indexSearchBatch()) {}
    assert.deepEqual(store.searchChatIds("تکه"), [], "the earlier rows are gone");
    assert.deepEqual(store.searchChatIds("قدیمی"), [chat.id]);
    answer(store, chat.id, "r", ["پاسخ تازه"]);
    store.deleteChat(chat.id);
    assert.deepEqual(store.searchChatIds("پاسخ"), [], "the new delete trigger takes an answer's row with its chat");
    assert.ok(!objects(file).includes("events_fts_ai"));
  } finally {
    store.close();
  }
});

test("GET /api/chats/search: off by default (titles only); CHAT_SEARCH_MESSAGES=on answers", async () => {
  const store = searchable();
  try {
    const chat = store.createChat({ title: "x", model: "m", mode: "agent" });
    store.appendEvent(chat.id, null, "user", { text: "کلاستر مبین" });
    const off = createApp({ store, runner: {}, asks: {} });
    assert.deepEqual(await (await off.request("/api/chats/search?q=" + encodeURIComponent("مبین"))).json(), { ids: [], on: false });
    const on = createApp({ store, runner: {}, asks: {}, searchMessages: () => true });
    assert.deepEqual(await (await on.request("/api/chats/search?q=" + encodeURIComponent("مبین"))).json(), { ids: [chat.id], on: true });
  } finally {
    store.close();
  }
});

test("the server's backfill thread (search-worker.mjs) indexes an old DB step by step on its own connection", async () => {
  const file = tempFile();
  const chat = oldDb(file, (put) => {
    for (let i = 0; i < 250; i++) put(null, "user", { text: `پیام شماره${i}` });
  });
  const store = openStore(file); // search not made here: the worker makes it
  const worker = new Worker(new URL("../src/search-worker.mjs", import.meta.url), { workerData: { file } });
  try {
    let steps = 0;
    await new Promise((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", ({ more, error }) => {
        steps += 1;
        if (error) return reject(new Error(error));
        if (more) worker.postMessage("step");
        else resolve();
      });
      worker.postMessage("step");
    });
    assert.equal(steps, 3, "250 events, 100 per step");
    assert.equal(store.searchBackfillDone(), true, "nothing left: the server starts no worker");
    assert.deepEqual(store.searchChatIds("شماره249"), [chat.id]);
    assert.deepEqual(store.searchChatIds("شماره0"), [chat.id]);
  } finally {
    await worker.terminate();
    store.close();
  }
});
