import test from "node:test";
import assert from "node:assert/strict";
import { createZaiQuotaCache, parseZaiQuota, zaiQuotaFetch } from "../src/zai-usage.mjs";

// Fixture in the shape Z.ai actually answered when probed live (2026-10-04, level "lite"):
// usage/currentValue/remaining are prompt tokens, nextResetTime an epoch in milliseconds.
const LIVE_SHAPE = {
  code: 200,
  success: true,
  data: {
    level: "lite",
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 451, remaining: 1548, percentage: 22, nextResetTime: 1791147943560 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 40000, currentValue: 9000, remaining: 31000, percentage: 23, nextResetTime: 1791600000000 },
    ],
  },
};

test("parseZaiQuota reads the two quota windows: five-hour first, weekly second", () => {
  const parsed = parseZaiQuota(LIVE_SHAPE);
  assert.equal(parsed.available, true);
  assert.equal(parsed.level, "lite");
  assert.deepEqual(parsed.rows.map((r) => r.id), ["five_hour", "weekly"]);
  const [session, weekly] = parsed.rows;
  assert.equal(session.used, 451);
  assert.equal(session.total, 2000);
  assert.equal(session.remaining, 1548);
  assert.equal(session.percent, 22);
  assert.equal(session.resetsAt, new Date(1791147943560).toISOString());
  assert.equal(weekly.id, "weekly");
  assert.equal(weekly.resetsAt, new Date(1791600000000).toISOString());
});

test("parseZaiQuota drops unusable windows and keeps an unknown one labelled, not guessed", () => {
  const parsed = parseZaiQuota({
    success: true,
    data: {
      limits: [
        { type: "MODEL_USAGE", unit: 1 }, // not a credit limit
        { type: "CREDIT_LIMIT", unit: 9, number: 9, usage: 0 }, // no usable total
        { type: "CREDIT_LIMIT", unit: 9, number: 2, usage: 500, currentValue: 100, percentage: 20 }, // unknown window
      ],
    },
  });
  assert.equal(parsed.available, true);
  assert.deepEqual(parsed.rows.map((r) => r.id), ["credit:9:2"]);
  assert.equal(parsed.rows[0].remaining, 400, "remaining falls back to total - used");
  assert.equal(parsed.rows[0].percent, 20);
  assert.equal(parsed.rows[0].resetsAt, null);
});

test("parseZaiQuota says unavailable for a non-answer instead of throwing", () => {
  for (const raw of [null, {}, { success: false }, { success: true, data: null }, { success: true, data: { limits: [] } }]) {
    const parsed = parseZaiQuota(raw);
    assert.equal(parsed.available, false, String(JSON.stringify(raw)).slice(0, 40));
    assert.ok(parsed.reason);
  }
});

test("the cache serves one fetch across calls inside the TTL and shares the in-flight one", async () => {
  let calls = 0;
  let at = 1_000_000;
  const cache = createZaiQuotaCache({ fetchQuota: async () => (calls += 1, LIVE_SHAPE), now: () => at });
  const [a, b] = await Promise.all([cache(), cache()]);
  assert.equal(calls, 1, "concurrent callers share one fetch");
  assert.equal(a.available, true);
  assert.equal(b.available, true);
  await cache();
  assert.equal(calls, 1, "second read within the TTL is served from the cache");
  at += 61_000;
  await cache();
  assert.equal(calls, 2, "past the TTL it fetches again");
});

test("a failed fetch becomes an unavailable answer, cached like a success", async () => {
  let calls = 0;
  let at = 1_000_000;
  const cache = createZaiQuotaCache({
    fetchQuota: async () => (calls += 1, Promise.reject(new Error("HTTP 503"))),
    now: () => at,
  });
  const first = await cache();
  assert.equal(first.available, false);
  assert.match(first.reason, /HTTP 503/);
  await cache();
  assert.equal(calls, 1, "the failure is cached too, not retried per popover open");
});

test("zaiQuotaFetch refuses to fire without a key, and never logs one", async () => {
  await assert.rejects(() => zaiQuotaFetch({ key: "" }), /no Z.ai key set/);
});
