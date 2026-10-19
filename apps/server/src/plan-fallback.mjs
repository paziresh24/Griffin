// Plan limit: ask before moving a chat to another engine (port of Karsara !75/!76; Karsara owner
// decision 2026-10-13: a switch is never silent). PLAN_FALLBACK=auto moves the run to the next usable
// engine account by itself (4cc27dc, d20ed99). With PLAN_FALLBACK=ask (the default since 2026-10-19), an
// owner's own chat instead gets a question card: go on with <model>, or wait for the reset. No
// answer, «صبر کن» or a new message: nothing moves and the wait for the reset stands as before.

import { ASK_TOOL } from "./asks.mjs";
import { maskText } from "./redact.mjs";
import { isCreditError } from "./engine-state.mjs";

// Which way the install goes when a plan limit stops an owner's chat: "ask" (default since owner
// 2026-10-19: a switch is never silent in his own chats) or "auto".
export const planFallbackMode = (value) => (String(value || "").trim().toLowerCase() === "auto" ? "auto" : "ask");

// Claude's text for a spent plan, mirroring the CLI's own limit messages: «You've hit your limit»,
// «You've hit your weekly limit», «You've reached your Fable limit», «You're out of extra usage»,
// «You're out of usage credits», «Your org is out of usage», «Claude AI usage limit reached»,
// «5-hour limit reached». Not «fast limit» (fast mode only), not «Context limit reached».
const CLAUDE_PLAN_LIMIT = /\b(?:hit|reached) your (?!fast\b)(?:\w+[ -]){0,2}limit\b|you(?:'|’)re out of (?:extra )?usage|you(?:'|’)re out of usage credits|your org(?:anization)? is out of usage|claude ai usage limit reached|\b(?:usage|session|daily|weekly|monthly|5-hour|opus|sonnet|haiku|fable) limit reached/i;
export const isClaudePlanLimit = (message) => CLAUDE_PLAN_LIMIT.test(String(message || ""));

// Griffin's own classification since 8d4b48b (2026-10-10): an unknown model, a 404, a 429 or an
// overloaded API also moves the run in auto mode, because colleague threads died on «Unknown
// Model». Kept as it is for auto. Such an error that is not a spent plan gets its own code,
// ENGINE_UNAVAILABLE: auto treats it as a plan limit (unchanged), ask mode as an ordinary error
// (no card, no switch).
export const AUTO_FALLBACK_TEXT = /usage limit|rate limit|limit reached|hit your limit|unknown model|model code|not[_ ]?found|overloaded|\b429\b/i;
export const ENGINE_UNAVAILABLE = "engine_unavailable";
// The code a failed Claude result carries: limit = a rejected rate_limit_event.
// Out of credit («Credit balance is too low») is a spent engine too: it moves on (owner 2026-10-18;
// before, the run just failed with the error on many colleagues' installs).
export function claudeLimitCode(message, limit = null) {
  if (limit || isClaudePlanLimit(message) || isCreditError(message)) return "plan_limit";
  return AUTO_FALLBACK_TEXT.test(String(message || "")) ? ENGINE_UNAVAILABLE : null;
}
// Whether auto mode moves the run: exactly Griffin's match before this change (8d4b48b), no more
// and no less, whatever the code says.
export const autoMovesOn = (message, limit = null) => Boolean(limit) || AUTO_FALLBACK_TEXT.test(String(message || "")) || isCreditError(message);

// The rerun's note after a same-model move between accounts that could not keep the session.
export const accountMoveNote = (hop, done = null) =>
  `(سیستم) سقف پلن حساب ${hop.from} پر شد و همین مدل روی حساب ${hop.account} ادامه می‌دهد، ولی جلسهٔ قبلی به این حساب نرسید: گفت‌وگوی قبلی را نمی‌بینی و اجرای قبلی ممکن است بخشی از کار را کرده باشد. پیش از تکرار هر کار بیرونی وضعیت را بررسی کن.` + doneLines(done);

// Z.ai says when it resets: «Your limit will reset at 2026-10-13 18:00:00» (Inferred: Beijing time).
export function resetFromText(text) {
  const m = String(text || "").match(/reset at (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/i);
  if (!m) return null;
  const at = Date.parse(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}+08:00`);
  return Number.isFinite(at) ? at : null;
}

// Where the chat moved on a yes (kv): { provider, model, from (name), fromProvider, fromModel,
// fromAgentId } — the engine that hit the limit and its session, kept for the way back.
export const FALLBACK_KEY = (chatId) => `plan-fallback:${chatId}`;
// Open cards, kept so a restart neither loses the stopped message nor leaves a card that turns a
// click into an ordinary message: chatId -> { askId, runId, message, to, done, args }.
export const FALLBACK_OFFERS_KEY = "plan-fallback-offers";

const faNumber = (n) => Number(n).toLocaleString("fa-IR");
const tehranAt = (ms, now) => {
  const far = ms - now > 20 * 60 * 60_000;
  return new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hour12: false, ...(far ? { weekday: "long" } : {}) }).format(new Date(ms));
};

// Tools that only look: listed after everything that may have acted (sent, written, ran).
const LOOK_ONLY = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch", "NotebookRead", "read", "read_file", "grep", "glob", "ls", "list_dir", "web_search", "web_fetch", "todo_write"]);
const looksOnly = (name) => LOOK_ONLY.has(name) || /_(get|list|read|search|logs|describe|status)$/.test(name);
export const MAX_LISTED_TOOLS = 30;
const ARG_CUT = 240; // characters of a call's input looked at, before masking
function shortArgs(args) {
  if (args == null) return "{}";
  if (typeof args !== "object") return maskText(String(args).slice(0, 4096)).slice(0, ARG_CUT);
  // Cut every value first: a 200 KB file body is never serialised whole, nor masked whole.
  const small = {};
  // Masked before the cut, so a token straddling the cut never survives as a fragment.
  for (const [key, value] of Object.entries(args).slice(0, 12)) small[key] = typeof value === "string" ? maskText(value.slice(0, 4096)).slice(0, ARG_CUT) : typeof value === "object" && value ? "…" : value;
  let text = "";
  try {
    text = JSON.stringify(small);
  } catch {}
  return text.slice(0, ARG_CUT);
}

// What the stopped run already did, from its stored events: every finished tool call (not a
// question card) is counted; at most MAX_LISTED_TOOLS are listed, those that may have acted (sent,
// wrote, ran) first, each with a short masked look at its input.
export function doneTools(store, runId) {
  const empty = { count: 0, list: [], more: 0 };
  if (!runId || !store?.runEvents) return empty;
  const started = new Map();
  const calls = [];
  for (const event of store.runEvents(runId)) {
    const data = event.data || {};
    if (event.type === "tool.started" && data.callId) started.set(data.callId, data.args);
    if (event.type !== "tool.done" || !data.name || data.name === ASK_TOOL || data.sub) continue;
    calls.push({ name: String(data.name), raw: data.args ?? started.get(data.callId) });
  }
  const acted = calls.filter((c) => !looksOnly(c.name));
  const looked = calls.filter((c) => looksOnly(c.name));
  const list = [...acted, ...looked].slice(0, MAX_LISTED_TOOLS).map((c) => {
    const args = maskText(shortArgs(c.raw));
    return { name: c.name, args: args.length > 120 ? `${args.slice(0, 120)}…` : args };
  });
  return { count: calls.length, list, more: calls.length - list.length };
}

export function doneLines(done) {
  if (!done?.list?.length) return "";
  const more = done.more > 0 ? `\nو ${faNumber(done.more)} کار دیگر` : "";
  return `\nکارهایی که اجرای قبلی انجام داد (تکرارشان نکن مگر لازم باشد):\n${done.list.map((t) => `- ${t.name} ${t.args}`).join("\n")}${more}`;
}

// The lead note the model reads before the stopped message. back: the chat returns to the engine
// it came from, whose own session (with the conversation up to the first move) resumes.
export const fallbackNote = (to, done = null) =>
  (to.back
    ? `(سیستم) سقف پلن ${to.fromName} هم پر شد و مالک گفت به ${to.name} برگردیم. این همان جلسهٔ قبلی توست، ولی در این فاصله مدل دیگری روی این گفتگو کار کرده که آن را نمی‌بینی: پیش از تکرار هر کار بیرونی وضعیت را بررسی کن.`
    : `(سیستم) سقف پلن ${to.fromName} پر شد و مالک گفت با ${to.name} ادامه بدهیم. گفت‌وگوی قبلی را نمی‌بینی و اجرای قبلی ممکن است بخشی از کار را کرده باشد: پیش از تکرار هر کار بیرونی (push، ارسال پیام، دیپلوی) وضعیت را بررسی کن، و اگر پیام زیر بدون آن گفت‌وگو روشن نیست، بپرس.`) + doneLines(done);

export const withLeadNote = (message, note) => (typeof message === "string" ? `${note}\n\n${message}` : { ...message, text: `${note}\n\n${message?.text || ""}` });

// Kept in the store with the offer: the text only. Pictures and files stay in memory; after a
// restart the rerun says how many did not come along.
export function storableMessage(message) {
  if (typeof message === "string") return message;
  const dropped = (message?.images?.length || 0) + (message?.files?.length || 0);
  return dropped ? { text: String(message?.text || ""), dropped } : { text: String(message?.text || "") };
}
export const droppedNote = (n) => `(سیستم) پیام اصلی ${faNumber(n)} پیوست (تصویر یا فایل) داشت که پس از ری‌استارت سرور به این اجرا نرسید؛ اگر لازم است، از مالک بخواه دوباره بفرستد.`;

export const waitLabel = "صبر کن";
export const goLabel = (to) => `با ${to.name} ادامه بده`;
export const CARD_KIND = "plan-fallback";

// The card's text. to: { name, fromName, back? }; resetsAt: when the limited plan opens, if known.
export function fallbackQuestion(to, resetsAt, now = Date.now(), doneCount = 0) {
  const until = resetsAt && resetsAt > now ? `ساعت ${tehranAt(resetsAt, now)}` : "باز شدن سقف";
  const did = doneCount > 0 ? ` اجرای قبلی ${faNumber(doneCount)} کار انجام داده بود.` : "";
  const history = to.back ? "(به جلسهٔ قبلی همین گفتگو برمی‌گردد و کارهای این فاصله را نمی‌بیند)" : "(این مدل تاریخچهٔ این گفتگو را نمی‌بیند)";
  return {
    // The history does not carry over to another engine: said up front, never found out later.
    question: `سقف پلن ${to.fromName} پر شده.${did} با ${to.name} ادامه بدهم؟ ${history} یا تا ${until} صبر کنم؟`,
    options: [
      {
        label: goLabel(to),
        description: to.back ? "به جلسهٔ قبلی همین گفتگو برمی‌گردد و همین پیام دوباره اجرا می‌شود؛ کارهای این فاصله را نمی‌بیند." : "همین پیام با این مدل دوباره اجرا می‌شود؛ گفت‌وگوی قبلی به این مدل نمی‌رسد.",
      },
      { label: waitLabel, description: "مثل همیشه منتظر باز شدن سقف می‌ماند." },
    ],
    // The web card shows no free-text box for this kind and is never clickable once closed.
    kind: CARD_KIND,
  };
}

export const saidYes = (selected, to) => Array.isArray(selected) && selected[0] === goLabel(to);
export const saidWait = (selected) => Array.isArray(selected) && selected[0] === waitLabel;

// Which candidate runs (index.mjs routeModel). auto: the first usable one (enabled, keyed, not at
// its plan limit), so a limit moves the chat by itself. ask: a limited account is NOT skipped —
// the chat stays on its own engine (and hits the limit again, which asks again) until the owner
// says yes on the card, which pins the chat to the engine he chose.
export function pickRoute(list, { usable, enabled, keyed = () => true, ask = false, kindOf = (id) => id }) {
  if (ask) {
    const home = list.find((c) => enabled(c.provider) && keyed(c.provider));
    // The same model on another usable account is not a switch: taken without asking.
    if (home && !usable(home.provider)) {
      const alt = list.find((c) => usable(c.provider) && sameModelAccount(home, c, kindOf));
      if (alt) return alt;
    }
    return home || list.find((c) => enabled(c.provider)) || list[0] || null;
  }
  return list.find((c) => usable(c.provider)) || list.find((c) => enabled(c.provider)) || list[0] || null;
}

// The same model on another account of the same kind, when the chat's own account (the first
// enabled candidate) is limited: { from, account } — the move that stays automatic in ask mode.
// Claude accounts only (they share one Claude Code config folder, so the session carries over),
// and only an explicit, identical model: two OpenAI-kind accounts can be different vendors, and
// «auto» names no model at all. Anything else goes through the card.
export const sameModelAccount = (home, c, kindOf) =>
  c.provider !== home.provider && kindOf(c.provider) === "claude" && kindOf(home.provider) === "claude" && Boolean(home.model) && home.model !== "auto" && c.model === home.model;
export function pickAccountHop(list, route, { enabled, keyed = () => true, usable, nameOf, kindOf = (id) => id }) {
  const home = list.find((c) => enabled(c.provider) && keyed(c.provider));
  if (!home || usable(home.provider)) return null;
  const alt = list.find((c) => usable(c.provider) && sameModelAccount(home, c, kindOf));
  if (!alt || (route && route.provider !== alt.provider)) return null;
  return { provider: alt.provider, from: nameOf(home.provider) || home.provider, account: nameOf(alt.provider) || alt.provider };
}

// The engine a limited chat would go on with: the first usable candidate on another account.
// nameOf(id) -> the account's shown name. Another account of the same model says which account.
export function pickFallback(list, current, { usable, nameOf, kindOf = (id) => id }) {
  if (!current) return null;
  const next = list.find((c) => c.provider !== current.provider && usable(c.provider));
  if (!next) return null;
  const fromName = nameOf(current.provider) || current.provider;
  const model = next.model && next.model !== "auto" ? next.model : nameOf(next.provider) || next.provider;
  const sameKind = kindOf(next.provider) === kindOf(current.provider);
  const name = sameKind ? `${model} (${nameOf(next.provider) || next.provider})` : model;
  return { provider: next.provider, model: next.model, name, fromName };
}
