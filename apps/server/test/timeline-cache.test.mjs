// Opening a chat must not re-read its whole event log every time: the folded timeline is kept in
// memory and only newer events are read. Measured on the live data (2026-10-05): a 456k-event chat
// took 7.5s per open, synchronously, and every other request waited behind it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { foldEvents } from "@griffin/timeline";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { createTimelineCache } from "../src/timeline-cache.mjs";

const PAGE = 50;

function setup({ maxBytes } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tlcache-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  // Count the event rows actually read from the store.
  const read = { rows: 0, calls: 0 };
  const eventsAfter = store.eventsAfter.bind(store);
  store.eventsAfter = (...args) => {
    const rows = eventsAfter(...args);
    read.rows += rows.length;
    read.calls += 1;
    return rows;
  };
  const allEvents = store.allEvents.bind(store);
  store.allEvents = function* counted(...args) {
    for (const event of allEvents(...args)) {
      read.rows += 1;
      yield event;
    }
  };
  const timelines = createTimelineCache({ store, pageSize: PAGE, ...(maxBytes ? { maxBytes } : {}) });
  const app = createApp({ store, runner: {}, timelines });
  const cleanup = () => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, app, timelines, read, cleanup };
}

// A chat with one finished run of many small thinking deltas, like the real ones.
function bigChat(store, deltas = 220) {
  const chat = store.createChat({ title: "big", mode: "agent" });
  store.appendEvent(chat.id, null, "user", { text: "سلام" });
  const runId = store.startRun(chat.id);
  store.appendEvent(chat.id, runId, "run.started", { model: "m" });
  for (let i = 0; i < deltas; i += 1) store.appendEvent(chat.id, runId, "thinking", { text: `گام ${i} را بررسی می‌کنم. ` });
  store.appendEvent(chat.id, runId, "thinking.done", { durationMs: 5 });
  store.appendEvent(chat.id, runId, "text", { text: "جواب" });
  store.appendEvent(chat.id, runId, "chat.suggested", { id: "s1", title: "بعدی", tldr: "x" });
  store.appendEvent(chat.id, runId, "run.finished", { status: "finished" });
  return { chat, runId };
}

const fullFold = (store, chatId) => {
  const rows = store.db.prepare("SELECT id, run_id, type, data, at FROM events WHERE chat_id = ? ORDER BY id").all(chatId);
  return foldEvents(rows.map((r) => ({ id: r.id, runId: r.run_id, type: r.type, data: JSON.parse(r.data), at: r.at })));
};

test("the second /timeline of a big chat does not read its events again", async () => {
  const { store, app, read, cleanup } = setup();
  try {
    const { chat } = bigChat(store);
    const first = await (await app.request(`/api/chats/${chat.id}/timeline`)).json();
    assert.ok(read.rows >= 220, "the first open reads the log");
    assert.deepEqual(first.timeline, fullFold(store, chat.id));

    read.rows = 0;
    const second = await (await app.request(`/api/chats/${chat.id}/timeline`)).json();
    assert.equal(read.rows, 0, "the second open must not read old events");
    assert.deepEqual(second.timeline, first.timeline);
  } finally {
    cleanup();
  }
});

test("a cached timeline plus newer events equals a full fold, reading only the newer ones", async () => {
  const { store, app, read, cleanup } = setup();
  try {
    const { chat, runId } = bigChat(store);
    await app.request(`/api/chats/${chat.id}/timeline`);

    // every kind of change: a status on the old run's card, a new turn with tools, an open run
    store.appendEvent(chat.id, null, "chat.suggestion.status", { id: "s1", status: "started" });
    store.appendEvent(chat.id, null, "user", { text: "ادامه" });
    const run2 = store.startRun(chat.id);
    store.appendEvent(chat.id, run2, "run.started", { model: "m" });
    store.appendEvent(chat.id, run2, "thinking", { text: "فکر " });
    store.appendEvent(chat.id, run2, "thinking", { text: "دوم" });
    store.appendEvent(chat.id, run2, "tool.started", { callId: "c1", name: "df", args: { a: 1 } });
    store.appendEvent(chat.id, run2, "tool.done", { callId: "c1", name: "df", args: { a: 1 }, result: { status: "success" } });
    store.appendEvent(chat.id, run2, "text", { text: "نیمه" });
    store.appendEvent(chat.id, runId, "usage", { inputTokens: 3 });
    const added = 9;

    read.rows = 0;
    const { timeline } = await (await app.request(`/api/chats/${chat.id}/timeline`)).json();
    assert.deepEqual(timeline, fullFold(store, chat.id));
    assert.equal(read.rows, added, "only the newer events are read");

    // and again while the run keeps going
    store.appendEvent(chat.id, run2, "text", { text: " تمام" });
    store.appendEvent(chat.id, run2, "run.finished", { status: "finished" });
    const again = await (await app.request(`/api/chats/${chat.id}/timeline`)).json();
    assert.deepEqual(again.timeline, fullFold(store, chat.id));
  } finally {
    cleanup();
  }
});

test("a snapshot already handed out does not change when later events arrive", async () => {
  const { store, timelines, cleanup } = setup();
  try {
    const { chat } = bigChat(store);
    const run2 = store.startRun(chat.id);
    store.appendEvent(chat.id, run2, "run.started", { model: "m" });
    store.appendEvent(chat.id, run2, "text", { text: "الف" });
    const before = await timelines.get(chat.id);
    const frozen = JSON.stringify(before.timeline);
    const body = Buffer.from(before.body);

    store.appendEvent(chat.id, run2, "text", { text: "ب" });
    store.appendEvent(chat.id, null, "chat.suggestion.status", { id: "s1", status: "dismissed" });
    const after = await timelines.get(chat.id);

    assert.notEqual(after.timeline.lastEventId, before.timeline.lastEventId);
    assert.equal(JSON.stringify(before.timeline), frozen);
    assert.ok(body.equals(before.body));
    assert.deepEqual(JSON.parse(after.body.toString("utf8")).timeline, fullFold(store, chat.id));
  } finally {
    cleanup();
  }
});

test("a cold fold of a long chat lets other work run between pages", async () => {
  const { store, timelines, cleanup } = setup();
  try {
    const { chat } = bigChat(store); // 226 events = 5 pages of 50
    let turns = 0;
    let running = true;
    const tick = () => {
      turns += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    await timelines.get(chat.id);
    running = false;
    assert.ok(turns >= 3, `the event loop ran ${turns} times during the fold`);
  } finally {
    cleanup();
  }
});

test("two opens of the same cold chat share one fold", async () => {
  const { store, timelines, read, cleanup } = setup();
  try {
    const { chat } = bigChat(store);
    read.rows = 0;
    const [a, b] = await Promise.all([timelines.get(chat.id), timelines.get(chat.id)]);
    assert.equal(a.timeline, b.timeline);
    assert.equal(read.rows, 226);
  } finally {
    cleanup();
  }
});

test("deleting one chat while another is being folded does not throw that fold away", async () => {
  const { store, timelines, read, cleanup } = setup();
  try {
    const big = bigChat(store).chat;
    const other = bigChat(store, 10).chat;
    const folding = timelines.get(big.id); // yields between pages
    store.deleteChat(other.id);
    await folding;
    read.rows = 0;
    await timelines.get(big.id);
    assert.equal(read.rows, 0, "the fold that was under way was kept");
  } finally {
    cleanup();
  }
});

test("a chat deleted, or events added, while its own fold is under way", async () => {
  const { store, timelines, cleanup } = setup();
  try {
    const { chat, runId } = bigChat(store);
    const folding = timelines.get(chat.id);
    store.appendEvent(chat.id, runId, "note", { text: "وسط کار" });
    const entry = await folding;
    assert.deepEqual(entry.timeline, fullFold(store, chat.id), "events that arrive mid-fold are in it");

    const gone = bigChat(store).chat;
    const doomed = timelines.get(gone.id);
    store.deleteChat(gone.id);
    await doomed;
    assert.equal(timelines.stats().entries, 1, "a fold that ends after its chat was deleted is not stored");
    // and the mark left by that delete does not stick to the id
    assert.equal((await timelines.get(chat.id)).timeline, entry.timeline);
  } finally {
    cleanup();
  }
});

test("a shared chat's public page reads from the same memory", async () => {
  const { store, app, read, cleanup } = setup();
  try {
    const { chat } = bigChat(store);
    store.chatForShare = (token) => (token === "tok" ? { id: chat.id, title: "big", created_at: "x" } : null);
    const first = await (await app.request("/api/public/tok")).json();
    assert.deepEqual(first.timeline, fullFold(store, chat.id));
    read.rows = 0;
    const second = await (await app.request("/api/public/tok")).json();
    assert.equal(read.rows, 0);
    assert.deepEqual(second.timeline, first.timeline);
    assert.equal((await app.request("/api/public/nope")).status, 404);
  } finally {
    cleanup();
  }
});

test("the client's «I already have this» gets a tiny answer; a stale or foreign copy gets the timeline", async () => {
  const { store, app, cleanup } = setup();
  try {
    const { chat } = bigChat(store);
    const first = await (await app.request(`/api/chats/${chat.id}/timeline`)).json();
    assert.ok(first.rev, "the response names the server revision that folded it");
    const have = first.timeline.lastEventId;

    const same = await (await app.request(`/api/chats/${chat.id}/timeline?have=${have}&rev=${first.rev}`)).json();
    assert.deepEqual(same, { unchanged: true, rev: first.rev });

    const otherRev = await (await app.request(`/api/chats/${chat.id}/timeline?have=${have}&rev=nope`)).json();
    assert.deepEqual(otherRev.timeline, first.timeline);

    store.appendEvent(chat.id, null, "user", { text: "تازه" });
    const moved = await (await app.request(`/api/chats/${chat.id}/timeline?have=${have}&rev=${first.rev}`)).json();
    assert.equal(moved.timeline.messages.at(-1).text, "تازه");
  } finally {
    cleanup();
  }
});

test("the timeline goes out gzipped when the client accepts it, and plain when it does not", async () => {
  const { store, app, cleanup } = setup();
  try {
    const { chat } = bigChat(store);
    const plain = await app.request(`/api/chats/${chat.id}/timeline`);
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.equal(plain.headers.get("cache-control"), "no-store");
    const plainBytes = Buffer.from(await plain.arrayBuffer());

    for (let i = 0; i < 2; i += 1) {
      const res = await app.request(`/api/chats/${chat.id}/timeline`, { headers: { "accept-encoding": "gzip, deflate, br" } });
      assert.equal(res.headers.get("content-encoding"), "gzip");
      assert.match(res.headers.get("vary") || "", /accept-encoding/i);
      assert.match(res.headers.get("content-type") || "", /application\/json/);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const packed = Buffer.from(await res.arrayBuffer());
      assert.ok(packed.length < plainBytes.length / 2);
      assert.ok(zlib.gunzipSync(packed).equals(plainBytes));
    }
  } finally {
    cleanup();
  }
});

test("a deleted chat and a rewritten event log are not served from memory", async () => {
  const { store, app, timelines, cleanup } = setup();
  try {
    const { chat, runId } = bigChat(store);
    const bytes = Object.fromEntries(Array.from({ length: 80_000 }, (_, i) => [String(i), 255]));
    store.appendEvent(chat.id, runId, "tool.done", { callId: "c9", name: "s3_get", args: {}, result: { value: { content: [{ image: { data: bytes } }] } } });
    await app.request(`/api/chats/${chat.id}/timeline`);
    assert.equal(timelines.stats().entries, 1);

    assert.equal(store.compactLargeEvents(() => ({ callId: "c9", name: "s3_get", args: {}, result: { value: "omitted" } })), 1);
    const { timeline } = await (await app.request(`/api/chats/${chat.id}/timeline`)).json();
    assert.deepEqual(timeline, fullFold(store, chat.id));

    store.deleteChat(chat.id);
    assert.equal(timelines.stats().entries, 0);
    assert.equal((await app.request(`/api/chats/${chat.id}/timeline`)).status, 404);
  } finally {
    cleanup();
  }
});

test("memory is bounded: the least recently opened chat is dropped first", async () => {
  const { store, timelines: probe, read, cleanup } = setup();
  try {
    const a = bigChat(store, 60).chat;
    const b = bigChat(store, 60).chat;
    const c = bigChat(store, 60).chat;
    await probe.get(a.id);
    const one = probe.stats().bytes;
    const maxBytes = Math.floor(one * 2.5); // room for two of these chats, not three
    const timelines = createTimelineCache({ store, pageSize: PAGE, maxBytes });
    await timelines.get(a.id);
    await timelines.get(b.id);
    await timelines.get(a.id); // a is now the most recent
    await timelines.get(c.id); // over budget: b goes
    assert.equal(timelines.stats().entries, 2);
    assert.ok(timelines.stats().bytes <= maxBytes);
    read.rows = 0;
    await timelines.get(a.id);
    await timelines.get(c.id);
    assert.equal(read.rows, 0, "the recently used chats stayed");
    const again = await timelines.get(b.id);
    assert.ok(read.rows > 60, "the dropped chat is folded again");
    assert.deepEqual(again.timeline, fullFold(store, b.id));
    // the gzipped copy counts too, and the total never drifts
    const before = timelines.stats().bytes;
    const packed = await again.gzip();
    const after = timelines.stats();
    assert.ok(after.bytes <= maxBytes);
    // b plus its gzipped copy no longer fits beside the other two: the oldest one made room
    assert.ok(after.entries < 2 || after.bytes === before + packed.length);
    store.deleteChat(a.id);
    store.deleteChat(b.id);
    store.deleteChat(c.id);
    assert.deepEqual(timelines.stats(), { entries: 0, bytes: 0 });
  } finally {
    cleanup();
  }
});

test("a live stream replays everything after the given id, however much that is", async () => {
  const { store, app, cleanup } = setup();
  try {
    const chat = store.createChat({ title: "long", mode: "agent" });
    const total = 5_200; // more than one page of the store's replay query
    store.db.exec("BEGIN");
    for (let i = 0; i < total; i += 1) store.appendEvent(chat.id, null, "note", { text: "n" });
    store.db.exec("COMMIT");
    const controller = new AbortController();
    const res = await app.request(`/api/chats/${chat.id}/stream?after=0`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let seen = 0;
    let text = "";
    const deadline = Date.now() + 10_000;
    while (seen < total && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), 1_500))]);
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      const parts = text.split("event: event");
      seen += parts.length - 1;
      text = parts.at(-1);
    }
    controller.abort();
    await reader.cancel().catch(() => {});
    assert.equal(seen, total);
  } finally {
    cleanup();
  }
});
