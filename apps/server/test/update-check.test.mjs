import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { changesFromCommits, createUpdateCheck, UPDATE_COMMAND } from "../src/update-check.mjs";
import { createUpdates } from "../src/update.mjs";

const commit = (n, message) => ({ sha: `${n}`.repeat(40).slice(0, 40), commit: { message, committer: { date: `2026-11-1${n}T10:00:00Z` } } });
const ANSWER = [commit(3, "feat: three\n\nbody"), commit(2, "Merge branch 'x' into 'main'"), commit(1, "fix: one")];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "upd-"));
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test("changes are the commits newer than this build, merges and handoff notes left out", () => {
  const out = changesFromCommits(ANSWER, "1".repeat(12));
  assert.deepEqual(out.map((c) => c.text), ["feat: three"]);
  assert.equal(out[0].commit, "3".repeat(12));
  // A build older than the whole page gets all of it; an unknown build only the newest few.
  assert.equal(changesFromCommits(ANSWER, "9".repeat(12)).length, 2);
  assert.equal(changesFromCommits(ANSWER, null).length, 2);
});

test("a newer main is written as available.json and the sidebar state says «manual» with the command", async () => {
  const dir = tmp();
  const check = createUpdateCheck({ dir, current: "1".repeat(12), fetchImpl: ok(ANSWER), log: { warn() {} } });
  const out = await check.check();
  assert.equal(out.available, "3".repeat(12));
  const written = JSON.parse(fs.readFileSync(path.join(dir, "available.json"), "utf8"));
  assert.equal(written.source, "github");
  const state = createUpdates({ dir, current: "1".repeat(12) }).state();
  assert.equal(state.manual, true);
  assert.equal(state.command, UPDATE_COMMAND);
  assert.equal(state.available.commit, "3".repeat(12));
  assert.match(createUpdates({ dir, current: "1".repeat(12) }).request().error, /install\.sh/);
});

test("when this build is the newest the offer goes away", async () => {
  const dir = tmp();
  const check = createUpdateCheck({ dir, current: "1".repeat(12), fetchImpl: ok(ANSWER), log: { warn() {} } });
  await check.check();
  const same = createUpdateCheck({ dir, current: "3".repeat(12), fetchImpl: ok(ANSWER), log: { warn() {} } });
  assert.deepEqual(await same.check(), { current: true });
  assert.equal(fs.existsSync(path.join(dir, "available.json")), false);
});

test("a host agent's own files are never touched, and GRIFFIN_UPDATE_CHECK=off stops it", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "available.json"), JSON.stringify({ commit: "f".repeat(12), at: "x", changes: [] }));
  let calls = 0;
  const f = async () => { calls += 1; return { ok: true, json: async () => ANSWER }; };
  const hosted = createUpdateCheck({ dir, current: "1".repeat(12), fetchImpl: f, log: { warn() {} } });
  assert.deepEqual(await hosted.check(), { skipped: "host-managed" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "available.json"), "utf8")).commit, "f".repeat(12));
  const dir2 = tmp();
  const off = createUpdateCheck({ dir: dir2, current: "1".repeat(12), fetchImpl: f, env: { GRIFFIN_UPDATE_CHECK: "off" } });
  assert.deepEqual(await off.check(), { skipped: "off" });
  const none = createUpdateCheck({ dir: dir2, current: null, fetchImpl: f });
  assert.deepEqual(await none.check(), { skipped: "unknown current version" });
  assert.equal(calls, 0);
});

test("no route to GitHub keeps the old file and warns once", async () => {
  const dir = tmp();
  const warns = [];
  const check = createUpdateCheck({ dir, current: "1".repeat(12), fetchImpl: async () => { throw new Error("offline"); }, log: { warn: (m) => warns.push(m) } });
  assert.match((await check.check()).error, /offline/);
  await check.check();
  assert.equal(warns.length, 1);
  assert.equal(fs.existsSync(path.join(dir, "available.json")), false);
});
