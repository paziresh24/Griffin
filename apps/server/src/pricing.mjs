// Claude API list prices (USD per million tokens) and what a turn's token parts would cost at them.
// The plans (Claude Max 200$) are flat-rate, so this is not a bill: it is the one scale on which
// Opus, Sonnet and Haiku tokens, fresh input, cache writes and cache reads can be added up and
// compared (an Opus output token is not a Haiku cache read). Prices as of 2026-11-01; cache write is
// the 5-minute write (1.25x input). Edit the table when Anthropic changes a price.
//
// «ضریب» (weight) of a model = its output price relative to Sonnet 5.5: how many Sonnet tokens one of
// its tokens is worth.

const M = 1e6;
// [match, label, input, output, cacheRead]; the first row whose regex matches the normalized model wins.
const TABLE = [
  [/fable/, "Fable", 10, 50, 0.25],
  [/opus-?(5-5|5\.5)|^opus$/, "Opus 5.5", 4, 20, 0.2],
  [/opus/, "Opus", 5, 25, 0.5],
  [/sonnet-?(5-5|5\.5|5)(?!\d)|^sonnet$/, "Sonnet 5.5", 2, 10, 0.2],
  [/sonnet/, "Sonnet 4", 3, 15, 0.3],
  [/haiku-?(5-5|5\.5|5)(?!\d)|^haiku$/, "Haiku 5.5", 0.1, 0.5, 0.01],
  [/haiku/, "Haiku 4.5", 1, 5, 0.1],
];
const SONNET_OUT = 10;

/** "claude-opus-5-5-20260401", "opus[1m]", "Sonnet" → "opus-5-5" … lower-case, no prefix, date or context suffix. */
export function normalizeModel(model) {
  return String(model || "")
    .toLowerCase()
    .replace(/\[.*?\]/g, "")
    .replace(/^claude-?/, "")
    .replace(/-\d{8}$/, "")
    .trim();
}

/** { label, input, output, cacheWrite, cacheRead, weight } in USD/MTok, or null for a model with no list price (GLM, auto, …). */
export function priceOf(model) {
  const m = normalizeModel(model);
  const row = TABLE.find(([re]) => re.test(m));
  if (!row) return null;
  const [, label, input, output, cacheRead] = row;
  return { label, input, output, cacheWrite: input * 1.25, cacheRead, weight: output / SONNET_OUT };
}

/** USD for one set of parts { input, output, cacheWrite, cacheRead }. An unpriced model costs 0 (and is flagged by priceOf → null). */
export function costOf(parts, model) {
  const p = priceOf(model);
  if (!p || !parts) return 0;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return (n(parts.input) * p.input + n(parts.output) * p.output + n(parts.cacheWrite) * p.cacheWrite + n(parts.cacheRead) * p.cacheRead) / M;
}
