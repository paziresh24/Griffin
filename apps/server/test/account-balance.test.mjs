import test from "node:test";
import assert from "node:assert/strict";
import { accountLoad, balanceAccounts, HIGH_LOAD } from "../src/account-balance.mjs";

const now = Date.parse("2026-10-22T08:00:00Z");
const later = now / 1000 + 3600;
const win = (five, week, reset = later) => ({ five_hour: { utilization: five, resetsAt: reset }, seven_day: { utilization: week, resetsAt: reset } });

test("an account's load is its fuller window; a window already reset counts as empty", () => {
  assert.equal(accountLoad(win(0.21, 0.72), now), 72);
  assert.equal(Math.round(accountLoad({ five_hour: { utilization: 0.9, resetsAt: now / 1000 - 60 }, seven_day: { utilization: 0.3, resetsAt: later } }, now)), 30);
  assert.equal(accountLoad(null, now), null);
  assert.equal(accountLoad({}, now), null);
});

// The four shared accounts on 2026-10-22: claude-2 at 5% of its week, the others past 68%.
const loads = { "claude-4": 72, "claude-2": 5, "claude-6": 68, "claude-5": 70 };
const list = [
  { provider: "claude-4", model: "opus" },
  { provider: "claude-2", model: "opus" },
  { provider: "claude-6", model: "opus" },
  { provider: "claude-5", model: "opus" },
  { provider: "openai", model: "glm-5.3" },
];
const opts = (extra = {}) => ({ isPlain: (id) => id.startsWith("claude"), usable: () => true, loadOf: (id) => loads[id] ?? null, ...extra });

test("a new chat starts on the account with the most room left; the rest keep their order behind it", () => {
  const { list: out, chosen } = balanceAccounts(list, opts());
  assert.equal(chosen, "claude-2");
  assert.deepEqual(out.map((c) => c.provider), ["claude-2", "claude-4", "claude-6", "claude-5", "openai"]);
});

test("a chat stays on its own account until that one is unusable or past the high line with clearly more room elsewhere", () => {
  assert.equal(balanceAccounts(list, opts({ placed: "claude-6" })).chosen, "claude-6", "68% is below the line: no move");
  assert.equal(balanceAccounts(list, opts({ placed: "claude-6", usable: (id) => id !== "claude-6" })).chosen, "claude-2", "its account hit the limit");
  const full = { ...loads, "claude-6": HIGH_LOAD + 5 };
  assert.equal(balanceAccounts(list, opts({ placed: "claude-6", loadOf: (id) => full[id] })).chosen, "claude-2", "past the line, another has far more room");
  const allFull = { "claude-4": 95, "claude-2": 92, "claude-6": 90, "claude-5": 97 };
  assert.equal(balanceAccounts(list, opts({ placed: "claude-6", loadOf: (id) => allFull[id] })).chosen, "claude-6", "nowhere clearly better: stays");
});

test("only the same model on plain Claude accounts is interchangeable; another engine first is left alone", () => {
  const glmFirst = [{ provider: "openai", model: "glm-5.3" }, ...list.slice(0, 4)];
  assert.deepEqual(balanceAccounts(glmFirst, opts()), { list: glmFirst, chosen: null });
  const mixed = [{ provider: "claude-4", model: "opus" }, { provider: "claude-2", model: "sonnet" }, { provider: "claude-6", model: "opus" }];
  assert.equal(balanceAccounts(mixed, opts()).chosen, "claude-6", "claude-2 runs another model here");
  const zai = [{ provider: "claude-4", model: "opus" }, { provider: "claude-zai", model: "opus" }];
  assert.equal(balanceAccounts(zai, opts({ isPlain: (id) => id !== "claude-zai" && id.startsWith("claude") })).chosen, "claude-4");
});

test("an account no run has reported on is neither preferred nor avoided", () => {
  const some = { "claude-4": 72, "claude-6": 30 };
  assert.equal(balanceAccounts(list, opts({ loadOf: (id) => some[id] ?? null })).chosen, "claude-6");
  const high = { "claude-4": 72, "claude-6": 68, "claude-5": 70 };
  assert.equal(balanceAccounts(list, opts({ loadOf: (id) => high[id] ?? null })).chosen, "claude-2");
});

test("nothing usable: the list is returned as it was, for the limit handling to choose", () => {
  assert.deepEqual(balanceAccounts(list.slice(0, 4), opts({ usable: () => false })).chosen, null);
});
