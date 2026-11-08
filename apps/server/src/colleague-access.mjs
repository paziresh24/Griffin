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
import { HANDOFF_PROMPT_ROOM, handoffTool } from "./handoff.mjs";
import { maskText } from "./redact.mjs";

export const FULL_ACCESS_TOOL = "request_full_access";
// «بپرس»: what every colleague conversation shows and runs as until he grants more.
export const COLLEAGUE_MODE = "ask";
export const FULL_ACCESS_HOURS = 6;
export const OWNER_CHAT_TOOL = "request_owner_chat";
const KEY = (rootChatId) => `fullaccess:${rootChatId}`;
const YES = "اجازه بده";
const NO = "نه";
const START_CHAT = "شروع کن";
export const SHELL_TOOL = "request_shell";
const SHELL_YES = "برگردان";

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
      const out = await ask({ ownCard: true, question: fullAccessQuestion({ who, why }), options: [{ label: YES, description: `${FULL_ACCESS_HOURS} ساعت بدون پرسیدن` }, { label: NO }] });
      const answer = answerOf(out);
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

/** The question for one owner chat: he says yes to this exact work, so the work itself is in it. */
export function ownerChatQuestion({ who, title, why, prompt }) {
  const work = prompt.length > 700 ? `${prompt.slice(0, 700)}…` : prompt;
  return `${who ? `${who}: ` : ""}${why}\nاین گفتگو به این کار دسترسی ندارد. یک چت خودتان با دسترسی کامل شما همین کار را شروع کند؟ نتیجه خودکار به همین گفتگو برمی‌گردد.\n\n${title}\n${work}`;
}

/**
 * request_owner_chat: full access is Griffin's tools, not his shell and keys, so a login on a server
 * stays out of a colleague's conversation (owner 2026-11-04: a colleague server disk, the assistant has no
 * sudo, «بدون پرسیدن» changed nothing). His yes to this one job starts a chat of his own (handoff.mjs):
 * the colleague side's text is framed as evidence there and each result comes back. The colleague's
 * chain itself never gets his keys. start(row) starts the chat, notify(text, chatId) rings him.
 */
export function ownerChatTool({ store, chatId, rootChatId, who = null, ask, start, notify = null }) {
  const handoff = (approved = null) => handoffTool({ store, chatId, rootChatId, who, notify, start, approved });
  return {
    description:
      `Ask ${OWNER.name} once to run one job in a chat of his own, with his real access (his shell, keys and logins), when this conversation hits a wall its tools cannot pass: permission denied, a sudo password, a login on a server. ` +
      "Find out what you can first. On his yes the chat starts by itself and every result it finishes comes back to this conversation; then tell the requester. `prompt` must stand alone: who asked, the evidence you found (hosts, names, errors), the exact work, how to check it is done. Only one job per call, and never again for the same job. Returns {started} or {started:false}.",
    inputSchema: handoff().inputSchema,
    async execute(args) {
      const title = maskText(String(args?.title || "").trim()).slice(0, 120);
      const why = maskText(String(args?.why || "").trim()).slice(0, 600);
      const prompt = maskText(String(args?.prompt || "").trim());
      if (!title || !why || !prompt) return text({ error: "title, why and prompt are required" });
      if (prompt.length > HANDOFF_PROMPT_ROOM) return text({ error: `prompt is ${prompt.length} characters; the limit is ${HANDOFF_PROMPT_ROOM}. Shorten it and call again.` });
      const question = ownerChatQuestion({ who, title, why, prompt });
      const answer = answerOf(await ask({ ownCard: true, question, options: [{ label: START_CHAT, description: "یک چت خودتان، فقط برای همین کار" }, { label: NO }] }));
      if (!answer?.answered || !ownerSaidYes(answer.answer, [{ label: START_CHAT }])) {
        return text({ started: false, answer: answer?.answer || answer?.reason || null, note: `${OWNER.nameFa} اجازه نداد؛ همین را مؤدبانه به درخواست‌کننده بگو و دوباره نپرس` });
      }
      return handoff({ question, answer: answer.answer }).execute(args);
    },
  };
}

/** Said in the rules of an owner chat with no shell. No chat title or other stored text: rules are trusted. */
export const SHELL_HELD_NOTE = `

No shell in this chat: it, or a chat it was made from, holds someone else's message, so Bash and the file tools are closed (their words must not drive ${OWNER.name}'s shell). Do not tell him to grant access and do not file an owner_task for it: he has no switch for that. A chat made from this one has the same wall. When the work needs the shell, call ${SHELL_TOOL} once: it tells him why and his yes opens the shell for this chat.
`;

/**
 * request_shell, in his own chat that holds someone else's words (knowledge-trust.mjs heldWhy). The
 * reason on the card comes from the record, never from the model. allow() records his yes;
 * resume(text) sends the next turn, which starts with the shell (runner placement).
 */
export function shellTool({ reason, ask, allow, resume }) {
  return {
    description:
      `Ask ${OWNER.name} once to open Bash and the file tools in this chat, closed because it or a chat it was made from holds someone else's message. Only when the work needs them. ` +
      "On his yes this turn ends and the next one starts by itself with the shell. New words from someone else close it again. Returns {granted} or {granted:false}.",
    inputSchema: {
      type: "object",
      properties: { why: { type: "string", description: "one plain Persian line: what you need the shell for. No tool names." } },
      required: ["why"],
      additionalProperties: false,
    },
    async execute(args) {
      const why = maskText(String(args?.why || "").trim()).slice(0, 400);
      if (!why) return text({ error: "why is required" });
      const question = `این چت Bash و ابزارهای فایل ندارد، چون ${reason}.\nبرای: ${why}\nشل برای همین چت برگردد؟ اگر پیام تازه‌ای از کس دیگری بیاید، دوباره بسته می‌شود.`;
      const answer = answerOf(await ask({ ownCard: true, question, options: [{ label: SHELL_YES, description: "فقط همین چت" }, { label: NO }] }));
      if (!answer?.answered || !ownerSaidYes(answer.answer, [{ label: SHELL_YES }])) {
        return text({ granted: false, answer: answer?.answer || answer?.reason || null, note: "شل بسته ماند؛ با ابزارهای دیگر ادامه بده و دوباره نپرس" });
      }
      allow();
      await resume?.(`[شل برگشت — این پیام را سیستم فرستاده] ${OWNER.nameFa} اجازه داد Bash و ابزارهای فایل در همین چت برگردند (برای: ${why}). کار را از جایی که ماند تا آخر انجام بده.`);
      return text({ granted: true, note: "همین نوبت را با یک خط کوتاه ببند؛ نوبت بعدی با شل خودش شروع می‌شود" });
    },
  };
}

/** The turn his «بدون پرسیدن» on the page starts: without it the grant sat unused until the next message. */
export function pageGrantNote() {
  return (
    `[دسترسی کامل — این پیام را سیستم فرستاده] ${OWNER.nameFa} از صفحهٔ چت این گفتگو را تا ${FULL_ACCESS_HOURS} ساعت روی «بدون پرسیدن» گذاشت. ` +
    "کار باز یا گیرکردهٔ همین گفتگو را از جایی که ماند تا آخر انجام بده، خودت تست کن و نتیجه را به درخواست‌کننده بگو. کار بازی نیست؟ یک خط بگو و نوبت را ببند؛ به کسی پیام نده."
  );
}

/** Said in the rules of a run that has the grant. */
export function fullAccessNote(grant) {
  return `

Full access (granted by ${OWNER.name} until ${grant.until} UTC — ${grant.why || "this conversation's request"}): this colleague conversation is on «بدون پرسیدن» with his tool quota and no per-call approval. On Claude it is also a full shell (Bash, on his host when it runs there): use it for what ssh_exec as griffin cannot reach. On another engine it is Griffin's tools only, and a wall there (permission denied, a sudo password) is request_owner_chat. Do the whole job yourself — the change, the test the way the requester will use it, the report. Only what the request needs; secret values still never go to the colleague, and a message to anyone else still asks him.
If no tool here makes the granted change, never end on a menu of options: say exactly which change on which system has no tool, and in the same turn call build_tool for it (owner_task, or ask_owner where that is all you have, for a missing permission — name the exact tool or permission). (2026-10-29, freeturn-monitor: the grant came, no tool could delete the CronJob, and the run answered «حذف انجام نشد» with a list of options.)
`;
}

function answerOf(out) {
  try {
    return JSON.parse(out?.content?.[0]?.text || "null");
  } catch {
    return null;
  }
}

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
