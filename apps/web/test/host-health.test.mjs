import { test } from "node:test";
import assert from "node:assert/strict";
import { CPU_SUSTAIN, hostAlerts, loadLevel } from "../src/host-health.js";

test("gauges take status colours by load, not the palette", () => {
  assert.equal(loadLevel(30), "ok");
  assert.equal(loadLevel(74), "warn");
  assert.equal(loadLevel(85), "danger");
});

test("the sidebar speaks of a busy server, a short CPU spike only once it lasts", () => {
  const busy = { cpu: { percent: 95 }, memory: { percent: 40 }, disk: { percent: 50 } };
  assert.deepEqual(hostAlerts(busy, { cpuStreak: 1 }), []);
  assert.equal(hostAlerts(busy, { cpuStreak: CPU_SUSTAIN })[0].key, "cpu");
  const full = { cpu: { percent: 10 }, memory: { percent: 96 }, disk: { percent: 91 } };
  assert.deepEqual(hostAlerts(full).map((a) => [a.key, a.level]), [["memory", "warn"], ["disk", "warn"]]);
  assert.equal(hostAlerts({ available: false })[0].key, "down");
  assert.deepEqual(hostAlerts({ cpu: { percent: 20 }, memory: { percent: 50 } }), []);
});
