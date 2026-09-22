import { ToolInputError } from "./kube.mjs";

// Prometheus queries through the cluster's own Prometheus (monitoring/prometheus-operated),
// reached via the kube API service proxy — so the same public-API-then-emergency-SSH fallback
// applies. The agent only ever sees statistics; full series go to the chart renderer.

export const PROMETHEUS_PATH = "/api/v1/namespaces/monitoring/services/prometheus-operated:9090/proxy/api/v1";

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };
const NICE_STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
const MAX_RANGE = 30 * 86400;
const MAX_POINTS_PER_SERIES = 2000;

export function parseDuration(value, label) {
  const match = String(value ?? "").trim().match(/^(\d{1,5})(s|m|h|d)$/);
  if (!match) throw new ToolInputError(`${label} must look like 30m, 24h or 7d`);
  return Number(match[1]) * UNIT_SECONDS[match[2]];
}

// ~300 points per series, snapped to a step a person would pick.
export function autoStep(rangeSeconds, targetPoints = 300) {
  const raw = rangeSeconds / targetPoints;
  return NICE_STEPS.find((step) => step >= raw) || NICE_STEPS.at(-1);
}

export function createMetrics({ kube, now = () => Date.now() }) {
  async function run(cluster, apiPath) {
    return kube.withFallback(cluster, {
      viaApi: async () => (await kube.publicRequest(cluster, apiPath)).body,
      viaSsh: async () => JSON.parse(await kube.emergency(cluster, ["get", "--raw", apiPath])),
    });
  }

  // Returns { instant, step, start, end, series: [{ labels, points: [[unixSeconds, number]] }], source, attempts }
  async function query({ cluster, promql, range = "1h", step, instant = false }) {
    const text = String(promql ?? "").trim();
    if (!text || text.length > 4000) throw new ToolInputError("promql is required (max 4000 chars)");
    const end = Math.floor(now() / 1000);
    if (instant) {
      const result = await run(cluster, `${PROMETHEUS_PATH}/query?${new URLSearchParams({ query: text, time: String(end) })}`);
      const data = checkPrometheus(result.value);
      const series = (data.result || []).map((item) => ({
        labels: item.metric || {},
        points: item.value ? [[Number(item.value[0]), Number(item.value[1])]] : [],
      }));
      return { instant: true, step: null, start: end, end, series, source: result.source, attempts: result.attempts };
    }
    const rangeSeconds = parseDuration(range, "range");
    if (rangeSeconds > MAX_RANGE) throw new ToolInputError("range is limited to 30d");
    const stepSeconds = step ? parseDuration(step, "step") : autoStep(rangeSeconds);
    if (rangeSeconds / stepSeconds > MAX_POINTS_PER_SERIES) throw new ToolInputError(`step too small for range (max ${MAX_POINTS_PER_SERIES} points)`);
    const start = end - rangeSeconds;
    const params = new URLSearchParams({ query: text, start: String(start), end: String(end), step: String(stepSeconds) });
    const result = await run(cluster, `${PROMETHEUS_PATH}/query_range?${params}`);
    const data = checkPrometheus(result.value);
    const series = (data.result || []).map((item) => ({
      labels: item.metric || {},
      points: (item.values || []).map(([t, v]) => [Number(t), Number(v)]),
    }));
    return { instant: false, step: stepSeconds, start, end, series, source: result.source, attempts: result.attempts };
  }

  return { query };
}

function checkPrometheus(body) {
  if (!body || body.status !== "success") {
    throw new Error(`prometheus: ${body?.error || body?.status || "invalid response"}`);
  }
  return body.data || {};
}

// Short human name for a series: the labels that differ, or the single label value.
export function seriesName(labels) {
  const entries = Object.entries(labels || {}).filter(([key]) => key !== "__name__");
  if (!entries.length) return labels?.__name__ || "total";
  if (entries.length === 1) return String(entries[0][1]);
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

export function stats(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { count: 0, min: null, max: null, avg: null };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of finite) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  return { count: finite.length, min, max, avg: sum / finite.length };
}

// Axis bounds a person would choose: pad the data range, snap to round numbers, and keep 0 as
// the floor when the data is non-negative and already close to it (so small wiggles are not
// blown up into cliffs, and large offsets are not flattened into a line at the top).
export function niceDomain(min, max, { zero } = {}) {
  if (min === null || max === null) return null;
  if (min === max) {
    // A flat non-negative series reads best against 0; otherwise give it room on both sides.
    if (min > 0 && zero !== false) return niceDomain(0, min * 1.15, { zero: true });
    const pad = Math.abs(min) * 0.1 || 1;
    return niceDomain(min - pad, max + pad, { zero });
  }
  const span = max - min;
  let lo = min - span * 0.08;
  let hi = max + span * 0.08;
  const nearZero = min >= 0 && min <= span * 0.6;
  if (zero === true || (zero !== false && nearZero) || (min >= 0 && lo < 0)) lo = 0;
  // Try 4-8 ticks and keep the tightest round axis that still contains the padded range.
  let best = null;
  for (let ticks = 4; ticks <= 8; ticks += 1) {
    const step = niceStep((hi - lo) / ticks);
    const candidate = [roundTo(Math.floor(lo / step) * step), roundTo(Math.ceil(hi / step) * step)];
    if (!best || candidate[1] - candidate[0] < best[1] - best[0]) best = candidate;
  }
  return best;
}

function niceStep(raw) {
  const exponent = Math.floor(Math.log10(raw));
  const base = 10 ** exponent;
  const fraction = raw / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * base;
}

function roundTo(value) {
  return Number(value.toPrecision(12));
}

// What the agent sees: overall bounds, a suggested axis, and the top series by peak.
export function summarizeQuery(result, { maxSeries = 20 } = {}) {
  const all = result.series.map((item) => {
    const values = item.points.map(([, v]) => v);
    const s = stats(values);
    return { name: seriesName(item.labels), labels: item.labels, ...s, last: values.at(-1) ?? null };
  });
  const overall = stats(result.series.flatMap((item) => item.points.map(([, v]) => v)));
  const top = [...all].sort((a, b) => (b.max ?? -Infinity) - (a.max ?? -Infinity)).slice(0, maxSeries);
  return {
    instant: result.instant,
    range: result.instant ? null : { start: new Date(result.start * 1000).toISOString(), end: new Date(result.end * 1000).toISOString() },
    step: result.step,
    seriesTotal: all.length,
    points: overall.count,
    overall,
    suggestedDomain: niceDomain(overall.min, overall.max),
    series: top,
    truncatedSeries: all.length > top.length,
    source: result.source,
    attempts: result.attempts,
  };
}
