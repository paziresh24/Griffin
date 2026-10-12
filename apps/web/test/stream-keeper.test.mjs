import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { keepOpen, RETRY_DELAYS_MS, retryDelay } from "../src/stream-keeper.js";

// A fake clock: timers run only when the test moves time forward.
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    get now() {
      return now;
    },
  };
}

// EventSource as a browser behaves: a non-200 answer (a 502 during a deploy) fires error with
// readyState CLOSED, and the browser never tries again on its own.
class FakeSource {
  static CLOSED = 2;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.closed = false;
  }
  addEventListener(name, fn) {
    (this.listeners[name] ||= []).push(fn);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  fail502() {
    this.readyState = 2;
    this.onerror?.();
  }
  emit(name) {
    for (const fn of this.listeners[name] || []) fn({ data: "" });
  }
}

class FakeTarget {
  constructor() {
    this.listeners = {};
    this.visibilityState = "visible";
  }
  addEventListener(name, fn) {
    (this.listeners[name] ||= new Set()).add(fn);
  }
  removeEventListener(name, fn) {
    this.listeners[name]?.delete(fn);
  }
  fire(name) {
    for (const fn of this.listeners[name] || []) fn();
  }
}

function harness() {
  const clock = fakeClock();
  const sources = [];
  const states = [];
  const win = new FakeTarget();
  const doc = new FakeTarget();
  let opened = 0;
  let lastEventId = 0;
  const keeper = keepOpen({
    open: () => {
      const source = new FakeSource(`/api/chats/c1/stream?after=${lastEventId}`);
      sources.push(source);
      return source;
    },
    onOpen: () => (opened += 1),
    onState: (state) => states.push(state),
    timers: clock,
    win,
    doc,
  });
  return { clock, sources, states, win, doc, keeper, opens: () => opened, setLast: (id) => (lastEventId = id) };
}

test("back-off is 1s, 2s, 5s, then at most 15s", () => {
  assert.deepEqual(RETRY_DELAYS_MS, [1000, 2000, 5000, 15000]);
  assert.deepEqual([0, 1, 2, 3, 4, 50].map(retryDelay), [1000, 2000, 5000, 15000, 15000, 15000]);
});

test("a 502 while the server restarts: the chat reconnects by itself within 15s, no refresh", () => {
  const h = harness();
  h.sources[0].open();
  assert.equal(h.states.at(-1), "live");
  h.setLast(42);
  // The deploy: the stream drops and every reconnect gets a 502 for a while.
  h.sources[0].fail502();
  assert.equal(h.states.at(-1), "reconnecting");
  for (let i = 0; i < 6; i += 1) {
    const before = h.sources.length;
    h.clock.advance(15_000);
    assert.equal(h.sources.length, before + 1, `attempt ${i + 1} came within 15s`);
    h.sources.at(-1).fail502();
  }
  // The server is back: the next attempt (≤15s) opens.
  h.clock.advance(15_000);
  const back = h.sources.at(-1);
  back.open();
  assert.equal(back.url, "/api/chats/c1/stream?after=42", "resumes after the last event it has, so nothing shows twice");
  assert.equal(h.states.at(-1), "restored", "says «وصل شد» once");
  h.clock.advance(5_000);
  assert.equal(h.states.at(-1), "live");
  assert.ok(h.sources.slice(0, -1).every((s) => s.closed), "a dead source is never left open");
  assert.equal(h.opens(), 2, "onOpen ran for the first open and the reconnect");
  h.keeper.stop();
});

test("network back or the tab shown again: it reconnects at once instead of waiting", () => {
  const h = harness();
  h.sources[0].open();
  h.sources[0].fail502();
  h.clock.advance(1000);
  h.sources[1].fail502(); // next wait is 2s
  h.win.fire("online");
  assert.equal(h.sources.length, 3, "online reconnects now");
  h.sources[2].fail502();
  h.doc.visibilityState = "hidden";
  h.doc.fire("visibilitychange");
  assert.equal(h.sources.length, 3, "a hidden tab does not hurry");
  h.doc.visibilityState = "visible";
  h.doc.fire("visibilitychange");
  assert.equal(h.sources.length, 4, "a tab shown again reconnects now");
  h.keeper.stop();
});

test("«تلاش دوباره» reconnects at once; a live stream is left alone", () => {
  const h = harness();
  h.sources[0].open();
  h.keeper.retryNow();
  assert.equal(h.sources.length, 1, "nothing to do while live");
  h.sources[0].fail502();
  h.keeper.retryNow();
  assert.equal(h.sources.length, 2);
  h.keeper.stop();
});

test("a stream that says open but went silent (no ping for 40s) is replaced", () => {
  const h = harness();
  h.sources[0].open();
  h.clock.advance(30_000);
  h.sources[0].emit("ping");
  h.clock.advance(30_000);
  assert.equal(h.sources.length, 1, "pings keep it");
  h.clock.advance(15_000);
  assert.equal(h.states.at(-1), "reconnecting");
  assert.ok(h.sources[0].closed);
  h.clock.advance(1000);
  assert.equal(h.sources.length, 2);
  h.keeper.stop();
});

test("stop closes the stream and no timer opens another", () => {
  const h = harness();
  h.sources[0].fail502();
  h.keeper.stop();
  h.clock.advance(60_000);
  h.win.fire("online");
  assert.equal(h.sources.length, 1);
});

test("both live streams of the page (the chat and the chat list) are kept open by it", () => {
  const source = fs.readFileSync(new URL("../src/api.js", import.meta.url), "utf8");
  const chats = source.slice(source.indexOf("export function useChats"), source.indexOf("export function useTimeline"));
  const timeline = source.slice(source.indexOf("export function useTimeline"), source.indexOf("export function usePolling"));
  assert.match(chats, /keepOpen\(/, "useChats reconnects");
  assert.match(timeline, /openTimeline\(/, "useTimeline goes through timeline-stream.js (tested there)");
  assert.doesNotMatch(source, /"closed"/, "no dead-end closed state");
});
