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

// A reloaded list with what did not change kept as the same objects (and the same array when nothing
// changed), so memoized rows skip their redraw: with hundreds of chats that redraw held the page for
// 100-300 ms on every list event, while the owner typed or scrolled.
const rowText = new WeakMap();
const textOf = (row) => {
  if (!rowText.has(row)) rowText.set(row, JSON.stringify(row));
  return rowText.get(row);
};
export function keepSameRows(before, after) {
  const was = new Map(before.map((row) => [row.id, row]));
  let same = before.length === after.length;
  const rows = after.map((row, i) => {
    const old = was.get(row.id);
    const kept = old && textOf(old) === textOf(row) ? old : row;
    if (kept !== before[i]) same = false;
    return kept;
  });
  return same ? before : rows;
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
