// «به سارا سپردم» with nothing sent to him (owner 2026-10-27: «خیلی زیاد پیام میده به بچه ها که به
// سارا سپردم ولی نه پیام میده نه هیچی … چند تاشم گفته تصمیم با سارا است ولی چیزی نپرسیده»). A week of
// colleague conversations had a dozen such lines to people and twenty «تصمیمش با سارا است» answers to
// colleagues' agents, none with an ask_owner or a handoff_to_owner behind it: the agent took writing it
// in its own report as telling him. A colleague then waits on a promise nobody holds.
//
// A conversation that has reached the owner is marked (trackOwnerReach); a message to a colleague that
// says it did — or that leaves a decision with him — is refused (mother chat send_to_person) or sent
// back once (a colleague's agent's answer, runner.mjs) until it really has.

import { OWNER } from "./persona.mjs";

const REACH_KEY = (rootChatId) => `ownerreach:${rootChatId}`;
// How long one ask or handoff backs a claim: «هنوز دست سارا است» the next day is still true.
export const REACH_WINDOW_MS = 48 * 3_600_000;
// The owner writing to that colleague himself: he is in the conversation, «تصمیمش با خودشونه» holds.
const OWNER_WROTE_WINDOW_MS = 6 * 3_600_000;

// The tools whose successful call puts something in front of the owner.
export const REACH_TOOLS = new Set(["ask_owner", "request_full_access", "handoff_to_owner", "owner_task", "tell_owner", "notify_owner", "chat_send", "forward_to_chat"]);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ZW = "[\\u200c\\s]?";
// «سارا», «خانم احمدی», «سارا احمدی»: how a message names him. Pronouns are left out — «ایشان»
// is as often the colleague's own manager or the database owner.
function ownerNames() {
  const names = new Set();
  if (OWNER.nameFa) names.add(OWNER.nameFa);
  const full = String(OWNER.fullNameFa || "").trim();
  if (full) {
    names.add(full);
    const surname = full.split(/\s+/).slice(1).join(" ");
    if (surname) names.add(`آقای ${surname}`);
  }
  return [...names].filter((n) => n && n !== "صاحب‌کار").map((n) => esc(n).replace(/[‌ ]/g, ZW));
}

// Said it reached him: «به سارا سپردم / گفتم / رساندم / خبر دادم / ثبت کردم / یادآوری کردم», «از
// سارا پرسیدم», and the same as a promise («می‌سپارم», «می‌گم», «می‌رسونم»). Left a decision with
// him: «تصمیمش با سارا است», «سارا باید تصمیم بگیرد», «منتظر تأیید سارا».
const VERBS = [
  "سپرد", `می${ZW}سپار`, "گفتم", `می${ZW}گ(?:م|ویم)`, "رساندم", "رسوندم", `می${ZW}رسا?ن`, `می${ZW}رسون`,
  `خبر${ZW}(?:دادم|می${ZW}د)`, "پرسیدم", `می${ZW}پرسم`, `ثبت${ZW}کردم`, `یادآوری${ZW}(?:کردم|می${ZW}کنم)`, `اطلاع${ZW}(?:دادم|می${ZW}دهم)`,
].join("|");

let cached = null;
function patterns() {
  const names = ownerNames();
  if (!names.length) return null;
  if (cached?.key === names.join("|")) return cached.re;
  const who = `(?:${names.join("|")})`;
  const re = new RegExp(
    [
      `(?:به|از|برای)\\s${who}[^.!؟?\\n]{0,40}?(?<!\\p{L})(?:${VERBS})`,
      `${who}\\s(?:را\\s|رو\\s)?در${ZW}جریان\\s(?:گذاشتم|است|هست|هستن|هستند)`,
      `دست\\s${who}(?:\\s|ه|است)`,
      `تصمیم(?:ش|ی|\\sنهایی)?(?:\\s[^.!؟?\\n]{0,30}?)?\\s(?:با|دست|به${ZW}عهدهٔ?)\\s(?:خود\\s)?${who}(?![^.!؟?\\n]{0,15}هماهنگ)`,
      `تصمیم\\s${who}`,
      `${who}\\s(?:باید\\s)?تصمیم(?:ش)?\\s(?:را\\s)?(?:بگیر|می${ZW}گیر)`,
      `منتظر\\s(?:تأیید|تایید|جواب|نظر)\\s${who}`,
    ].join("|"),
    "u",
  );
  cached = { key: names.join("|"), re };
  return re;
}

/** The phrase in `text` that says the owner was told, or that a decision is his; null if none. */
export function ownerClaim(text) {
  const re = patterns();
  if (!re) return null;
  const m = re.exec(String(text || ""));
  return m ? m[0].trim() : null;
}

/** The conversation rooted at rootChatId put something in front of the owner now. */
export function markOwnerReached(store, rootChatId, at = new Date()) {
  if (rootChatId) store.setKv(REACH_KEY(rootChatId), at.toISOString());
}

/**
 * True when the conversation rooted at rootChatId reached the owner lately: a tool of REACH_TOOLS, a
 * handoff card it left, an approval question one of its chats raised, or (ownerWroteAt) the owner
 * writing to that colleague himself.
 */
export function ownerReached(store, rootChatId, { now = Date.now(), ownerWroteAt = null } = {}) {
  if (!rootChatId) return false;
  const since = now - REACH_WINDOW_MS;
  const marked = Date.parse(store.getKv(REACH_KEY(rootChatId)) || "");
  if (marked >= since) return true;
  if (ownerWroteAt && Date.parse(ownerWroteAt) >= now - OWNER_WROTE_WINDOW_MS) return true;
  const sinceIso = new Date(since).toISOString();
  try {
    if (store.db?.prepare("SELECT 1 FROM suggestions WHERE from_chat_id = ? AND created_at >= ? LIMIT 1").get(rootChatId, sinceIso)) return true;
    const asked = store.db?.prepare("SELECT DISTINCT chat_id FROM approvals WHERE at >= ? AND chat_id IS NOT NULL").all(sinceIso) || [];
    if (asked.some((row) => row.chat_id === rootChatId || store.rootChatId?.(row.chat_id) === rootChatId)) return true;
  } catch {
    // An older database without these tables: the mark alone decides.
  }
  return false;
}

const failed = (out) => {
  if (!out || out.isError) return true;
  try {
    const value = JSON.parse(out?.content?.[0]?.text || "null");
    return Boolean(value && typeof value === "object" && value.error);
  } catch {
    return false;
  }
};

/** Wraps the REACH_TOOLS in `tools` so a successful call marks the conversation (markOwnerReached). */
export function trackOwnerReach(tools, { store, rootChatId }) {
  const out = { ...tools };
  for (const [name, tool] of Object.entries(tools)) {
    if (!REACH_TOOLS.has(name) || typeof tool?.execute !== "function") continue;
    out[name] = {
      ...tool,
      async execute(...args) {
        const result = await tool.execute(...args);
        if (!failed(result)) markOwnerReached(store, rootChatId);
        return result;
      },
    };
  }
  return out;
}

/** What send_to_person answers when the message claims a hand-over that never happened. */
export function unbackedSendError(phrase) {
  return (
    `پیام نرفت: در آن نوشته‌ای «${phrase}»، ولی این گفتگو در ۴۸ ساعت گذشته هیچ چیزی به ${OWNER.nameFa} نرسانده ` +
    `(نه request_full_access، نه ask_owner). نوشتن در گزارش پایانی‌ات به او نمی‌رسد. یکی از این‌ها: ` +
    `کاری که دسترسی او را می‌خواهد → اول request_full_access؛ تصمیمی که فقط او می‌گیرد → اول ask_owner با یک سؤال ساده و گزینه‌ها؛ ` +
    `بعد همین پیام را بفرست. اگر لازم نیست به او برسد، آن جمله را بردار و بدون آن بفرست.`
  );
}

/** The engine message that sends a colleague-facing answer back once (runner.mjs, ownerClaimLeg). */
export function unbackedAnswerNudge(phrase) {
  return [
    `[تذکر سیستمی — از طرف هیچ آدمی نیست؛ به آن جواب نده] جوابت به درخواست‌کننده می‌گوید «${phrase}»، ولی این گفتگو هیچ چیزی به ${OWNER.nameFa} نرسانده است: نه ask_owner، نه request_full_access، نه owner_task.`,
    `اگر برای همین درخواست تصمیم یا تأیید او لازم است، همین حالا بپرس (ask_owner: یک سؤال ساده با گزینه‌ها؛ یا request_full_access اگر داری و کار تغییر است). اگر لازم نیست، آن جمله را حذف کن — «تصمیمش با ${OWNER.nameFa} است» بدون پرسیدن، درخواست‌کننده را منتظر کسی می‌گذارد که خبر ندارد.`,
    "بعد جواب نهایی را کامل از نو بنویس، با آنچه واقعاً انجام شد.",
  ].join("\n");
}
