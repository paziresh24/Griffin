// Business signals as alerts, read from the source of truth rather than from a chat channel.
//
// The shape Griffin expects: some job of yours already decides, on its own baseline, whether the
// number that matters (sales, signups, visits…) has dropped, and writes each decision as a row in a
// SQL table. Griffin reads the latest row and turns it into an alert; it never re-decides the drop.
//   - latest row says it alerted      → BusinessSignalDrop (critical when the reason says so)
//   - no fresh row for > staleMinutes → BusinessSignalStale (the job or the DB is down)
//
// Configure it with GRIFFIN_BUSINESS_SIGNAL, a JSON object passed straight to pg_query, plus the
// table to read. Leave it unset and this source stays off:
//
//   {"cluster":"prod","namespace":"analytics","name":"metrics-db","database":"metrics",
//    "table":"sales_checks","staleMinutes":40,"timezoneOffset":"+03:30",
//    "compare":["this_week","last_week","two_weeks_ago"]}
//
// The table needs created_at (naive local wall time), alerted (boolean-ish) and alert_reason; any
// column named in `compare` is appended to the summary. created_at is read with timezoneOffset
// because a wall-clock timestamp with no zone is otherwise read as UTC.

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function visitSql({ table, compare = [] }) {
  if (!COLUMN.test(String(table || ""))) throw new Error("business signal: invalid table name");
  const extra = compare.filter((c) => COLUMN.test(String(c)));
  return `select created_at, alerted, alert_reason${extra.length ? `, ${extra.join(", ")}` : ""} from ${table} order by created_at desc limit 1`;
}

export const naiveToDate = (text, offset = "+00:00") => new Date(`${String(text).trim().replace(" ", "T")}${offset}`);

const truthy = (v) => v === true || ["t", "true", "1", "yes"].includes(String(v).trim().toLowerCase());

export function businessAlerts(row, { now = new Date(), staleMinutes = 40, timezoneOffset = "+00:00", compare = [], label = "business signal" } = {}) {
  const base = { cluster: "business", seenFrom: "business", owner: null, fingerprint: null, startsAt: null };
  if (!row) {
    return [{ ...base, alertname: "BusinessSignalStale", severity: "warning", labels: { job: label }, summary: `${label}: the table is empty, so the drop alert cannot fire.` }];
  }
  const at = naiveToDate(row.created_at, timezoneOffset);
  const alerts = [];
  const ageMin = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (!Number.isFinite(ageMin) || ageMin > staleMinutes) {
    alerts.push({
      ...base,
      alertname: "BusinessSignalStale",
      severity: "warning",
      labels: { job: label },
      summary: `${label}: nothing written for ${Number.isFinite(ageMin) ? ageMin : "?"} minutes; the job that decides the drop is not running.`,
      startsAt: at.toISOString(),
    });
  } else if (truthy(row.alerted)) {
    const reason = String(row.alert_reason || "").trim();
    const numbers = compare.filter((c) => row[c] !== undefined).map((c) => `${c} ${row[c]}`).join("، ");
    alerts.push({
      ...base,
      alertname: "BusinessSignalDrop",
      severity: /بحرانی|critical/i.test(reason) ? "critical" : "warning",
      labels: { job: label },
      summary: `${reason || label}${numbers ? ` — ${numbers}` : ""} (${row.created_at})`.slice(0, 300),
      startsAt: at.toISOString(),
    });
  }
  return alerts;
}

/**
 * Wraps a pg_query call; cached so the round trip happens every `everyMs`, not on every poll.
 * `config` is the parsed GRIFFIN_BUSINESS_SIGNAL; without it the source reports "off".
 */
export function createBusinessSource({ query, config = null, everyMs = 5 * 60_000, now = () => new Date() }) {
  if (!config || !config.table) return async () => ({ ok: true, off: true, alerts: [] });
  const sql = visitSql(config);
  const { cluster, namespace, name, database } = config;
  let cache = null;
  return async function read() {
    const t = now().getTime();
    if (cache && t - cache.at < everyMs) return cache.value;
    let value;
    try {
      const rows = await query({ cluster, namespace, name, database, sql });
      value = { ok: true, alerts: businessAlerts(rows[0] || null, { now: now(), ...config }) };
    } catch (error) {
      value = { ok: false, error: String(error.message).slice(0, 300), alerts: [] };
    }
    cache = { at: t, value };
    return value;
  };
}
