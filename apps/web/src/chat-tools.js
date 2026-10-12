// Pure logic for the chat tools (suggested chats, chapters). No React and no DOM here,
// so node tests can import it directly.
import { num, t } from "./i18n.js";
//
// Server contract:
//   GET  /api/suggestions?status=open -> { suggestions: [{ id, fromChatId, fromChatTitle, title, tldr, prompt, promptSha, repo, model, status, createdAt }] }
//   POST /api/suggestions/:id/start { promptSha, model?, note?, notePosition? } -> { chat }   (refused unless it is the hash of the stored prompt)
//   POST /api/suggestions/:id/dismiss
//   timeline parts { type: "suggestion", id, title, tldr, status } and { type: "chapter", title, summary }

/**
 * What the thread draws under the work log, in the run's own order: the answer parts plus the
 * chapter dividers splitRun set aside in `other`; suggestion cards close the turn, after the answer
 * (where the reader ends up). Any other part type in `other` is left out.
 */
export function answerItems(parts, answer, other) {
  const keep = new Set(answer);
  const cards = new Set();
  for (const part of other || []) {
    if (part?.type === "chapter") keep.add(part);
    else if (part?.type === "suggestion") cards.add(part);
  }
  const list = Array.isArray(parts) ? parts : [];
  return [...list.filter((part) => keep.has(part)), ...list.filter((part) => cards.has(part))];
}

// --- Suggested chats -----------------------------------------------------------------------

const SUGGESTION_LABELS = { started: t("شروع شد"), dismissed: t("رد شد") };

// A prompt shorter than this is shown expanded in the thread card; a longer one takes one tap.
export const PROMPT_OPEN_MAX = 600;

/**
 * What a suggestion card shows: its actions while open, a muted label afterwards. `item` is the
 * suggestion as the list API returns it (the full prompt, never cut, and its hash).
 */
export function suggestionView(part, override, item) {
  const raw = override || part?.status || "open";
  const status = raw === "started" || raw === "dismissed" ? raw : "open";
  const prompt = String(item?.prompt || "");
  return {
    status,
    label: SUGGESTION_LABELS[status] || null,
    title: String(part?.title || "").trim() || t("چت پیشنهادی"),
    tldr: String(part?.tldr || "").trim(),
    prompt,
    promptSha: String(item?.promptSha || ""),
    promptOpen: Boolean(prompt) && prompt.length < PROMPT_OPEN_MAX,
    repo: String(item?.repo || "").trim(),
    model: String(item?.model || "").trim(),
  };
}

/** "Start chat" works for any open suggestion whose prompt is loaded; opening the full text is optional. */
export function canStartSuggestion(view) {
  return Boolean(view && view.status === "open" && view.prompt && view.promptSha);
}

export function openSuggestions(list, overrides = {}) {
  return (Array.isArray(list) ? list : []).filter((s) => s && s.id && (overrides[s.id] || s.status || "open") === "open");
}

/** This chat's own open suggestions, in the server's order (newest first). */
export function chatSuggestions(list, overrides, chatId) {
  if (!chatId) return [];
  return openSuggestions(list, overrides).filter((s) => s.fromChatId === chatId);
}

/** Scroll target of a suggestion card in the thread. */
export function suggestionAnchor(id) {
  return `sg-${String(id).replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** Badge text: empty for zero, capped at 9+. */
export function badgeText(count) {
  if (!count || count < 1) return "";
  return count > 9 ? `${num(9)}+` : num(count);
}

/**
 * The start request: the hash of the prompt that was shown, plus what the owner changed on the
 * card — another model ("" = the agent's default) and a note put before or after the prompt.
 */
export function suggestionStartBody(promptSha, edits = {}) {
  const body = { promptSha };
  if (typeof edits.model === "string") body.model = edits.model;
  const note = String(edits.note || "").trim();
  if (note) {
    body.note = note;
    body.notePosition = edits.notePosition === "before" ? "before" : "after";
  }
  return body;
}

export const suggestionPaths = {
  list: () => "/api/suggestions?status=open",
  start: (id) => `/api/suggestions/${encodeURIComponent(id)}/start`,
  dismiss: (id) => `/api/suggestions/${encodeURIComponent(id)}/dismiss`,
};

/**
 * One store for the sidebar section and the cards in the thread, so an action in one place is
 * seen in the other at once. `api(path, { method, body })` is the app's fetch helper. `edits`
 * (model, note) are kept here so every place that shows a suggestion shares one copy.
 */
export function createSuggestionStore(api) {
  let state = { items: [], overrides: {}, busy: {}, edits: {}, loaded: false };
  const listeners = new Set();
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const act = async (id, status, path, body) => {
    if (!id || state.busy[id]) return null;
    set({ busy: { ...state.busy, [id]: true } });
    try {
      const result = await api(path, { method: "POST", ...(body ? { body } : {}) });
      set({ overrides: { ...state.overrides, [id]: status } });
      return result || {};
    } finally {
      const { [id]: _done, ...busy } = state.busy;
      set({ busy });
    }
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    async refresh() {
      try {
        const data = await api(suggestionPaths.list());
        set({ items: Array.isArray(data?.suggestions) ? data.suggestions : [], loaded: true });
      } catch {
        set({ loaded: true });
      }
    },
    setEdits(id, edits) {
      if (id) set({ edits: { ...state.edits, [id]: edits } });
    },
    /** Resolves to the new chat. Sends the hash of the prompt this client holds; the server refuses another. */
    async start(id) {
      const seen = state.items.find((s) => s?.id === id)?.promptSha;
      if (!seen) throw new Error("prompt not loaded");
      const result = await act(id, "started", suggestionPaths.start(id), suggestionStartBody(seen, state.edits[id]));
      return result?.chat || null;
    },
    async dismiss(id) {
      return Boolean(await act(id, "dismissed", suggestionPaths.dismiss(id)));
    },
  };
}

// --- Chapters ------------------------------------------------------------------------------

export function chapterAnchor(messageId, partIndex) {
  return `ch-${String(messageId).replace(/[^a-zA-Z0-9_-]/g, "")}-${partIndex}`;
}

/** Table of contents: every chapter part of the thread, in order, with its scroll target. */
export function collectChapters(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "assistant" || !Array.isArray(message.parts)) continue;
    message.parts.forEach((part, index) => {
      if (part?.type !== "chapter") return;
      const title = String(part.title || "").trim();
      if (title) out.push({ id: chapterAnchor(message.id, index), title, summary: String(part.summary || "").trim() });
    });
  }
  return out;
}
