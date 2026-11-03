// What a module's own screen (modules/<id>/web/<view>.jsx, docs/modules.md) may use from the core:
// imported as "@griffin/module-kit". Everything else of the core web is not the module's to touch.

import { useModuleRows } from "./module-hooks.js";
import { api, navigate } from "./api.js";
import { actionOutcome } from "./modules.js";
import { readSetting, writeSetting } from "./brand.js";

export { readSetting, writeSetting } from "./brand.js";
export { clockLabel, exactTime } from "./elapsed.js";
export { toast } from "sonner";
export { api, navigate, useChats } from "./api.js";
export { textDir } from "./dir.js";

/** The page's rows from the module's source (the same data the list shows), with its filters. */
export const useRows = (moduleId, pageId, values, nonce) => useModuleRows(moduleId, pageId, values, nonce);

/**
 * Run one of the page's actions on a row. A chat it asks for is made through the ordinary chat API
 * (the owner's chat, every guard a chat has) and opened; the id comes back so the screen can find
 * it again. A message is returned as { message }. `open: false` makes the chat but leaves the person
 * on the page (the chat id still comes back, for a «open it» link).
 */
export async function runAction(moduleId, actionId, row, { open = true } = {}) {
  const outcome = actionOutcome(await api(`/api/modules/${moduleId}/actions/${actionId}`, { method: "POST", body: { row } }));
  if (outcome.kind === "chat") {
    // repo: the repository the new chat works in, when the action names one ("" = none); without it the chat gets the default repo.
    const repo = typeof outcome.chat.repo === "string" ? { repo: outcome.chat.repo } : {};
    const { chat } = await api("/api/chats", { method: "POST", body: { agent: outcome.chat.agent, title: outcome.chat.title, text: outcome.chat.text, module: moduleId, refs: outcome.chat.refs, folder: outcome.chat.folder, ...repo } });
    if (open) navigate(chat.id);
    return { chatId: chat.id };
  }
  return outcome.kind === "message" ? { message: outcome.message } : {};
}

/** One of the module's actions with any body, its answer as it is (a form's save, a draft, …). */
export const callAction = (moduleId, actionId, body = {}) => api(`/api/modules/${moduleId}/actions/${actionId}`, { method: "POST", body });

/** What this chat is about elsewhere (chat_refs): [{ kind, ref, title }]. */
export const chatRefs = (chatId) => api(`/api/chats/${encodeURIComponent(chatId)}/refs`).then((r) => r.refs || []);

/** For one kind: { ref: [{ id, title, archived, updatedAt }] } — the chats about each thing. */
export const chatsAbout = (kind) => api(`/api/chat-refs?kind=${encodeURIComponent(kind)}`).then((r) => r.refs || {});

/** Point a chat at things elsewhere. */
export const linkChat = (chatId, refs) => api(`/api/chats/${encodeURIComponent(chatId)}/refs`, { method: "POST", body: { refs } });

/** Take one ref off a chat. */
export const unlinkChat = (chatId, kind, ref) => api(`/api/chats/${encodeURIComponent(chatId)}/refs?kind=${encodeURIComponent(kind)}&ref=${encodeURIComponent(ref)}`, { method: "DELETE" });

/** Is this chat still there (not deleted)? An archived chat still opens. */
export async function chatExists(chatId) {
  try {
    await api(`/api/chats/${encodeURIComponent(chatId)}`);
    return true;
  } catch {
    return false;
  }
}

/** A small JSON memory per module in this browser (which chat explained which row, …). */
export function memory(moduleId, name) {
  const key = `griffin.module.${moduleId}.${name}`;
  return {
    read() {
      try {
        const value = JSON.parse(readSetting(key, "{}"));
        return value && typeof value === "object" ? value : {};
      } catch {
        return {};
      }
    },
    write(value) {
      writeSetting(key, JSON.stringify(value));
    },
  };
}
