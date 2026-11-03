import test from "node:test";
import assert from "node:assert/strict";
import { chatAdvice, spendAdvice } from "../src/usage-advice.mjs";

const NOW = new Date("2026-11-02T12:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
// 1M Opus output tokens at 20$/M = 20$.
const row = (h, outputM, model = "opus") => ({ at: hoursAgo(h), model, usage: { output_tokens: outputM * 1e6 } });

test("spendAdvice: a day far above the usual one is flagged, with the heavy share", () => {
  const rows = [row(30, 1), row(54, 1), row(78, 1), row(102, 1), row(2, 3), row(3, 1, "sonnet")];
  const a = spendAdvice(rows, { now: NOW });
  assert.equal(a.kind, "spend");
  assert.equal(a.today, 70);
  assert.equal(a.baseline, 20);
  assert.equal(a.ratio, 3.5);
  assert.equal(a.heavyShare, 86);
});

test("spendAdvice: a normal day, a small day or too little history says nothing", () => {
  const usual = [row(30, 1), row(54, 1), row(78, 1), row(102, 1)];
  assert.equal(spendAdvice([...usual, row(2, 1.2)], { now: NOW }), null); // 24$ vs 20$
  assert.equal(spendAdvice([row(30, 0.1), row(54, 0.1), row(78, 0.1), row(2, 0.5)], { now: NOW }), null); // under the floor
  assert.equal(spendAdvice([row(30, 1), row(2, 5)], { now: NOW }), null); // one day of history
  assert.equal(spendAdvice([], { now: NOW }), null);
});

const run = (id, tools, outputTokens, model = "opus") => [
  { type: "usage", runId: id, data: { output_tokens: outputTokens } },
  ...Array.from({ length: tools }, () => ({ type: "tool.started", runId: id, data: {} })),
  { type: "run.started", runId: id, data: { model } },
];

test("chatAdvice: light turns on Opus suggest Sonnet", () => {
  const events = [...run("c", 1, 400), ...run("b", 0, 300), ...run("a", 2, 800)];
  const a = chatAdvice(events, { model: "opus" });
  assert.equal(a.suggest, "sonnet");
  assert.equal(a.runs, 3);
});

test("chatAdvice: heavy work, too few runs, a Sonnet chat or a mixed history stay quiet", () => {
  assert.equal(chatAdvice([...run("c", 9, 400), ...run("b", 0, 300), ...run("a", 0, 300)], { model: "opus" }), null); // many tools
  assert.equal(chatAdvice([...run("c", 0, 9000), ...run("b", 0, 300), ...run("a", 0, 300)], { model: "opus" }), null); // long answers
  assert.equal(chatAdvice([...run("b", 0, 300), ...run("a", 0, 300)], { model: "opus" }), null); // two runs
  assert.equal(chatAdvice([...run("c", 0, 100), ...run("b", 0, 100), ...run("a", 0, 100)], { model: "sonnet" }), null);
  assert.equal(chatAdvice([...run("c", 0, 100), ...run("b", 0, 100, "sonnet"), ...run("a", 0, 100)], { model: "opus" }), null); // Sonnet in between: fewer than 3 heavy runs in a row
  assert.equal(chatAdvice([...run("d", 0, 100), ...run("c", 0, 100), ...run("b", 0, 100), ...run("a", 0, 100, "sonnet")], { model: "opus" }).runs, 3); // an older Sonnet run ends the stretch
});
