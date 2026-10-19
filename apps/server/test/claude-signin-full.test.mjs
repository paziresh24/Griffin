import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaudeSignin } from "../src/claude-signin.mjs";

// A stand-in for `claude auth login --claudeai`: prints the sign-in address, treats a multi-character
// write as a paste (a lone Enter submits), then either writes .credentials.json into CLAUDE_CONFIG_DIR
// and exits (code ending "#ok") or prints "Login failed" and waits.
function fakeClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-full-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.slice(2).join(" ") !== "auth login --claudeai") { console.log("wrong args: " + process.argv.slice(2).join(" ")); process.exit(2); }
process.stdout.write("Opening browser to sign in…\\nhttps://claude.com/cai/oauth/authorize?code=true&scope=user%3Aprofile+user%3Ainference&state=x\\nPaste code here if prompted > ");
let text = "";
process.stdin.setRawMode?.(true);
process.stdin.on("data", (chunk) => {
  const s = chunk.toString();
  if (s === "\\r") {
    if (text.endsWith("#ok")) {
      fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), '{"claudeAiOauth":{}}');
      process.stdout.write("Login successful.\\n");
      process.exit(0);
    }
    process.stdout.write("Login failed: Request failed with status code 400\\n");
    return;
  }
  text += s.replace(/\\r/g, "");
});
`,
    { mode: 0o755 },
  );
  return bin;
}

const harness = (t, extra = {}) => {
  const bin = fakeClaude();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signin-data-"));
  const logins = [];
  const signin = createClaudeSignin({
    env: { ...process.env, GRIFFIN_CLAUDE_BIN: bin },
    loginDir: (id) => path.join(data, "claude-accounts", id),
    onLogin: (id, dir) => logins.push({ id, dir }),
    onToken: () => assert.fail("a full login must not use the token flow"),
    ...extra,
  });
  t.after(() => {
    signin.cancel();
    fs.rmSync(path.dirname(bin), { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });
  return { signin, data, logins };
};

test("a good code leaves the login in the account's own folder and tells onLogin", async (t) => {
  const { signin, data, logins } = harness(t);
  const { url } = await signin.start("claude-3");
  assert.match(url, /oauth\/authorize/);
  await signin.submit("claude-3", "abc#ok");
  const dir = path.join(data, "claude-accounts", "claude-3");
  assert.deepEqual(logins, [{ id: "claude-3", dir }]);
  assert.equal(fs.existsSync(path.join(dir, ".credentials.json")), true, "the login folder is kept");
});

test("a rejected code is reported and an earlier login in that folder stays", async (t) => {
  const { signin, data, logins } = harness(t);
  const dir = path.join(data, "claude-accounts", "claude-3");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".credentials.json"), "OLD");
  await signin.start("claude-3");
  await assert.rejects(() => signin.submit("claude-3", "abc#bad"), /rejected the code/);
  assert.equal(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"), "OLD");
  assert.deepEqual(logins, []);
});

test("an old login in the folder does not count as the new one", async (t) => {
  const { signin, data, logins } = harness(t);
  const dir = path.join(data, "claude-accounts", "claude-3");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".credentials.json"), "OLD");
  await signin.start("claude-3");
  // the old file is there before the code: nothing may finish until Claude writes a newer one
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(logins, []);
  await signin.submit("claude-3", "abc#ok");
  assert.equal(logins.length, 1);
});
