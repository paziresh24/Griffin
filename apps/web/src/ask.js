// ask_owner card extras: an MCP server's sign-in link (Claude Code elicitation).
export function askLink(args) {
  const link = typeof args?.link === "string" ? args.link.trim() : "";
  return /^https?:\/\//i.test(link) ? link : null;
}

// Tools that ask the owner from inside the server (colleague-access.mjs): no ask_owner part reaches
// the thread, so their card is this chat's open question from the inbox, the one the home page shows
// (owner 2026-11-05: «دیالوگ این سوال فقط تو صفحه اصلی باز میشه و توی چت باز نمیشه»).
export const ASKS_INSIDE = new Set(["request_full_access", "request_owner_chat"]);

/** The newest open question or approval that chat `chatId` itself raised, or null. */
export function chatAsk(items, chatId) {
  if (!chatId) return null;
  let found = null;
  for (const item of items || []) {
    if (item?.kind !== "question" && item?.kind !== "approval") continue;
    if ((item.sourceChatId || item.chatId) !== chatId) continue;
    if (!found || String(item.at || "") > String(found.at || "")) found = item;
  }
  return found;
}
