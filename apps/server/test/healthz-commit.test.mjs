// /healthz names the running commit, so anyone can prove from a public hostname which code serves
// it. The commit is stamped at build time into
// apps/server/BUILD_COMMIT; a git checkout without the stamp answers with `git rev-parse HEAD`;
// unknown => the field is left out (never a guess).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";
import { readBuildCommit } from "../src/build-commit.mjs";

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-healthz-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sdk = { async create() { throw new Error("no runs"); }, async resume() { throw new Error("no runs"); } };
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {} });
  const app = createApp({ store, runner, ...opts });
  return { app, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: os.tmpdir() };
for (const k of Object.keys(gitEnv)) if (k.startsWith("GIT_") && k !== "GIT_CONFIG_NOSYSTEM") delete gitEnv[k];

test("/healthz carries the 12-character commit it was given", async () => {
  const { app, cleanup } = setup({ buildCommit: "0123456789ab" });
  try {
    const res = await app.request("/healthz");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.commit, "0123456789ab");
    // Griffin's own fields stay (griffin-update and install.sh read workingRuns).
    assert.equal(body.ok, true);
    assert.equal(body.workingRuns, 0);
    assert.ok("version" in body && "activeRuns" in body);
  } finally { cleanup(); }
});

test("/healthz without a known commit leaves the field out", async () => {
  const { app, cleanup } = setup({ buildCommit: null });
  try {
    assert.equal("commit" in (await (await app.request("/healthz")).json()), false);
  } finally { cleanup(); }
});

test("readBuildCommit: the stamped file wins and is cut to 12 characters", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-bc-"));
  try {
    fs.mkdirSync(path.join(root, "apps/server"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps/server/BUILD_COMMIT"), `${SHA}\n`);
    assert.equal(readBuildCommit({ root }), SHA.slice(0, 12));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("readBuildCommit: a stamp that is not a commit id is ignored; no git => null", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-bc-"));
  try {
    fs.mkdirSync(path.join(root, "apps/server"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps/server/BUILD_COMMIT"), "not a sha; rm -rf /\n");
    assert.equal(readBuildCommit({ root, env: gitEnv, gitCeiling: path.dirname(root) }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("readBuildCommit: a git checkout without a stamp answers with its HEAD", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-bc-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: root, env: gitEnv, encoding: "utf8" }).trim();
    git("init", "-q");
    fs.writeFileSync(path.join(root, "f"), "x");
    git("add", "f");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
    const head = git("rev-parse", "HEAD");
    fs.mkdirSync(path.join(root, "apps/server"), { recursive: true });
    assert.equal(readBuildCommit({ root, env: gitEnv }), head.slice(0, 12));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("readBuildCommit: an app copied inside another repo does not answer with that repo's HEAD", () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-bc-outer-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: outer, env: gitEnv, encoding: "utf8" }).trim();
    git("init", "-q");
    fs.writeFileSync(path.join(outer, "f"), "x");
    git("add", "f");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
    const root = path.join(outer, "karsara", "app");
    fs.mkdirSync(path.join(root, "apps/server"), { recursive: true });
    assert.equal(readBuildCommit({ root, env: gitEnv }), null);
  } finally { fs.rmSync(outer, { recursive: true, force: true }); }
});

test("/healthz tells how long the install has been quiet", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-quiet-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sdk = { async create() { throw new Error("no runs"); }, async resume() { throw new Error("no runs"); } };
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {} });
  const app = createApp({ store, runner, buildCommit: null });
  try {
    // No event yet: the field is left out (unknown is never a guess).
    assert.equal("quietSec" in (await (await app.request("/healthz")).json()), false);
    const chat = store.createChat({ title: "t" });
    store.db.prepare("INSERT INTO events (chat_id, run_id, type, data, at) VALUES (?, NULL, 'user', '{}', ?)").run(chat.id, new Date(Date.now() - 125_000).toISOString());
    const q = (await (await app.request("/healthz")).json()).quietSec;
    assert.ok(q >= 125 && q < 140, `quietSec=${q}`);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
