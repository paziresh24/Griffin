// Chat tools: suggest a new chat (spawn_task-like) and mark a chapter in a long answer.
// Only chats rooted in the owner get them (index.mjs): a peer, a colleague's thread, the ops room or
// a job never proposes work to the owner this way.
import crypto from "node:crypto";
import { splitModel } from "./providers/ids.mjs";

export const CHAT_TOOL_NAMES = ["chat_suggest", "chat_dismiss_suggestion", "chat_chapter"];

// A suggestion's prompt is capped (opening it before «شروع چت» is optional): a longer one is
// refused, never cut — the owner may start it without reading it, so what runs is what was stored.
export const PROMPT_MAX = 4000;
// 20 open per chat; the overall wall leaves room for five such chats.
export const SUGGEST_MAX_PER_CHAT = 20;
export const SUGGEST_MAX_OPEN = 100;
// The owner's own note on a card, put before or after the prompt when it starts.
export const SUGGEST_NOTE_MAX = 2000;

export function withOwnerNote(prompt, note, position) {
  const text = String(note ?? "").trim();
  if (!text) return prompt;
  const line = `تذکر مالک: ${text}`;
  return position === "before" ? `${line}\n\n${prompt}` : `${prompt}\n\n${line}`;
}

/** What the owner saw: /start must present this for the prompt it is about to run. */
export const promptSha = (prompt) => crypto.createHash("sha256").update(String(prompt ?? ""), "utf8").digest("hex");

/** A suggestion as the API lists it: always with the full prompt and its hash, so the card can show it. */
export function publicSuggestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    fromChatId: row.from_chat_id || null,
    fromChatTitle: row.from_chat_title || null,
    title: row.title,
    tldr: row.tldr || "",
    repo: row.repo || null,
    model: row.model || null,
    status: row.status,
    startedChatId: row.started_chat_id || null,
    createdAt: row.created_at,
    prompt: row.prompt || "",
    promptSha: promptSha(row.prompt),
  };
}

/** open -> started | dismissed, once; the suggesting chat's card follows through a chat.suggestion.status event. */
export function settleSuggestion(store, id, status, startedChatId = null) {
  const row = store.settleSuggestion(id, status, startedChatId);
  if (row?.from_chat_id && store.getChat(row.from_chat_id)) {
    store.appendEvent(row.from_chat_id, null, "chat.suggestion.status", { id: row.id, status });
  }
  return row;
}

const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }] });
const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// checkModel(account|null, model, chat) → null when that account runs the model as named, else the
// reason (with the valid ids). account null = the chat's own engine. index.mjs checks the account
// registry (enabled, keyed, not limited) and the account's model list.
export function createChatTools({ store, chatId, isValidRepo = () => false, checkModel = async () => null }) {
  return {
    chat_suggest: {
      description:
        "Suggest a NEW chat for work that is out of this chat's scope or a follow-up (a bug spotted in passing, stale docs, the next step). It does NOT start anything: the owner sees a card and starts it with one click. `prompt` is the new chat's first message and must stand alone (paths, context, what done means), at most 4,000 characters. Returns {id}.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "short imperative title, under 60 characters" },
          tldr: { type: "string", description: "one or two plain sentences for the card: why now, and what the new chat will do" },
          prompt: { type: "string", description: "self-contained first message for the new chat" },
          repo: { type: "string", description: "repo name under the repos root; omit for this chat's repo" },
          provider: { type: "string", description: "engine account id (e.g. claude, openai) for `model`; omit for this chat's" },
          model: { type: "string", description: "model id; omit for this chat's model" },
        },
        required: ["title", "tldr", "prompt"],
        additionalProperties: false,
      },
      async execute(args) {
        const title = str(args?.title, 120);
        const tldr = str(args?.tldr, 600);
        const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
        if (!title || !tldr || !prompt) return fail("title, tldr and prompt are required");
        if (prompt.length > PROMPT_MAX) {
          return fail(`prompt is ${prompt.length} characters; the limit is ${PROMPT_MAX}. Shorten it (point at files instead of pasting them) and call again.`);
        }
        const open = store.listSuggestions({ status: "open", limit: SUGGEST_MAX_OPEN + 1 });
        if (open.filter((row) => row.from_chat_id === chatId).length >= SUGGEST_MAX_PER_CHAT) {
          return fail(`this chat already has ${SUGGEST_MAX_PER_CHAT} open suggestions waiting for the owner. Stop suggesting: withdraw a stale one with chat_dismiss_suggestion, or say it in your reply.`);
        }
        if (open.length >= SUGGEST_MAX_OPEN) {
          return fail(`there are already ${SUGGEST_MAX_OPEN} open suggestions waiting for the owner. Stop suggesting: say what you found in your reply instead.`);
        }
        const chat = store.getChat(chatId);
        const repo = str(args?.repo, 200);
        if (repo && !isValidRepo(repo)) return fail(`unknown repo: ${repo}`);
        // No model named: the new chat runs where this one does (a suggestion from an
        // OpenAI-compatible chat must not start on another engine). The provider only qualifies a bare model ("openai" + "glm-5.3").
        // Nothing silent: a provider without a model, a model that account does not
        // list, or an account that cannot run now is refused, not swapped for a default nobody chose.
        const provider = str(args?.provider, 40);
        const model = str(args?.model, 200);
        if (provider && !model) return fail(`provider "${provider}" named without a model: name the model too, or omit both to use this chat's.`);
        const pinned = model ? (provider && !splitModel(model) ? `${provider}:${model}` : model) : chat?.model || null;
        if (model) {
          const split = splitModel(pinned);
          const problem = await checkModel(split?.provider || null, split?.model || pinned, chat);
          if (problem) return fail(problem);
        }
        const row = store.createSuggestion({
          fromChatId: chatId,
          title,
          tldr,
          prompt,
          repo: repo || chat?.repo || null,
          model: pinned,
        });
        store.appendEvent(chatId, null, "chat.suggested", { id: row.id, title, tldr });
        return ok({ id: row.id });
      },
    },

    chat_dismiss_suggestion: {
      description: "Withdraw a suggestion this chat made with chat_suggest that is stale, superseded or already done. Only one the owner has not started.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      async execute(args) {
        const current = store.getSuggestion(str(args?.id, 80));
        if (!current || current.from_chat_id !== chatId) return fail("no suggestion with that id from this chat");
        if (current.status !== "open") return fail(`suggestion is already ${current.status}`);
        const row = settleSuggestion(store, current.id, "dismissed");
        return row ? ok({ id: row.id, status: row.status }) : fail("suggestion is no longer open");
      },
    },

    chat_chapter: {
      description:
        "Mark the start of a new chapter in THIS chat when the work moves to a clearly different phase (exploration → implementation → verification, or the owner changes subject). The owner sees a divider and a table of contents. A short noun-phrase title; a few per chat, not one per tool call.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string", description: "under 40 characters" }, summary: { type: "string", description: "one line" } },
        required: ["title"],
        additionalProperties: false,
      },
      async execute(args) {
        const title = str(args?.title, 80);
        if (!title) return fail("title is required");
        const summary = str(args?.summary, 300);
        store.appendEvent(chatId, null, "chapter", { title, ...(summary ? { summary } : {}) });
        return ok({ ok: true });
      },
    },
  };
}

// --- side chats: change files like the main chat unless the owner turned edits off when starting
// it (from Karsara, owner 2026-10-11). A read-only side chat reads the main chat's folder and asks.
const sideEditsKey = (chatId) => `side-edits:${chatId}`;
export const setSideAllowEdits = (store, chatId, allow) => (allow === false ? store.setKv(sideEditsKey(chatId), false) : store.deleteKv(sideEditsKey(chatId)));
export const sideAllowsEdits = (store, chat) => Boolean(chat?.side_of) && store.getKv(sideEditsKey(chat.id)) !== false;
export const sideIsReadOnly = (store, chat) => Boolean(chat?.side_of) && !sideAllowsEdits(store, chat);
export const SIDE_READ_ONLY_TOOLS = ["ask_owner", "chat_read", "repo_list", "repo_read", "repo_search", "visualize", "show_media"];
export function restrictForReadOnlySide(tools) {
  return Object.fromEntries(Object.entries(tools || {}).filter(([name]) => SIDE_READ_ONLY_TOOLS.includes(name)));
}
