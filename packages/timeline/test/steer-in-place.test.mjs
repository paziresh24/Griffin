// A message the owner sends while a run works (steered into it, or typed as the answer to an open
// ask_owner card) sits where the run read it, not under the run's final answer.
// The OpenAI engine takes steered messages at a round boundary and says so (user.read);
// a tool round that ended after the message counts too.
import test from "node:test";
import assert from "node:assert/strict";
import { finalText, foldEvents, lastRun, wholeRun } from "../src/index.mjs";

let nextId = 1;
const ev = (type, data = {}, runId = "run1") => ({ id: nextId++, runId, type, data, at: `t${nextId}` });
const shape = (messages) => messages.map((m) => (m.role === "user" ? `user:${m.text}` : `run:${m.parts.map((p) => p.type).join(",")}`));
const ok = { status: "success", value: 1 };

test("an answer typed for an open ask card sits under the card, before what the run did next", () => {
  const { messages } = foldEvents([
    ev("user", { text: "شروع" }, null),
    ev("run.started"),
    ev("tool.started", { callId: "a1", name: "ask_owner", args: { question: "کدام؟" } }),
    ev("user", { text: "سلام", intent: "steer" }),
    ev("tool.done", { callId: "a1", name: "ask_owner", result: ok }),
    ev("usage", { prompt_tokens: 10, completion_tokens: 2 }),
    ev("text", { text: "جواب به " }),
    ev("text", { text: "سلام" }),
    ev("usage", { prompt_tokens: 20, completion_tokens: 3 }),
    ev("run.finished", { status: "finished" }),
  ]);
  assert.deepEqual(shape(messages), ["user:شروع", "run:tool", "user:سلام", "run:text"]);
  assert.equal(messages[1].parts[0].status, "success");
  assert.equal(messages[1].continued, true, "the piece above has no footer of its own");
  assert.equal(messages[3].runId, "run1");
  assert.equal(messages[3].startedAt, messages[1].startedAt, "the footer counts the whole run");
  assert.equal(messages[3].usage.requests, 2, "and its usage");
  assert.notEqual(messages[3].id, messages[1].id);
  assert.equal(finalText(messages.at(-1)), "جواب به سلام");
});

test("a message steered during a final answer moves in where the engine read it", () => {
  const { messages } = foldEvents([
    ev("run.started"),
    ev("text", { text: "جواب اول" }),
    ev("user", { text: "این را هم بگو", intent: "steer" }),
    ev("text", { text: " تمام." }),
    ev("usage", { prompt_tokens: 1 }),
    ev("user.read"),
    ev("text", { text: "\n\n" }),
    ev("text", { text: "و این هم جواب تو." }),
    ev("run.finished", { status: "finished" }),
  ]);
  assert.deepEqual(shape(messages), ["run:text", "user:این را هم بگو", "run:text"]);
  assert.equal(messages[0].parts[0].text, "جواب اول تمام.");
  assert.equal(finalText(lastRun(messages)), "جواب اول تمام.\n\nو این هم جواب تو.", "a delivery reads the run whole");
});

test("a message the run never read stays after it", () => {
  const { messages } = foldEvents([
    ev("run.started"),
    ev("text", { text: "کار" }),
    ev("user", { text: "دیر رسید", intent: "steer" }),
    ev("text", { text: " تمام" }),
    ev("run.finished", { status: "finished" }),
  ]);
  assert.deepEqual(shape(messages), ["run:text", "user:دیر رسید"]);
  assert.equal(messages[0].waiting, null);
});

test("a message before any output goes above the run", () => {
  const { messages } = foldEvents([
    ev("run.started"),
    ev("user", { text: "زود", intent: "steer" }),
    ev("text", { text: "سلام" }),
    ev("run.finished", { status: "finished" }),
  ]);
  assert.deepEqual(shape(messages), ["user:زود", "run:text"]);
});

test("parallel tool calls are not split; the tool in flight finishes in the piece above", () => {
  const { messages } = foldEvents([
    ev("run.started"),
    ev("tool.started", { callId: "p1", name: "kube_get", args: {} }),
    ev("user", { text: "و آن یکی", intent: "steer" }),
    ev("tool.started", { callId: "p2", name: "kube_get", args: {} }),
    ev("tool.done", { callId: "p1", name: "kube_get", result: ok }),
    ev("tool.done", { callId: "p2", name: "kube_get", result: ok }),
    ev("user.read"),
    ev("tool.started", { callId: "p3", name: "kube_logs", args: {} }),
    ev("tool.done", { callId: "p3", name: "kube_logs", result: ok }),
    ev("text", { text: "دیدم" }),
    ev("run.finished", { status: "finished" }),
  ]);
  assert.deepEqual(shape(messages), ["run:tool,tool", "user:و آن یکی", "run:tool,text"]);
  assert.deepEqual(messages[0].parts.map((p) => p.status), ["success", "success"]);
  assert.deepEqual(wholeRun(messages, "run1").parts.map((p) => p.type), ["tool", "tool", "tool", "text"]);
});

test("a tool left running in the piece above is closed when the run ends", () => {
  const { messages } = foldEvents([
    ev("run.started"),
    ev("tool.started", { callId: "x1", name: "debug_exec", args: {} }),
    ev("user", { text: "بس است", intent: "steer" }),
    ev("user.read"),
    ev("text", { text: "باشه" }),
    ev("run.finished", { status: "cancelled" }),
  ]);
  assert.deepEqual(shape(messages), ["run:tool", "user:بس است", "run:text"]);
  assert.equal(messages[0].parts[0].status, "cancelled");
});

test("two messages in a row move together; a queued one stays after the run", () => {
  const { messages } = foldEvents([
    ev("run.started"),
    ev("tool.started", { callId: "d0", name: "debug_exec", args: {} }),
    ev("user", { text: "اول", intent: "steer" }),
    ev("user", { text: "بعدی", intent: "queue" }, null),
    ev("user", { text: "دوم", intent: "steer" }),
    ev("tool.done", { callId: "d0", name: "debug_exec", result: ok }),
    ev("tool.started", { callId: "d1", name: "debug_exec", args: {} }),
    ev("run.finished", { status: "finished" }),
  ]);
  assert.deepEqual(shape(messages), ["run:tool", "user:اول", "user:دوم", "run:tool", "user:بعدی"]);
});

test("folding one event at a time, through a JSON round trip, gives the same thread", () => {
  const events = [
    ev("run.started", {}, "r7"),
    ev("text", { text: "a" }, "r7"),
    ev("tool.started", { callId: "f0", name: "x", args: {} }, "r7"),
    ev("user", { text: "x", intent: "steer" }, "r7"),
    ev("tool.done", { callId: "f0", name: "x", result: ok }, "r7"),
    ev("text", { text: "b" }, "r7"),
    ev("tool.started", { callId: "f1", name: "x", args: {} }, "r7"),
    ev("tool.done", { callId: "f1", name: "x", result: ok }, "r7"),
    ev("run.finished", { status: "finished" }, "r7"),
  ];
  // The server's timeline cache and the browser keep the fold between pages, serialised.
  let step;
  for (const event of events) step = JSON.parse(JSON.stringify(foldEvents([event], step)));
  assert.deepEqual(step, JSON.parse(JSON.stringify(foldEvents(events))));
  assert.deepEqual(shape(step.messages), ["run:text,tool", "user:x", "run:text,tool"]);
});
