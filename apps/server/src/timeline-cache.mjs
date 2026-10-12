// Folded timelines kept in memory, one per chat.
//
// Folding a chat reads its whole event log; on the live data a 456k-event chat took 7.5s per open
// (three quarters of it reading rows), synchronously, with every other request waiting behind it.
// Here the log is read once: later opens read only the events after the cached lastEventId, and a
// cold fold yields to the event loop between pages so running chats keep streaming meanwhile.
//
// applyEvent never mutates a timeline (it returns a new one that shares the untouched parts), so
// an entry handed out stays a fixed snapshot whatever arrives afterwards.
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { emptyTimeline, foldEvents } from "@griffin/timeline";

const gzip = promisify(zlib.gzip);
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

export function createTimelineCache({ store, maxBytes = 256 * 1024 * 1024, pageSize = 2000 }) {
  // A copy the browser kept is only as good as the code that folded it: a restart changes rev.
  const rev = randomBytes(6).toString("hex");
  const entries = new Map(); // chatId -> entry; insertion order is least recently used first
  const pending = new Map(); // chatId -> the refresh in flight
  let bytes = 0;
  const dropped = new Map(); // chatId -> how often it was dropped, so a fold under way then is not stored

  // The folded object is kept beside its JSON (the next refresh folds onto it) and measured at
  // about twice the JSON on the heap, hence three times the body.
  const size = (entry) => entry.body.length * 3 + (entry.packed?.length || 0);

  function forget(chatId) {
    const entry = entries.get(chatId);
    if (!entry) return;
    bytes -= entry.kept;
    entries.delete(chatId);
  }

  function keep(chatId, entry) {
    forget(chatId);
    entry.kept = size(entry);
    entries.set(chatId, entry);
    bytes += entry.kept;
    for (const [oldest] of entries) {
      if (bytes <= maxBytes || oldest === chatId) break;
      forget(oldest);
    }
    // One chat bigger than the whole budget is served but not kept.
    if (bytes > maxBytes) forget(chatId);
  }

  async function refresh(chatId) {
    const startedIn = dropped.get(chatId) || 0;
    const cached = entries.get(chatId);
    let timeline = cached?.timeline || emptyTimeline();
    for (;;) {
      const events = store.eventsAfter(chatId, timeline.lastEventId, pageSize);
      if (events.length) timeline = foldEvents(events, timeline);
      if (events.length < pageSize) break;
      await yieldToLoop();
    }
    if (cached && cached.timeline === timeline) {
      keep(chatId, cached);
      return cached;
    }
    const entry = { timeline, rev, body: Buffer.from(JSON.stringify({ timeline, rev })), packed: null, packing: null, kept: 0 };
    // The gzipped body is made on first use, off the main thread, and kept with the entry.
    entry.gzip = () => {
      if (entry.packed) return Promise.resolve(entry.packed);
      entry.packing ||= gzip(entry.body, { level: 4 }).then((packed) => {
        entry.packed = packed;
        entry.packing = null;
        if (entries.get(chatId) === entry) keep(chatId, entry);
        return packed;
      });
      return entry.packing;
    };
    // The chat may have been deleted, or its log rewritten, while this fold was yielding.
    if ((dropped.get(chatId) || 0) === startedIn) keep(chatId, entry);
    return entry;
  }

  function get(chatId) {
    let work = pending.get(chatId);
    if (!work) {
      work = refresh(chatId).finally(() => {
        if (pending.get(chatId) === work) pending.delete(chatId);
        if (!pending.has(chatId)) dropped.delete(chatId);
      });
      pending.set(chatId, work);
    }
    return work;
  }

  function drop(chatId) {
    // Only a fold that is under way needs the mark; it is cleared when that fold ends.
    if (pending.has(chatId)) dropped.set(chatId, (dropped.get(chatId) || 0) + 1);
    forget(chatId);
    pending.delete(chatId);
  }

  store.bus.on("chats", (change) => {
    if (change?.type === "deleted") drop(change.chatId);
  });
  // A rewind names its chat; a bulk rewrite does not and drops everything.
  store.bus.on("events.rewritten", (only) => {
    for (const chatId of only ? [only] : [...entries.keys(), ...pending.keys()]) drop(chatId);
  });

  return { get, drop, rev, stats: () => ({ entries: entries.size, bytes }) };
}
