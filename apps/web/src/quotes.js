// Quoted selections waiting in a chat's composer («به گفتگو»): each is kept folded above the
// input with the owner's note about it, and joins the message only when it is sent. Kept per
// chat in the browser, like the draft.
export const MAX_QUOTES = 20;
const key = (chatId) => `griffin:quotes:${chatId || "new"}`;

function read(storage, chatId) {
  try {
    const list = JSON.parse(storage?.getItem(key(chatId)) || "[]");
    return Array.isArray(list) ? list.filter((q) => q && typeof q.text === "string" && q.text.trim()) : [];
  } catch {
    return [];
  }
}

function write(storage, chatId, list) {
  try {
    if (!storage) return;
    if (!list.length) storage.removeItem(key(chatId));
    else storage.setItem(key(chatId), JSON.stringify(list));
  } catch {
    /* private mode or a full quota: the quotes last for this page only */
  }
}

/** The message as the agent reads it: every quote as a blockquote, its note under it, then the typed text. */
export function withQuotes(quotes, text) {
  const blocks = (quotes || []).map((q) => {
    const quoted = `> ${String(q.text).split("\n").join("\n> ")}`;
    const note = String(q.note || "").trim();
    return note ? `${quoted}\n\n${note}` : quoted;
  });
  const typed = String(text || "").trim();
  if (typed) blocks.push(typed);
  return blocks.join("\n\n");
}

/** One folded line for the composer chip. */
export function quotePreview(text, max = 90) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}

// One store per page: the selection popup adds, the composer shows, the send takes.
export function createQuoteStore(storage) {
  const cache = new Map();
  const listeners = new Set();
  let seq = 0;
  const get = (chatId) => {
    const k = chatId || "new";
    if (!cache.has(k)) cache.set(k, read(storage, chatId));
    return cache.get(k);
  };
  const set = (chatId, list) => {
    cache.set(chatId || "new", list);
    write(storage, chatId, list);
    for (const listener of listeners) listener();
  };
  return {
    get,
    add(chatId, { text, note = "" }) {
      const clean = String(text || "").trim();
      if (!clean) return null;
      const quote = { id: `${Date.now().toString(36)}-${(seq += 1)}-${Math.random().toString(36).slice(2, 7)}`, text: clean, note: String(note || "").trim() };
      set(chatId, [...get(chatId), quote].slice(-MAX_QUOTES));
      return quote;
    },
    // The owner's edit of a waiting quote, in place. A quote cannot be emptied (× removes it), and
    // one already sent is not brought back.
    update(chatId, id, { text, note = "" }) {
      const clean = String(text || "").trim();
      const list = get(chatId);
      const at = list.findIndex((q) => q.id === id);
      if (!clean || at < 0) return null;
      const quote = { ...list[at], text: clean, note: String(note || "").trim() };
      if (quote.text !== list[at].text || quote.note !== (list[at].note || "")) set(chatId, list.map((q, i) => (i === at ? quote : q)));
      return quote;
    },
    // After a send: take out the quotes it carried, but not one edited meanwhile — the message held
    // the old version, so the edit waits for the next one.
    removeSent(chatId, sent) {
      const delivered = new Set(sent);
      const next = get(chatId).filter((q) => !delivered.has(q));
      if (next.length !== get(chatId).length) set(chatId, next);
    },
    remove(chatId, ids) {
      const drop = new Set([].concat(ids));
      const next = get(chatId).filter((q) => !drop.has(q.id));
      if (next.length !== get(chatId).length) set(chatId, next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function pageStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export const quoteStore = createQuoteStore(pageStorage());
