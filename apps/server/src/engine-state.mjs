// Where an engine account stands for routing, the engines page and the sidebar alerts (owner
// 2026-10-18: «تست سلامت فقط وصل بودن رو چک می‌کنه… ترتیب خودکار باشه»): usable first; at a plan
// limit (5-hour / weekly) next, the soonest reset first; out of credit last, since waiting does not
// bring credit back.

// An account with no money left: Anthropic's «Credit balance is too low», OpenAI-style
// insufficient_quota, Payment Required (a 402 status is checked apart). Not a plan window: there is no reset to wait for.
const CREDIT = /credit balance is too low|insufficient[ _-]?(credits?|balance|funds|quota)|out of (usage )?credits|payment required/i;
export const isCreditError = (text) => CREDIT.test(String(text || ""));

// A credit mark is tried again after this long (someone may have topped up); a run that hits it
// again marks it again. A passing test clears it at once.
export const CREDIT_RETRY_MS = 6 * 60 * 60_000;

/** { state: "ok"|"limited"|"credit"|"no_key"|"off", until? } */
export function engineState({ enabled, keyed, limitedUntil = 0, creditAt = 0, now = Date.now() }) {
  if (!enabled) return { state: "off" };
  if (!keyed) return { state: "no_key" };
  if (creditAt && now - creditAt < CREDIT_RETRY_MS) return { state: "credit", since: creditAt };
  if (limitedUntil > now) return { state: "limited", until: limitedUntil };
  return { state: "ok" };
}

const TIER = { ok: 0, limited: 1, credit: 2, no_key: 3, off: 4 };
/** Stable sort by usability: items keep their own order inside a tier; limited by reset time.
 *  idOf(item) -> account id; stateOf(id) -> engineState(). */
export function rankByState(list, stateOf, idOf = (item) => item.provider ?? item.id) {
  return list
    .map((item, index) => ({ item, index, s: stateOf(idOf(item)) }))
    .sort((a, b) => (TIER[a.s.state] ?? 9) - (TIER[b.s.state] ?? 9) || (a.s.state === "limited" ? a.s.until - b.s.until : 0) || a.index - b.index)
    .map((x) => x.item);
}

/** A probe's verdict (doctor.mjs probeEngine) -> the state to store: "credit" | "limited" | "ok" | null. */
export function probeVerdict(result) {
  if (!result) return null;
  if (result.state === "credit" || result.state === "limited") return result.state;
  if (result.ok && !result.busy) return "ok";
  return null;
}

/** Whether a model name the agent asked of account b means the same on account a: the same account,
 *  or two plain Claude logins (an endpoint account or another OpenAI-kind vendor names other models). */
export const sameModelNames = (a, b, { kindOf, isEndpoint = () => false }) =>
  a === b || (kindOf(a) === "claude" && kindOf(b) === "claude" && !isEndpoint(a) && !isEndpoint(b));
