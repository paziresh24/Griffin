import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loginDirKey } from "../src/claude-account-dir.mjs";
import { loginGate, loginState, noteLogin } from "../src/claude-login-guard.mjs";

const account = (oauth) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "login-guard-"));
  const write = (o) => fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: o }));
  write(oauth);
  return { dir, key: loginDirKey(dir), write };
};
const tokens = (n, expiresAt) => ({ accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresAt });

test("loginState never carries a token value", () => {
  const { dir } = account(tokens(1, 1234));
  const state = loginState(dir);
  assert.equal(state.empty, false);
  assert.equal(state.expiresAt, 1234);
  assert.equal(JSON.stringify(state).includes("access-1"), false);
  assert.equal(JSON.stringify(state).includes("refresh-1"), false);
});

test("noteLogin logs a refresh and tokens going empty", () => {
  const a = account(tokens(1, Date.now() + 1e6));
  const lines = [];
  const log = (line) => lines.push(line);
  noteLogin(a.key, "t0", { log });
  a.write(tokens(2, Date.now() + 2e6));
  noteLogin(a.key, "t1", { log });
  a.write({ accessToken: "", refreshToken: "", expiresAt: 0 });
  noteLogin(a.key, "t2", { log });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /refreshed/);
  assert.match(lines[1], /went EMPTY/);
  assert.equal(lines.join("").includes("refresh-"), false);
});

test("a key that is not a login folder, or a fresh token, passes at once", async () => {
  await loginGate("sk-ant-oat01-x");
  const a = account(tokens(1, Date.now() + 3_600_000));
  const started = Date.now();
  await Promise.all([loginGate(a.key), loginGate(a.key), loginGate(a.key)]);
  assert.ok(Date.now() - started < 200);
});

test("with an expiring token the second process waits for the first one's refresh", async () => {
  const a = account(tokens(1, Date.now() + 1000));
  const order = [];
  await loginGate(a.key, { log: () => {} });
  order.push("first-start");
  const second = loginGate(a.key, { log: () => {} }).then(() => order.push("second-start"));
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(order, ["first-start"], "second still waits");
  // the first process refreshes: the file moves, the line opens
  a.write(tokens(2, Date.now() + 3_600_000));
  fs.utimesSync(path.join(a.dir, ".credentials.json"), new Date(), new Date(Date.now() + 5000));
  await second;
  assert.deepEqual(order, ["first-start", "second-start"]);
});

test("the wait has a limit", async () => {
  const a = account(tokens(1, Date.now() + 1000));
  await loginGate(a.key, { waitMs: 300, log: () => {} });
  const started = Date.now();
  await loginGate(a.key, { waitMs: 300, log: () => {} });
  assert.ok(Date.now() - started >= 250 && Date.now() - started < 1500);
});
