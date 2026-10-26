// The chat list kept from the last visit, so a reload shows the sidebar at once while the server is
// asked for the real one (owner 2026-10-19: after a refresh the sidebar said «گفتگویی نیست» for minutes).
// Only what the list needs to draw itself; the next load replaces it, and a list that cannot be read
// or parsed is simply no cache.

const KEY = "griffin.chats.cache.v1";
const MAX_CHATS = 120;

export function readChatsCache(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) || "null");
    if (!saved || !Array.isArray(saved.chats)) return null;
    return { chats: saved.chats, groups: Array.isArray(saved.groups) ? saved.groups : [], looseAt: Number.isInteger(saved.looseAt) ? saved.looseAt : null };
  } catch {
    return null;
  }
}

// looseAt: where «بدون گروه» sits among the groups (drag.js); undefined keeps the cached one.
export function writeChatsCache(chats, groups, storage = globalThis.localStorage, looseAt) {
  try {
    const kept = looseAt === undefined ? readChatsCache(storage)?.looseAt ?? null : looseAt;
    storage?.setItem(KEY, JSON.stringify({ chats: (chats || []).slice(0, MAX_CHATS), groups: groups || [], looseAt: kept }));
  } catch {
    // Storage full or blocked: the sidebar just waits for the server next time.
  }
}
