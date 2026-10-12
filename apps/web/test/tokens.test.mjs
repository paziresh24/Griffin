import test from "node:test";
import assert from "node:assert/strict";
import { dayBars, formatTokens, labelledDays, modelOrder } from "../src/tokens-format.js";

const DAYS = [
  { date: "2026-10-04", total: 0, byModel: {} },
  { date: "2026-10-05", total: 200, byModel: { opus: 150, "GLM-5.3": 50 } },
  { date: "2026-10-06", total: 100, byModel: { "GLM-5.3": 100 } },
];

test("modelOrder: biggest consumer first, so every day stacks in the same order", () => {
  assert.deepEqual(modelOrder(DAYS), ["opus", "GLM-5.3"]);
});

test("dayBars: heights are relative to the busiest day; an empty day has no segments", () => {
  const bars = dayBars(DAYS, modelOrder(DAYS));
  assert.deepEqual(bars[0], { date: "2026-10-04", total: 0, height: 0, segments: [] });
  assert.equal(bars[1].height, 1);
  assert.deepEqual(bars[1].segments, [{ model: "opus", index: 0, tokens: 150, share: 0.75 }, { model: "GLM-5.3", index: 1, tokens: 50, share: 0.25 }]);
  assert.equal(bars[2].height, 0.5);
  assert.deepEqual(dayBars([], []), []);
});

test("formatTokens reaches billions: a month of totals is not written as thousands of millions", () => {
  assert.equal(formatTokens(1_917_000_000), "1.9B");
  assert.equal(formatTokens(774_000_000), "774M");
});

test("labelledDays: about eight evenly spaced labels that always include today and never crowd it", () => {
  const picks = (n) => [...Array(n).keys()].filter((i) => labelledDays(n)(i));
  assert.deepEqual(picks(7), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(picks(30), [1, 5, 9, 13, 17, 21, 25, 29]);
  const ninety = picks(90);
  assert.equal(ninety.at(-1), 89);
  assert.ok(ninety.every((v, k) => k === 0 || v - ninety[k - 1] === 12), "even gaps");
});
