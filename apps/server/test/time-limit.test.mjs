import test from "node:test";
import assert from "node:assert/strict";
import { withinTime } from "../src/time-limit.mjs";

test("withinTime: a call that never answers gives the fallback in time", async () => {
  const started = Date.now();
  const value = await withinTime(new Promise(() => {}), 50, () => ({ ok: false, error: "timeout" }));
  assert.deepEqual(value, { ok: false, error: "timeout" });
  assert.ok(Date.now() - started < 1000);
});

test("withinTime: a quick answer wins, and a quick failure still rejects", async () => {
  assert.equal(await withinTime(Promise.resolve(7), 1000, () => 0), 7);
  await assert.rejects(withinTime(Promise.reject(new Error("x")), 1000, () => 0), /x/);
});
