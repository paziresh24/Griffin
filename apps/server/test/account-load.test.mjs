import test from "node:test";
import assert from "node:assert/strict";
import { planLoad, createAccountLoads } from "../src/account-load.mjs";
import { roomiestAccount } from "../src/account-balance.mjs";

const NOW = Date.parse("2026-11-04T08:00:00Z");
const later = "2026-11-04T12:00:00Z";
const raw = (five, week, opus = 0) => ({ subscription_type: "max", rate_limits: { five_hour: { utilization: five, resets_at: later }, seven_day: { utilization: week, resets_at: later }, seven_day_opus: { utilization: opus, resets_at: later } } });

test("planLoad is the fuller shared window; a per-model window does not count", () => {
  assert.equal(planLoad(raw(20, 61, 99), NOW), 61);
});

test("planLoad: a window already reset is empty; no plan answer is unknown", () => {
  const past = { rate_limits: { five_hour: { utilization: 90, resets_at: "2026-11-04T07:00:00Z" }, seven_day: { utilization: 30, resets_at: later } } };
  assert.equal(planLoad(past, NOW), 30);
  assert.equal(planLoad({ rate_limits_available: false }, NOW), null);
  assert.equal(planLoad(null, NOW), null);
});

test("after a refresh every account is known, and the newer of plan and run readings wins", async () => {
  let t = NOW;
  const run = { a: { load: 10, at: NOW - 60_000 }, b: { load: 70, at: NOW + 60_000 } };
  const loads = createAccountLoads({
    ids: () => ["a", "b", "c"],
    fetchUsage: async (id) => ({ a: raw(40, 50), b: raw(5, 5), c: raw(80, 20) })[id],
    runLoad: (id) => run[id]?.load ?? null,
    runAt: (id) => run[id]?.at ?? 0,
    now: () => t,
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(loads.loadOf("c"), null);
  await loads.refresh();
  assert.equal(loads.loadOf("a"), 50); // plan read after the run
  assert.equal(loads.loadOf("b"), 70); // a run after the plan read
  assert.equal(loads.loadOf("c"), 80);
});

test("one account failing to answer does not stop the others", async () => {
  const loads = createAccountLoads({
    ids: () => ["a", "b"],
    fetchUsage: async (id) => {
      if (id === "a") throw new Error("boom");
      return raw(12, 3);
    },
    runLoad: () => null,
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
  });
  await loads.refresh();
  assert.equal(loads.loadOf("a"), null);
  assert.equal(loads.loadOf("b"), 12);
});

test("roomiestAccount: least used usable account; ties keep order; none usable is null", () => {
  const load = { a: 60, b: 20, c: 5 };
  assert.equal(roomiestAccount(["a", "b", "c"], { usable: (id) => id !== "c", loadOf: (id) => load[id] }), "b");
  assert.equal(roomiestAccount(["a", "b"], { usable: () => true, loadOf: () => null }), "a");
  assert.equal(roomiestAccount(["a"], { usable: () => false, loadOf: () => 0 }), null);
});
