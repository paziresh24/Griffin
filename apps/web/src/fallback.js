// The line under an answer given by the engine the owner moved the chat to when a plan limit hit
// (PLAN_FALLBACK=ask, runner answerFallback): which model answered, and why it was not the usual one.
export function fallbackLabel(run) {
  if (!run?.fallback || typeof run.fallback !== "object" || !run.model) return null;
  const from = run.fallback.from ? ` (سقف پلن ${run.fallback.from} پر بود)` : "";
  // Same model on another account (no card): the account is named.
  const account = run.fallback.account ? `، حساب ${run.fallback.account}` : "";
  return `پاسخ از ${run.model}${account}${from}`;
}

// A plan-limit card («با X ادامه بدهم یا صبر کنم؟»): no free-text box, and once closed (answered,
// withdrawn, stale) it is never clickable — a click there must not become a message to the engine.
export const isFallbackCard = (args) => args?.kind === "plan-fallback";
