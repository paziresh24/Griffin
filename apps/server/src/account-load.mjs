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
import { windowWeight } from "./account-balance.mjs";

export const REFRESH_MS = 15 * 60_000;
const FIRST_DELAY_MS = 30_000;
const GAP_MS = 2_000;
// Only the windows every model shares; a per-model weekly window does not stop the others.
const SHARED = new Set(["five_hour", "seven_day"]);

/** The fuller shared window (0-100) of a planUsage answer; a window already reset counts as empty, a 5-hour
 *  one below SESSION_HOT as nothing (account-balance.mjs). null = nothing known. */
export function planLoad(raw, now = Date.now()) {
  const parsed = parsePlanUsage(raw);
  if (!parsed.available) return null;
  let load = null;
  for (const row of parsed.rows) {
    if (!SHARED.has(row.id)) continue;
    const reset = row.resetsAt ? Date.parse(row.resetsAt) : 0;
    load = Math.max(load ?? 0, windowWeight(row.id, reset && reset <= now ? 0 : row.percent));
  }
  return load;
}

/**
 *   ids()          -> the accounts to read now (usable plain Claude accounts)
 *   fetchUsage(id) -> provider.planUsage() of that account
 *   runLoad(id)    -> accountLoad of the windows its last run reported, or null
 *   runAt(id)      -> when that run reported them (ms), or 0
 */
  export function createAccountLoads({ ids, fetchUsage, runLoad, runAt = () => 0, runWindows = null, refreshMs = REFRESH_MS, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.()), log = console.error }) {
  const read = new Map(); // id -> { load, parsed, at }
  let timer = null;
  let running = null;

  async function refreshOne(id) {
    try {
      const raw = await fetchUsage(id);
      const parsed = parsePlanUsage(raw);
      const load = planLoad(raw, now());
      if (parsed.available || load != null) {
        read.set(id, { load, parsed: parsed.available ? parsed : null, at: now() });
      }
      return read.get(id) || null;
    } catch (error) {
      log(`[account-load] ${id}: ${String(error?.message || error).slice(0, 120)}`);
      return null;
    }
  }

  async function refresh() {
    if (running) return running;
    running = (async () => {
      for (const id of ids()) {
        await refreshOne(id);
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
    if (plan && plan.load != null && (fromRun == null || plan.at >= (runAt(id) || 0))) return plan.load;
    return fromRun ?? null;
  }

  function usageOf(id) {
    const plan = read.get(id);
    const rAt = runAt(id) || 0;
    const rawWin = typeof runWindows === "function" ? runWindows(id) : null;
    const nowMs = now();
    const rowFromRun = (w, wid, label) => {
      if (!w || typeof w !== "object") return null;
      const pct = Number.isFinite(w.utilization) ? Math.round(w.utilization * (w.utilization <= 1 ? 100 : 1)) : Number.isFinite(w.percent) ? Math.round(w.percent) : null;
      if (pct == null) return null;
      const resetsAt = w.resetsAt ? (typeof w.resetsAt === "number" ? new Date(w.resetsAt * (w.resetsAt < 1e12 ? 1000 : 1)).toISOString() : String(w.resetsAt)) : null;
      const resetMs = resetsAt ? Date.parse(resetsAt) : 0;
      return { id: wid, label, percent: resetMs && resetMs <= nowMs ? 0 : Math.max(0, Math.min(100, pct)), resetsAt };
    };
    const fromRunRows = [];
    if (rawWin && typeof rawWin === "object") {
      const w5 = rowFromRun(rawWin.five_hour || rawWin.fiveHour || rawWin["5h"], "five_hour", "پنجرهٔ ۵ ساعته");
      const w7 = rowFromRun(rawWin.seven_day || rawWin.sevenDay || rawWin["7d"], "seven_day", "سهمیهٔ هفتگی");
      if (w5) fromRunRows.push(w5);
      if (w7) fromRunRows.push(w7);
    }
    const planRows = plan?.parsed?.rows?.map((r) => {
      const resetMs = r.resetsAt ? Date.parse(r.resetsAt) : 0;
      return { ...r, percent: resetMs && resetMs <= nowMs ? 0 : r.percent };
    }) || [];
    if (planRows.length && (!fromRunRows.length || plan.at >= rAt)) {
      return {
        rows: planRows,
        extra: plan.parsed?.extra || null,
        load: plan.load,
        updatedAt: plan.at,
        source: "plan",
      };
    }
    if (fromRunRows.length) {
      return {
        rows: fromRunRows,
        extra: null,
        load: runLoad(id),
        updatedAt: rAt || nowMs,
        source: "run",
      };
    }
    return null;
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
  return { loadOf, usageOf, refreshOne, refresh, start, stop };
}
