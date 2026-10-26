import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Adding a Claude subscription account (a second one too) from the browser. Griffin runs the bundled Claude binary's
// `setup-token` under a pseudo-terminal (it prints nothing without one), hands the owner its sign-in
// address, passes the code the owner pastes to its stdin, and keeps the long-lived token it prints —
// straight into the secret store. Nothing here logs the output, the code or the token.
//
// With `loginDir` the account gets the FULL login instead (`claude auth login --claudeai`, 2026-10-19):
// the same pseudo-terminal flow, but the login lands in the account's own folder as .credentials.json
// (profile, usage, sessions, connectors, uploads, plugins — a setup-token carries only inference), and
// `onLogin(accountId, dir)` is told instead of `onToken`.

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]/g;
const SIGN_IN = /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com|console\.anthropic\.com)\/[^\s\x07\x1b"'<>]*oauth\/authorize\?[^\s\x07\x1b"'<>]+/;
const TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{40,}/;
const CODE = /^[\x21-\x7e]{1,2048}$/;

// What the terminal shows. Claude's UI redraws only the cells that changed and jumps over the rest
// with cursor moves, so dropping escape codes loses characters (owner 2026-10-18: the stored token
// came out "sk-ant-at01-…", its "o" left over from the previous frame). Enough of a VT100 for that.
const SEQ = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[([0-9;?>=<]*)([@-~])|\x1b([78])|\x1b[()][A-Za-z0-9]|\x1b.?|[^\x1b]/g;
export function screen(raw) {
  const rows = [[]];
  let r = 0;
  let c = 0;
  let saved = [0, 0];
  const row = () => (rows[r] ||= []);
  for (const [t, params, final, cursor] of raw.matchAll(SEQ)) {
    if (final) {
      if (/[?>=<]/.test(params)) continue;
      const [a, b] = params.split(";").map((v) => parseInt(v, 10));
      const n = a || 1;
      if (final === "A") r = Math.max(0, r - n);
      else if (final === "B") r += n;
      else if (final === "C") c += n;
      else if (final === "D") c = Math.max(0, c - n);
      else if (final === "G") c = n - 1;
      else if (final === "H" || final === "f") [r, c] = [(a || 1) - 1, (b || 1) - 1];
      else if (final === "K") rows[r] = a === 2 ? [] : a === 1 ? Array.from(row(), (x, i) => (i <= c ? " " : x)) : row().slice(0, c);
      else if (final === "J" && !a) (rows[r] = row().slice(0, c)), (rows.length = r + 1);
      else if (final === "J" && a === 2) (rows.length = 0), rows.push([]);
    } else if (cursor) {
      if (cursor === "7") saved = [r, c];
      else [r, c] = saved;
    } else if (t === "\r") c = 0;
    else if (t === "\n") r += 1;
    else if (t === "\b") c = Math.max(0, c - 1);
    else if (t.length === 1 && t >= " ") row()[c++] = t;
  }
  return Array.from({ length: rows.length }, (_, i) => Array.from(rows[i] || [], (x) => x ?? " ").join("").trimEnd()).join("\n");
}

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

const credentialsAt = (dir) => {
  try {
    return fs.statSync(path.join(dir, ".credentials.json")).mtimeMs;
  } catch {
    return 0;
  }
};

// Claude's own words after the code went in («OAuth error: Request failed with status code 400», «Login
// failed: …»), so the page says what really happened instead of guessing «expired».
export function claudeSaid(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const hit = lines.findLast((l) => /Login failed|OAuth error/i.test(l)) || lines.at(-1) || "";
  return hit.replace(/Press Enter to retry\.?/i, "").trim().slice(0, 240) || "no reason given";
}

export function createClaudeSignin({ onToken, onLogin = null, loginDir = null, env = process.env, timeoutMs = 30 * 60_000 } = {}) {
  let attempt = null;

  function stop() {
    if (!attempt) return;
    clearTimeout(attempt.timer);
    clearTimeout(attempt.enter);
    clearInterval(attempt.poll);
    try {
      attempt.child.kill("SIGKILL");
    } catch {
      // already gone
    }
    // A folder login is the account's own: only a throwaway sign-in folder is removed.
    if (!attempt.keepDir) fs.rmSync(attempt.dir, { recursive: true, force: true });
    attempt = null;
  }

  return {
    available: () => Boolean(claudeBinary(env)),
    /** A sign-in for this account is waiting for its code. */
    pending: (accountId) => attempt?.accountId === accountId,

    /** Starts a sign-in for an account; resolves with the address the owner opens. */
    start(accountId) {
      const bin = claudeBinary(env);
      if (!bin) return Promise.reject(new Error("the Claude binary is not installed on this server"));
      stop();
      const own = typeof loginDir === "function" && typeof onLogin === "function" ? loginDir(accountId) : null;
      if (own) fs.mkdirSync(own, { recursive: true, mode: 0o700 });
      const dir = own || fs.mkdtempSync(path.join(os.tmpdir(), "griffin-claude-signin-"));
      // `script` gives it a terminal; a wide one keeps the token on one line.
      const child = spawn("script", ["-qfc", `stty cols 4000 2>/dev/null; exec ${JSON.stringify(bin)} ${own ? "auth login --claudeai" : "setup-token"}`, "/dev/null"], {
        env: { ...env, CLAUDE_CONFIG_DIR: dir, BROWSER: "true", COLUMNS: "4000" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const current = { accountId, child, dir, out: "", url: null, done: null, keepDir: Boolean(own), full: Boolean(own), credsBefore: own ? credentialsAt(dir) : 0 };
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
          if (current.done && (current.full ? /Login failed|OAuth error/i : /OAuth error/i).test(plain.slice(current.submittedAt))) {
            const fail = current.done;
            current.done = null;
            fail.reject(new Error(`Claude rejected the code: ${claudeSaid(plain.slice(current.submittedAt))}`));
            stop();
            return;
          }
          if (current.full) return; // a full login is told by its credentials file (submit polls it)
          // Claude prints the token in a wrapped Text between "(valid for …):" and "Store this token";
          // a wrap must not split it.
          const shown = current.done ? screen(raw).match(/\)\s*:([\s\S]*?)Store this token/)?.[1] : null;
          const token = shown?.replace(/\s+/g, "").match(TOKEN)?.[0];
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
          current.exited = true;
          clearTimeout(current.enter);
        });
        // Claude exits right after printing the token: "exit" can come before that last output is read,
        // so a missing token is only decided once its output has closed.
        child.on("close", () => {
          if (!current.url) reject(new Error("Claude sign-in ended before showing an address"));
          // A full login ends the process right after writing its credentials: the poll tells that apart.
          const loggedIn = current.full && credentialsAt(current.dir) > current.credsBefore;
          if (current.done && !loggedIn) {
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
      if (!attempt || attempt.accountId !== accountId) {
        // The sign-in this code belongs to is gone (restart, timeout, another tab). A code only works for
        // the sign-in that made it, so start a new one and hand its address back instead of a bare error.
        return this.start(accountId).then(
          ({ url }) => Promise.reject(Object.assign(new Error("the earlier sign-in had ended; a new one was started"), { restarted: { url } })),
          () => Promise.reject(new Error("no sign-in in progress for this account — start again")),
        );
      }
      if (!CODE.test(value)) return Promise.reject(new Error("that does not look like a sign-in code"));
      const current = attempt;
      if (current.done) return Promise.reject(new Error("a code is already being checked for this account"));
      return new Promise((resolve, reject) => {
        current.done = { resolve, reject };
        current.submittedAt = current.out.replace(ANSI, "").length;
        if (current.full) {
          // The login is done when Claude has written (or rewritten) .credentials.json in the folder.
          current.poll = setInterval(() => {
            if (!current.done || credentialsAt(current.dir) <= current.credsBefore) return;
            clearInterval(current.poll);
            const finish = current.done;
            current.done = null;
            // A moment for Claude to finish writing the file, then hand the folder over.
            setTimeout(() => {
              Promise.resolve(onLogin(current.accountId, current.dir)).then(() => finish.resolve({ ok: true }), finish.reject);
              if (attempt === current) stop();
            }, 400);
          }, 300);
          // not unref'd: the poll keeps the result of a short-lived `claude auth login` process in sight
        }
        // Claude's terminal treats code + Return in one write as a paste and never submits it
        // (owner 2026-10-18: the request hung until 504). Send Return after its paste debounce.
        current.child.stdin.write(value);
        current.enter = setTimeout(() => {
          if (attempt === current && current.done && !current.exited) current.child.stdin.write("\r");
        }, 500);
        current.enter.unref?.();
        setTimeout(() => {
          clearInterval(current.poll);
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
