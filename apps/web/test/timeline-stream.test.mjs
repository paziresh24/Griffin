import test from "node:test";
import assert from "node:assert/strict";
import { emptyTimeline } from "@griffin/timeline";
import { catchUpTimeline, openTimeline } from "../src/timeline-stream.js";
import { createOutbox, createSender, mergeOutbox } from "../src/outbox.js";
import { FakeSource, FakeTarget, fakeClock, flushPromises } from "./stream-fakes.mjs";

const CHAT = "c-1";

// A server for one chat: history, the events route, the message route (de-duplicated by client
// id), and a switch that makes everything fail as during a restart.
function fakeServer({ lastEventId = 40 } = {}) {
  const events = [];
  let nextId = lastEventId + 1;
  const server = {
    down: false,
    calls: [],
    events,
    async api(path, { method = "GET", body } = {}) {
      server.calls.push(`${method} ${path}`);
      if (server.hang && path.includes("/events")) return new Promise(() => {});
      if (path === "/api/auth/me") return { authenticated: !server.loggedOut }; // 200 either way, like auth.mjs
      if (server.down) throw Object.assign(new Error("http 502"), { status: 502 });
      if (path.startsWith(`/api/chats/${CHAT}/timeline`)) return { timeline: { ...emptyTimeline(), lastEventId }, rev: "r1" };
      if (path.startsWith(`/api/chats/${CHAT}/events`)) {
        const after = Number(new URL(path, "http://x").searchParams.get("after"));
        return { events: events.filter((e) => e.id > after) };
      }
      if (path === `/api/chats/${CHAT}/messages` && method === "POST") {
        if (events.some((e) => e.data.clientId === body.clientId)) return { delivered: "duplicate" };
        events.push({ id: nextId++, type: "user", data: { text: body.text, clientId: body.clientId }, at: "2026-10-11T10:00:00Z" });
        return { delivered: "queued" };
      }
      return {};
    },
  };
  return server;
}

function open(server, { remembered = null, onUnauthorized = () => {} } = {}) {
  FakeSource.all = [];
  const clock = fakeClock();
  const shown = [];
  const handle = openTimeline({
    chatId: CHAT,
    remembered,
    api: server.api,
    EventSourceImpl: FakeSource,
    raf: (fn) => clock.setTimeout(fn, 16),
    caf: (id) => clock.clearTimeout(id),
    timers: clock,
    win: new FakeTarget(),
    doc: new FakeTarget(),
    onShow: (state) => shown.push(state),
    onUnauthorized,
  });
  return { clock, shown, handle, last: () => shown.at(-1), sources: FakeSource.all };
}

test("the chat reconnects by itself after a 502 and resumes after its last event", async () => {
  const server = fakeServer();
  const t = open(server);
  await flushPromises();
  assert.equal(t.sources.length, 1);
  t.sources[0].open();
  assert.equal(t.last().connection, "live");
  t.sources[0].emit("event", JSON.stringify({ id: 41, type: "note", data: { text: "x" } }));
  t.clock.advance(20); // the frame that applies it
  t.sources[0].fail502();
  assert.equal(t.last().connection, "reconnecting");
  t.clock.advance(15_000);
  assert.ok(t.sources.length >= 2, "a new stream opened within 15s, no refresh");
  assert.equal(t.sources.at(-1).url, `/api/chats/${CHAT}/stream?after=41`);
  t.sources.at(-1).open();
  assert.equal(t.last().connection, "restored");
  t.handle.stop();
});

test("a message sent while the stream is dead reaches the screen through the direct fetch", async () => {
  const server = fakeServer();
  const t = open(server);
  await flushPromises();
  t.sources[0].open();
  t.sources[0].fail502(); // the stream dies and stays dead (the next tries get 502 too)
  const outbox = createOutbox();
  const sender = createSender({
    outbox,
    post: (entry) => server.api(`/api/chats/${CHAT}/messages`, { method: "POST", body: { ...entry.payload, intent: entry.intent, clientId: entry.clientId } }),
    catchUp: catchUpTimeline, // the real registry the page uses
    settle: () => {},
    later: () => {},
  });
  await sender.submit({ chatId: CHAT, clientId: "k1", text: "سلام", typed: "سلام", intent: "send", payload: { text: "سلام", images: [] }, held: "h", quoteIds: [] });
  await flushPromises();
  const timeline = t.last().timeline;
  const screen = mergeOutbox(timeline.messages, outbox.forChat(CHAT));
  assert.equal(screen.length, 1);
  assert.equal(screen[0].text, "سلام");
  assert.equal(screen[0].sendState, undefined, "the server's copy, fetched without the stream");
  sender.landed(CHAT, timeline.messages);
  assert.equal(outbox.forChat(CHAT).length, 0, "it left the outbox once it landed");
  t.handle.stop();
  catchUpTimeline(CHAT); // a stopped timeline is no longer asked
  await flushPromises();
});

test("a failed history load is tried again, never replaced by a stream from the first event", async () => {
  const server = fakeServer();
  server.down = true;
  const t = open(server);
  await flushPromises();
  assert.equal(t.sources.length, 0, "no stream from event 0");
  assert.equal(t.last().connection, "reconnecting", "said like a lost stream, not «بارگذاری…»");
  server.down = false;
  t.clock.advance(1000);
  await flushPromises();
  assert.equal(t.sources.length, 1);
  assert.equal(t.sources[0].url, `/api/chats/${CHAT}/stream?after=40`);
  t.handle.stop();
});

test("no direct fetch before the history is in; a stream failing for an ended session shows the login", async () => {
  const server = fakeServer();
  server.down = true;
  let loggedOut = 0;
  const t = open(server, { onUnauthorized: () => (loggedOut += 1) });
  await flushPromises();
  await t.handle.catchUp(true);
  assert.equal(server.calls.filter((c) => c.includes("/events")).length, 0);
  server.down = false;
  t.clock.advance(1000);
  await flushPromises();
  t.sources[0].fail502();
  await flushPromises();
  assert.equal(loggedOut, 0, "a live session: just reconnect");
  server.loggedOut = true;
  t.clock.advance(1000);
  t.sources.at(-1).fail502();
  await flushPromises();
  assert.equal(loggedOut, 1, "{authenticated:false} shows the login screen");
  t.handle.stop();
});

test("«تلاش دوباره» while a retried history load is on its way opens one stream, and stop closes it", async () => {
  const server = fakeServer();
  server.down = true;
  const t = open(server);
  await flushPromises(); // first load failed; a retry waits 1s
  let release;
  const gate = new Promise((r) => (release = r));
  const api = server.api;
  server.api = async (path, opts) => {
    if (path.includes("/timeline")) await gate; // the retried load hangs until released
    return api(path, opts);
  };
  server.down = false;
  t.clock.advance(1000); // the retry starts and hangs
  t.handle.retryNow(); // the owner taps meanwhile
  release();
  await flushPromises();
  assert.equal(server.calls.filter((c) => c.includes("/timeline")).length, 2, "the first load and one retry, no extra load");
  assert.equal(t.sources.length, 1, "one stream");
  t.handle.stop();
  assert.ok(t.sources.every((s) => s.closed), "no stream outlives the chat");
});

test("an older history answer arriving after a newer one went live changes nothing", async () => {
  const server = fakeServer();
  const answers = [];
  server.api = async (path) => {
    if (path.includes("/timeline")) return new Promise((resolve, reject) => answers.push({ resolve, reject }));
    if (path === "/api/auth/me") return { authenticated: true };
    return {};
  };
  const t = open(server);
  answers[0].reject(new Error("502"));
  await flushPromises();
  t.clock.advance(1000); // retry #1 in flight (answers[1])
  answers[1].resolve({ timeline: { ...emptyTimeline(), lastEventId: 40 }, rev: "r" });
  await flushPromises();
  t.sources[0].open();
  assert.equal(t.last().connection, "live");
  t.handle.retryNow(); // nothing waiting: no new load
  assert.equal(answers.length, 2);
  t.handle.stop();
});

test("while the history cannot load the header says it is reconnecting, and «تلاش دوباره» tries now", async () => {
  const server = fakeServer();
  server.down = true;
  const t = open(server);
  await flushPromises();
  assert.equal(t.last().connection, "reconnecting");
  t.clock.advance(1000);
  await flushPromises();
  t.clock.advance(2000);
  await flushPromises(); // the next wait is 5s
  server.down = false;
  const before = server.calls.filter((c) => c.includes("/timeline")).length;
  t.handle.retryNow();
  await flushPromises();
  assert.equal(server.calls.filter((c) => c.includes("/timeline")).length, before + 1);
  assert.equal(t.sources.length, 1, "history in, stream opened");
  t.handle.stop();
});

test("a direct fetch that hangs gives way after 10s, and the next one runs", async () => {
  const server = fakeServer();
  const t = open(server);
  await flushPromises();
  t.sources[0].fail502();
  server.hang = true;
  const first = t.handle.catchUp(true);
  t.clock.advance(10_000);
  await first;
  server.hang = false;
  const before = server.calls.length;
  await t.handle.catchUp(true);
  assert.equal(server.calls.length, before + 1);
  t.handle.stop();
});

test("loadOlder fetches the page before the oldest message held and prepends it", async () => {
  const messages = (from, to) => Array.from({ length: to - from }, (_, i) => ({ id: `u${from + i}`, role: "user", text: `m${from + i}` }));
  const calls = [];
  const server = fakeServer();
  const base = server.api;
  server.api = async (path, opts) => {
    if (path.startsWith(`/api/chats/${CHAT}/timeline/older`)) {
      calls.push(path);
      const before = new URL(path, "http://x").searchParams.get("before");
      assert.equal(before, "u50");
      return { messages: messages(10, 50), earlier: 10 };
    }
    if (path.startsWith(`/api/chats/${CHAT}/timeline`)) {
      calls.push(path);
      return { timeline: { messages: messages(50, 60), lastEventId: 40, earlier: 50 }, rev: "r1" };
    }
    return base(path, opts);
  };
  const { shown, handle } = open(server);
  await flushPromises();
  assert.match(calls[0], /timeline\?limit=40/);
  assert.equal(shown.at(-1).timeline.earlier, 50);
  assert.equal(await handle.loadOlder(), true);
  const { timeline } = shown.at(-1);
  assert.equal(timeline.messages.length, 50);
  assert.equal(timeline.messages[0].id, "u10");
  assert.equal(timeline.earlier, 10);
  handle.stop();
});
