import test from "node:test";
import assert from "node:assert/strict";
import { createPlanUsageCache, fromRunWindows, parsePlanUsage } from "../src/plan-usage.mjs";

// Shapes recorded from the SDK (0.3.274) on the owner's Max login, 2026-09-30.
const USAGE_SAMPLE = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 6, resets_at: "2026-09-30T14:29:59.644740+00:00", limit_dollars: null },
    seven_day: { utilization: 35, resets_at: "2026-10-05T02:59:59.644760+00:00" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    iguana_necktie: { utilization: 0, resets_at: "2026-11-05T07:59:00+00:00", limit_dollars: 250 },
    model_scoped: [{ display_name: "Fable", utilization: 5, resets_at: "2026-10-05T02:59:59.644905+00:00" }],
  },
  behaviors: null,
};

test("plan: 5-hour, weekly and per-model rows with ISO reset times; unknown windows dropped", () => {
  const p = parsePlanUsage(USAGE_SAMPLE);
  assert.equal(p.available, true);
  assert.equal(p.plan, "max");
  assert.deepEqual(
    p.rows.map((r) => [r.label, r.model, r.percent, r.resetsAt]),
    [
      ["session", null, 6, "2026-09-30T14:29:59.644Z"],
      ["weekly", null, 35, "2026-10-05T02:59:59.644Z"],
      ["weekly_model", "Fable", 5, "2026-10-05T02:59:59.644Z"],
    ],
  );
});

test("plan: API-key login reports unavailable with a reason", () => {
  const p = parsePlanUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null });
  assert.equal(p.available, false);
  assert.match(p.reason, /API key/);
});

test("plan: utilization is clamped to 0-100 and a missing reset stays null", () => {
  const p = parsePlanUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 130.4, resets_at: null } } });
  assert.deepEqual(p.rows, [{ id: "five_hour", label: "session", model: null, percent: 100, resetsAt: null }]);
});

test("plan: Ultra has no 5-hour window, the weekly rows stand alone", () => {
  const p = parsePlanUsage({ subscription_type: "ultra", rate_limits: { ...USAGE_SAMPLE.rate_limits, five_hour: null } });
  assert.equal(p.available, true);
  assert.equal(p.plan, "ultra");
  assert.deepEqual(p.rows.map((r) => r.id), ["seven_day", "model:Fable"]);
});

test("plan: the limits list fills in what the named fields left out, without doubling a row", () => {
  // Entries as recorded from the SDK (0.3.316) on a Max login, 2026-10-31.
  const list = [
    { kind: "session", group: "session", percent: 46, resets_at: "2026-10-31T10:59:59.763361+00:00", severity: "normal", is_active: false, scope: null },
    { kind: "weekly_all", group: "weekly", percent: 60, resets_at: "2026-11-03T01:59:59.763388+00:00", severity: "normal", is_active: true, scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 1, resets_at: "2026-11-03T01:59:59.763615+00:00", severity: "normal", is_active: false, scope: { model: { display_name: "Fable", id: null }, surface: null } },
    { kind: "weekly_scoped", group: "weekly", percent: 7, resets_at: null, severity: "normal", is_active: false, scope: { model: null, surface: { display_name: "Cowork" } } },
    { kind: "unheard_of", group: "x", percent: 9, resets_at: null, severity: "normal", is_active: false, scope: null },
  ];
  const onlyList = parsePlanUsage({ rate_limits: { five_hour: null, seven_day: null, limits: list } });
  assert.deepEqual(
    onlyList.rows.map((r) => [r.id, r.label, r.model, r.percent]),
    [
      ["five_hour", "session", null, 46],
      ["seven_day", "weekly", null, 60],
      ["model:Fable", "weekly_model", "Fable", 1],
      ["model:Cowork", "weekly_model", "Cowork", 7],
    ],
  );
  assert.equal(onlyList.rows[1].resetsAt, "2026-11-03T01:59:59.763Z");
  const both = parsePlanUsage({ rate_limits: { ...USAGE_SAMPLE.rate_limits, limits: list } });
  assert.deepEqual(both.rows.map((r) => [r.id, r.percent]), [["five_hour", 6], ["seven_day", 35], ["model:Fable", 5], ["model:Cowork", 7]]);
});

test("plan cache: one SDK call per 60 s, shared by concurrent callers; errors become unavailable", async () => {
  let t = 0;
  let calls = 0;
  const cache = createPlanUsageCache({ now: () => t, fetchUsage: async () => (calls += 1, USAGE_SAMPLE) });
  const [a, b] = await Promise.all([cache(), cache()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  t = 59_000;
  await cache();
  assert.equal(calls, 1);
  t = 60_001;
  await cache();
  assert.equal(calls, 2);

  const failing = createPlanUsageCache({ fetchUsage: async () => { throw new Error("spawn failed"); } });
  const f = await failing();
  assert.equal(f.available, false);
  assert.match(f.reason, /spawn failed/);
});

test("plan limits: a failed read after a good one keeps showing the last good numbers, marked stale, and is retried soon", async () => {
  let t = 0;
  let calls = 0;
  let fail = false;
  const cache = createPlanUsageCache({
    now: () => t,
    fetchUsage: async () => {
      calls += 1;
      if (fail) return { subscription_type: "max", rate_limits_available: false };
      return USAGE_SAMPLE;
    },
  });
  const good = await cache();
  assert.equal(good.available, true);
  fail = true;
  t = 61_000;
  const stale = await cache();
  assert.equal(stale.available, true, "the last good rows are still served");
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.rows, good.rows);
  assert.equal(stale.fetchedAt, good.fetchedAt, "the time shown is when the numbers were really read");
  assert.match(stale.staleReason, /plan limits do not apply/);
  t = 61_000 + 11_000;
  await cache();
  assert.equal(calls, 3, "a failure is cached for seconds, not a full minute");
  fail = false;
  t += 11_000;
  const fresh = await cache();
  assert.equal(fresh.available, true);
  assert.equal(fresh.stale, undefined);
});

test("plan limits: with no good read yet, a failure says why and is retried soon", async () => {
  let t = 0;
  let calls = 0;
  const cache = createPlanUsageCache({ now: () => t, fetchUsage: async () => { calls += 1; throw new Error("spawn failed"); } });
  const first = await cache();
  assert.equal(first.available, false);
  assert.match(first.reason, /spawn failed/);
  t = 11_000;
  await cache();
  assert.equal(calls, 2);
});

test("plan limits: old numbers are not kept across a login change, nor beyond half an hour", async () => {
  let t = 0;
  let answer = USAGE_SAMPLE;
  const cache = createPlanUsageCache({ now: () => t, fetchUsage: async () => answer });
  assert.equal((await cache()).available, true);
  // Another login (an API key has no subscription): the old subscription's numbers must go.
  answer = { subscription_type: null, rate_limits_available: false };
  t = 61_000;
  const switched = await cache();
  assert.equal(switched.available, false);
  assert.equal(switched.stale, undefined);
  answer = USAGE_SAMPLE;
  t += 11_000;
  assert.equal((await cache()).available, true);
  // Same login, reads keep failing: stale for a while, then honestly unavailable.
  answer = null;
  t += 61_000;
  assert.equal((await cache()).stale, true);
  t += 31 * 60_000;
  const old = await cache();
  assert.equal(old.available, false);
  assert.match(old.reason, /no answer/);
});

test("plan: a run's unifiedWindows (0-1) read as percent rows when the SDK has no limits for this login", () => {
  const raw = fromRunWindows({ five_hour: { utilization: 0.42, resetsAt: 1_800_000_000 }, seven_day: { utilization: 0.1 } });
  const parsed = parsePlanUsage(raw);
  assert.equal(parsed.available, true);
  assert.deepEqual(parsed.rows.map((r) => [r.id, r.percent]), [["five_hour", 42], ["seven_day", 10]]);
  assert.equal(parsed.rows[0].resetsAt, new Date(1_800_000_000_000).toISOString());
  assert.equal(fromRunWindows(null), null);
});
