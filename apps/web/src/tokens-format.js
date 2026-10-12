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
