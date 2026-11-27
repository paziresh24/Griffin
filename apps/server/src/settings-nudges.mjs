// A setting offered from how the owner works (owner 2026-11-23, the plan's «پیشنهاد خودجوش»; behind
// SETTINGS_NUDGES, off by default, turned on install by install). No model: a few plain signals of the
// last seven days, each pointing at one setting of the catalogue (settings-catalog.js), and the card in the
// sidebar applies it only on the owner's click (web SettingsNudge.jsx) — the same rules as «پرسش از دستیار».
//
// What counts (the owner's own chats only — not a job's, a colleague's or the Telegram desk's):
//   limit   runs that stopped at a plan limit                 → «ادامهٔ خودکار بعد از سقف» on
//   double  a second message under 20 s after the first one  → Enter sends nothing, Shift+Enter does
//   queued  messages that waited for the run to finish        → «پیام وسط کار» on
// Click-map dead clicks were looked at and left out: the busiest ones (g-work-host, g-answer) are the
// page's blank space and selected text, not a setting anyone could turn.
//
// At most one card a week; one the owner put off («بعداً») or applied does not come back for 60 days.
import { describePick } from "./settings-suggest.mjs";

export const NUDGES_CONFIG = "SETTINGS_NUDGES";
const KV = "settings-nudge";
export const WINDOW_DAYS = 7;
export const GAP_DAYS = 7;
export const QUIET_DAYS = 60;
const DAY = 86_400_000;
const DOUBLE_GAP_MS = 20_000;

export const RULES = [
  { id: "limit", entry: "set:AUTO_CONTINUE", value: "on", min: 3, why: (n) => `این هفته ${n} بار گفتگو به سقف خورد و منتظر ماند تا دوباره بنویسید؛ با این کلید بعد از باز شدن سقف خودش ادامه می‌دهد.` },
  { id: "double", entry: "set:ENTER_KEY", value: "shiftEnter", min: 5, why: (n) => `این هفته ${n} بار پیامی را چند ثانیه بعد از پیام قبلی فرستادید؛ اگر اینتر پیام را زود می‌فرستد، با این گزینه اینتر فقط خط بعد می‌رود.` },
  { id: "queued", entry: "set:CLAUDE_STEER", value: "on", min: 5, why: (n) => `این هفته ${n} پیام شما تا تمام شدن کار در صف ماند؛ با این کلید پیام وسط کار همان لحظه به ایجنت می‌رسد.` },
];

// The first event of the window: ids grow with time, so a binary search on the primary key, not a scan.
function firstEventSince(db, since) {
  const bounds = db.prepare("SELECT MIN(id) AS lo, MAX(id) AS hi FROM events").get();
  let lo = Number(bounds?.lo || 0);
  let hi = Number(bounds?.hi || 0);
  if (!hi) return null;
  const atOf = db.prepare("SELECT at FROM events WHERE id >= ? ORDER BY id LIMIT 1");
  if (String(atOf.get(hi)?.at || "") < since) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (String(atOf.get(mid)?.at || "") < since) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

/** The signals of the last WINDOW_DAYS in the owner's own chats: { limit, double, queued }. */
export function countSignals({ store, isOwnChat, now = Date.now() }) {
  const db = store.db;
  const since = new Date(now - WINDOW_DAYS * DAY).toISOString();
  const from = firstEventSince(db, since);
  const counts = { limit: 0, double: 0, queued: 0 };
  if (from == null) return counts;
  const rows = db.prepare("SELECT chat_id, run_id, type, data, at FROM events WHERE id >= ? AND type IN ('user', 'run.phase') ORDER BY id").all(from);
  const own = new Map();
  const mine = (chatId) => {
    if (!own.has(chatId)) own.set(chatId, Boolean(isOwnChat(store.getChat(chatId))));
    return own.get(chatId);
  };
  const limitedRuns = new Set();
  const lastOwnerText = new Map();
  for (const row of rows) {
    if (!mine(row.chat_id)) continue;
    const data = parse(row.data);
    if (row.type === "run.phase") {
      if (data.phase === "limited" && row.run_id) limitedRuns.add(row.run_id);
      continue;
    }
    // The owner's own words: not a reminder, a colleague's note or a hand-over (`from`), not a steer's echo.
    if (data.from || typeof data.text !== "string" || !data.text.trim()) continue;
    if (data.intent === "queue") counts.queued += 1;
    const at = Date.parse(row.at);
    const before = lastOwnerText.get(row.chat_id);
    if (before != null && at - before < DOUBLE_GAP_MS) counts.double += 1;
    lastOwnerText.set(row.chat_id, at);
  }
  counts.limit = limitedRuns.size;
  return counts;
}

/** The kv record: { shown: { rule, at, ... } | null, quiet: { [rule]: until } }. */
function readState(store) {
  const value = store.getKv(KV);
  return value && typeof value === "object" ? { shown: value.shown || null, quiet: value.quiet || {} } : { shown: null, quiet: {} };
}

/**
 * Decide this week's card: the first rule whose signal is over its bar, whose setting one click may change
 * (and is not already that way), that the owner did not put off lately, and only GAP_DAYS after the last card.
 */
export function pickNudge({ counts, entries, state, now = Date.now() }) {
  if (state.shown && now - Date.parse(state.shown.at) < GAP_DAYS * DAY) return null;
  for (const rule of RULES) {
    const n = counts[rule.id] || 0;
    if (n < rule.min) continue;
    if (state.quiet[rule.id] && now < Date.parse(state.quiet[rule.id])) continue;
    const card = describePick({ id: rule.entry, value: rule.value, why: rule.why(n) }, entries);
    if (card?.oneClick) return { rule: rule.id, count: n, ...card };
  }
  return null;
}

export function createSettingsNudges({ store, catalog, isOwnChat, enabled, now = () => Date.now() }) {
  const write = (state) => store.setKv(KV, state);
  return {
    /** Look again (a timer, a few times a day): store this week's card, if any. */
    refresh() {
      if (!enabled()) return null;
      const state = readState(store);
      const card = pickNudge({ counts: countSignals({ store, isOwnChat, now: now() }), entries: catalog(), state, now: now() });
      if (card) write({ ...state, shown: { ...card, at: new Date(now()).toISOString(), open: true } });
      return card;
    },
    /** The card the sidebar shows now, re-described with today's values (gone once it is already set). */
    current() {
      if (!enabled()) return null;
      const shown = readState(store).shown;
      if (!shown?.open) return null;
      const rule = RULES.find((r) => r.id === shown.rule);
      const card = rule ? describePick({ id: rule.entry, value: rule.value, why: shown.why }, catalog()) : null;
      return card?.oneClick ? { rule: shown.rule, ...card } : null;
    },
    /** «بعداً» or applied: the card closes and that rule stays quiet for QUIET_DAYS. */
    close(ruleId, outcome = "later") {
      const state = readState(store);
      if (!state.shown || state.shown.rule !== ruleId) return false;
      write({ shown: { ...state.shown, open: false, outcome }, quiet: { ...state.quiet, [ruleId]: new Date(now() + QUIET_DAYS * DAY).toISOString() } });
      return true;
    },
  };
}
