import { test } from "node:test";
import assert from "node:assert/strict";
import { NUDGE_LATER_MS, showNudge } from "../src/two-step-nudge.js";

test("the two-step line shows only while it is off, and «بعداً» hides it for a week", () => {
  const now = Date.now();
  assert.equal(showNudge(null, "", now), false); // not known yet (or no sign-in on this install)
  assert.equal(showNudge({ enabled: false, failed: true }, "", now), false);
  assert.equal(showNudge({ enabled: true }, "", now), false);
  assert.equal(showNudge({ enabled: false }, "", now), true);
  assert.equal(showNudge({ enabled: false }, String(now - 3_600_000), now), false);
  assert.equal(showNudge({ enabled: false }, String(now - NUDGE_LATER_MS - 1), now), true);
  assert.equal(showNudge({ enabled: false }, "garbage", now), true);
});
