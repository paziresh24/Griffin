import { guardTools } from "../guard.mjs";

// Telegram stand-in: owner types /agent in a teammate's chat; the agent (not canned text)
// greets them, works, then closes with end_agent after saying goodbye.
// Dangerous / irreversible tool calls for caller "team" are hard-gated here (not by prompt).

export const COVERAGE_CALLER = "team";
export const END_AGENT_TOOL = "end_agent";

// Owner only starts. Optional kill-switch: /agent off
const START = /^\s*\/agent\s*$/i;
const END = /^\s*\/agent\s+off\s*$/i;

export function coverageCommand(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (START.test(s)) return "start";
  if (END.test(s)) return "end";
  return null;
}

/** First run after /agent: agent must introduce itself to the peer (no tools). */
export function coverageIntroPrompt(peerName) {
  const who = peerName || "همکار";
  return (
    `[Owner در تلگرام دستور /agent زد و این گفتگو با «${who}» را به تو سپرد. ` +
    `یک پیام کوتاه فارسی بنویس و خودت را معرفی کن: بگو ایجنت پلتفرم‌بان هستی؛ فعلاً فقط وقتی Owner /agent بزند کار می‌کنی ` +
    `(همکار مستقیم درخواست ندهد). اگر چیزی مبهم بود از Owner با ask_owner بپرس. ابزار صدا نزن. با Owner حرف نزن — فقط همان معرفی.]`
  );
}

/** First run after plain /agent: review recent chat history (Owner-driven; peer cannot chat the agent). */
export function coverageContextPrompt(peerName, historyLines) {
  const who = peerName || "همکار";
  const history = (historyLines || []).filter(Boolean).slice(-25).join("\n");
  return (
    `[Owner در تلگرام دستور /agent زد (بدون ریپلای روی یک پیام) و گفتگو با «${who}» را به تو سپرد. ` +
    `مهم: همکار نمی‌تواند مستقیم از تو درخواست کند — فقط Owner با /agent یا ریپلای+/agent کار را جلو می‌برد. ` +
    `تاریخچهٔ اخیر را بخوان؛ درخواست‌های باز همکار را انجام بده. اگر مبهم یا خطرناک است ask_owner بزن. ` +
    `معرفی را حداکثر یک خط نگه دار. با Owner حرف نزن.]\n\n` +
    `تاریخچهٔ اخیر (قدیمی→جدید):\n${history || "(پیامی نیست)"}`
  );
}

/**
 * Owner replied to a specific peer message with /agent — answer THAT message only.
 * Keep it short; match tone (including playful); no long intro.
 */
export function coverageReplyPrompt(peerName, replyText) {
  const who = peerName || "همکار";
  const quoted = String(replyText || "").trim().slice(0, 2000);
  return (
    `[Owner روی یک پیام خاص در چت با «${who}» ریپلای زد و /agent فرستاد. ` +
    `فقط به همان پیام جواب بده — کوتاه، فارسی، هم‌تون. اگر شوخی/محبت بود، خودت هم ایجنتیک و شوخ باش ` +
    `(مثلاً قربونت ولی ایجنتیک). معرفی بلند نکن؛ حداکثر نیم‌خط که ایجنت پلتفرم‌بانی. ` +
    `ابزار صدا نزن مگر همان پیام صریحاً کار فنی بخواهد. با Owner حرف نزن.]\n\n` +
    `پیام موردنظر:\n«${quoted}»`
  );
}

export function coveragePrompt(peerName, text) {
  const who = peerName || "همکار";
  return (
    `[ایجنت پلتفرم‌بان — گفتگو با «${who}». تو از طرف Owner هستی و مسئله را خودت حل کن؛ ` +
    `پیام‌هایت مستقیم به همین نفر می‌رود. هرگز نگو «از عرفان/Owner بپرس» — خودت انجام بده یا با ask_owner تأیید بگیر و بعد خودت اعمال کن. ` +
    `یوزر SSO/GitLab را خودت پیدا کن؛ از همکار نپرس. ` +
    `رمز/توکن: از infisical_list و infisical_get استفاده کن؛ روی هاست debug دنبال توکن/glab/.git-credentials نگرد و ادعا نکن «به Infisical دسترسی ندارم» بدون اینکه این ابزارها را زده باشی. ` +
    `برای بررسی MR از gitlab_mr و برای فایل‌ها از gitlab_file استفاده کن؛ ادغام MR / push جهش است و ابزار ادغام فقط با تأیید Owner مجاز است؛ از debug برای GitLab استفاده نکن. ` +
    `ask_owner را تنها صدا بزن (هم‌زمان با ابزار دیگر نه) و تا جواب Owner هیچ کار دیگری نکن و به همکار نگوی «نمی‌توانم». ` +
    `برای کار برگشت‌ناپذیر ask_owner بزن (تأیید از ربات گریفین به Owner می‌رسد). وقتی کار تمام شد، جمع‌بندی بگو و end_agent را صدا بزن.]\n\n` +
    String(text || "").trim()
  );
}

export function createEndAgentTool({ onEnd }) {
  return {
    description:
      "Call after you have written the final goodbye / summary to the teammate. Closes this /agent session so later messages are ignored until the owner starts /agent again.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string", description: "optional short note for the owner" } },
      additionalProperties: false,
    },
    async execute(args) {
      onEnd?.(typeof args?.note === "string" ? args.note : "");
      return { content: [{ type: "text", text: JSON.stringify({ ended: true }) }] };
    },
  };
}
// Teammate coverage talks to a colleague in their chat: on top of the general irreversible gate
// (guard.mjs), these need the owner too. Replying in the same chat is free.
export const TEAM_MUTATING = new Set(["arvan_cache_purge", "telegram_send", "knowledge_write"]);

export { isDestructiveShell, isDestructiveSql, isYes } from "../guard.mjs";

export function guardTeamTools(tools, { chatId, asks, store = null, peerChat = null } = {}) {
  return guardTools(tools, {
    chatId,
    asks,
    store,
    caller: COVERAGE_CALLER,
    extra: TEAM_MUTATING,
    allowPass: (name, args) => {
      if (name !== "telegram_send" || !peerChat) return false;
      const target = String(args?.chat || "").trim();
      return target === String(peerChat) || target.includes(String(peerChat));
    },
  });
}
