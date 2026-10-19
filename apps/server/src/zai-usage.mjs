// The Z.ai coding-plan quota behind the usage popover (ported from Karsara zai-usage.mjs). Z.ai exposes no documented
// usage API; its own plugin (zai-org/zai-coding-plugins, query-usage.mjs) reads
// GET {base}/api/monitor/usage/quota/limit with the SAME key the Anthropic-compatible endpoint
// uses, as the raw Authorization header. Live shape (probed 2026-10-04, level "lite"):
//   { code: 200, success: true, data: { level: "lite", limits: [
//     { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 451,
//       remaining: 1548, percentage: 22, nextResetTime: 1791147943560 },   // 5-hour window
//     { type: "CREDIT_LIMIT", unit: 6, number: 1, ... } ] } }              // weekly window
// Everything is read defensively: an unknown window type is still shown (labelled by its
// unit/number), anything without a usable total is dropped rather than guessed.

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function rowOf(entry) {
  if (!entry || typeof entry !== "object" || entry.type !== "CREDIT_LIMIT") return null;
  const total = num(entry.usage);
  const used = num(entry.currentValue);
  if (!total || total <= 0 || used == null) return null;
  // (unit, number) identifies the window: (3, 5) is the 5-hour one, unit 6 the weekly one.
  const id = entry.unit === 3 && entry.number === 5 ? "five_hour" : entry.unit === 6 ? "weekly" : `credit:${entry.unit}:${entry.number}`;
  const label = id === "five_hour" ? "session" : id === "weekly" ? "weekly" : null;
  const resets = num(entry.nextResetTime);
  return {
    id,
    label,
    used,
    total,
    remaining: num(entry.remaining) ?? Math.max(0, total - used),
    percent: num(entry.percentage) ?? Math.round((used / total) * 100),
    resetsAt: resets != null && resets > 0 ? new Date(resets).toISOString() : null,
  };
}

/**
 * quota/limit response -> what the popover draws. `available: false` carries a plain reason;
 * the plan level ("lite", "pro", ...) rides along when Z.ai names one.
 */
export function parseZaiQuota(raw) {
  if (!raw || typeof raw !== "object" || !raw.success || typeof raw.data !== "object" || !raw.data) {
    return { available: false, reason: "no answer from Z.ai" };
  }
  const level = typeof raw.data.level === "string" && raw.data.level ? raw.data.level : null;
  const rows = (Array.isArray(raw.data.limits) ? raw.data.limits : [])
    .map(rowOf)
    .filter(Boolean)
    .sort((a, b) => (a.id === "five_hour" ? -1 : b.id === "five_hour" ? 1 : 0));
  if (!rows.length) return { available: false, level, reason: "Z.ai returned no quota windows" };
  return { available: true, level, rows };
}

/**
 * One cached reader, like the Claude plan-limits cache: the popover may open often and the
 * answer costs a round trip to Z.ai. Concurrent callers share one in-flight fetch.
 */
export function createZaiQuotaCache({ fetchQuota, ttlMs = 60_000, now = () => Date.now() } = {}) {
  let cached = null;
  let inflight = null;
  async function zaiQuota() {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    if (inflight) return inflight;
    inflight = (async () => {
      let value;
      try {
        value = parseZaiQuota(await fetchQuota());
      } catch (error) {
        value = { available: false, reason: `Z.ai could not answer: ${String(error?.message || error).slice(0, 200)}` };
      }
      value = { ...value, fetchedAt: new Date(now()).toISOString() };
      cached = { at: now(), value };
      return value;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }
  // A successful reset card changes the numbers immediately; the next read must not be stale.
  zaiQuota.invalidate = () => {
    cached = null;
  };
  return zaiQuota;
}

/**
 * One GET to Z.ai's quota page with the key as the whole Authorization header, like Z.ai's own
 * plugin. Through fetch so Griffin's proxy settings apply; no path here logs the key.
 */
export async function zaiQuotaFetch({ key, base = "https://api.z.ai", timeoutMs = 10_000 } = {}) {
  if (!key) throw new Error("no Z.ai key set");
  const res = await fetch(`${base}/api/monitor/usage/quota/limit`, {
    headers: { Authorization: key, "Accept-Language": "en-US,en", "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error("response was not JSON");
  }
}
