import test from "node:test";
import assert from "node:assert/strict";
import { byDay, formatSize, offerState } from "../src/update.js";

test("every change is listed, grouped by its day, in the order given", () => {
  const days = byDay([
    { commit: "a", at: "2026-10-24T10:00:00Z", text: "یک" },
    { commit: "b", at: "2026-10-24T08:00:00Z", text: "fix: two" },
    { commit: "c", at: "2026-10-23T08:00:00Z", text: "سه" },
  ]);
  assert.deepEqual(days.map((d) => d.items.map((c) => c.commit)), [["a", "b"], ["c"]]);
});

test("offer state follows the host", () => {
  assert.equal(offerState({ available: null }), null);
  assert.equal(offerState({ available: { commit: "x" } }), "offered");
  assert.equal(offerState({ available: { commit: "x" }, requested: "x" }), "waiting");
  assert.equal(offerState({ available: { commit: "x" }, status: { state: "failed" } }), "failed");
  assert.equal(offerState({ available: { commit: "x" } }, 1000, 2000), "waiting");
  assert.equal(offerState({ available: { commit: "x" } }, 1000, 1000 + 4 * 60_000), "offered");
});

test("the host's download shows before the button is pressed", () => {
  const u = (state, extra = {}) => ({ available: { commit: "x" }, status: { state }, ...extra });
  assert.equal(offerState(u("downloading")), "downloading");
  assert.equal(offerState(u("ready")), "ready");
  assert.equal(offerState(u("download-failed")), "download-failed");
  assert.equal(offerState(u("ready", { requested: "x" })), "waiting");
  assert.equal(offerState(u("installing", { requested: "x" })), "installing");
  assert.equal(formatSize(0), "");
  assert.match(formatSize(284 * 1024 ** 2), /مگابایت/);
});

test("the sidebar says what the update is doing and what it waits for", async () => {
  const { describeUpdate, autoLine } = await import("../src/update.js");
  const base = { available: { commit: "b".repeat(12) }, policy: { auto: true, quietSec: 600, gapLeftSec: 0, autoFailed: false } };
  // ready, chats open: waits for them
  assert.match(autoLine({ ...base, live: { active: 2, working: 1, quietSec: 0 } }), /۲ گفتگو باز/);
  // ready, quiet for 3 of 10 minutes
  assert.match(autoLine({ ...base, live: { active: 0, working: 0, quietSec: 180 } }), /۷ دقیقه دیگر/);
  assert.match(autoLine({ ...base, policy: { ...base.policy, auto: false } }), /خاموش/);
  assert.match(autoLine({ ...base, policy: { ...base.policy, autoFailed: true } }), /دوباره امتحان نمی‌شود/);
  assert.match(autoLine({ ...base, live: { active: 0, quietSec: 900 }, policy: { ...base.policy, gapLeftSec: 600 } }), /۱۰ دقیقه دیگر/);
  assert.match(autoLine({ ...base, live: { active: 0, quietSec: 900 } }), /چند لحظه/);
  // pressed: says which condition it waits for
  assert.match(describeUpdate({ ...base, live: { working: 3 } }, "waiting").sub, /۳ گفتگوی در حال کار/);
  assert.match(describeUpdate({ ...base, status: { state: "downloading", size: 5 * 1024 ** 2 } }, "waiting").sub, /دانلود/);
  assert.match(describeUpdate(base, "installing").sub, /۲ دقیقه/);
  assert.match(describeUpdate(base, "failed").sub, /قبلی برگشت/);
  assert.equal(describeUpdate(base, "ready").label, "آپدیت دانلود شد");
  assert.equal(describeUpdate(base, null).label, "");
});
