// Side chat and quoted selections. Pure logic, so node tests import it directly.
//   POST /api/chats/:id/side { text, images } -> { chat }   (sideOf: parent; seeded with its conversation)
//   GET  /api/chats/:id/sides                 -> { chats }

export const sidePaths = {
  create: (chatId) => `/api/chats/${chatId}/side`,
  list: (chatId) => `/api/chats/${chatId}/sides`,
};

// A very long selection is cut rather than dumping a whole answer into the input.
export const SELECTION_QUOTE_MAX = 2000;

/** The selection as a markdown blockquote the model reads as quoted material. */
export function quoteForChat(selection, { max = SELECTION_QUOTE_MAX } = {}) {
  let text = String(selection || "")
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (!text) return "";
  if (text.length > max) text = `${text.slice(0, max).trimEnd()}…`;
  return `> ${text.split("\n").join("\n> ")}`;
}

export function emptySide(parentId = null) {
  return { parentId, open: false, activeId: null, sides: [] };
}

/** Panel state for one parent chat. Closing only hides it: reopening lands on the same side chat. */
export function sideReducer(state, action) {
  switch (action?.type) {
    case "parent":
      return action.id === state.parentId ? state : emptySide(action.id);
    case "open":
      return { ...state, open: true };
    case "close":
      return { ...state, open: false };
    case "toggle":
      return { ...state, open: !state.open };
    case "loaded": {
      if (action.parentId !== state.parentId) return state;
      const sides = Array.isArray(action.chats) ? action.chats : [];
      // One created here but not yet in the server's answer stays on top.
      const known = new Set(sides.map((c) => c.id));
      return { ...state, sides: [...state.sides.filter((c) => !known.has(c.id)), ...sides] };
    }
    case "created":
      if (!action.chat?.id) return state;
      return { ...state, open: true, activeId: action.chat.id, sides: [action.chat, ...state.sides.filter((c) => c.id !== action.chat.id)] };
    case "select":
      return { ...state, activeId: action.id || null };
    case "new":
      return { ...state, activeId: null };
    default:
      return state;
  }
}

// The run to show «ارسال دوباره» under: the latest undelivered one, while the server still keeps
// a message (chat.kept). A retry that got through after it clears it.
export function retryableRunId(messages, keptCount) {
  if (!keptCount) return null;
  let pending = null;
  for (const message of messages || []) {
    if (message?.role !== "assistant") continue;
    if (message.status === "error" && message.undelivered) pending = message.id;
    else if (message.retry && message.status === "finished") pending = null;
  }
  return pending;
}
