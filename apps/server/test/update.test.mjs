import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { changesSince, createUpdates } from "../src/update.mjs";

const release = { commit: "bbbbbbbbbbbb", sha: "b".repeat(40), at: "2026-10-18T05:00:00Z", changes: [
  { commit: "bbbbbbbbbbbb", text: "آپدیت از سایدبار" },
  { commit: "cccccccccccc", text: "fix: x" },
  { commit: "aaaaaaaaaaaa", text: "قبلی" },
] };

test("changesSince stops at the running commit", () => {
  assert.deepEqual(changesSince(release.changes, "aaaaaaaaaaaa").map((c) => c.commit), ["bbbbbbbbbbbb", "cccccccccccc"]);
  assert.equal(changesSince(release.changes, "zzzz").length, 3);
});

test("changesSince matches the main commit an install runs, not only an MR's own commit", () => {
  const changes = [
    { commit: "111111111111", main: "e3e3e3e3e3e3", text: "سه" },
    { commit: "222222222222", main: "e2e2e2e2e2e2", text: "دو الف" },
    { commit: "333333333333", main: "e2e2e2e2e2e2", text: "دو ب" },
    { commit: "444444444444", main: "e1e1e1e1e1e1", text: "یک" },
  ];
  assert.deepEqual(changesSince(changes, "e2e2e2e2e2e2").map((c) => c.text), ["سه"]);
  assert.deepEqual(changesSince(changes, "e1e1e1e1e1e1").map((c) => c.text), ["سه", "دو الف", "دو ب"]);
  assert.equal(changesSince(changes, "ffffffffffff").length, 4, "older than the list: all of it, not ten");
});

test("a press carries over to a release published after it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-"));
  fs.writeFileSync(path.join(dir, "available.json"), JSON.stringify(release));
  fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify({ commit: "dddddddddddd", at: "x" }));
  assert.equal(createUpdates({ dir, current: "aaaaaaaaaaaa" }).state().requested, "bbbbbbbbbbbb");
});

test("offer, request, and nothing offered once running it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-"));
  const none = createUpdates({ dir, current: "aaaaaaaaaaaa" });
  assert.equal(none.state().available, null);
  assert.ok(none.request().error);
  fs.writeFileSync(path.join(dir, "available.json"), JSON.stringify(release));
  const u = createUpdates({ dir, current: "aaaaaaaaaaaa" });
  assert.equal(u.state().available.commit, "bbbbbbbbbbbb");
  assert.equal(u.state().available.changes.length, 2);
  assert.ok(u.request("dddddddddddd").error, "stale commit refused");
  assert.equal(u.request("bbbbbbbbbbbb").ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8")).commit, "bbbbbbbbbbbb");
  assert.equal(u.state().requested, "bbbbbbbbbbbb");
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "ready", commit: "bbbbbbbbbbbb", size: 1234 }));
  assert.deepEqual([u.state().status.state, u.state().status.size], ["ready", 1234]);
  assert.ok(u.state().checkedAt);
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "failed", commit: "bbbbbbbbbbbb" }));
  assert.equal(u.state().status.state, "failed");
  assert.equal(createUpdates({ dir, current: "bbbbbbbbbbbb" }).state().available, null);
});

test("English lines are put into Persian once by the install's own model and kept", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-"));
  fs.writeFileSync(path.join(dir, "available.json"), JSON.stringify(release));
  let calls = 0;
  const translate = async (prompt) => {
    calls += 1;
    assert.match(prompt, /fix: x/);
    assert.doesNotMatch(prompt, /آپدیت از سایدبار/);
    return 'بفرمایید: ["یک اشکال رفع شد"]';
  };
  const u = createUpdates({ dir, current: "aaaaaaaaaaaa", translate, log: { error() {} } });
  assert.equal(u.state().translating, true);
  await u.settled();
  assert.deepEqual(u.state().available.changes.map((c) => c.text), ["آپدیت از سایدبار", "یک اشکال رفع شد"]);
  const again = createUpdates({ dir, current: "aaaaaaaaaaaa", translate });
  assert.equal(again.state().available.changes[1].text, "یک اشکال رفع شد");
  assert.equal(calls, 1, "kept, not asked again");
});

test("a request that cannot be written answers with a Persian error, never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-"));
  fs.writeFileSync(path.join(dir, "available.json"), JSON.stringify(release));
  fs.mkdirSync(path.join(dir, "request.json")); // stands in for a request.json the app may not replace
  const u = createUpdates({ dir, current: "aaaaaaaaaaaa" });
  const out = u.request("bbbbbbbbbbbb");
  assert.ok(out.error && /request\.json/.test(out.error), JSON.stringify(out));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("request.json.")), [], "the temp file is removed");
});

test("the host's policy is passed on, malformed policy is ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-"));
  fs.writeFileSync(path.join(dir, "available.json"), JSON.stringify(release));
  const u = createUpdates({ dir, current: "aaaaaaaaaaaa" });
  assert.equal(u.state().policy, null);
  fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ auto: false, quietSec: 600, gapLeftSec: 90, autoFailed: true }));
  assert.deepEqual(u.state().policy, { auto: false, quietSec: 600, gapLeftSec: 90, autoFailed: true });
  fs.writeFileSync(path.join(dir, "policy.json"), "{broken");
  assert.equal(u.state().policy, null);
});

// 2026-10-21: an out-of-credit account was asked again on every page load (every ~1.5 minutes).
test("a failed translation is not retried for half an hour", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-"));
  fs.writeFileSync(path.join(dir, "available.json"), JSON.stringify(release));
  let calls = 0;
  const u = createUpdates({ dir, current: "aaaaaaaaaaaa", translate: async () => { calls += 1; throw new Error("Credit balance is too low"); }, log: { error() {} } });
  u.state();
  await u.settled();
  u.state();
  await u.settled();
  assert.equal(calls, 1);
});
