import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountLoginDir, hasLogin, isLoginDirKey, linkSharedEntries, loginDirKey, loginDirOf, removeLoginDir } from "../src/claude-account-dir.mjs";
import { claudeAuthEnv, createClaudeProvider } from "../src/providers/claude.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "claude-acct-"));

test("the marker is not a secret and round-trips", () => {
  const dir = "/data/claude-accounts/claude-3";
  assert.equal(isLoginDirKey(loginDirKey(dir)), true);
  assert.equal(loginDirOf(loginDirKey(dir)), dir);
  assert.equal(isLoginDirKey("sk-ant-oat01-abc"), false);
  assert.equal(accountLoginDir("/data", "claude-3"), dir);
  assert.equal(accountLoginDir("/data", "../etc"), null);
});

test("linking shares settings, skills and conversations — never the login", () => {
  const main = tmp();
  const dir = path.join(tmp(), "acct");
  fs.writeFileSync(path.join(main, "CLAUDE.md"), "rules");
  fs.writeFileSync(path.join(main, "settings.json"), "{}");
  fs.mkdirSync(path.join(main, "skills"));
  fs.writeFileSync(path.join(main, ".credentials.json"), "MAIN-LOGIN");
  fs.writeFileSync(path.join(main, ".claude.json"), "{}");
  const linked = linkSharedEntries({ dir, main });
  assert.deepEqual(linked.sort(), ["CLAUDE.md", "projects", "settings.json", "skills"]);
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), "rules");
  assert.equal(fs.existsSync(path.join(main, "projects")), true, "projects is created in the main folder first");
  assert.equal(fs.existsSync(path.join(dir, ".credentials.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".claude.json")), false);
  assert.equal(hasLogin(dir), false);
  // again: nothing is replaced, nothing breaks
  assert.deepEqual(linkSharedEntries({ dir, main }), []);
});

test("an account's own file is left alone", () => {
  const main = tmp();
  const dir = tmp();
  fs.writeFileSync(path.join(main, "settings.json"), "main");
  fs.writeFileSync(path.join(dir, "settings.json"), "own");
  linkSharedEntries({ dir, main });
  assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), "own");
});

test("removing an account folder never touches what its links point to", () => {
  const data = tmp();
  const main = tmp();
  fs.writeFileSync(path.join(main, "CLAUDE.md"), "rules");
  const dir = accountLoginDir(data, "claude-3");
  linkSharedEntries({ dir, main });
  fs.writeFileSync(path.join(dir, ".credentials.json"), "x");
  assert.equal(hasLogin(dir), true);
  assert.equal(removeLoginDir(data, "claude-3"), true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(path.join(main, "CLAUDE.md"), "utf8"), "rules");
  assert.equal(fs.existsSync(path.join(main, "projects")), true);
  assert.equal(removeLoginDir(data, "../x"), false);
});

test("a folder login runs with CLAUDE_CONFIG_DIR and no token in the environment", () => {
  const env = claudeAuthEnv(loginDirKey("/data/claude-accounts/claude-3"));
  assert.equal(env.CLAUDE_CONFIG_DIR, "/data/claude-accounts/claude-3");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("health of a folder login asks `claude auth status`: logged in = ok, otherwise refused (401)", async () => {
  const key = loginDirKey("/data/claude-accounts/claude-3");
  const good = createClaudeProvider({ apiKey: key, statusImpl: async () => JSON.stringify({ loggedIn: true, email: "a@b.c", subscriptionType: "max" }) });
  const h = await good.health();
  assert.equal(h.ok, true);
  assert.equal(h.status, 200);
  const bad = createClaudeProvider({ apiKey: key, statusImpl: async () => JSON.stringify({ loggedIn: false }) });
  const g = await bad.health();
  assert.equal(g.ok, false);
  assert.equal(g.status, 401);
  const none = createClaudeProvider({ apiKey: key, statusImpl: async () => null });
  assert.equal((await none.health()).status, 401);
});
