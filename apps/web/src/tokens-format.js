import { t } from "./i18n.js";

// Shaping for Settings → "Token usage" (GET /api/usage/tokens).

export function formatTokens(n) {
  n = Number(n) || 0;
  const short = (v, unit) => `${v.toFixed(v >= 100 ? 0 : 1).replace(/\.0$/, "")}${unit}`;
  if (n >= 1e9) return short(n / 1e9, "B");
  if (n >= 1e6) return short(n / 1e6, "M");
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

// Models by total over the window, biggest first: the stacking order of every day's bar and the
// colour each model keeps.
export function modelOrder(days) {
  const totals = new Map();
  for (const day of days) for (const [model, tokens] of Object.entries(day.byModel || {})) totals.set(model, (totals.get(model) || 0) + tokens);
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
}

// One bar per day: its height relative to the busiest day, and its segments as shares of the day.
export function dayBars(days, order) {
  const max = Math.max(0, ...days.map((d) => d.total || 0));
  return days.map((day) => ({
    date: day.date,
    total: day.total || 0,
    height: max ? (day.total || 0) / max : 0,
    segments: order
      .map((model, index) => ({ model, index, tokens: day.byModel?.[model] || 0 }))
      .filter((s) => s.tokens > 0)
      .map((s) => ({ ...s, share: s.tokens / day.total })),
  }));
}

// Which of `count` day columns carry a date label: about eight, evenly spaced, counted back from
// today so the last column is always labelled and never crowded by its neighbour.
export function labelledDays(count) {
  const every = Math.max(1, Math.ceil(count / 8));
  return (index) => (count - 1 - index) % every === 0;
}

// The token count under an answer in the Karsara skin:
// everything billed (the timeline's total: input, cache writes and reads, output), «۳.۶M توکن» (the
// skin's font draws the digits Persian); the split on hover, input counting the cache writes.
// Nothing when the run billed nothing. A usage folded before `total` existed: the sum.
export function answerTokens(usage) {
  const n = (v) => Number(v) || 0;
  const total = usage?.total != null ? n(usage.total) : n(usage?.input) + n(usage?.cached) + n(usage?.output);
  if (!total) return null;
  usage = { ...usage, input: Math.max(0, total - n(usage.cached) - n(usage.output)) };
  const trim = (v) => String(Number(v.toFixed(1)));
  const short = total >= 1e9 ? `${trim(total / 1e9)}B` : total >= 1e6 ? `${trim(total / 1e6)}M` : total >= 1e3 ? `${trim(total / 1e3)}k` : String(Math.round(total));
  const en = (v) => n(v).toLocaleString("en-US");
  return { label: t("{n} توکن", { n: short }), title: t("ورودی {input} · از کش {cached} · خروجی {output}", { input: en(usage.input), cached: en(usage.cached), output: en(usage.output) }) };
}

// Plan limits and the Z.ai quota (GET /api/usage/limits, /api/usage/zai). Under a day the reset is a countdown, further away a weekday and clock time.
const DAYS = [t("یکشنبه"), t("دوشنبه"), t("سه‌شنبه"), t("چهارشنبه"), t("پنجشنبه"), t("جمعه"), t("شنبه")];
export function formatReset(iso, now = new Date()) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  const ms = at.getTime() - now.getTime();
  if (ms <= 0) return t("بازنشانی به‌زودی");
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const parts = [];
    if (h) parts.push(t("{n} ساعت", { n: h }));
    if (m || !h) parts.push(t("{n} دقیقه", { n: m }));
    return t("بازنشانی تا {time}", { time: parts.join(t(" و ")) });
  }
  const hh = at.getHours();
  return t("بازنشانی {day} {clock} {half}", { day: DAYS[at.getDay()], clock: `${hh % 12 || 12}:${String(at.getMinutes()).padStart(2, "0")}`, half: hh < 12 ? t("صبح") : t("عصر") });
}

const PLANS = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" };
export const planName = (plan) => (plan ? PLANS[plan] || plan : "");

export function limitLabel(row) {
  if (row.label === "session") return t("محدودیت ۵ ساعته");
  if (row.label === "weekly") return t("هفتگی · همهٔ مدل‌ها");
  return t("هفتگی · {model}", { model: row.model || "" });
}

// Why the plan limits are missing, in the owner's words (the server's reason is English).
export function limitsProblem(reason) {
  const r = String(reason || "");
  if (/do not apply/.test(r)) return t("این ورود سقف اشتراک ندارد (کلید API یا سرویس دیگر)؛ با اشتراک Claude وارد شو تا سقف‌ها دیده شوند.");
  if (/could not answer/.test(r)) return t("Claude Code جواب نداد؛ چند دقیقه بعد دوباره باز کن.");
  if (/no limit windows/.test(r)) return t("Claude Code عددی برنگرداند؛ بعد از اولین گفتگو با Claude دوباره ببین.");
  if (/not configured/.test(r)) return t("حساب Claude وصل نیست؛ در «موتورها» واردش شو.");
  return t("در دسترس نیست؛ کمی بعد دوباره باز کن.");
}
