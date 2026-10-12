import { genv } from "./env.mjs";

// Token consumption over time for Settings → «مصرف توکن» (GET /api/usage/tokens): every
// recorded turn (a `usage` event) bucketed by day, by model and by chat. Pure — the store hands in rows.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// The four parts of one turn, each counted once. The engines report differently: OpenAI-compatible
// (GLM) puts the cached part inside prompt_tokens; Anthropic and Cursor report cache reads/writes
// apart from fresh input.
export function usageParts(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  let input;
  let cacheRead;
  if (u.prompt_tokens != null) {
    cacheRead = num(u.prompt_tokens_details?.cached_tokens);
    input = Math.max(0, num(u.prompt_tokens) - cacheRead);
  } else {
    cacheRead = num(u.cache_read_input_tokens ?? u.cacheReadTokens);
    input = num(u.input_tokens ?? u.inputTokens);
  }
  const output = num(u.completion_tokens ?? u.output_tokens ?? u.outputTokens);
  const cacheWrite = num(u.cache_creation_input_tokens ?? u.cacheWriteTokens);
  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

const empty = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 });
const add = (into, p) => {
  for (const key of Object.keys(p)) into[key] += p[key];
};

// The owner's day boundary: GRIFFIN_TZ, else the server's own zone.
export const ownerTimeZone = () => genv("TZ", "") || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// Calendar day in a zone, as YYYY-MM-DD (en-CA formats exactly that).
// One formatter per zone: building one per row cost ~4 s for 22k rows (the app is blocked meanwhile).
const dayFormats = new Map();
function dayKey(date, timeZone) {
  if (!dayFormats.has(timeZone)) dayFormats.set(timeZone, new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }));
  return dayFormats.get(timeZone).format(date);
}

export const TOKEN_USAGE_MAX_DAYS = 90;

// First instant worth reading for a `days`-day window: one day earlier than needed, so no zone offset
// can cut the first day short. Rows outside the window are dropped by the aggregation.
export function tokenUsageSince({ days, now = new Date() }) {
  return new Date(now.getTime() - (days + 1) * 86_400_000).toISOString();
}

/**
 * rows: [{ at, chatId, title, model, usage }] -> { days, totals, byModel, byChat, chatCount }.
 * `days` are the last N calendar days ending today, oldest first, empty days included.
 */
export function aggregateTokenUsage(rows, { days = 30, now = new Date(), timeZone = "UTC", chatLimit = 50 } = {}) {
  const keys = [];
  for (let i = days - 1; i >= 0; i -= 1) keys.push(dayKey(new Date(now.getTime() - i * 86_400_000), timeZone));
  const byDay = new Map(keys.map((date) => [date, { date, ...empty(), byModel: {} }]));
  const models = new Map();
  const chats = new Map();
  const totals = empty();
  for (const row of rows) {
    const at = new Date(row.at);
    if (Number.isNaN(at.getTime())) continue;
    const day = byDay.get(dayKey(at, timeZone));
    if (!day) continue;
    const p = usageParts(row.usage);
    if (!p.total) continue;
    const model = row.model || "unknown";
    add(day, p);
    day.byModel[model] = (day.byModel[model] || 0) + p.total;
    add(totals, p);
    if (!models.has(model)) models.set(model, { model, ...empty(), turns: 0 });
    const m = models.get(model);
    add(m, p);
    m.turns += 1;
    if (!chats.has(row.chatId)) chats.set(row.chatId, { chatId: row.chatId, title: row.title || "", ...empty(), turns: 0, models: [] });
    const c = chats.get(row.chatId);
    add(c, p);
    c.turns += 1;
    if (!c.models.includes(model)) c.models.push(model);
  }
  const desc = (a, b) => b.total - a.total;
  return {
    days: [...byDay.values()],
    totals,
    byModel: [...models.values()].sort(desc),
    byChat: [...chats.values()].sort(desc).slice(0, chatLimit),
    chatCount: chats.size,
  };
}
