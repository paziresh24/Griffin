import test from "node:test";
import assert from "node:assert/strict";
import { applyEvent, emptyTimeline, finalText, foldEvents, usageByModel } from "../src/index.mjs";

let nextId = 1;
const ev = (type, data = {}, runId = "run1") => ({ id: nextId++, runId, type, data, at: "t" });

test("text deltas are joined verbatim (no guessed spaces)", () => {
  const t = foldEvents([
    ev("user", { text: "دیسک؟" }, null),
    ev("run.started"),
    ev("text", { text: "فضای دی" }),
    ev("text", { text: "سک ۱: " }),
    ev("text", { text: "8.6G" }),
    ev("text", { text: " آزاد" }),
    ev("run.finished", { status: "finished" }),
  ]);
  const run = t.messages[1];
  assert.equal(run.parts.length, 1);
  assert.equal(run.parts[0].text, "فضای دیسک ۱: 8.6G آزاد");
  assert.equal(run.status, "finished");
});

test("thinking, tools and text become ordered parts", () => {
  const t = foldEvents([
    ev("run.started"),
    ev("thinking", { text: "باید " }),
    ev("thinking", { text: "df بگیرم" }),
    ev("text", { text: "الان دیسک را می‌خوانم." }),
    ev("tool.started", { callId: "c1", name: "kube_df", args: { pod: "p" } }),
    ev("tool.done", { callId: "c1", name: "kube_df", args: { pod: "p" }, result: { status: "success", value: {} } }),
    ev("text", { text: "۸٫۶G آزاد است." }),
    ev("run.finished", { status: "finished" }),
  ]);
  const parts = t.messages[0].parts;
  assert.deepEqual(parts.map((p) => p.type), ["reasoning", "text", "tool", "text"]);
  assert.equal(parts[0].text, "باید df بگیرم");
  assert.equal(parts[0].done, true);
  assert.equal(parts[2].status, "success");
  assert.equal(finalText(t.messages[0]), "۸٫۶G آزاد است.");
});

test("tool errors and cancelled runs close open parts", () => {
  const t = foldEvents([
    ev("run.started"),
    ev("tool.started", { callId: "a", name: "read" }),
    ev("tool.started", { callId: "b", name: "grep" }),
    ev("tool.done", { callId: "a", name: "read", result: { status: "error", error: { message: "x" } } }),
    ev("run.finished", { status: "cancelled" }),
  ]);
  const [a, b] = t.messages[0].parts;
  assert.equal(a.status, "error");
  assert.equal(b.status, "cancelled");
});

test("replayed events are ignored by id", () => {
  const events = [ev("run.started"), ev("text", { text: "سلام" })];
  let t = foldEvents(events);
  t = applyEvent(t, events[1]);
  assert.equal(t.messages[0].parts[0].text, "سلام");
  assert.equal(emptyTimeline().lastEventId, 0);
});

test("finalText: the goodbye before end_agent is the answer; chatter after it is not sent", async () => {
  const { finalText } = await import("../src/index.mjs");
  const message = {
    role: "assistant",
    parts: [
      { type: "text", text: "دارم چک می‌کنم" },
      { type: "tool", name: "kube_get" },
      { type: "text", text: "خواهش، هر وقت کاری بود بنویس «گریفین»" },
      { type: "tool", name: "end_agent" },
      { type: "text", text: "مخلصم" },
    ],
  };
  assert.equal(finalText(message), "خواهش، هر وقت کاری بود بنویس «گریفین»");
});

test("user.queue settles the queued message it names; others keep no state", () => {
  const { messages } = foldEvents([
    { id: 1, type: "user", data: { text: "a", intent: "queue", tracked: true } },
    { id: 2, type: "user", data: { text: "b", intent: "queue", tracked: true } },
    { id: 3, runId: "r2", type: "run.started", data: {} },
    { id: 4, type: "user.queue", data: { userEventId: 1, state: "started" } },
    { id: 5, type: "user.queue", data: { userEventId: 99, state: "dropped" } },
  ]);
  assert.equal(messages[0].queueState, "started");
  assert.equal(messages[1].queueState, undefined, "a tracked label waits for its own event, not the next run");
});

test("older «در صف» messages settle by what followed: the next turn ran them, a cancel dropped them", () => {
  const { messages } = foldEvents([
    { id: 1, runId: "r1", type: "run.started", data: {} },
    { id: 2, type: "user", data: { text: "a", intent: "queue" } },
    { id: 3, runId: "r1", type: "run.finished", data: { status: "finished" } },
    { id: 4, runId: "r2", type: "run.started", data: {} },
    { id: 5, type: "user", data: { text: "b", intent: "queue" } },
    { id: 6, runId: "r2", type: "run.finished", data: { status: "cancelled" } },
    { id: 7, runId: "r3", type: "run.started", data: {} },
  ]);
  const users = messages.filter((m) => m.role === "user");
  assert.deepEqual(users.map((m) => m.queueState), ["started", "dropped"]);
});

test("chat.suggested and chapter events fold into suggestion and chapter parts", () => {
  const t = foldEvents([
    ev("run.started"),
    ev("text", { text: "شروع" }),
    ev("chapter", { title: "کاوش", summary: "خواندن کد" }, null),
    ev("chat.suggested", { id: "s1", title: "رفع README", tldr: "نشان قدیمی" }, null),
    ev("chapter", { title: "بی‌خلاصه" }, null),
    ev("run.finished", { status: "finished" }),
  ]);
  assert.deepEqual(t.messages[0].parts.slice(1), [
    { type: "chapter", title: "کاوش", summary: "خواندن کد" },
    { type: "suggestion", id: "s1", title: "رفع README", tldr: "نشان قدیمی", status: "open" },
    { type: "chapter", title: "بی‌خلاصه", summary: null },
  ]);
  // The answer is still only the text.
  assert.equal(finalText(t.messages[0]), "شروع");
});

test("a suggestion's status change updates its card, in whichever run holds it", () => {
  const t = foldEvents([
    ev("run.started", {}, "a"),
    ev("chat.suggested", { id: "s1", title: "الف", tldr: "خ" }, "a"),
    ev("run.finished", { status: "finished" }, "a"),
    ev("run.started", {}, "b"),
    ev("chat.suggested", { id: "s2", title: "ب", tldr: "خ" }, "b"),
    ev("run.finished", { status: "finished" }, "b"),
    ev("chat.suggestion.status", { id: "s1", status: "started" }, null),
  ]);
  assert.equal(t.messages[0].parts[0].status, "started");
  assert.equal(t.messages[1].parts[0].status, "open");
});

test("retry phase, manifest changes and per-model usage (each run once)", () => {
  const t = foldEvents([
    ev("run.started", { model: "glm-5.3" }, "a"),
    ev("manifest", { changes: [{ kind: "rules" }, { kind: "tools" }] }, null),
    ev("run.phase", { phase: "retrying", detail: { attempt: 2, max: 6, status: 429, delayMs: 4000 } }, "a"),
    ev("usage", { inputTokens: 100, outputTokens: 20 }, "a"),
    ev("run.finished", { status: "finished" }, "a"),
    ev("manifest", { changes: [{ kind: "rules" }] }, null), // no running run: ignored
    ev("run.started", { model: "sonnet" }, "b"),
    ev("usage", { inputTokens: 50, outputTokens: 5 }, "b"),
    ev("run.finished", { status: "finished" }, "b"),
  ]);
  const [a, b] = t.messages;
  assert.equal(a.manifestChanges, 2);
  assert.equal(a.phaseDetail.attempt, 2);
  assert.equal(a.phaseAt, "t");
  assert.equal(b.manifestChanges, undefined);
  // a split run repeats its usage on the later piece: counted once
  const split = [...t.messages, { ...a, id: "ra~9" }];
  assert.deepEqual(usageByModel(split), { total: 175, byModel: [{ model: "glm-5.3", tokens: 120 }, { model: "sonnet", tokens: 55 }] });
});

// Telegram v2: a colleague's message in a mother chat says who wrote it; desk notes are messages of
// their own that never disturb the run around them.
test("tg.note folds into a note message; user.from is kept; runs and the final text are untouched", () => {
  const t = foldEvents([
    ev("user", { text: "«کریمی»: سلام", from: { kind: "colleague", name: "کریمی", personId: "p1" } }, null),
    ev("run.started", {}, "m"),
    ev("text", { text: "در حال بررسی" }, "m"),
    ev("tg.note", { kind: "owner_line", name: "شما", text: "خودم جواب دادم", by: "owner", personId: "p1" }, null),
    ev("tool.started", { callId: "s", name: "send_to_person", args: { text: "سلام" } }, "m"),
    ev("tool.done", { callId: "s", name: "send_to_person", result: { status: "success" } }, "m"),
    ev("text", { text: "کریمی سلام کرد؛ جواب دادم." }, "m"),
    ev("run.finished", { status: "finished" }, "m"),
    ev("tg.note", { kind: "report", name: "کریمی", state: "sent", sent: ["سلام"], text: "جواب دادم", id: "x", role: "user" }, null),
  ]);
  const [user, run, note, report] = t.messages;
  assert.deepEqual(user.from, { kind: "colleague", name: "کریمی", personId: "p1" });
  assert.equal(run.role, "assistant");
  assert.equal(run.status, "finished");
  assert.equal(note.role, "note");
  assert.equal(note.kind, "owner_line");
  assert.equal(note.by, "owner");
  assert.match(note.id, /^n\d+$/);
  assert.equal(report.role, "note", "data never overrides the note's own role or id");
  assert.match(report.id, /^n\d+$/);
  assert.deepEqual(report.sent, ["سلام"]);
  assert.equal(t.messages.findLast((m) => m.role === "assistant"), run);
  assert.equal(finalText(run), "کریمی سلام کرد؛ جواب دادم.");
  assert.equal(foldEvents([ev("user", { text: "x" }, null)]).messages[0].from, undefined, "the owner's own message has no from");
});
