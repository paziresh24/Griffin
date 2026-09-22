import test from "node:test";
import assert from "node:assert/strict";
import { applyEvent, emptyTimeline, finalText, foldEvents } from "../src/index.mjs";

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
