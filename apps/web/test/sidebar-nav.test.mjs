import test from "node:test";
import assert from "node:assert/strict";
import { cleanNav, NAV_PRESETS } from "../src/sidebar-nav.js";

test("nav prefs keep only known sections and styles", () => {
  assert.deepEqual(cleanNav(null), { style: "list", hidden: [] });
  assert.deepEqual(cleanNav({ style: "grid", hidden: ["jobs", "nope", "jobs"] }), { style: "list", hidden: ["jobs"] });
  assert.deepEqual(cleanNav({ style: "icons", hidden: "jobs" }), { style: "icons", hidden: [] });
});

test("the short preset keeps Telegram", () => {
  const few = NAV_PRESETS.find((p) => p.id === "few");
  assert.ok(!few.hidden.includes("telegram"));
  assert.equal(cleanNav({ hidden: few.hidden }).hidden.length, 4);
});
