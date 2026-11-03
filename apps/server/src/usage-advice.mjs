// Two quiet nudges under the composer (owner 2026-11-02: «به کاربر اعلام کند خیلی مصرف می‌کنی … یا
// پیشنهاد بدهد این چت به Opus نیاز ندارد»). Pure functions; app.mjs gathers the rows.
//  - spendAdvice: the last 24 hours cost far more (at API list price) than this install's usual day.
//  - chatAdvice: a chat on a heavy model whose recent turns were light enough for Sonnet.
import { costOf } from "./pricing.mjs";
import { usageParts } from "./token-usage.mjs";
import { isHeavyModel } from "./model-policy.mjs";

const DAY = 86_400_000;
const usd = (n) => Math.round(n);

/** rows: usageRows() ({ at, model, usage }). Null when there is too little history or nothing stands out. */
export function spendAdvice(rows, { now = new Date(), factor = 1.6, floor = 30, minDays = 3 } = {}) {
  const t = now.getTime();
  let today = 0;
  let todayHeavy = 0;
  const days = new Map(); // whole days back (1..7) -> cost
  for (const row of rows || []) {
    const age = t - Date.parse(row.at);
    if (!(age >= 0)) continue;
    const cost = costOf(usageParts(row.usage), row.model);
    if (age < DAY) {
      today += cost;
      if (isHeavyModel(row.model)) todayHeavy += cost;
    } else {
      const d = Math.floor(age / DAY);
      if (d <= 7) days.set(d, (days.get(d) || 0) + cost);
    }
  }
  if (days.size < minDays) return null;
  const baseline = [...days.values()].reduce((a, b) => a + b, 0) / days.size;
  if (today < floor || today < baseline * factor) return null;
  return { kind: "spend", today: usd(today), baseline: usd(baseline), ratio: Math.round((today / Math.max(baseline, 1)) * 10) / 10, heavyShare: today ? Math.round((todayHeavy / today) * 100) : 0 };
}

/**
 * events: a chat's newest-first run.started / tool.started / usage events ({ type, runId, data }).
 * Suggests Sonnet when the last runs on a heavy model needed few tool calls and wrote little.
 */
export function chatAdvice(events, { model, minRuns = 3, maxTools = 3, maxOutput = 2500 } = {}) {
  if (!isHeavyModel(model)) return null;
  const runs = new Map(); // runId -> { heavy, tools, output }
  for (const e of events || []) {
    if (!e.runId) continue;
    const r = runs.get(e.runId) || { heavy: null, tools: 0, output: 0 };
    if (e.type === "run.started") r.heavy = isHeavyModel(e.data?.model);
    else if (e.type === "tool.started") r.tools += 1;
    else if (e.type === "usage") r.output += usageParts(e.data).output;
    runs.set(e.runId, r);
  }
  // The newest unbroken stretch of runs on a heavy model (an older Sonnet run ends it).
  const recent = [];
  for (const r of runs.values()) {
    if (r.heavy === null) continue; // no run.started in the window: unknown, not a break
    if (r.heavy !== true) break;
    recent.push(r);
    if (recent.length === 6) break;
  }
  if (recent.length < minRuns) return null;
  const tools = recent.map((r) => r.tools);
  if (Math.max(...tools) > maxTools) return null;
  const output = recent.reduce((a, r) => a + r.output, 0) / recent.length;
  if (output > maxOutput) return null;
  return { kind: "model", runs: recent.length, avgTools: Math.round((tools.reduce((a, b) => a + b, 0) / tools.length) * 10) / 10, avgOutput: Math.round(output), suggest: "sonnet" };
}
