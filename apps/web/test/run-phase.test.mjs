import test from "node:test";
import assert from "node:assert/strict";
import { phaseLabel } from "../src/run-phase.js";

test("phaseLabel: retry with attempt and reason, expires after its wait; limited with reset time", () => {
  assert.equal(phaseLabel("connecting"), "در حال اتصال");
  const at = "2026-10-12T10:00:00.000Z";
  const detail = { attempt: 2, max: 6, status: 429, delayMs: 4000 };
  assert.equal(phaseLabel("retrying", detail, { at, now: Date.parse(at) + 1000 }), "تلاش دوباره (۲ از ۶)؛ محدودیت نرخ درخواست");
  assert.equal(phaseLabel("retrying", detail, { at, now: Date.parse(at) + 60_000 }), "در حال کار");
  assert.match(phaseLabel("limited", { limitType: "seven_day", resetsAt: Date.parse(at) }), /^سقف مصرف هفتگی پر شد؛ ساعت [۰-۹]{2}:[۰-۹]{2} باز می‌شود$/);
  assert.equal(phaseLabel("limited"), "سقف مصرف پر شد");
});
