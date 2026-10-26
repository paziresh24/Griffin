// Plan limit with PLAN_FALLBACK=ask (port of Karsara !75/!76): the owner is asked on a card before
// the chat moves to another engine; the card survives a restart, a stale one is refused, what the
// stopped run did is listed, the answer is labelled, and switching back resumes the old session.
// Also: a 429, an overload or an unknown model is not a plan limit (both modes).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";
import { CONFIG_SCHEMA } from "../src/config.mjs";
import { foldEvents } from "../../../packages/timeline/src/index.mjs";
import { buildEnvelope } from "../src/peers.mjs";
import {
  autoMovesOn,
  claudeLimitCode,
  doneTools,
  FALLBACK_KEY,
  fallbackQuestion,
  goLabel,
  isClaudePlanLimit,
  MAX_LISTED_TOOLS,
  pickAccountHop,
  pickFallback,
  pickRoute,
  planFallbackMode,
  waitLabel,
} from "../src/plan-fallback.mjs";

const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout");
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-planfb-"));
  const file = path.join(dir, "db.sqlite");
  const store = openStore(file);
  return { store, file, dir, done: () => (store.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

// A fake engine: each send runs script(n, options, message); sends keep the message and the agent.
function fakeSdk(script) {
  const sends = [];
  let made = 0;
  const agent = (agentId) => ({
    agentId,
    async send(message, options) {
      const text = typeof message === "string" ? message : message.text;
      sends.push({ message: text, options, agentId });
      const n = sends.length;
      return { id: `r${n}`, supports: () => true, async cancel() {}, wait: async () => script(n, options, text) };
    },
  });
  return { sends, sdk: { kind: "claude", create: async () => agent(`fresh-${++made}`), resume: async (id) => agent(id) } };
}

const limitHit = () => ({ status: "error", error: { message: "You've hit your limit", code: "plan_limit", resetsAt: Date.now() + 60 * 60_000 } });
const runsDone = (store, chatId, n) => store.eventsAfter(chatId).filter((e) => e.type === "run.finished").length === n;
const events = (store, chatId, type) => store.eventsAfter(chatId).filter((e) => e.type === type);
const tool = (callId, name, args) => [
  { type: "tool-call-started", callId, toolCall: { type: name, args } },
  { type: "tool-call-completed", callId, toolCall: { type: name, args, result: { status: "success", value: "ok" } } },
];

// The chat routes by its pinned model ("zai:glm-5.3") or Claude; zai is the fallback.
function routing(store) {
  const label = (chat) => {
    const pinned = typeof chat?.model === "string" && chat.model.includes(":") ? chat.model.split(":") : null;
    return pinned ? { provider: pinned[0], model: pinned[1] } : { provider: "claude", model: "opus" };
  };
  return {
    runLabel: label,
    askFallback: (chat) => (chat.caller || "owner") === "owner",
    fallbackFor: (chat) => (label(chat).provider === "claude" ? { provider: "zai", model: "glm-5.3", name: "glm-5.3", fromName: "Claude" } : { provider: "claude", model: "opus", name: "opus", fromName: "zai" }),
  };
}

test("PLAN_FALLBACK is a setting, auto by default", () => {
  assert.equal(planFallbackMode(undefined), "auto");
  assert.equal(planFallbackMode("ask"), "ask");
  assert.equal(planFallbackMode("anything"), "auto");
  assert.deepEqual(CONFIG_SCHEMA.find((c) => c.key === "PLAN_FALLBACK")?.options, ["ask", "auto"]);
});

test("ask mode: a plan limit asks on a card instead of moving; nothing reruns without a yes", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk(async (n, options) => {
    if (n === 1) {
      for (const u of [...tool("c1", "Read", { file_path: "/a" }), ...tool("c2", "Bash", { command: "git push" })]) await options.onDelta({ update: u });
      return limitHit();
    }
    return { status: "finished" };
  });
  let marked = 0;
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: () => (marked += 1, true), ...routing(store) });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "کار را تمام کن" });
    await until(() => runsDone(store, chat.id, 1));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(marked, 1, "the account is still marked limited");
    assert.equal(sends.length, 1, "no silent rerun on another engine");
    const card = events(store, chat.id, "tool.started").find((e) => e.data.args?.kind === "plan-fallback");
    assert.ok(card, "a question card");
    assert.match(card.data.args.question, /^سقف پلن Claude پر شده\. اجرای قبلی ۲ کار انجام داده بود\. با glm-5\.3 ادامه بدهم؟ \(این مدل تاریخچهٔ این گفتگو را نمی‌بیند\) یا تا ساعت .+ صبر کنم؟$/);
    assert.deepEqual(card.data.args.options.map((o) => o.label), [goLabel({ name: "glm-5.3" }), waitLabel]);
    // Outward and write actions first.
    assert.match(card.data.args.done[0], /^Bash /);
    assert.equal(runner.openFallbackCard(chat.id), card.data.args.askId);
    // «صبر کن»: nothing moves.
    assert.equal(runner.answerFallback(chat.id, card.data.args.askId, [waitLabel]), true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sends.length, 1);
    assert.equal(store.getChat(chat.id).model ?? null, null);
    assert.equal(runner.openFallbackCard(chat.id), null);
  } finally {
    done();
  }
});

test("yes: the chat moves, the message reruns with what was done, and the answer is labelled", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk(async (n, options) => {
    if (n === 1) {
      for (const u of tool("c1", "Edit", { file_path: "/x", old_string: "a", new_string: "b" })) await options.onDelta({ update: u });
      return limitHit();
    }
    return { status: "finished" };
  });
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: () => true, ...routing(store) });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "پیام اصلی" });
    await until(() => runsDone(store, chat.id, 1));
    const firstSession = store.getChat(chat.id).agent_id;
    assert.ok(firstSession);
    const askId = runner.openFallbackCard(chat.id);
    assert.equal(runner.answerFallback(chat.id, askId, [goLabel({ name: "glm-5.3" })]), true);
    await until(() => runsDone(store, chat.id, 2));
    assert.equal(store.getChat(chat.id).model, "zai:glm-5.3", "pinned to the engine the owner chose");
    assert.match(sends[1].message, /مالک گفت با glm-5\.3 ادامه بدهیم/);
    assert.match(sends[1].message, /- Edit /);
    assert.match(sends[1].message, /پیام اصلی$/);
    const started = events(store, chat.id, "run.started");
    assert.deepEqual(started[1].data.movedFrom, { from: "Claude" });
    const timeline = foldEvents(store.eventsAfter(chat.id)).messages;
    const answer = timeline.filter((m) => m.role === "assistant").at(-1);
    assert.deepEqual(answer.fallback, { from: "Claude" }, "the timeline carries the label");
    const { fallbackLabel } = await import("../../web/src/fallback.js");
    assert.equal(fallbackLabel({ ...answer, model: "glm-5.3" }), "پاسخ از glm-5.3 (سقف پلن Claude پر بود)");
    // A second answer on the fallback engine still carries the label.
    await runner.send(chat.id, { text: "بعدی" });
    await until(() => runsDone(store, chat.id, 3));
    assert.deepEqual(events(store, chat.id, "run.started")[2].data.movedFrom, { from: "Claude" });

    // Switching back in the picker: the first session resumes, the label stops.
    store.updateChat(chat.id, { model: null, provider: "claude" });
    await runner.send(chat.id, { text: "برگشتم" });
    await until(() => runsDone(store, chat.id, 4));
    assert.equal(sends[3].agentId, firstSession, "the old Claude session resumes");
    assert.equal(events(store, chat.id, "run.started")[3].data.movedFrom, undefined);
    assert.equal(store.getKv(FALLBACK_KEY(chat.id)) ?? null, null);
  } finally {
    done();
  }
});

test("the card survives a restart; a stale or withdrawn card is refused", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk((n) => (n === 1 ? limitHit() : { status: "finished" }));
  const opts = { store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: () => true, ...routing(store) };
  try {
    const chat = store.createChat({ title: "t" });
    let runner = createRunner(opts);
    await runner.send(chat.id, { text: "اول" });
    await until(() => runsDone(store, chat.id, 1));
    const askId = runner.openFallbackCard(chat.id);
    assert.ok(askId);
    assert.equal(runner.answerFallback(chat.id, "deadbeef", [goLabel({ name: "glm-5.3" })]), false, "another card's id is refused");

    // Restart: a new runner on the same store still holds the card, and a yes reruns the text.
    runner = createRunner(opts);
    assert.equal(runner.openFallbackCard(chat.id), askId);
    assert.equal(runner.answerFallback(chat.id, askId, [goLabel({ name: "glm-5.3" })]), true);
    await until(() => runsDone(store, chat.id, 2));
    assert.match(sends[1].message, /اول$/);
    assert.equal(runner.answerFallback(chat.id, askId, [goLabel({ name: "glm-5.3" })]), false, "an answered card is refused");

    // A new message withdraws an open card: closed as withdrawn, and its id is refused.
    store.updateChat(chat.id, { model: null, provider: "claude" });
    const other = store.createChat({ title: "u" });
    const { sdk: sdk2, sends: sends2 } = fakeSdk((n) => (n === 1 ? limitHit() : { status: "finished" }));
    const r2 = createRunner({ ...opts, sdk: sdk2 });
    await r2.send(other.id, { text: "x" });
    await until(() => runsDone(store, other.id, 1));
    const stale = r2.openFallbackCard(other.id);
    await r2.send(other.id, { text: "پیام تازه" });
    // The stopped message (nothing reached the owner) is kept and goes first, then the new one.
    await until(() => runsDone(store, other.id, 3));
    const closed = events(store, other.id, "tool.done").find((e) => e.data.args?.askId === stale);
    assert.equal(closed?.data.result?.reason, "withdrawn");
    assert.equal(r2.answerFallback(other.id, stale, [goLabel({ name: "glm-5.3" })]), false);
    assert.equal(sends2.length, 3);
  } finally {
    done();
  }
});

test("default (auto): no card, the run moves by itself as before", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk((n) => (n === 1 ? limitHit() : { status: "finished" }));
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: () => true });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "x" });
    await until(() => runsDone(store, chat.id, 2));
    assert.equal(sends.length, 2);
    assert.equal(events(store, chat.id, "tool.started").length, 0);
    assert.equal(events(store, chat.id, "run.started")[1].data.fallback, true);
  } finally {
    done();
  }
});

test("what was done: every call counted, at most 30 listed, actions before looks, «و N کار دیگر»", () => {
  const evs = [];
  for (let i = 0; i < 20; i += 1) evs.push({ type: "tool.done", data: { callId: `r${i}`, name: "Read", args: { file_path: `/f${i}` } } });
  for (let i = 0; i < 15; i += 1) evs.push({ type: "tool.done", data: { callId: `w${i}`, name: i % 2 ? "Write" : "mcp:telegram_send", args: { text: "x".repeat(5000) } } });
  evs.push({ type: "tool.done", data: { callId: "q", name: "ask_owner", args: {} } });
  const done = doneTools({ runEvents: () => evs }, "run");
  assert.equal(done.count, 35);
  assert.equal(done.list.length, MAX_LISTED_TOOLS);
  assert.equal(done.more, 5);
  assert.ok(done.list.slice(0, 15).every((t) => t.name !== "Read"), "outward and write actions first");
  assert.ok(done.list.every((t) => t.args.length <= 121));
  const q = fallbackQuestion({ name: "glm", fromName: "Claude" }, null, Date.now(), done.count);
  assert.match(q.question, /اجرای قبلی ۳۵ کار انجام داده بود/);
  assert.match(q.question, /یا تا باز شدن سقف صبر کنم؟$/);
});

test("ask routing never skips a limited account; auto routing does", () => {
  const list = [{ provider: "claude" }, { provider: "zai" }];
  const limited = new Set(["claude"]);
  const usable = (id) => !limited.has(id);
  const enabled = () => true;
  assert.equal(pickRoute(list, { usable, enabled }).provider, "zai");
  assert.equal(pickRoute(list, { usable, enabled, ask: true }).provider, "claude");
  const to = pickFallback([{ provider: "claude", model: "opus" }, { provider: "claude-2", model: "opus" }], { provider: "claude", model: "opus" }, { usable, nameOf: (id) => (id === "claude" ? "Claude" : "حساب دوم"), kindOf: (id) => id.split("-")[0] });
  assert.deepEqual(to, { provider: "claude-2", model: "opus", name: "opus (حساب دوم)", fromName: "Claude" });
});

test("a 429, an overload or an unknown model is not a plan limit", () => {
  assert.equal(isClaudePlanLimit("You've hit your limit · resets 5pm"), true);
  assert.equal(isClaudePlanLimit("Claude AI usage limit reached|1760000000"), true);
  for (const text of ["API Error: 429 rate limit", "Overloaded", "API Error: 529 overloaded_error", "There's an issue with the selected model (opus-9). It may not exist", "unknown model", "model not found", "No conversation found"]) {
    assert.equal(isClaudePlanLimit(text), false, text);
  }
});

test("review: a typed answer leaves the card open; a message queued behind the stopped one still goes after a yes", async () => {
  const { store, done } = setup();
  let release;
  const gate = new Promise((r) => (release = r));
  const { sdk, sends } = fakeSdk(async (n) => {
    if (n === 1) await gate;
    return n <= 2 ? limitHit() : { status: "finished" };
  });
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: () => true, ...routing(store) });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "الف" });
    await until(() => sends.length === 1);
    await runner.send(chat.id, { text: "ب", intent: "queue" });
    release();
    await until(() => runner.openFallbackCard(chat.id), 3000);
    const askId = runner.openFallbackCard(chat.id);
    assert.equal(runner.answerFallback(chat.id, askId, ["یک چیز دیگر"]), false, "not an option: refused, card stays open");
    assert.equal(runner.openFallbackCard(chat.id), askId);
    assert.equal(runner.answerFallback(chat.id, askId, [goLabel({ name: "glm-5.3" })]), true);
    await until(() => sends.length === 4 && runsDone(store, chat.id, 4), 3000);
    assert.match(sends[2].message, /الف$/);
    assert.match(sends[3].message, /ب$/, "the queued message follows the delivered rerun");
    assert.ok(!/مالک گفت/.test(sends[3].message));
  } finally {
    done();
  }
});

test("review: Claude's other spent-plan wordings still count", () => {
  for (const text of ["5-hour limit reached ∙ resets 3pm", "Weekly limit reached", "You've hit your session limit", "Opus limit reached"]) assert.equal(isClaudePlanLimit(text), true, text);
});

test("same model on the owner's other account: no card, the run moves by itself and the answer names the account", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk((n) => (n === 1 ? limitHit() : { status: "finished" }));
  let limited = false;
  const runner = createRunner({
    store, sdk, agentOptions: () => ({}), log: {},
    onPlanLimit: () => ((limited = true), true),
    ...routing(store),
    accountHop: () => (limited ? { from: "Claude", account: "دوم" } : null),
  });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "x" });
    await until(() => runsDone(store, chat.id, 2));
    assert.equal(sends.length, 2, "moved without asking");
    assert.equal(runner.openFallbackCard(chat.id), null);
    assert.equal(events(store, chat.id, "tool.started").length, 0, "no card");
    const started = events(store, chat.id, "run.started")[1].data;
    assert.deepEqual(started.movedFrom, { from: "Claude", account: "دوم" });
    const answer = foldEvents(store.eventsAfter(chat.id)).messages.filter((m) => m.role === "assistant").at(-1);
    const { fallbackLabel } = await import("../../web/src/fallback.js");
    assert.equal(fallbackLabel({ ...answer, model: "opus" }), "پاسخ از opus، حساب دوم (سقف پلن Claude پر بود)");
  } finally {
    done();
  }
});

test("ask routing takes the same model on another account; a different model still waits for the card", () => {
  const kindOf = (id) => id.split("-")[0];
  const limited = new Set(["claude"]);
  const usable = (id) => !limited.has(id);
  const enabled = () => true;
  const nameOf = (id) => ({ claude: "Claude", "claude-2": "دوم" })[id] || id;
  const same = [{ provider: "claude", model: "opus" }, { provider: "zai", model: "glm" }, { provider: "claude-2", model: "opus" }];
  assert.equal(pickRoute(same, { usable, enabled, ask: true, kindOf }).provider, "claude-2");
  assert.deepEqual(pickAccountHop(same, { provider: "claude-2" }, { usable, enabled, nameOf, kindOf }), { provider: "claude-2", from: "Claude", account: "دوم" });
  const other = [{ provider: "claude", model: "opus" }, { provider: "zai", model: "glm" }, { provider: "claude-2", model: "sonnet" }];
  assert.equal(pickRoute(other, { usable, enabled, ask: true, kindOf }).provider, "claude", "a different model is a switch: no silent move");
  assert.equal(pickAccountHop(other, { provider: "claude" }, { usable, enabled, nameOf, kindOf }), null);
  limited.clear();
  assert.equal(pickAccountHop(same, { provider: "claude" }, { usable, enabled, nameOf, kindOf }), null, "own account back: no label");
});

test("archived by any path (the idle sweep, Telegram): the open card closes at once", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk((n) => (n === 1 ? limitHit() : { status: "finished" }));
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: () => true, ...routing(store) });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "x" });
    await until(() => runsDone(store, chat.id, 1));
    const askId = runner.openFallbackCard(chat.id);
    assert.ok(askId);
    store.updateChat(chat.id, { archived: true }); // what idle-archive.mjs and mother/manager do
    assert.equal(runner.openFallbackCard(chat.id), null);
    const closed = events(store, chat.id, "tool.done").find((e) => e.data.args?.askId === askId);
    assert.equal(closed?.data.result?.reason, "withdrawn");
    assert.equal(runner.answerFallback(chat.id, askId, [goLabel({ name: "glm-5.3" })]), false);
    assert.equal(sends.length, 1);
  } finally {
    done();
  }
});

// ---- re-review of 9f83385 ----

test("auto keeps 8d4b48b exactly; ask gives 429/overload/unknown model their own code", () => {
  const spent = ["You've hit your limit · resets 5pm", "Claude AI usage limit reached|1760000000", "5-hour limit reached ∙ resets 1pm", "Opus weekly limit reached", "You're out of extra usage · resets 5pm", "You've hit your weekly limit", "You've reached your Fable limit", "Fable limit reached", "You've hit your monthly spend limit", "Your org is out of usage · add funds to continue", "You're out of usage credits. /model to switch models."];
  for (const t of spent) assert.equal(claudeLimitCode(t), "plan_limit", t);
  // What auto mode moved on before (8d4b48b) still moves it, under its own code.
  for (const t of ["API Error: 529 Overloaded", "API Error: 429 rate_limit_error", "Unknown Model, please check the model code", "model not found", "Context limit reached", "Server is temporarily limiting requests (not your usage limit)"]) {
    assert.equal(claudeLimitCode(t), "engine_unavailable", t);
  }
  assert.equal(claudeLimitCode("You've hit your fast limit"), null, "fast mode is not a plan");
  assert.equal(claudeLimitCode("No conversation found"), null);
  assert.equal(claudeLimitCode("anything", { status: "rejected" }), "plan_limit", "a rejected rate_limit_event");
});

const unavailable = () => ({ status: "error", error: { message: "API Error: 429 rate_limit_error", code: "engine_unavailable" } });

test("auto mode moves on engine_unavailable exactly as it did on the old plan_limit", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk((n) => (n === 1 ? unavailable() : { status: "finished" }));
  let marked = 0;
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: () => ((marked += 1), true) });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "x" });
    await until(() => runsDone(store, chat.id, 2));
    assert.equal(marked, 1);
    assert.equal(sends.length, 2);
    assert.equal(events(store, chat.id, "run.started")[1].data.fallback, true);
  } finally {
    done();
  }
});

test("ask mode: a 429 is an ordinary error — no card, no switch, the message is kept", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk(() => unavailable());
  let marked = 0;
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: () => ((marked += 1), true), ...routing(store) });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "x" });
    await until(() => runsDone(store, chat.id, 1));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sends.length, 1, "no switch");
    assert.equal(marked, 0, "the account is not marked limited");
    assert.equal(runner.openFallbackCard(chat.id), null, "no card");
    assert.equal(events(store, chat.id, "run.finished")[0].data.undelivered, true, "kept like any error");
  } finally {
    done();
  }
});

function hopRunner(store, script, { keepNoSession = false } = {}) {
  let limited = false;
  const { sdk, sends } = fakeSdk(async (n, options) => {
    const out = await script(n, options);
    if (out?.error?.code === "plan_limit") limited = true;
    return out;
  });
  const runner = createRunner({
    store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: () => true,
    runLabel: () => ({ provider: limited ? "claude-2" : "claude", model: "opus" }),
    askFallback: () => true, fallbackFor: () => null,
    accountHop: () => (limited ? { from: "Claude", account: "دوم" } : null),
  });
  return { runner, sends };
}

test("same-model account move keeps the session (one config folder, only the token differs)", async () => {
  const { store, done } = setup();
  const { runner, sends } = hopRunner(store, async (n, options) => {
    if (n === 2) {
      for (const u of tool("c1", "mcp:telegram_send", { text: "hi colleague" })) await options.onDelta({ update: u });
      return limitHit();
    }
    return { status: "finished" };
  });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "first message with context" });
    await until(() => runsDone(store, chat.id, 1));
    await runner.send(chat.id, { text: "ok do it" });
    await until(() => runsDone(store, chat.id, 3));
    assert.equal(sends[1].agentId, sends[0].agentId);
    assert.equal(sends[2].agentId, sends[1].agentId, "the hop resumes the same session");
    assert.equal(sends[2].message, "ok do it", "the session has the history: no lead note needed");
    assert.deepEqual(events(store, chat.id, "run.started")[2].data.movedFrom, { from: "Claude", account: "دوم" });
  } finally {
    done();
  }
});

test("same-model account move without a session to keep: the rerun gets the note and the done list", async () => {
  const { store, done } = setup();
  let chatId;
  const { runner, sends } = hopRunner(store, async (n, options) => {
    if (n === 1) {
      for (const u of tool("c1", "mcp:telegram_send", { text: "hi" })) await options.onDelta({ update: u });
      store.setAgentId(chatId, null); // the session is gone
      return limitHit();
    }
    return { status: "finished" };
  });
  try {
    const chat = store.createChat({ title: "t" });
    chatId = chat.id;
    await runner.send(chat.id, { text: "اصلی" });
    await until(() => runsDone(store, chat.id, 2));
    assert.match(sends[1].message, /سقف پلن حساب Claude پر شد و همین مدل روی حساب دوم ادامه می‌دهد/);
    assert.ok(!/مالک گفت/.test(sends[1].message), "the owner was not asked");
    assert.match(sends[1].message, /- mcp:telegram_send /);
    assert.match(sends[1].message, /اصلی$/);
  } finally {
    done();
  }
});

test("the silent account move is for Claude accounts with an explicit, identical model only", () => {
  const kindOf = (id) => (id.startsWith("claude") ? "claude" : "openai");
  const enabled = () => true;
  const vendors = [{ provider: "openai", model: "glm-4.6" }, { provider: "claude", model: "opus" }, { provider: "openai-2", model: "glm-4.6" }];
  assert.equal(pickRoute(vendors, { usable: (id) => id !== "openai", enabled, ask: true, kindOf }).provider, "openai", "two OpenAI-kind accounts: card");
  assert.equal(pickAccountHop(vendors, { provider: "openai-2" }, { usable: (id) => id !== "openai", enabled, nameOf: (x) => x, kindOf }), null);
  const auto = [{ provider: "claude", model: "auto" }, { provider: "claude-2", model: "auto" }];
  assert.equal(pickRoute(auto, { usable: (id) => id !== "claude", enabled, ask: true, kindOf }).provider, "claude", "«auto» names no model: card");
});

test("an account move after a yes keeps the way back", async () => {
  const { store, done } = setup();
  const { runner } = hopRunner(store, (n) => (n === 1 ? limitHit() : { status: "finished" }));
  try {
    const chat = store.createChat({ title: "t" });
    store.setKv(FALLBACK_KEY(chat.id), { provider: "claude", model: "opus", from: "zai", fromProvider: "zai", fromAgentId: "z-session" });
    await runner.send(chat.id, { text: "x" });
    await until(() => runsDone(store, chat.id, 2));
    assert.equal(store.getKv(FALLBACK_KEY(chat.id))?.fromAgentId, "z-session", "the original session is still the way back");
  } finally {
    done();
  }
});

test("a yes during a graceful stop waits for the next boot; a yes keeps the kept FIFO order", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk(async (n, options) => {
    if (n === 1 || n === 4) {
      for (const u of tool(`c${n}`, "Bash", { command: "ls" })) await options.onDelta({ update: u });
      return limitHit();
    }
    return { status: "finished" };
  });
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: () => true, ...routing(store) });
  try {
    // Order: an older kept message runs before the rerun.
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "الف" });
    await until(() => runsDone(store, chat.id, 1));
    store.setKv(`kept:${chat.id}`, [{ id: "kold", message: "قدیمی", fails: 0 }]);
    assert.equal(runner.answerFallback(chat.id, runner.openFallbackCard(chat.id), [goLabel({ name: "glm-5.3" })]), true);
    await until(() => runsDone(store, chat.id, 3));
    assert.match(sends[1].message, /^\(سیستم\) سقف پلن Claude پر شد و مالک گفت با glm-5\.3 ادامه بدهیم/, "the first message on the new engine gets the note");
    assert.match(sends[1].message, /قدیمی$/, "the older kept message first");
    assert.equal(sends[2].message, "الف", "then the rerun, in the same new session (one note)");

    // Graceful stop: nothing starts, the rerun waits for the boot.
    const other = store.createChat({ title: "u" });
    await runner.send(other.id, { text: "ب" });
    await until(() => runsDone(store, other.id, 1));
    const askId = runner.openFallbackCard(other.id);
    await runner.shutdown({ timeoutMs: 100 });
    const before = sends.length;
    assert.equal(runner.answerFallback(other.id, askId, [goLabel({ name: "glm-5.3" })]), true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sends.length, before, "nothing runs while stopping");
    assert.match(String(store.getKv(`runq:${other.id}`)?.queue?.[0]?.message), /ب$/);
    assert.ok((store.getKv("resume:pending") || []).some((i) => i.chatId === other.id));
  } finally {
    done();
  }
});

test("a delegated subtask that moved after a plan limit says which model answered", () => {
  const evs = [
    { type: "run.started", data: { model: "glm-5.3", provider: "zai", fallback: true, limitMove: true } },
    { type: "text", data: { text: "نتیجهٔ زیرکار به اندازهٔ کافی بلند که خلاصه شود و برگردد." } },
  ];
  const env = buildEnvelope({ allEvents: () => evs }, "c", { status: "finished" });
  assert.deepEqual(env.answeredBy, { model: "glm-5.3", provider: "zai", movedAfterLimit: true });
  assert.equal(env.modelLabel, "پاسخ از glm-5.3 (موتور قبلی به سقف پلن خورد)");
  const plain = buildEnvelope({ allEvents: () => [{ type: "run.started", data: { model: "opus" } }] }, "c", { status: "finished" });
  assert.equal(plain.modelLabel, undefined);
  const lostSession = buildEnvelope({ allEvents: () => [{ type: "run.started", data: { model: "opus", fallback: true } }] }, "c", { status: "finished" });
  assert.equal(lostSession.modelLabel, undefined, "a lost-session retry is not a limit move");
});

test("review: curly apostrophes and bare wording still count; «reached your conversation length» does not; auto moves exactly as before", () => {
  for (const t of ["You’ve hit your limit · resets 3pm", "You have hit your limit", "hit your limit", "You’re out of extra usage"]) assert.equal(claudeLimitCode(t), "plan_limit", t);
  assert.equal(claudeLimitCode("You've reached your conversation length"), null);
  // Auto mode: the old match, no more and no less.
  const OLD = /usage limit|rate limit|limit reached|hit your limit|unknown model|model code|not[_ ]?found|overloaded|\b429\b/i;
  for (const t of ["You're out of extra usage", "Your org is out of usage", "You've hit your weekly limit", "API Error: 429", "Unknown Model", "Fable limit reached", "You've reached your conversation length", "No conversation found"]) {
    assert.equal(autoMovesOn(t), OLD.test(t), t);
  }
  assert.equal(autoMovesOn("x", { status: "rejected" }), true);
});

test("auto mode: a spent-plan text the old match missed stays an ordinary error (no move)", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk((n) => (n === 1 ? { status: "error", error: { message: "You're out of extra usage", code: "plan_limit", autoFallback: false } } : { status: "finished" }));
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: () => true });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "x" });
    await until(() => runsDone(store, chat.id, 1));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sends.length, 1);
  } finally {
    done();
  }
});

test("the kept copy holds no stale lead note: «ارسال دوباره» after switching back sends the owner's text", async () => {
  const { store, done } = setup();
  const { sdk, sends } = fakeSdk((n) => (n <= 2 ? limitHit() : { status: "finished" }));
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: () => true, ...routing(store) });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "اصلی" });
    await until(() => runsDone(store, chat.id, 1));
    assert.equal(runner.answerFallback(chat.id, runner.openFallbackCard(chat.id), [goLabel({ name: "glm-5.3" })]), true);
    await until(() => runsDone(store, chat.id, 2));
    assert.match(sends[1].message, /مالک گفت با glm-5\.3/, "the rerun on the new engine has the note");
    assert.ok(!/سیستم/.test(String(store.getKv(`kept:${chat.id}`)?.[0]?.message)), "the kept copy is the owner's text");
    // Back on Claude (the picker), then «ارسال دوباره».
    store.updateChat(chat.id, { model: null, provider: "claude" });
    runner.retry(chat.id);
    await until(() => runsDone(store, chat.id, 3));
    assert.equal(sends[2].message, "اصلی", "no stale note on the old engine");
  } finally {
    done();
  }
});
