import fs from "node:fs";
import path from "node:path";

// Claude Code renews a folder login's 8-hour OAuth token itself, on the first request after it runs
// out, under a lock (.oauth_refresh.lock in the account's folder). A process that dies holding it
// (cut by an abort, killed mid-renewal) leaves the lock behind, and every run of that account then
// dies with «another Claude Code process is refreshing it (or exited mid-refresh)» — a retry 40 s
// later too (a colleague, 2026-10-28: 06:00, 11:30 and 15:00Z, each right at the token's expiry, no
// Claude Code process alive; a lone fresh process renewed it at once, 06:05 and 15:06). So, with
// config CLAUDE_TOKEN_KEEPER=on, Griffin
//   * removes a renewal lock nobody has touched for STALE_LOCK_MS (a live holder keeps touching it), and
//   * renews a token about to run out itself, from one process at a time that nobody cuts, so runs
//     do not meet the expiry at the same moment.
export const STALE_LOCK_MS = 45_000;
// Claude Code renews only a token close to its end; earlier, a call just uses the old one.
export const LEAD_MS = 4 * 60_000;
// After an attempt that did not move the expiry, the same folder waits this long before the next.
export const RETRY_GAP_MS = 10 * 60_000;
export const LOCK_NAME = ".oauth_refresh.lock";

/** The folder login's access-token expiry (ms), or null when there is none to read. */
export function tokenExpiry(dir, { readFileSync = fs.readFileSync } = {}) {
  try {
    const at = Number(JSON.parse(readFileSync(path.join(dir, ".credentials.json"), "utf8"))?.claudeAiOauth?.expiresAt);
    return at > 0 ? at : null;
  } catch {
    return null;
  }
}

/**
 * dirs() -> the folder logins to look after; renew(dir) -> one short Claude Code turn on that login
 * (it renews the token on its way). Never two renewals at once, from this keeper.
 */
export function createTokenKeeper({ dirs, renew, now = Date.now, fsImpl = fs, staleLockMs = STALE_LOCK_MS, leadMs = LEAD_MS, retryGapMs = RETRY_GAP_MS, log = () => {} }) {
  let busy = false;
  const tried = new Map(); // dir -> { at, expiry } of the last renewal that did not move the expiry

  function clearStaleLock(dir) {
    const lock = path.join(dir, LOCK_NAME);
    let stat;
    try {
      stat = fsImpl.statSync(lock);
    } catch {
      return false;
    }
    if (now() - stat.mtimeMs < staleLockMs) return false;
    fsImpl.rmSync(lock, { recursive: true, force: true });
    log(`removed a stale token renewal lock (${Math.round((now() - stat.mtimeMs) / 1000)}s untouched) in ${dir}`);
    return true;
  }

  async function tick() {
    if (busy) return [];
    busy = true;
    const done = [];
    try {
      for (const dir of dirs()) {
        const cleared = clearStaleLock(dir);
        const expiry = tokenExpiry(dir, fsImpl);
        if (!expiry || expiry - now() > leadMs) {
          if (cleared) done.push({ dir, cleared });
          continue;
        }
        const last = tried.get(dir);
        if (last && last.expiry === expiry && now() - last.at < retryGapMs) continue;
        try {
          await renew(dir);
        } catch (error) {
          log(`renewing ${dir}: ${error?.message || error}`);
        }
        const after = tokenExpiry(dir, fsImpl);
        const ok = Boolean(after && after > expiry);
        if (ok) tried.delete(dir);
        else tried.set(dir, { at: now(), expiry });
        log(`${ok ? "renewed" : "could not renew"} the token of ${dir}${ok ? ` (until ${new Date(after).toISOString()})` : ""}`);
        done.push({ dir, cleared, renewed: ok });
      }
    } finally {
      busy = false;
    }
    return done;
  }

  return { tick };
}
