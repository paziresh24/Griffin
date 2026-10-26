// What «@» offers in the composer (owner 2026-10-20: «با @ بشه چت های اخیر رو دید و صدا زد»): this
// install's own agents, the colleagues' agents on the network and the owner's recent chats, in that
// order, each section filtered by what he typed. Pure, so the composer only draws it.
import { filterMentionables } from "@griffin/timeline";
import { t } from "./i18n.js";

const MOTHER = "griffin";
const stamp = (c) => {
  const v = c?.updatedAt || c?.createdAt;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const s = String(v || "");
  const t = Date.parse(/^\d{4}-\d\d-\d\d \d/.test(s) ? `${s.replace(" ", "T")}Z` : s);
  return Number.isFinite(t) ? t : 0;
};

/** This install's agents a chat can hand work to: not the mother agent, not the chat's own. */
export function ownAgents(profiles, chatAgent = MOTHER) {
  return (Array.isArray(profiles) ? profiles : [])
    .filter((p) => p?.id && p.id !== MOTHER && p.id !== (chatAgent || MOTHER))
    .map((p) => ({ kind: "agent", id: p.id, name: p.label || p.id, domain: p.domain || "" }));
}

/** The owner's own chats, newest first, as «@» items: no side chats, threads of others, archive or this chat. */
export function recentChats(chats, chatId = null) {
  return (Array.isArray(chats) ? chats : [])
    .filter((c) => c?.id && c.id !== chatId && c.title && (c.caller || "owner") === "owner" && !c.sideOf && !c.archived && !c.mother && !c.personId && !c.parentChatId && !c.global)
    .sort((a, b) => stamp(b) - stamp(a))
    .map((c) => ({ kind: "chat", id: c.id, name: c.title, runStatus: c.runStatus || null }));
}

/**
 * The picker's rows for the typed query, one flat list (the keys move through it) in sections:
 * own agents, colleagues' agents, recent chats. `pool` is every agent, for the handles' twin rule.
 */
export function mentionRows({ own = [], network = [], chats = [], query = "" }) {
  const q = String(query || "");
  return [...filterMentionables(own, q, 8), ...filterMentionables(network, q, 8), ...filterMentionables(chats, q, q ? 8 : 6)];
}

export const SECTION = {
  agent: t("ایجنت‌های ما — کار به او سپرده می‌شود و گزارشش همین‌جا می‌آید"),
  network: t("ایجنت همکاران — از او می‌پرسد و جوابش همین‌جا می‌آید"),
  chat: t("گفتگوهای اخیر — خوانده می‌شود، یا پیامی به آن می‌رود"),
};
