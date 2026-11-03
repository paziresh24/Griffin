// A colleague's conversation (their Telegram chat, rootCaller "team", or their agent over /mcp,
// "peer:*") sits on «بپرس»: it reads, and a change it cannot make is refused. When the work really
// needs more, it asks the owner once (request_full_access); his yes moves that conversation to
// «بدون پرسیدن» for a few hours — his tool quota, no per-call questions — and the work goes on there
// by itself (owner 2026-10-28: «نمیشه کاری کرد که اگر دسترسی خواست بهم بگه و من بهش اجازه بدم بره تو
// حالت بدون پرسیدن و همه کارا رو بکنه؟» — before this it only left chat suggestions he had to start).
// His switching the chat's mode to «بدون پرسیدن» on the page is the same grant; any other mode ends it.
//
// What stays even with full access: secret values never go to a colleague (secretsGate), the
// backdoor fence, and messages to other people or knowledge writes still ask him.

import { OWNER } from "./persona.mjs";
import { ownerSaidYes } from "./asks.mjs";
import { maskText } from "./redact.mjs";

export const FULL_ACCESS_TOOL = "request_full_access";
// «بپرس»: what every colleague conversation shows and runs as until he grants more.
export const COLLEAGUE_MODE = "ask";
export const FULL_ACCESS_HOURS = 6;
const KEY = (rootChatId) => `fullaccess:${rootChatId}`;
const YES = "اجازه بده";
const NO = "نه";

/** True for a chain rooted in a colleague's conversation: their Telegram chat or their agent. */
export const colleagueCaller = (rootCaller) => rootCaller === "team" || (typeof rootCaller === "string" && rootCaller.startsWith("peer:"));

const emit = (store, chatId) => store.bus?.emit?.("chats", { type: "live", chatId });

/** He granted it (the tool's yes, or the mode switch on the page): «بدون پرسیدن» until `hours` from now. */
export function grantFullAccess(store, rootChatId, { hours = FULL_ACCESS_HOURS, by = "owner", why = "", now = Date.now() } = {}) {
  const until = new Date(now + hours * 3_600_000).toISOString();
  store.setKv(KEY(rootChatId), { until, by, why: String(why).slice(0, 300), at: new Date(now).toISOString() });
  if ((store.getChat(rootChatId)?.mode || "agent") !== "agent") store.updateChat(rootChatId, { mode: "agent" });
  emit(store, rootChatId);
  return until;
}

export function endFullAccess(store, rootChatId) {
  store.deleteKv(KEY(rootChatId));
}

/**
 * The conversation's live grant ({ until, by, why }) or null. A colleague conversation on
 * «بدون پرسیدن» without a live grant — the old default, or the grant ran out — goes back to «بپرس».
 */
export function fullAccess(store, rootChatId, now = Date.now()) {
  const root = store.getChat(rootChatId);
  if (!root) return null;
  const grant = store.getKv(KEY(rootChatId));
  const live = grant && Date.parse(grant.until) > now;
  if (live && (root.mode || "agent") === "agent") return grant;
  if (grant) endFullAccess(store, rootChatId);
  if ((root.mode || "agent") === "agent") {
    store.updateChat(rootChatId, { mode: COLLEAGUE_MODE });
    emit(store, rootChatId);
  }
  return null;
}

/** The question he answers: who, what for, and what «اجازه بده» does — in plain Persian. */
export function fullAccessQuestion({ who, why }) {
  return `${who ? `${who}: ` : ""}${why}\nبرای انجامش این گفتگو دسترسی بیشتری لازم دارد. اجازه می‌دهید تا ${FULL_ACCESS_HOURS} ساعت «بدون پرسیدن» با دسترسی شما کار را انجام دهد؟`;
}

/**
 * request_full_access for a colleague conversation. ask(args) is ask_owner's execute for this chat;
 * resume(text) sends the chat its next turn (it starts with the full tools).
 */
export function fullAccessTool({ store, rootChatId, who = null, ask, resume }) {
  return {
    description:
      `Ask ${OWNER.name} once to let this conversation work with his full access («بدون پرسیدن», ${FULL_ACCESS_HOURS} hours) when the request needs a change or an access you do not have here (cluster, database, repo/MR/push, DNS/CDN, router, secret, server, Griffin's own code). ` +
      "Not for something you can read yourself. On his yes this turn ends and the next one starts by itself with the full tools — then do the whole job. Returns {granted} or {granted:false}.",
    inputSchema: {
      type: "object",
      properties: {
        why: { type: "string", description: "one or two plain Persian lines, as you would tell him out loud: who asked, what will be changed, why. No tool names." },
      },
      required: ["why"],
      additionalProperties: false,
    },
    async execute(args) {
      const why = maskText(String(args?.why || "").trim()).slice(0, 600);
      if (!why) return text({ error: "why is required" });
      const live = fullAccess(store, rootChatId);
      if (live) return text({ granted: true, until: live.until, note: "این گفتگو همین الان دسترسی کامل دارد؛ کار را انجام بده" });
      const out = await ask({ question: fullAccessQuestion({ who, why }), options: [{ label: YES, description: `${FULL_ACCESS_HOURS} ساعت بدون پرسیدن` }, { label: NO }] });
      let answer = null;
      try {
        answer = JSON.parse(out?.content?.[0]?.text || "null");
      } catch {
        answer = null;
      }
      if (!answer?.answered || !ownerSaidYes(answer.answer, [{ label: YES }])) {
        return text({ granted: false, answer: answer?.answer || answer?.reason || null, note: `${OWNER.nameFa} اجازه نداد؛ همین را مؤدبانه به درخواست‌کننده بگو و دوباره نپرس` });
      }
      const until = grantFullAccess(store, rootChatId, { why });
      await resume?.(
        `[دسترسی کامل — این پیام را سیستم فرستاده] ${OWNER.nameFa} اجازه داد این گفتگو تا ${FULL_ACCESS_HOURS} ساعت «بدون پرسیدن» با دسترسی او کار کند (برای: ${why}). ` +
          "ابزارهای کامل حالا در دست توست: همان کار را از جایی که ماند تا آخر انجام بده، خودت تست کن و نتیجه را به درخواست‌کننده بگو. فقط همان کاری که برایش اجازه گرفتی.",
      );
      return text({ granted: true, until, note: "همین نوبت را با یک خط کوتاه («اجازه گرفتم، الان انجامش می‌دهم») ببند؛ نوبت بعدی با ابزارهای کامل خودش شروع می‌شود" });
    },
  };
}

/** Said in the rules of a run that has the grant. */
export function fullAccessNote(grant) {
  return `

Full access (granted by ${OWNER.name} until ${grant.until} UTC — ${grant.why || "this conversation's request"}): this colleague conversation is on «بدون پرسیدن» with his tool quota and no per-call approval. Do the whole job yourself — the change, the test the way the requester will use it, the report. Only what the request needs; secret values still never go to the colleague, and a message to anyone else still asks him.
If no tool here makes the granted change, never end on a menu of options: say exactly which change on which system has no tool, and in the same turn call build_tool for it (owner_task, or ask_owner where that is all you have, for a missing permission — name the exact tool or permission). (2026-10-29, freeturn-monitor: the grant came, no tool could delete the CronJob, and the run answered «حذف انجام نشد» with a list of options.)
`;
}

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
