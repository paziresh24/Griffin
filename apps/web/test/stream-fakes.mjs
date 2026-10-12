// Fakes for the live-stream tests: a clock that moves only when told, a browser-like EventSource,
// and an event target for window/document.

export function fakeClock() {
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
export class FakeSource {
  static CLOSED = 2;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.closed = false;
    FakeSource.all.push(this);
  }
  static all = [];
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
  emit(name, data = "") {
    for (const fn of this.listeners[name] || []) fn({ data });
  }
}

export class FakeTarget {
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

export const flushPromises = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};
