import { guardTools } from "../guard.mjs";
import { OWNER_NAME } from "../owner.mjs";

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
 * Owner replied to a specific peer message with /agent — answer THAT message, in the light of the
 * conversation around it. With only the quoted line («اشتباه نمیکنه؟»), no tools
 * and a "be playful, say قربونت" nudge, the agent answered a serious question with «قربونت 😄 …
 * بگو کدوم پیام رو میگی» — twice. The history was right there; now it is passed in.
 */
export function coverageReplyPrompt(peerName, replyText, historyLines = []) {
  const who = peerName || "همکار";
  const quoted = String(replyText || "").trim().slice(0, 2000);
  const history = (historyLines || []).filter(Boolean).slice(-20).join("\n");
  return (
    `[Owner روی یک پیام خاص در چت با «${who}» ریپلای زد و /agent فرستاد. به همان پیام جواب بده، ` +
    `ولی معنی‌اش را از تاریخچهٔ گفتگوی زیر بفهم — «این»، «اون»، «اشتباه نمیکنه؟» تقریباً همیشه به پیام‌های قبلی اشاره دارد؛ ` +
    `نپرس «کدوم پیام؟» وقتی تاریخچه جوابش را دارد. اگر جواب درست به چک کردن نیاز دارد، با ابزارهای خواندنی چک کن و بعد جواب بده. ` +
    `کوتاه (۱ تا ۳ خط)، فارسی محاوره، نتیجه اول، بدون Markdown و بدون ایموجی. خودت را معرفی نکن (امضای پیام این کار را می‌کند). ` +
    `فقط اگر خودِ پیام شوخی یا تشکر بود، سبک جواب بده؛ سؤال جدی جواب جدی می‌خواهد. ` +
    `اگر ابزار چیزی پیدا نکرد، بگو «پیدا نکردم»، نه «وجود ندارد»؛ چیزی را که چک نکرده‌ای ادعا نکن. ` +
    `خطِ «گریفین (ایجنت)» در تاریخچه جوابِ قبلیِ خودت است، نه حرفِ ${OWNER_NAME}. با Owner حرف نزن.]\n\n` +
    (history ? `تاریخچهٔ اخیر (قدیمی→جدید):\n${history}\n\n` : "") +
    `پیامی که باید جوابش را بدهی:\n«${quoted}»`
  );
}

/**
 * The owner typing in a coverage chat from the web UI. Without a frame the agent took it for the
 * colleague and its answer went to them: «چه جوابی داده؟ متنش رو بفرست» reached the colleague.
 */
export function coverageOwnerNote(peerName, text) {
  return `«${OWNER_NAME} از داخل گریفین — برای تو، نه برای ${peerName || "همکار"}»: ${String(text || "").trim()}`;
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
