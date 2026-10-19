// Read-state rules: the sidebar's unread badge must reflect exactly the chats whose content the
// owner has not seen — including the «بازش کرده بودم ولی جواب بعداً کامل شد» case.
import test from "node:test";
import assert from "node:assert/strict";
import { arriveAt, isUnreadChat, lookAt, markSeen, markUnread, onStorageChange, resetSyncForTests, seenOf, seedSeen, syncSeen } from "../src/seen.js";

test("a finished chat is unread until its updatedAt is seen; running never is", () => {
  const at = "2026-10-05T05:07:01.509Z";
  assert.equal(isUnreadChat({ id: "c1", updatedAt: at, runStatus: "finished" }, null), true);
  assert.equal(isUnreadChat({ id: "c1", updatedAt: at, runStatus: "finished" }, at), false);
  // while running the spinner speaks; the badge would be noise
  assert.equal(isUnreadChat({ id: "c1", updatedAt: at, runStatus: "running" }, null), false);
  // a chat with no timestamps carries no signal either way
  assert.equal(isUnreadChat({ id: "c1", updatedAt: null, runStatus: "finished" }, null), false);
  assert.equal(isUnreadChat(null, null), false);
});

test("markSeen round-trips, and a run finishing after the visit re-marks the chat", () => {
  const id = "seen-roundtrip-chat";
  const at = "2026-10-05T06:00:00.000Z";
  assert.equal(seenOf(id), null);
  markSeen(id, at);
  assert.equal(seenOf(id), at);
  assert.equal(isUnreadChat({ id, updatedAt: at, runStatus: "finished" }, seenOf(id)), false);
  // the owner's case: he opened the chat mid-run (seen at `at`), the run finished afterwards
  // (updatedAt bumped to `later`) — the chat must read as unread again
  const later = "2026-10-05T06:05:00.000Z";
  assert.equal(isUnreadChat({ id, updatedAt: later, runStatus: "finished" }, seenOf(id)), true);
  markSeen(id, later);
  assert.equal(isUnreadChat({ id, updatedAt: later, runStatus: "finished" }, seenOf(id)), false);
});

test("markSeen ignores junk input and is idempotent", () => {
  markSeen(null, "2026-10-05T06:00:00.000Z");
  markSeen("junk-chat", null);
  markSeen("junk-chat", "");
  assert.equal(seenOf("junk-chat"), null);
  markSeen("idem-chat", "2026-10-05T06:00:00.000Z");
  markSeen("idem-chat", "2026-10-05T06:00:00.000Z");
  assert.equal(seenOf("idem-chat"), "2026-10-05T06:00:00.000Z");
});

test("seedSeen writes the baseline once, then never again", () => {
  // node has no localStorage: markSeen/seenOf still work through the in-memory cache, and the
  // storage-less seed must refuse rather than wipe state every load
  assert.equal(seedSeen([{ id: "s1", updatedAt: "2026-10-05T07:00:00.000Z" }]), false);
  // but with a stubbed storage the baseline lands exactly once
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  try {
    assert.equal(seedSeen([{ id: "s2", updatedAt: "2026-10-05T07:00:00.000Z" }, { id: "no-ts" }]), true);
    assert.deepEqual(JSON.parse(store.get("griffin.seen.v1")).s2, "2026-10-05T07:00:00.000Z");
    assert.equal("no-ts" in JSON.parse(store.get("griffin.seen.v1")), false);
    // second call: baseline exists → no-op (a later chat must still earn its badge)
    assert.equal(seedSeen([{ id: "s3", updatedAt: "2026-10-05T08:00:00.000Z" }]), false);
    assert.equal("s3" in JSON.parse(store.get("griffin.seen.v1")), false);
    assert.equal(isUnreadChat({ id: "s3", updatedAt: "2026-10-05T08:00:00.000Z", runStatus: "finished" }, seenOf("s3")), true);
  } finally {
    delete globalThis.localStorage;
  }
});

test("«علامت خوانده‌نشده»: the badge returns, survives the tab coming back, and clears when the chat is opened", () => {
  const id = "marked-unread-chat";
  const at = "2026-10-05T07:00:00.000Z";
  const chat = { id, updatedAt: at, runStatus: "finished" };
  markSeen(id, at);
  assert.equal(isUnreadChat(chat, seenOf(id)), false);
  markUnread(id);
  assert.equal(isUnreadChat(chat, seenOf(id)), true);
  // the tab became visible again, or the open chat got new content: not an "I read it"
  markSeen(id, at, { force: false });
  assert.equal(isUnreadChat(chat, seenOf(id)), true, "a passive see keeps the hand-made mark");
  // the owner opens the chat (or picks «علامت خوانده‌شده»)
  markSeen(id, at);
  assert.equal(isUnreadChat(chat, seenOf(id)), false);
  // a passive see still works for a chat that was never marked by hand
  const later = "2026-10-05T07:05:00.000Z";
  markSeen(id, later, { force: false });
  assert.equal(seenOf(id), later);
});

test("opening a chat clears a hand-made unread mark once per arrival, at the first visible look", () => {
  const at = "2026-10-05T08:00:00.000Z";
  const unread = (id) => isUnreadChat({ id, updatedAt: at, runStatus: "finished" }, seenOf(id));
  const state = { chat: null, pending: false };

  // marked while open: the tab coming back is not an opening
  arriveAt(state, "a");
  lookAt(state, "a", at, true);
  markUnread("a");
  arriveAt(state, "a");
  lookAt(state, "a", at, true);
  assert.equal(unread("a"), true, "still unread while it stays the open chat");

  // away to a page with no chat (settings, new chat) and back by the Back button: an opening
  arriveAt(state, null);
  arriveAt(state, "a");
  lookAt(state, "a", at, true);
  assert.equal(unread("a"), false);

  // opened in a background tab: the opening counts when the tab is first looked at
  markUnread("b");
  const other = { chat: null, pending: false };
  arriveAt(other, "b");
  lookAt(other, "b", at, false);
  assert.equal(unread("b"), true, "a hidden tab has not been read");
  lookAt(other, "b", at, true);
  assert.equal(unread("b"), false);
});

test("a read in another tab reaches this one through the storage event", () => {
  const store = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  onStorageChange({ key: null });
  try {
    const id = "cross-tab-chat";
    const at = "2026-10-18T06:00:00.000Z";
    markSeen(id, "2026-10-18T05:00:00.000Z");
    // the other tab opens the chat at its new updatedAt and writes the shared storage
    const other = JSON.parse(store.get("griffin.seen.v1"));
    other[id] = at;
    store.set("griffin.seen.v1", JSON.stringify(other));
    assert.notEqual(seenOf(id), at, "stale until the event arrives");
    assert.equal(onStorageChange({ key: "unrelated" }), false);
    assert.equal(onStorageChange({ key: "griffin.seen.v1" }), true);
    assert.equal(seenOf(id), at);
  } finally {
    globalThis.localStorage = prev;
    onStorageChange({ key: null });
  }
});

test("the read state is the server's: the first device uploads a baseline, another adopts it, reads are sent back", async () => {
  const at = "2026-10-19T05:00:00.000Z";
  const later = "2026-10-19T06:00:00.000Z";
  const server = { seen: null, rev: 0 };
  const calls = [];
  const request = async (url, opts = {}) => {
    calls.push([opts.method || "GET", url]);
    if (opts.method === "PUT") {
      const { set, init } = opts.body;
      if (init && server.seen) return { seen: server.seen, rev: server.rev };
      server.seen = { ...(server.seen || {}), ...set };
      server.rev += 1;
      return { rev: server.rev, ...(init ? { seen: server.seen } : {}) };
    }
    return server.seen ? { seen: server.seen, rev: server.rev } : { seen: null, rev: 0 };
  };
  // nothing on the server yet: this device's list becomes the baseline, a read before the sync is kept
  markSeen("early-chat", at);
  assert.equal(await syncSeen([{ id: "listed-chat", updatedAt: at }], { request }), true);
  // the baseline upload, then the read made before the sync (sent again: it is cheap and idempotent)
  assert.deepEqual(calls.map((c) => c[0]), ["GET", "PUT", "PUT"]);
  assert.equal(server.seen["listed-chat"], at);
  assert.equal(server.seen["early-chat"], at);
  assert.equal(isUnreadChat({ id: "listed-chat", updatedAt: at, runStatus: "finished" }, seenOf("listed-chat")), false);
  // a read after the sync reaches the server (batched)
  markSeen("listed-chat", later);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(server.seen["listed-chat"], later);
  // later calls share the first answer
  assert.equal(await syncSeen([], { request }), true);
  assert.equal(calls.filter((c) => c[0] === "GET").length, 1);
});

test("a browser that never shared its read state keeps its own unread marks when the server already has a copy", async () => {
  const at = "2026-10-19T05:00:00.000Z";
  const store = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  resetSyncForTests();
  try {
    // this browser marked a chat unread before the update; another device already uploaded a baseline
    store.set("griffin.seen.v1", JSON.stringify({ "marked-chat": "unread", "old-chat": at }));
    const server = { seen: { "marked-chat": at, "old-chat": at, "phone-chat": at }, rev: 3 };
    const puts = [];
    const request = async (url, opts = {}) => {
      if (opts.method === "PUT") {
        puts.push(opts.body);
        Object.assign(server.seen, opts.body.set);
        server.rev += 1;
        return { rev: server.rev };
      }
      return { seen: server.seen, rev: server.rev };
    };
    assert.equal(await syncSeen([], { request }), true);
    assert.equal(seenOf("marked-chat"), "unread", "the mark survives the adoption");
    assert.equal(seenOf("phone-chat"), at, "the other device's state arrived");
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(server.seen["marked-chat"], "unread", "and went to the server for the other devices");
    assert.equal(store.get("griffin.seen.synced.v1"), "1");
    // a browser that has shared before takes the server's copy as it is
    resetSyncForTests();
    store.set("griffin.seen.v1", JSON.stringify({ "marked-chat": at }));
    server.seen["marked-chat"] = at;
    assert.equal(await syncSeen([], { request }), true);
    assert.equal(seenOf("marked-chat"), at);
  } finally {
    globalThis.localStorage = prev;
    resetSyncForTests();
  }
});
