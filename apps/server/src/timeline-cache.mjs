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

// A page of messages is never cut inside a run that is still going (its later events would find
// nothing to land on), but only that many messages before the cut are looked at for one.
const RUNNING_LOOKBACK = 50;
const TAILS_KEPT = 3;

/** Where the last `limit` messages start; 0 = show all. */
export function tailStart(messages, limit) {
  let cut = Math.max(0, messages.length - limit);
  for (let i = cut - 1; i >= Math.max(0, cut - RUNNING_LOOKBACK); i -= 1) {
    if (messages[i].role === "assistant" && messages[i].status === "running") cut = i;
  }
  return cut;
}

// A page goes out without the big tool results: they were ~90% of a chat's first screen (a page of
// 40 messages weighed 4.8 MB, 2026-10-28) though their cards sit folded in the work log. The card
// fetches its result when it is opened (GET /api/chats/:id/tool-result). Results drawn without a
// click — charts, files, questions, the plan, a subagent's steps — and failures always go out whole.
export const LAZY_RESULT_BYTES = 1024;
const SHOWN_WITHOUT_CLICK = new Set([
  "show_media", "browser_screenshot", "s3_get", "visualize", "preview_start", "ask_owner", "ask_requester", "ask_agent",
  "consult", "send_to_person", "owner_task", "task", "todo_write", "TodoWrite", "AskUserQuestion", "ExitPlanMode",
]);
const leavable = (part) => part.type === "tool" && part.status === "success" && Boolean(part.result) && Boolean(part.callId) && !SHOWN_WITHOUT_CLICK.has(part.name);

// What the folded card's head shows of a result (Tool.jsx SourceBadge) stays beside the stub.
function resultHead(result) {
  const first = result?.value?.content?.find?.((c) => typeof c?.text === "string" || typeof c?.text?.text === "string");
  const raw = typeof first?.text === "string" ? first.text : first?.text?.text;
  if (!raw || raw[0] !== "{") return {};
  try {
    const { source, attempts } = JSON.parse(raw);
    return { ...(typeof source === "string" ? { source } : {}), ...(Array.isArray(attempts) ? { attempts } : {}) };
  } catch {
    return {};
  }
}

/** The messages with each big, folded tool result swapped for a stub that says where to fetch it. */
export function liteMessages(messages, chatId) {
  return messages.map((message) => {
    if (!message.parts?.some(leavable)) return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (!leavable(part)) return part;
      const bytes = JSON.stringify(part.result).length;
      if (bytes < LAZY_RESULT_BYTES) return part;
      changed = true;
      return { ...part, result: { value: { lazy: { chat: chatId, bytes }, ...resultHead(part.result) } } };
    });
    return changed ? { ...message, parts } : message;
  });
}

/** One tool call's whole result by its callId, newest message first; null when there is none. */
export function toolResult(timeline, callId) {
  for (let i = timeline.messages.length - 1; i >= 0; i -= 1) {
    const part = timeline.messages[i].parts?.find((p) => p.type === "tool" && p.callId === callId);
    if (part) return { status: part.status, result: part.result ?? null };
  }
  return null;
}

/** The `limit` messages just before the one called `before`; null when there is no such message. */
export function olderPage(timeline, before, limit, chatId = null) {
  const at = timeline.messages.findIndex((m) => m.id === before);
  if (at < 0) return null;
  const from = Math.max(0, at - limit);
  const messages = timeline.messages.slice(from, at);
  return { messages: chatId ? liteMessages(messages, chatId) : messages, earlier: from };
}

export function createTimelineCache({ store, maxBytes = 256 * 1024 * 1024, pageSize = 2000 }) {
  // A copy the browser kept is only as good as the code that folded it: a restart changes rev.
  const rev = randomBytes(6).toString("hex");
  const entries = new Map(); // chatId -> entry; insertion order is least recently used first
  const pending = new Map(); // chatId -> the refresh in flight
  let bytes = 0;
  const dropped = new Map(); // chatId -> how often it was dropped, so a fold under way then is not stored

  // The folded object is measured at about twice its JSON on the heap; the JSON itself (only the
  // full-timeline answer makes it) counts once more when it exists. Until then the JSON's size is
  // estimated from the events folded in.
  const size = (entry) => (entry.full ? entry.full.length * 3 : entry.approx * 2) + (entry.packed?.length || 0);

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
    let approx = cached?.approx || 0;
    for (;;) {
      const events = store.eventsAfter(chatId, timeline.lastEventId, pageSize);
      for (const event of events) approx += (JSON.stringify(event.data)?.length || 0) + 64;
      if (events.length) timeline = foldEvents(events, timeline);
      if (events.length < pageSize) break;
      await yieldToLoop();
    }
    if (cached && cached.timeline === timeline) {
      keep(chatId, cached);
      return cached;
    }
    // The whole timeline as JSON is made only when something asks for all of it (scripts, guest
    // pages): stringifying a big chat on every new event kept the one thread busy for hundreds of ms
    // each time while every page asks only for its tail (owner 2026-11-07: chats opened after 1–6 s).
    const entry = {
      timeline, rev, approx, full: null, packed: null, packing: null, kept: 0,
      get body() {
        if (!this.full) {
          this.full = Buffer.from(JSON.stringify({ timeline, rev }));
          if (entries.get(chatId) === this) keep(chatId, this);
        }
        return this.full;
      },
    };
    // The gzipped body is made on first use, off the main thread, and kept with the entry.
    // The last `limit` messages (timeline.earlier = how many come before them): what a big chat's
    // first open needs; the rest is fetched page by page (olderPage). Big tool results stay behind
    // (liteMessages), also when the whole chat fits in the page.
    entry.tails = new Map();
    entry.tail = (limit) => {
      const cut = tailStart(timeline.messages, limit);
      let tail = entry.tails.get(limit);
      if (!tail) {
        const body = Buffer.from(JSON.stringify({ timeline: { ...timeline, messages: liteMessages(timeline.messages.slice(cut), chatId), ...(cut ? { earlier: cut } : {}) }, rev }));
        tail = { body, packed: null, packing: null };
        tail.gzip = () => {
          tail.packing ||= gzip(body, { level: 4 }).then((packed) => (tail.packed = packed));
          return tail.packing;
        };
        entry.tails.set(limit, tail);
        if (entry.tails.size > TAILS_KEPT) entry.tails.delete(entry.tails.keys().next().value);
      }
      return tail;
    };
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

  // After a restart (every release) the memory is empty and the first open of a big chat folded its
  // whole log: 1.3–5.3 s on 2026-10-28. The chats likely to be opened next are folded in the
  // background instead, one at a time, the most recent last so it stays the freshest in memory.
  async function warm(chatIds) {
    for (const chatId of [...chatIds].reverse()) {
      try {
        await get(chatId);
      } catch (error) {
        console.error(`[timelines] warm ${chatId}: ${error.message}`);
      }
      await yieldToLoop();
    }
  }

  return { get, drop, warm, rev, stats: () => ({ entries: entries.size, bytes }) };
}
