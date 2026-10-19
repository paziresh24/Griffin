// Exact plan limits (GET /api/usage/limits), ported from Karsara usage.mjs: asked of Claude Code
// itself (SDK Query.usage_EXPERIMENTAL..., the data behind `/usage`); Griffin never reads the login.
// A setup-token login has no profile scope and gets no rate_limits back; then the windows the
// account's last run reported (rate_limit_event, utilization 0-1) stand in (fromRunWindows).
// The SDK shape may change (the call is experimental), so every field is read defensively.

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (v) => {
  const n = num(v);
  return n == null ? null : Math.max(0, Math.min(100, Math.round(n)));
};

function window(entry) {
  if (!entry || typeof entry !== "object") return null;
  const percent = pct(entry.utilization ?? entry.percent);
  if (percent == null) return null;
  const resetsAt = typeof entry.resets_at === "string" && !Number.isNaN(Date.parse(entry.resets_at)) ? new Date(entry.resets_at).toISOString() : null;
  return { percent, resetsAt };
}

/**
 * SDKControlGetUsageResponse -> plan limit rows. `available: false` carries the reason in plain
 * words (API key / third-party provider sessions have no plan limits).
 */
export function parsePlanUsage(raw) {
  if (!raw || typeof raw !== "object") return { available: false, reason: "no answer from Claude Code" };
  const plan = typeof raw.subscription_type === "string" && raw.subscription_type ? raw.subscription_type : null;
  const limits = raw.rate_limits;
  if (raw.rate_limits_available === false || !limits || typeof limits !== "object") {
    return { available: false, plan, reason: "plan limits do not apply to this login (API key or another provider)" };
  }
  const rows = [];
  const add = (id, label, entry, model = null) => {
    const w = window(entry);
    if (w) rows.push({ id, label, model, ...w });
  };
  add("five_hour", "session", limits.five_hour);
  add("seven_day", "weekly", limits.seven_day);
  add("seven_day_opus", "weekly_model", limits.seven_day_opus, "Opus");
  add("seven_day_sonnet", "weekly_model", limits.seven_day_sonnet, "Sonnet");
  for (const scoped of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    const name = typeof scoped?.display_name === "string" ? scoped.display_name.slice(0, 40) : "";
    if (!name || rows.some((r) => r.model === name)) continue;
    add(`model:${name}`, "weekly_model", scoped, name);
  }
  if (!rows.length) return { available: false, plan, reason: "Claude Code returned no limit windows" };
  return { available: true, plan, rows };
}

/**
 * One cached reader for the plan limits: the SDK call is a round trip to Anthropic, and the
 * popover may open often. Concurrent callers share one in-flight fetch.
 *
 * A read that fails after a good one does not blank the popover: the last good rows are served,
 * marked `stale` with the reason, and the next read is tried again after `failTtlMs` instead of a
 * full minute. Old numbers are kept only while they can still be true: for the same subscription
 * (an answer naming another plan, or none, means the login changed) and for `staleMaxMs`. With
 * nothing to fall back on, the failure and its reason are returned as they are.
 */
export function createPlanUsageCache({ fetchUsage, ttlMs = 60_000, failTtlMs = 10_000, staleMaxMs = 30 * 60_000, now = () => Date.now(), log = () => {} } = {}) {
  let cached = null; // { at, value, ok }
  let lastGood = null; // { at, value }
  let inflight = null;
  return async function planLimits() {
    if (cached && now() - cached.at < (cached.ok ? ttlMs : failTtlMs)) return cached.value;
    if (inflight) return inflight;
    inflight = (async () => {
      let value;
      let answered = false; // Claude Code answered (as opposed to: threw, timed out, said nothing)
      try {
        const raw = await fetchUsage();
        answered = Boolean(raw && typeof raw === "object");
        value = parsePlanUsage(raw);
      } catch (error) {
        value = { available: false, reason: `Claude Code could not answer: ${String(error?.message || error).slice(0, 200)}` };
      }
      const ok = value.available === true;
      if (ok) {
        value = { ...value, fetchedAt: new Date(now()).toISOString() };
        lastGood = { at: now(), value };
      } else {
        log(`[usage] plan limits unavailable: ${value.reason}`);
        if (lastGood && ((answered && (value.plan || null) !== (lastGood.value.plan || null)) || now() - lastGood.at > staleMaxMs)) lastGood = null;
        value = lastGood ? { ...lastGood.value, stale: true, staleReason: value.reason } : { ...value, fetchedAt: new Date(now()).toISOString() };
      }
      cached = { at: now(), value, ok };
      return value;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

/** A run's unifiedWindows ({five_hour: {utilization 0-1, resetsAt epoch s}}) in the SDK's shape. */
export function fromRunWindows(windows) {
  const limits = {};
  for (const [key, w] of Object.entries(windows || {})) {
    if (!w || w.utilization == null) continue;
    limits[key] = { utilization: Number(w.utilization) * 100, resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null };
  }
  return Object.keys(limits).length ? { subscription_type: null, rate_limits: limits } : null;
}
