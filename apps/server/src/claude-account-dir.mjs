import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A Claude account added with the full `claude auth login` (not `setup-token`): its login lives in a
// folder of its own, <data>/claude-accounts/<id>, and a run uses it as CLAUDE_CONFIG_DIR with no token
// in the environment. A setup-token only carries user:inference; the full login also gets the profile
// (email, plan), usage, sessions, connectors, uploads and plugins (owner + a colleague 2026-10-19).
//
// The account's "key" in the secret store is this marker, not a secret: every "has a key" check in
// the app keeps working, and the real credential (.credentials.json) stays in the folder.

export const LOGIN_DIR_PREFIX = "claude-login-dir:";

export const loginDirKey = (dir) => `${LOGIN_DIR_PREFIX}${dir}`;
export const isLoginDirKey = (key) => typeof key === "string" && key.startsWith(LOGIN_DIR_PREFIX);
export const loginDirOf = (key) => (isLoginDirKey(key) ? key.slice(LOGIN_DIR_PREFIX.length) : null);

const ACCOUNT_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** Where account `id` keeps its login; null for an id that is not a plain account id. */
export function accountLoginDir(dataDir, id) {
  return ACCOUNT_ID.test(String(id || "")) ? path.join(dataDir, "claude-accounts", id) : null;
}

/** The folder Claude Code uses when the app does not name one: the shared settings, skills, projects. */
export const mainConfigDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

// What every account shares with the main folder (CLAUDE.md, settings, skills, plugins, commands,
// agents and the conversations, so a session can be resumed whichever account runs it). NEVER the
// login itself: a copy or link of .credentials.json made Claude Code log everyone out (2026-10-03).
export const SHARED_ENTRIES = ["CLAUDE.md", "settings.json", "skills", "plugins", "commands", "agents", "projects"];
const NEVER = new Set([".credentials.json", ".claude.json"]);

// The link text: relative when `main` sits next to the account folder under one root, so the link
// resolves the same in the container and on the host (the same folder at another path).
const relativeLink = (source, target) => {
  const rel = path.relative(path.dirname(target), source);
  return rel.split(path.sep).filter((part) => part === "..").length > 2 ? source : rel;
};

/**
 * Rewrites shared entries that are absolute links into `main` as relative ones (older logins made them
 * absolute, which dangle on the host). Returns the names it changed.
 */
export function relativizeSharedLinks({ dir, main = mainConfigDir() }) {
  const changed = [];
  for (const name of SHARED_ENTRIES) {
    const target = path.join(dir, name);
    try {
      if (!fs.lstatSync(target).isSymbolicLink()) continue;
      const now = fs.readlinkSync(target);
      if (!path.isAbsolute(now) || path.resolve(now) !== path.resolve(main, name)) continue;
      const rel = relativeLink(now, target);
      if (rel === now) continue;
      const tmp = `${target}.tmp-${process.pid}`;
      fs.symlinkSync(rel, tmp);
      fs.renameSync(tmp, target);
      changed.push(name);
    } catch {
      // not a link or not there: leave it
    }
  }
  return changed;
}

/**
 * Links the shared entries of `main` into `dir`. A file or folder the account already has of its own
 * is left alone; `projects` is created in `main` first so a link never dangles where Claude writes.
 */
export function linkSharedEntries({ dir, main = mainConfigDir() }) {
  const linked = [];
  if (!dir || path.resolve(dir) === path.resolve(main)) return linked;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of SHARED_ENTRIES) {
    if (NEVER.has(name)) continue;
    const source = path.join(main, name);
    const target = path.join(dir, name);
    if (name === "projects") fs.mkdirSync(source, { recursive: true });
    if (!fs.existsSync(source)) continue;
    try {
      fs.lstatSync(target);
      continue; // already there (a link from an earlier login, or the account's own)
    } catch {
      // not there yet
    }
    try {
      fs.symlinkSync(relativeLink(source, target), target);
      linked.push(name);
    } catch {
      // a read-only folder or a race: the account still works, it only misses this entry
    }
  }
  return linked;
}

/** The login a folder holds: .credentials.json exists. */
export const hasLogin = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, ".credentials.json"));

// The host (config CLAUDE_HOST) does not see this folder, and its Claude Code runs on the owner's own
// config folder: a run there gets the folder login's current access token in its env instead
// (CLAUDE_CODE_OAUTH_TOKEN), read here, never copied anywhere. The folder keeps the refresh token and
// only Claude Code in the container refreshes it; a token with less than `minLeftMs` to live gives
// null, so that run goes to the container, whose Claude Code refreshes the login (owner 2026-10-20:
// with the main account at its plan limit, his chats on the backup account lost the host — no ssh
// keys to .46/.32 in the container).
export function loginDirToken(dir, { now = Date.now(), minLeftMs = 60 * 60_000 } = {}) {
  if (!dir) return null;
  try {
    const oauth = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"))?.claudeAiOauth;
    const token = typeof oauth?.accessToken === "string" ? oauth.accessToken : "";
    const expiresAt = Number(oauth?.expiresAt);
    if (!token || !Number.isFinite(expiresAt) || expiresAt - now < minLeftMs) return null;
    return { token, expiresAt };
  } catch {
    return null;
  }
}

/** Removes an account's folder (only one under <data>/claude-accounts/). */
export function removeLoginDir(dataDir, id) {
  const dir = accountLoginDir(dataDir, id);
  if (!dir) return false;
  // Links inside point at the main folder: unlink them, never follow them.
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
