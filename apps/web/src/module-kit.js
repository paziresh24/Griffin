// What a module's own screen (modules/<id>/web/<view>.jsx, docs/modules.md) may use from the core:
// imported as "@griffin/module-kit". Everything else of the core web is not the module's to touch.

import { useModuleRows } from "./module-hooks.js";
import { api, navigate } from "./api.js";
import { actionOutcome } from "./modules.js";
import { readSetting, writeSetting } from "./brand.js";

export { readSetting, writeSetting } from "./brand.js";
export { clockLabel, exactTime } from "./elapsed.js";
export { toast } from "sonner";
export { api, navigate } from "./api.js";
export { textDir } from "./dir.js";

/** The page's rows from the module's source (the same data the list shows), with its filters. */
export const useRows = (moduleId, pageId, values, nonce) => useModuleRows(moduleId, pageId, values, nonce);

/**
 * Run one of the page's actions on a row. A chat it asks for is made through the ordinary chat API
 * (the owner's chat, every guard a chat has) and opened; the id comes back so the screen can find
 * it again. A message is returned as { message }.
 */
export async function runAction(moduleId, actionId, row) {
  const outcome = actionOutcome(await api(`/api/modules/${moduleId}/actions/${actionId}`, { method: "POST", body: { row } }));
  if (outcome.kind === "chat") {
    const { chat } = await api("/api/chats", { method: "POST", body: { agent: outcome.chat.agent, title: outcome.chat.title, text: outcome.chat.text, module: moduleId } });
    navigate(chat.id);
    return { chatId: chat.id };
  }
  return outcome.kind === "message" ? { message: outcome.message } : {};
}

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
