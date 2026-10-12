import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Adding a Claude subscription account (a second one too) from the browser. Griffin runs the bundled Claude binary's
// `setup-token` under a pseudo-terminal (it prints nothing without one), hands the owner its sign-in
// address, passes the code the owner pastes to its stdin, and keeps the long-lived token it prints —
// straight into the secret store. Nothing here logs the output, the code or the token.

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]/g;
const SIGN_IN = /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com|console\.anthropic\.com)\/[^\s\x07\x1b"'<>]*oauth\/authorize\?[^\s\x07\x1b"'<>]+/;
const TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{40,}/;
const CODE = /^[\x21-\x7e]{1,2048}$/;

export function claudeBinary(env = process.env) {
  if (env.GRIFFIN_CLAUDE_BIN) return env.GRIFFIN_CLAUDE_BIN;
  const require = createRequire(import.meta.url);
  for (const pkg of [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, "@anthropic-ai/claude-agent-sdk"]) {
    try {
      const dir = path.dirname(require.resolve(`${pkg}/package.json`));
      const bin = path.join(dir, "claude");
      if (fs.existsSync(bin)) return bin;
    } catch {
      // not installed for this platform
    }
  }
  return null;
}

export function createClaudeSignin({ onToken, env = process.env, timeoutMs = 10 * 60_000 } = {}) {
  let attempt = null;

  function stop() {
    if (!attempt) return;
    clearTimeout(attempt.timer);
    try {
      attempt.child.kill("SIGKILL");
    } catch {
      // already gone
    }
    fs.rmSync(attempt.dir, { recursive: true, force: true });
    attempt = null;
  }

  return {
    available: () => Boolean(claudeBinary(env)),

    /** Starts a sign-in for an account; resolves with the address the owner opens. */
    start(accountId) {
      const bin = claudeBinary(env);
      if (!bin) return Promise.reject(new Error("the Claude binary is not installed on this server"));
      stop();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-claude-signin-"));
      // `script` gives it a terminal; a wide one keeps the token on one line.
      const child = spawn("script", ["-qfc", `stty cols 4000 2>/dev/null; exec ${JSON.stringify(bin)} setup-token`, "/dev/null"], {
        env: { ...env, CLAUDE_CONFIG_DIR: dir, BROWSER: "true", COLUMNS: "4000" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const current = { accountId, child, dir, out: "", url: null, done: null };
      attempt = current;
      current.timer = setTimeout(() => attempt === current && stop(), timeoutMs);
      current.timer.unref?.();
      return new Promise((resolve, reject) => {
        const onData = (chunk) => {
          current.out = (current.out + chunk.toString("utf8")).slice(-200_000);
          const raw = current.out;
          if (!current.url) {
            const url = raw.match(SIGN_IN)?.[0] || raw.replace(ANSI, "").match(SIGN_IN)?.[0];
            if (url) {
              current.url = url;
              resolve({ url });
            }
          }
          const plain = raw.replace(ANSI, "");
          if (current.done && /OAuth error/i.test(plain.slice(current.submittedAt))) {
            const fail = current.done;
            current.done = null;
            fail.reject(new Error("Claude rejected the code (it may have expired) — start the sign-in again"));
            stop();
            return;
          }
          const token = plain.replace(/\s+/g, " ").match(TOKEN)?.[0];
          if (token && current.done) {
            const finish = current.done;
            current.done = null;
            Promise.resolve(onToken(current.accountId, token)).then(() => finish.resolve({ ok: true }), finish.reject);
            stop();
          }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (error) => reject(new Error(`could not start Claude sign-in (${error.code || "error"})`)));
        child.on("exit", () => {
          if (!current.url) reject(new Error("Claude sign-in ended before showing an address"));
          if (current.done) {
            current.done.reject(new Error("Claude did not accept the code"));
            current.done = null;
          }
        });
        setTimeout(() => !current.url && reject(new Error("Claude sign-in did not show an address in time")), 30_000).unref?.();
      });
    },

    /** The code from the sign-in page; resolves once the token is stored. */
    submit(accountId, code) {
      const value = String(code || "").trim();
      if (!attempt || attempt.accountId !== accountId) return Promise.reject(new Error("no sign-in in progress for this account — start again"));
      if (!CODE.test(value)) return Promise.reject(new Error("that does not look like a sign-in code"));
      const current = attempt;
      return new Promise((resolve, reject) => {
        current.done = { resolve, reject };
        current.submittedAt = current.out.replace(ANSI, "").length;
        current.child.stdin.write(`${value}\r`);
        setTimeout(() => {
          if (current.done) {
            current.done = null;
            reject(new Error("Claude did not return a token — the code may have expired; start again"));
            if (attempt === current) stop();
          }
        }, 90_000).unref?.();
      });
    },

    cancel: stop,
  };
}
