// Where a chat was born. Port of Karsara !79 (owner decision 2026-10-13): a chat CREATED FROM A
// TELEGRAM MESSAGE may not write the files that feed every later session's instructions
// (providers/state-guard.mjs instructionFilePaths) — on by default (config TELEGRAM_INSTRUCTION_GUARD=off turns it off), and only
// where such a chat has Bash at all (full Claude Code, CLAUDE_CODE=on). The boundary is the chat's
// origin, not what it has read: an owner chat that received a routed message (related.mjs
// third-party mark) stays as it is.
//
// In Griffin the one path that creates an owner chat (caller "owner", so full Claude Code) from a
// messenger message is integrations/manager.mjs receive(): Saved Messages and the paired bot chats.
// Colleagues' DMs go to the desk and mother chats, peers to their own callers; those chats get no
// built-in tool themselves (index.mjs fileAccess), but a chat made out of them (a consult, a side
// chat, a fork) could: the desk and mother chats count as an origin here (as in knowledge-trust.mjs).
// Not Telegram-born: a chat started by the OWNER'S OWN message. Proven two ways only: his Saved
// Messages (telegram_account, external chat "me"), and a telegram_bot chat whose external chat is
// his own Telegram user id as the connected account reports it (settings.me.id). The paired-chat
// fallback of manager.mjs ownerTelegramId() is a guess and is not used; a Bale bot cannot be proven
// (another id space). Such a chat gets the marker { from: "owner" }.
// A chat made out of a Telegram-born chat inherits its origin: a child (consult, subtask) through
// parent_chat_id, a side chat through side_of, a fork through kv fork-of:, a chat started from a
// suggestion it made through suggestions.from_chat_id — the same chain knowledge-trust.mjs walks.
//
// integration_links is the routing table, not a history: /new on a bot moves the external chat to
// another chat. So receive() writes a durable marker when it creates the chat, and the routing
// facts are read only to cover chats made before the marker.

import { ownMessengerChat } from "./db.mjs";
import { instructionFilePaths } from "./providers/state-guard.mjs";
import { isGlobalChat, motherInfo } from "./integrations/mother.mjs";

export const ORIGIN_KEY = (chatId) => `origin:${chatId}`;

/** True when a message on (integration, externalChat) is proven to come from the owner's own chat. */
export const isOwnerTelegramSource = (store, integrationId, externalChat) => ownMessengerChat(store, integrationId, externalChat);

/**
 * Records how `chatId` was born from a messenger message: the owner's own chat, or someone else's.
 * In a bot chat a forwarded first message, or one whose sender is missing or not the chat's own
 * user, is someone else's words (as manager.mjs ownerWroteIt). Saved Messages stays the owner's (only he writes there).
 */
export function markMessengerOrigin(store, chatId, integrationId, externalChat, { forwarded = false, senderId = null } = {}) {
  if (!chatId) return;
  const account = store.getIntegration?.(integrationId)?.kind === "telegram_account";
  const own = isOwnerTelegramSource(store, integrationId, externalChat) && (account || (!forwarded && senderId != null && String(senderId) === String(externalChat)));
  const kind = store.getIntegration?.(integrationId)?.kind || "bot";
  store.setKv(ORIGIN_KEY(chatId), { from: own ? "owner" : "telegram", via: kind, at: new Date().toISOString() });
}

// The one chat, without its sources: how it was born, or null.
function ownOrigin(store, chat) {
  const marked = store.getKv?.(ORIGIN_KEY(chat.id));
  if (marked?.from === "telegram") return marked.via || "telegram";
  if (marked?.from === "owner") return null;
  if (isGlobalChat(store, chat.id)) return "desk";
  if (motherInfo(store, chat.id)) return "mother";
  if ((store.linksForChat?.(chat.id) || []).some((l) => !isOwnerTelegramSource(store, l.integration_id, l.external_chat))) return "bot";
  return null;
}

// The chats this chat was made out of.
function sourcesOf(store, chat) {
  const out = [chat.parent_chat_id, chat.side_of, store.getKv?.(`fork-of:${chat.id}`)];
  for (const row of store.db?.prepare("SELECT from_chat_id FROM suggestions WHERE started_chat_id = ? AND from_chat_id IS NOT NULL").all(chat.id) || []) out.push(row.from_chat_id);
  return out.filter(Boolean).map(String);
}

/**
 * The messenger entry `chat` (or a chat it was made out of) was created by, or null when it was not
 * created from someone else's message.
 */
export function telegramOrigin(store, chat, { maxChats = 50 } = {}) {
  const queue = chat ? [chat] : [];
  const seen = new Set();
  while (queue.length && seen.size < maxChats) {
    const current = queue.shift();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    const via = ownOrigin(store, current);
    if (via) return via;
    for (const id of sourcesOf(store, current)) if (!seen.has(id)) queue.push(store.getChat(id));
  }
  // A chain longer than the walk is treated as Telegram-born (fail closed).
  return queue.length ? "unknown" : null;
}

/**
 * What index.mjs hands the Claude session as options.instructionPaths: the instruction files when
 * the chat was created from someone else's messenger message, else [] (the session is unchanged).
 */
export function instructionPathsFor(store, chat, { configDirs = [], reposRoot = null } = {}) {
  return telegramOrigin(store, chat) ? instructionFilePaths({ configDirs, reposRoot }) : [];
}
