// What the owner was typing, kept per chat in the browser: a reload or a look at
// another chat does not lose it. An emptied box (sent or cleared) forgets it.
export const MAX_DRAFT_CHARS = 50_000;
const key = (chatId) => `griffin:draft:${chatId || "new"}`;

export function loadDraft(storage, chatId) {
  try {
    return storage?.getItem(key(chatId)) || "";
  } catch {
    return "";
  }
}

export function saveDraft(storage, chatId, text) {
  try {
    if (!storage) return;
    if (!text || !text.trim() || text.length > MAX_DRAFT_CHARS) storage.removeItem(key(chatId));
    else storage.setItem(key(chatId), text);
  } catch {
    /* private mode or a full quota: typing goes on */
  }
}
