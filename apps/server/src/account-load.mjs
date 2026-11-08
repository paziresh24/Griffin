// How full each plain Claude account is, for routing (account-balance.mjs). Until now the only source
// was the windows an account's own last run reported, held in memory: after a restart every account
// was «unknown», so every new chat and every one-shot (titles, the backlog draft, reviewers) landed on
// the first account in the list until it filled (owner 2026-11-04: «همیشه کم مصرف ترین و در دسترس
// ترین اکانت رو برای همه کار ها انتخاب کنه»).
//
// Now each usable account's plan windows are also read every REFRESH_MS from Claude Code itself
// (provider.planUsage: the data behind `/usage`, no model call and no tokens), one account at a time.
// loadOf(id) answers the newer of the two readings.

import { parsePlanUsage } from "./plan-usage.mjs";

export const REFRESH_MS = 15 * 60_000;
const FIRST_DELAY_MS = 30_000;
const GAP_MS = 2_000;
// Only the windows every model shares; a per-model weekly window does not stop the others.
const SHARED = new Set(["five_hour", "seven_day"]);

/** The fuller shared window (0-100) of a planUsage answer; a window already reset counts as empty. null = nothing known. */
export function planLoad(raw, now = Date.now()) {
  const parsed = parsePlanUsage(raw);
  if (!parsed.available) return null;
  let load = null;
  for (const row of parsed.rows) {
    if (!SHARED.has(row.id)) continue;
    const reset = row.resetsAt ? Date.parse(row.resetsAt) : 0;
    load = Math.max(load ?? 0, reset && reset <= now ? 0 : row.percent);
  }
  return load;
}

/**
 *   ids()          -> the accounts to read now (usable plain Claude accounts)
 *   fetchUsage(id) -> provider.planUsage() of that account
 *   runLoad(id)    -> accountLoad of the windows its last run reported, or null
 *   runAt(id)      -> when that run reported them (ms), or 0
 */
export function createAccountLoads({ ids, fetchUsage, runLoad, runAt = () => 0, refreshMs = REFRESH_MS, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.()), log = console.error }) {
  const read = new Map(); // id -> { load, at }
  let timer = null;
  let running = null;

  async function refresh() {
    if (running) return running;
    running = (async () => {
      for (const id of ids()) {
        try {
          const load = planLoad(await fetchUsage(id), now());
          if (load != null) read.set(id, { load, at: now() });
        } catch (error) {
          log(`[account-load] ${id}: ${String(error?.message || error).slice(0, 120)}`);
        }
        await sleep(GAP_MS);
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function loadOf(id) {
    const fromRun = runLoad(id);
    const plan = read.get(id);
    if (plan && (fromRun == null || plan.at >= (runAt(id) || 0))) return plan.load;
    return fromRun ?? null;
  }

  function start() {
    if (timer) return;
    const first = setTimeout(() => refresh().catch(() => {}), FIRST_DELAY_MS);
    first.unref?.();
    timer = setInterval(() => refresh().catch(() => {}), refreshMs);
    timer.unref?.();
  }
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  return { loadOf, refresh, start, stop };
}
