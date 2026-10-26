// «@…» in the owner's message → the note the chat's agent gets with it (packages/timeline mentions.mjs):
// this install's own agents (delegate), the colleagues' agents on the network (network_ask) and his own
// chats written as @«title» (chat_read / chat_send). Never the chat's own agent, the mother agent or the
// chat itself; a chat that is not one of the owner's own is never named.
import { chatHandleTitle, chatMentionTitles, findMentions, mentionNote } from "@griffin/timeline";
import { DEFAULT_AGENT } from "./agents/registry.mjs";
import { isOwnerChat } from "./owner-chat-tools.mjs";

export function createMentionNote({ store, network = { list: () => [] } }) {
  return (text, chat = null) => {
    const t = String(text || "");
    if (!t.includes("@")) return "";
    const self = chat?.agent || DEFAULT_AGENT;
    const own = (store.listAgentProfiles?.() || [])
      .filter((p) => p.id !== DEFAULT_AGENT && p.id !== self)
      .map((p) => ({ kind: "agent", id: p.id, name: p.label || p.id, domain: p.domain || "" }));
    const agents = [...own, ...network.list().filter((a) => a.connected)];
    const titles = chatMentionTitles(t);
    // A title two chats share means the newest of them (the list he picked from is newest first).
    const chats = [];
    if (titles.length) {
      const rows = store.listChats().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      for (const title of titles) {
        const hit = rows.find((c) => c.id !== chat?.id && chatHandleTitle(c.title) === title && isOwnerChat(store, c));
        if (hit) chats.push({ kind: "chat", id: hit.id, name: hit.title });
      }
    }
    const all = [...agents, ...chats];
    return mentionNote(findMentions(t, all), all);
  };
}
