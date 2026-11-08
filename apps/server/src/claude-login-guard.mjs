import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isLoginDirKey, loginDirOf } from "./claude-account-dir.mjs";

// Why a full-login Claude account gets signed out (a colleague 2026-11-04: three accounts showed «OAuth
// session expired and could not be refreshed»; the stored access and refresh tokens were empty — Claude
// Code blanks them when Anthropic rejects a refresh). The refresh token is single-use: if two processes
// of one account refresh it together, the loser holds a dead token. Claude Code's own lock between
// processes is not enough (its telemetry showed «dead holder takeover» on a contended lock), and the app
// starts several processes per account at once (the chat, its title, the usage gauge, the probe).
//
// Two things here, nothing else:
//  1. loginGate(key): a process that would need a refresh waits until the one ahead has finished it
//     (the credentials file changed) or a short timeout passed. A fresh token never waits.
//  2. noteLogin(key, tag): logs when an account's login changed or went empty — only a short hash
//     of each token and its expiry, never a token — so the next sign-out has a timeline.

export const NEAR_EXPIRY_MS = 5 * 60_000;
export const GATE_WAIT_MS = 20_000;

const credFile = (dir) => path.join(dir, ".credentials.json");

/** What the account's login file holds, without any token value: {empty, expiresAt, access, refresh, mtimeMs} or null. */
export function loginState(dir) {
  try {
    const file = credFile(dir);
    const oauth = JSON.parse(fs.readFileSync(file, "utf8"))?.claudeAiOauth || {};
    const short = (value) => (value ? crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 8) : "");
    return {
      empty: !oauth.accessToken || !oauth.refreshToken,
      expiresAt: Number(oauth.expiresAt) || 0,
      access: short(oauth.accessToken),
      refresh: short(oauth.refreshToken),
      mtimeMs: fs.statSync(file).mtimeMs,
    };
  } catch {
    return null;
  }
}

const last = new Map();
const tails = new Map();

/** Logs a change in the account's login since the last look (a refresh, or the tokens going empty). */
export function noteLogin(key, tag = "", { log = console.error } = {}) {
  const dir = isLoginDirKey(key) ? loginDirOf(key) : null;
  if (!dir) return null;
  const state = loginState(dir);
  const before = last.get(dir);
  last.set(dir, state);
  if (!state || !before) return state;
  const name = path.basename(dir);
  if (state.empty && !before.empty) log(`[claude-login] ${name}: tokens went EMPTY (${tag}) — refresh was rejected; last refresh ${before.refresh}, access expired ${new Date(before.expiresAt).toISOString()}`);
  else if (state.refresh !== before.refresh && !state.empty) log(`[claude-login] ${name}: refreshed (${tag}) refresh ${before.refresh}→${state.refresh}, access valid until ${new Date(state.expiresAt).toISOString()}`);
  return state;
}

/**
 * Before starting a Claude process of a full-login account: if its access token is about to expire
 * (the process will refresh it), wait for the process ahead to finish its refresh. Other accounts,
 * keys and fresh tokens return at once.
 */
export async function loginGate(key, { waitMs = GATE_WAIT_MS, stepMs = 250, now = Date.now, log = console.error, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const dir = isLoginDirKey(key) ? loginDirOf(key) : null;
  if (!dir) return;
  noteLogin(key, "before start", { log });
  const needs = () => {
    const s = loginState(dir);
    return Boolean(s && !s.empty && s.expiresAt - now() < NEAR_EXPIRY_MS);
  };
  if (!needs()) return;
  const ahead = tails.get(dir) || Promise.resolve();
  let release;
  tails.set(dir, ahead.then(() => new Promise((resolve) => (release = resolve))));
  await ahead;
  // The one ahead refreshed it meanwhile: nothing left to wait for.
  if (!needs()) return release?.();
  // This process refreshes now: the next one is held until the file moves (or the wait is up).
  const from = loginState(dir)?.mtimeMs;
  const deadline = now() + waitMs;
  (async () => {
    while (now() < deadline && loginState(dir)?.mtimeMs === from) await sleep(stepMs);
    release?.();
  })();
}
