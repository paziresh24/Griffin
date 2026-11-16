// Claude plan limit resets (the «Reset for free» of claude.ai Settings → Usage, Claude Code's
// /limit-reset): Anthropic grants a subscription a few resets (a monthly full reset, one per model
// launch like Fable 5.2), each with a deadline. Claude Code's SDK does not expose them, so this asks
// the same two endpoints Claude Code 2.1.296 calls (program «cedar_ember»), with the login folder's
// own access token, read here and never copied or logged:
//   GET  /api/oauth/usage?cedar_ember=1&skip_spend=1 → .cedar_ember {grants, next_grant_id, …}
//   POST /api/organizations/<org>/reset_rate_limits {program, grant_id, request_id}
// Only a full Claude Code login (user:profile scope) has them; a setup-token gets none.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loginDirToken } from "./claude-account-dir.mjs";

const BASE = "https://api.anthropic.com";
const PROGRAM = "cedar_ember";
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const HEADERS = { "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json", "user-agent": "claude-cli/2.1.296 (external, cli)" };

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const iso = (v) => (str(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 12) : []);

/** The usage answer's cedar_ember block → what the popover shows. Read defensively: the shape is Anthropic's, undocumented. */
export function parseResets(block) {
  if (!block || typeof block !== "object") return { available: false, reason: "no_status" };
  const grants = (Array.isArray(block.grants) ? block.grants : [])
    .filter((g) => g && GRANT_ID.test(String(g.id)))
    .map((g) => ({
      id: g.id,
      label: str(g.label)?.slice(0, 120) || g.id,
      left: Number.isInteger(g.resets_left) ? g.resets_left : 0,
      total: Number.isInteger(g.resets_total) ? g.resets_total : null,
      endsAt: iso(g.ends_at),
      clears: list(g.clears),
      usableNow: g.usable_now === true && g.paused !== true,
      requiresLimit: g.use_requires_limit === true,
      blocking: list(g.blocking),
    }))
    .filter((g) => g.left > 0);
  return {
    available: true,
    eligible: block.eligible === true,
    atLimit: block.at_limit === true,
    exhausted: list(block.exhausted),
    nextGrantId: grants.some((g) => g.id === block.next_grant_id) ? block.next_grant_id : null,
    weeklyResetsAt: iso(block.weekly_resets_at),
    cooldownUntil: iso(block.cooldown_until),
    grants,
  };
}

/** A login folder's access token and organization; null when the folder has no usable login. */
export function readLogin(dir, { now = Date.now(), home = os.homedir() } = {}) {
  const auth = loginDirToken(dir, { now, minLeftMs: 60_000 });
  if (!auth) return null;
  // Claude Code keeps .claude.json in the config folder, or next to ~/.claude for the default one.
  for (const file of [path.join(dir, ".claude.json"), ...(path.resolve(dir) === path.join(home, ".claude") ? [path.join(home, ".claude.json")] : [])]) {
    try {
      const org = str(JSON.parse(fs.readFileSync(file, "utf8"))?.oauthAccount?.organizationUuid);
      if (org) return { token: auth.token, org };
    } catch {}
  }
  return { token: auth.token, org: null };
}

export async function fetchResets(login, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!login?.token) return { available: false, reason: "no_login" };
  const res = await fetchImpl(`${BASE}/api/oauth/usage?cedar_ember=1&skip_spend=1`, { headers: { ...HEADERS, authorization: `Bearer ${login.token}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 401 || res.status === 403) return { available: false, reason: "not_authorized" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseResets((await res.json())?.cedar_ember);
}

/** Spends one reset of `grantId`. result: reset | already_used | not_limited | cooldown | ineligible | unavailable | auth_error | rate_limited. */
export async function claimReset(login, grantId, { fetchImpl = fetch, timeoutMs = 25_000 } = {}) {
  if (!login?.token || !login.org) return { result: "auth_error" };
  if (!GRANT_ID.test(String(grantId))) return { result: "unavailable", reason: "unknown_grant" };
  const res = await fetchImpl(`${BASE}/api/organizations/${encodeURIComponent(login.org)}/reset_rate_limits`, {
    method: "POST",
    headers: { ...HEADERS, authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ program: PROGRAM, grant_id: grantId, request_id: randomUUID() }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) return { result: "auth_error" };
  if (res.status === 429) return { result: "rate_limited" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  return { result: str(body?.result) || "unavailable", reason: str(body?.reason), left: Number.isInteger(body?.resets_left) ? body.resets_left : null, cleared: list(body?.cleared) };
}
