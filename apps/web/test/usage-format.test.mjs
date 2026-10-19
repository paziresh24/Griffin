import test from "node:test";
import assert from "node:assert/strict";
import { formatReset, limitLabel, limitsProblem, planName } from "../src/tokens-format.js";

test("a reset under a day is a countdown; further away a weekday and time", () => {
  const now = new Date(2026, 8, 30, 12, 0, 0);
  assert.equal(formatReset(new Date(2026, 8, 30, 14, 2, 0).toISOString(), now), "بازنشانی تا 2 ساعت و 2 دقیقه");
  assert.equal(formatReset(new Date(2026, 8, 30, 12, 40, 0).toISOString(), now), "بازنشانی تا 40 دقیقه");
  assert.equal(formatReset(new Date(2026, 9, 5, 6, 30, 0).toISOString(), now), "بازنشانی دوشنبه 6:30 صبح");
  assert.equal(formatReset(null, now), "");
});

test("limit labels, plan names and why limits are missing", () => {
  assert.equal(planName("max"), "Max");
  assert.equal(limitLabel({ label: "session" }), "محدودیت ۵ ساعته");
  assert.equal(limitLabel({ label: "weekly_model", model: "Fable" }), "هفتگی · Fable");
  assert.match(limitsProblem("plan limits do not apply to this login"), /وارد شو/);
  assert.match(limitsProblem("whatever"), /دوباره/);
});
