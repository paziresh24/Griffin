// The owner's message shows at once with its state and is stored once however often it is resent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyEvent, emptyTimeline } from "@griffin/timeline";
import { createOutbox, createSender, FAILED_LABEL, mergeOutbox, retryableError, SENDING_LABEL, SENT_LABEL } from "../src/outbox.js";
import { connectionNotice } from "../src/timeline-memo.js";

const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};
const netError = () => Object.assign(new TypeError("Failed to fetch"), {});
const httpError = (status) => Object.assign(new Error(`http ${status}`), { status });

// A tiny "server": the chat's events, de-duplicated by clientId like the real route.
function fakeServer() {
  const events = [];
  return {
    events,
    post(chatId, body) {
      if (body.clientId && events.some((e) => e.data.clientId === body.clientId)) return { delivered: "duplicate" };
      events.push({ id: events.length + 1, type: "user", data: { text: body.text, clientId: body.clientId }, at: "2026-10-11T10:00:00Z" });
      return { delivered: "run" };
    },
    after(id) {
      return events.filter((e) => e.id > id);
    },
  };
}

function harness({ post } = {}) {
  const outbox = createOutbox();
  const server = fakeServer();
  let timeline = emptyTimeline();
  const settled = [];
  const posts = [];
  const timers = [];
  const sender = createSender({
    outbox,
    post: async (entry) => {
      posts.push(entry);
      return post ? post(entry, server) : server.post(entry.chatId, { ...entry.payload, intent: entry.intent, clientId: entry.clientId });
    },
    // The stream is dead: nothing arrives unless the timeline is fetched directly.
    catchUp: async () => {
      timeline = server.after(timeline.lastEventId).reduce(applyEvent, timeline);
    },
    settle: (entry, outcome, error) => settled.push({ clientId: entry.clientId, outcome, error }),
    later: (fn, ms) => timers.push({ fn, ms }),
  });
  const screen = () => mergeOutbox(timeline.messages, outbox.forChat("c1"));
  const submit = (text, clientId = `id-${text}`) => sender.submit({ chatId: "c1", clientId, text, typed: text, images: 0, intent: "send", payload: { text, images: [] } });
  return { outbox, server, sender, settled, posts, timers, screen, submit, timeline: () => timeline };
}

test("the owner's message shows at once as «در حال ارسال…» while the POST is on its way", async () => {
  const gate = deferred();
  const h = harness({ post: () => gate.promise });
  const sending = h.submit("سلام");
  const shown = h.screen();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].role, "user");
  assert.equal(shown[0].text, "سلام");
  assert.equal(shown[0].sendState, "sending");
  gate.resolve({ delivered: "run" });
  await sending;
  assert.equal(h.outbox.forChat("c1")[0].state, "sent");
  assert.equal(SENDING_LABEL, "در حال ارسال…");
  assert.ok(SENT_LABEL && FAILED_LABEL);
});

test("a message sent while the stream is dead shows on screen without a refresh", async () => {
  const h = harness();
  await h.submit("پیام در زمان قطعی");
  await tick();
  const shown = h.screen();
  assert.equal(shown.length, 1, "exactly one bubble: the server's copy replaced the pending one");
  assert.equal(shown[0].text, "پیام در زمان قطعی");
  assert.equal(shown[0].sendState, undefined, "it is the real message from the timeline now");
  assert.equal(shown[0].clientId, "id-پیام در زمان قطعی");
});

test("an echo that does not come back: the timeline is fetched again after a short wait", async () => {
  let fetched = 0;
  const outbox = createOutbox();
  const timers = [];
  const sender = createSender({
    outbox,
    post: async () => ({ delivered: "run" }),
    catchUp: async (_chatId, opts) => {
      fetched += 1;
      return opts;
    },
    settle: () => {},
    later: (fn, ms) => timers.push({ fn, ms }),
  });
  await sender.submit({ chatId: "c1", clientId: "x", text: "t", typed: "t", payload: { text: "t" }, intent: "send" });
  assert.equal(fetched, 1);
  assert.ok(timers.length === 1 && timers[0].ms <= 5000);
  timers[0].fn();
  assert.equal(fetched, 2, "still not landed: fetched again");
});

test("no message ever leaves the screen without its state: a network failure stays as a red bubble", async () => {
  const h = harness({ post: () => Promise.reject(netError()) });
  await h.submit("قطع شد");
  const shown = h.screen();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].sendState, "failed");
  assert.equal(h.settled.length, 0, "nothing settles: «ارسال دوباره» or «ویرایش» decides");
});

test("a server error (502/500) is retryable; a refusal (400) goes back to the box with its reason", async () => {
  assert.equal(retryableError(netError()), true);
  assert.equal(retryableError(httpError(502)), true);
  assert.equal(retryableError(httpError(500)), true);
  assert.equal(retryableError(httpError(400)), false);
  assert.equal(retryableError(httpError(409)), false);
  const h = harness({ post: () => Promise.reject(httpError(400)) });
  await h.submit("بلند");
  assert.equal(h.screen().length, 0, "the bubble goes only because the text is back in the box");
  assert.equal(h.settled[0].outcome, "refused");
  assert.equal(h.settled[0].error.status, 400);
});

test("«ارسال دوباره» resends with the same client id and never creates a duplicate", async () => {
  let fail = true;
  const h = harness({
    post: (entry, server) => {
      // The first try reached the server but its answer was lost (a 502 from the proxy).
      server.post(entry.chatId, { ...entry.payload, clientId: entry.clientId });
      if (fail) return Promise.reject(httpError(502));
      return server.post(entry.chatId, { ...entry.payload, clientId: entry.clientId });
    },
  });
  await h.submit("یک بار");
  assert.equal(h.screen()[0].sendState, "failed");
  fail = false;
  await h.sender.retry("id-یک بار");
  await tick();
  assert.equal(h.posts.length, 2);
  assert.equal(h.posts[0].clientId, h.posts[1].clientId);
  assert.equal(h.server.events.length, 1, "the server kept one copy");
  const shown = h.screen();
  assert.equal(shown.length, 1, "one bubble on screen");
  assert.equal(h.settled.at(-1).outcome, "sent");
});

test("a retry of a plain send goes as queue, so a chat that got busy meanwhile does not refuse it", async () => {
  let n = 0;
  const h = harness({ post: () => (n++ === 0 ? Promise.reject(netError()) : { delivered: "queued" }) });
  await h.submit("بعدی");
  await h.sender.retry("id-بعدی");
  assert.equal(h.posts[1].intent, "queue");
});

test("a failed message that reached the server arrives on reconnect: it settles as sent, once", async () => {
  const h = harness({
    post: (entry, server) => {
      server.post(entry.chatId, { ...entry.payload, clientId: entry.clientId });
      return Promise.reject(httpError(502));
    },
  });
  await h.submit("رسید");
  assert.equal(h.screen()[0].sendState, "failed");
  // The stream comes back and replays it.
  const timeline = h.server.events.reduce(applyEvent, emptyTimeline());
  h.sender.landed("c1", timeline.messages);
  h.sender.landed("c1", timeline.messages);
  assert.equal(mergeOutbox(timeline.messages, h.outbox.forChat("c1")).length, 1);
  assert.deepEqual(h.settled.map((s) => s.outcome), ["sent"], "settled once");
});

test("«ویرایش» on a failed bubble puts the text back in the box", async () => {
  const h = harness({ post: () => Promise.reject(netError()) });
  await h.submit("متن");
  h.sender.edit("id-متن");
  assert.equal(h.screen().length, 0);
  assert.equal(h.settled[0].outcome, "edited");
});

test("the timeline folds the client id onto the owner's message", () => {
  const timeline = applyEvent(emptyTimeline(), { id: 1, type: "user", data: { text: "x", clientId: "abc" }, at: "t" });
  assert.equal(timeline.messages[0].clientId, "abc");
});

test("the header never says a bare «قطع»: it says what happens and offers «تلاش دوباره»", () => {
  const down = connectionNotice("reconnecting");
  assert.equal(down.text, "اتصال لحظه‌ای قطع شد؛ دوباره وصل می‌شوم — پیام‌هایت محفوظ است");
  assert.equal(down.action, "تلاش دوباره");
  assert.equal(connectionNotice("restored").text, "وصل شد");
  assert.equal(connectionNotice("live"), null);
  assert.equal(connectionNotice("closed")?.text === "قطع", false);
});

test("the runtime sends through the outbox with a client id and fetches when the stream is down", () => {
  const source = fs.readFileSync(new URL("../src/runtime.jsx", import.meta.url), "utf8");
  assert.match(source, /createSender\(/);
  assert.match(source, /clientId/);
  assert.match(source, /catchUp: catchUpTimeline/);
  assert.match(source, /mergeOutbox\(/);
  assert.match(source, /sender\.landed\(chatId, timeline\.messages\)/, "a landed message settles (outbox.test covers what that does)");
});

test("a message on its way or not delivered counts as unsent (it holds a new version's reload off)", async () => {
  const gate = deferred();
  const h = harness({ post: () => gate.promise });
  assert.equal(h.outbox.unsent(), false);
  const sending = h.submit("x");
  assert.equal(h.outbox.unsent(), true);
  gate.reject(netError());
  await sending;
  assert.equal(h.outbox.unsent(), true, "a red message would be lost by a reload");
  h.sender.edit("id-x");
  assert.equal(h.outbox.unsent(), false);
  const source = fs.readFileSync(new URL("../src/runtime.jsx", import.meta.url), "utf8");
  assert.match(source, /outbox\.unsent\(\) && !releaseReload\) releaseReload = holdReload\(\)/);
});
