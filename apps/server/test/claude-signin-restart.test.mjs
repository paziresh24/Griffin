import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaudeSignin } from "../src/claude-signin.mjs";

function fakeClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write("Open https://claude.com/cai/oauth/authorize?code=true&state=x\\n");\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  return bin;
}

test("a code for a sign-in that no longer exists starts a new one and returns its address", async (t) => {
  const bin = fakeClaude();
  const signin = createClaudeSignin({ env: { ...process.env, GRIFFIN_CLAUDE_BIN: bin }, onToken: () => {} });
  t.after(() => {
    signin.cancel();
    fs.rmSync(path.dirname(bin), { recursive: true, force: true });
  });
  assert.equal(signin.pending("claude"), false);
  await assert.rejects(
    () => signin.submit("claude", "abc#def"),
    (error) => /oauth\/authorize/.test(error.restarted?.url || ""),
  );
  assert.equal(signin.pending("claude"), true);
});
