// Spreading chats over the shared Claude accounts (owner 2026-10-22: «ما این 4 اکانت رو بین همه شیر
// کردیم»). Routing used to take the first usable account in a fixed order and move only at a hard
// plan limit, so one account sat at 5% of its week while three were past 70% — where Claude Code
// itself turns things off (its next-message suggestion goes quiet at «allowed_warning»).
//
// Now a chat starts on the plain Claude account with the most room left (the fuller of its 5-hour and
// weekly windows, as the account's last run reported them) and stays there: every move costs the
// prompt cache, which is per account. It moves only when its account is no longer usable, or is past
// HIGH_LOAD while another one has clearly more room.

export const HIGH_LOAD = 85;
// Where a subscription account stops being used for a NEW chat (claude-safety.mjs): a run that starts
// at 95% of the week hits the wall mid-way, and a plan that is repeatedly pushed to its last breath is
// the «burn it to the end» pattern an anti-fraud reads as a farm rather than a person. Below HIGH_LOAD
// every account is used exactly as before; between the two it only stops taking new work, and a chat
// already on it stays there.
export const SOFT_CAP = 92;
// How much more room another account needs before a chat past HIGH_LOAD leaves its own.
const MOVE_MARGIN = 10;
// An account no run has reported on since the server started: neither preferred nor avoided.
const UNKNOWN_LOAD = 50;

/** kv key: the account a chat was placed on (its first run records the same on run.started). */
export const ACCOUNT_KEY = (chatId) => `account:${chatId}`;

// The 5-hour window refills within hours; the week is what runs out. It weighs in only once it is near
// its own cap (owner 2026-11-24: «چرا اکانت خانم دهقان و آقای ساجدی باهم استفاده نمیشه»): after
// Mahdieh's account reset its week, every install moved to it, its 5-hour window read ~35% while
// a colleague's week read 32%, and a morning's batch of chats went to a colleague's, the fuller week.
export const SESSION_HOT = 70;
/** How much one window counts toward an account's load: the 5-hour one only once it is hot. */
export const windowWeight = (key, used) => (key === "five_hour" && used < SESSION_HOT ? 0 : used);

/** The fuller window of an account (0-100) from a rate_limit_event's unifiedWindows; windows already
 *  reset count as empty, a 5-hour window below SESSION_HOT as nothing. null = nothing known. */
export function accountLoad(windows, now = Date.now()) {
  let load = null;
  for (const [key, w] of Object.entries(windows || {})) {
    if (!w || w.utilization == null) continue;
    const resetAt = Number(w.resetsAt) * 1000;
    const used = resetAt && resetAt <= now ? 0 : Number(w.utilization) * 100;
    if (Number.isFinite(used)) load = Math.max(load ?? 0, windowWeight(key, used));
  }
  return load;
}

/**
 * The candidate list with the chat's Claude account chosen by room left. Only the plain Claude
 * accounts that run the same model as the chat's first candidate are interchangeable; anything else
 * (another engine, an endpoint account, another model) keeps its place.
 *   isPlain(id)  -> a plain Claude login (not an endpoint account)
 *   usable(id)   -> may run now
 *   loadOf(id)   -> accountLoad of its last windows, or null
 *   placed       -> the account the chat is already on (kv or its last run), or null
 * Returns { list, chosen } — chosen = the account picked, null when nothing was balanced.
 */
export function balanceAccounts(list, { isPlain, usable, loadOf, placed = null }) {
  const head = list[0];
  if (!head || !isPlain(head.provider)) return { list, chosen: null };
  const group = [];
  for (const c of list) {
    if (isPlain(c.provider) && c.model === head.model && usable(c.provider) && !group.some((g) => g.provider === c.provider)) group.push(c);
  }
  if (!group.length) return { list, chosen: null };
  const load = (c) => loadOf(c.provider) ?? UNKNOWN_LOAD;
  const roomiest = group.reduce((best, c) => (load(c) < load(best) ? c : best));
  const own = placed ? group.find((c) => c.provider === placed) : null;
  const pick = own && (load(own) < HIGH_LOAD || load(own) - load(roomiest) < MOVE_MARGIN) ? own : roomiest;
  return { list: [pick, ...list.filter((c) => c !== pick)], chosen: pick.provider };
}

/** For a one-shot (a title, the backlog draft, a reviewer): the usable plain account with the most room
 *  left; equal loads keep the list's order. null = none usable. */
export function roomiestAccount(ids, { usable, loadOf, softCap = null }) {
  let best = null;
  let fallback = null;
  for (const id of ids) {
    if (!usable(id)) continue;
    const load = loadOf(id) ?? UNKNOWN_LOAD;
    // Past the soft cap an account takes no new work unless nothing else is left (never dropped).
    if (softCap != null && load >= softCap) {
      if (!fallback || load < fallback.load) fallback = { id, load };
      continue;
    }
    if (!best || load < best.load) best = { id, load };
  }
  return (best || fallback)?.id ?? null;
}
