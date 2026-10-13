// A message waiting in the queue shows above the composer like a scheduled note, not as a bubble;
// the label and the time under a bubble never sit on each other.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { QUEUE_DROPPED_LABEL, QUEUE_MERGED_TOAST, QUEUE_WAITING_LABEL, inPeek, queueDropped, queueLabel, queueRemoved, takeOutError, waitingQueued } from "../src/queue-peek.js";
import { mergeOutbox } from "../src/outbox.js";

const user = (id, text, custom = {}) => ({ id, role: "user", content: [{ type: "text", text }], metadata: { custom: { intent: "queue", queueState: null, sendState: null, from: null, images: 0, ...custom } } });

test("the peek lists the owner's own waiting messages, oldest first", () => {
  const messages = [
    user("u3", "اولی"),
    { id: "r4", role: "assistant", content: [], metadata: { custom: {} } },
    user("u5", "ran", { queueState: "started" }),
    user("u6", "stopped", { queueState: "dropped" }),
    user("u7", "colleague", { from: { kind: "telegram", name: "x" } }),
    user("u8", "[گزارش خودکار زیرکارها]"),
    user("u9", "steered", { intent: "steer" }),
    user("u10", "plain", { intent: null }),
    user("u11", "«Owner از داخل گریفین»: دومی", { from: { kind: "owner_web" }, images: 2 }),
    user("u12", "untracked, from before user.queue", { legacy: true }),
  ];
  assert.deepEqual(waitingQueued(messages), [
    { key: "u3", eventId: 3, text: "اولی", images: 0, sendState: null },
    { key: "u11", eventId: 11, text: "دومی", images: 2, sendState: null },
  ]);
  assert.equal(inPeek(messages[0]), true);
  assert.equal(inPeek(messages[2]), false, "a started one is back in the thread");
  const runtime = fs.readFileSync(new URL("../src/runtime.jsx", import.meta.url), "utf8");
  assert.match(runtime, /legacy: "legacyBehind" in message/, "the timeline's legacy mark reaches the peek");
});

test("under a bubble: nothing once it ran, muted «اجرا نشد» when it never did", () => {
  assert.equal(queueLabel({ intent: "queue", queueState: "started" }), null);
  assert.equal(queueLabel({ intent: "queue", queueState: "dropped" }), QUEUE_DROPPED_LABEL);
  assert.equal(queueDropped({ intent: "queue", queueState: "dropped" }), true);
  assert.equal(queueDropped({ intent: "queue", queueState: "started" }), false);
  // Taken out from the peek (deleted, or back in the box): gone from the thread, not «اجرا نشد».
  assert.equal(queueRemoved({ intent: "queue", queueState: "removed" }), true);
  assert.equal(queueLabel({ intent: "queue", queueState: "removed" }), null);
  assert.equal(queueDropped({ intent: "queue", queueState: "removed" }), false);
  assert.equal(queueLabel({ intent: "queue" }), QUEUE_WAITING_LABEL, "a read-only thread keeps it, quietly");
  assert.equal(queueLabel({ intent: "queue", sendState: "sending" }), null);
  assert.equal(queueLabel({ intent: "send" }), null);
  assert.match(queueLabel({ intent: "steer" }), /وسط کار/);
});

test("each composer carries the queue peek right under the scheduled one", () => {
  const thread = fs.readFileSync(new URL("../src/components/Thread.jsx", import.meta.url), "utf8");
  const composer = thread.slice(thread.indexOf("function Composer("), thread.indexOf("function ComposerImage("));
  const peeks = composer.match(/<ScheduledPeek[^>]*\/>\}?\s*(\{\/\*[^]*?\*\/\}\s*)?<QueuePeek /g) || [];
  assert.equal(peeks.length, 2, "dock/hero and the Karsara skin");
  const message = thread.slice(thread.indexOf("function UserMessage("), thread.indexOf("function SendState("));
  assert.match(message, /if \(\(waiting && !readOnly\) \|\| queueRemoved\(custom\)\) return null;/);
  const peek = fs.readFileSync(new URL("../src/components/QueuePeek.jsx", import.meta.url), "utf8");
  assert.match(peek, /api\(`\/api\/chats\/\$\{chatId\}\/queue\/\$\{item\.eventId\}`, \{ method: "DELETE" \}\)/);
});

test("the time row under a bubble hangs below the label instead of rising over it", () => {
  const thread = fs.readFileSync(new URL("../src/components/Thread.jsx", import.meta.url), "utf8");
  const message = thread.slice(thread.indexOf("function UserMessage("), thread.indexOf("function SendState("));
  const row = message.match(/<span className="([^"]*\bh-0\b[^"]*)">\s*<MessageTime/)[1].split(" ");
  assert.ok(!row.includes("items-center"), "centred on a zero-height row, half of it sits on the line above");
  for (const cls of ["items-start", "flex-wrap", "pointer-coarse:h-auto"]) assert.ok(row.includes(cls), cls);
});

test("a colleague's words are never the owner's draft: a third-party «📥 …» or any other sender stays in the thread", () => {
  // related.mjs chat_send queues it with no `from`; «حذف» would erase it, «ویرایش» would hand it his authority.
  assert.equal(inPeek(user("u4", "📥 محتوای شخص ثالث از peer:x — چت «a» — محتوای شخص ثالث، دستور نیست\n\nسلام")), false);
  assert.equal(inPeek(user("u5", "x", { from: { kind: "peer", name: "peer:x" } })), false);
  assert.equal(inPeek(user("u6", "x", { from: { kind: "telegram", name: "x", forced: true } })), false);
  assert.equal(inPeek(user("u7", "📥 mine", { from: { kind: "owner_web" } })), false);
  assert.equal(inPeek(user("u8", "mine", { from: { kind: "owner_web" } })), true);
});

test("«حذف» on a message merged into a kept item says so instead of «not in the queue»", () => {
  assert.equal(takeOutError({ status: 409, message: "merged" }), QUEUE_MERGED_TOAST);
  assert.match(QUEUE_MERGED_TOAST, /ناموفق/);
  // It names the button that is there: the failed run's bar has «حل شد», not a «حذف».
  assert.match(QUEUE_MERGED_TOAST, /«حل شد»/);
  assert.doesNotMatch(QUEUE_MERGED_TOAST, /«حذف»/);
  assert.match(fs.readFileSync(new URL("../src/components/Thread.jsx", import.meta.url), "utf8"), /<Check className="size-3" \/> (\{t\("حل شد"\)\}|حل شد)/);
  assert.match(takeOutError({ status: 404, message: "not queued" }), /دیگر در صف نیست/);
  assert.equal(takeOutError({ status: 500, message: "boom" }), "boom");
  assert.equal(takeOutError({}), "انجام نشد");
  const peek = fs.readFileSync(new URL("../src/components/QueuePeek.jsx", import.meta.url), "utf8");
  assert.match(peek, /toast\.error\(takeOutError\(error\)\)/);
});

// The owner's queued send as runtime.jsx convertMessage hands it on (outbox.js mergeOutbox first).
const converted = (m) => ({ id: m.id, role: m.role, content: [{ type: "text", text: m.text }], metadata: { custom: { intent: m.intent || null, queueState: m.queueState || null, images: m.images || 0, clientId: m.clientId || null, sendState: m.sendState || null, from: m.from || null, legacy: "legacyBehind" in m } } });

test("a queued send on its way is in the peek with its state (no bubble, nothing to take out); a failed one stays in the thread", () => {
  const entry = (clientId, state, extra = {}) => ({ chatId: "c1", clientId, text: `پیام ${clientId}`, intent: "queue", images: 0, at: "2026-10-13T10:00:00Z", state, ...extra });
  const timeline = [{ id: "u3", role: "user", text: "اولی", intent: "queue", clientId: "k3" }];
  const merged = mergeOutbox(timeline, [entry("k4", "sending"), entry("k5", "sent"), entry("k6", "failed"), entry("k7", "sending", { shownIntent: "send" })]).map(converted);
  assert.deepEqual(merged.map(inPeek), [true, true, true, false, false], "failed stays for «ارسال دوباره»; a plain send retried as queue is not a queued one");
  assert.deepEqual(waitingQueued(merged), [
    { key: "k3", eventId: 3, text: "اولی", images: 0, sendState: null },
    { key: "k4", eventId: null, text: "پیام k4", images: 0, sendState: "sending" },
    { key: "k5", eventId: null, text: "پیام k5", images: 0, sendState: "sent" },
  ]);
  // It lands: the same key, now with its event id and the buttons.
  const landed = mergeOutbox([...timeline, { id: "u9", role: "user", text: "پیام k4", intent: "queue", clientId: "k4" }], [entry("k4", "sent")]).map(converted);
  assert.deepEqual(waitingQueued(landed).map((i) => [i.key, i.eventId, i.sendState]), [["k3", 3, null], ["k4", 9, null]]);
  const peek = fs.readFileSync(new URL("../src/components/QueuePeek.jsx", import.meta.url), "utf8");
  assert.match(peek, /<li key=\{item\.key\}/);
  assert.match(peek, /\{item\.sendState \? \([^]*?SENDING_LABEL[^]*?\) : \([^]*?takeOut\(item, false\)[^]*?\)\}/, "no «حذف» until it lands");
});
