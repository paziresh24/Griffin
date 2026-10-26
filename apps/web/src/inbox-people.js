import { t } from "./i18n.js";
// The Telegram inbox by sender (from Karsara; config TELEGRAM_DM_MODE=inbox): #/inbox lists one row
// per person as in Telegram, #/inbox/<peerId> that person's messages with what the inbox did with each.

export const peoplePath = (peerId) => (peerId ? `#/inbox/${peerId}` : "#/inbox");
/** hash -> {peerId} on the people page (peerId null on the list), or null on any other page. */
export function peopleRoute(hash) {
  const match = /^#\/inbox(?:\/(\d{1,20}))?$/.exec(String(hash || ""));
  return match ? { peerId: match[1] || null } : null;
}
// A suggestion made from the inbox is titled «تلگرام: …»; under a Telegram message that is noise.
const bare = (title) => String(title || "").replace(/^تلگرام:\s*/, ""); // i18n-ignore
/** The first letter of a name for its avatar: a whole character, an emoji included. */
export const initial = (name) => Array.from(String(name || "").trim())[0] || "?";

const SUGGESTED = {
  open: (title) => t("پیشنهاد گفتگوی «{title}» (منتظر شما)", { title }),
  started: (title) => t("گفتگوی «{title}» شروع شد", { title }),
  dismissed: (title) => t("پیشنهاد «{title}» رد شد", { title }),
};

/** item: one entry of GET /api/inbox/people/:peerId. Returns [{kind, label, chatId?}] to show under it. */
export function itemOutcome(item) {
  const out = [
    ...(item.routed || []).map((r) => ({ kind: "routed", label: r.title ? t("رفت به گفتگوی «{title}»", { title: r.title }) : t("رفت به یک گفتگوی حذف‌شده"), chatId: r.title ? r.chatId : null })),
    ...(item.suggested || []).map((s) => ({ kind: "suggested", label: (SUGGESTED[s.status] || SUGGESTED.open)(bare(s.title)), chatId: s.chatId || null })),
  ];
  if (out.length) return out;
  if (item.status === "pending") return [{ kind: "waiting", label: t("در صف") }];
  if (item.status === "delivered") return [{ kind: "waiting", label: t("در حال بررسی") }];
  if (item.status === "failed") return [{ kind: "failed", label: t("بررسی نشد (خطا)") }];
  return [{ kind: "none", label: t("بدون اقدام") }];
}
