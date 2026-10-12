// One requester, many doors: a colleague's agent asked over MCP, then their Telegram bot wrote
// about the same work and a fresh chat started from zero. Every chat now sees
// the requester's other OPEN conversations (any channel) and can hand a follow-up to that chat
// instead of redoing the work — then says in one line where it is being followed.

export const RELATED_TOOL = "related_chat_send";

// Same person across channels: an MCP peer and a Telegram persona bound to the same peer user
// share `peer:<user>`; a plain Telegram teammate is `person:<id>`.
export function requesterKey(store, chat) {
  if (!chat || chat.sim) return null;
  if (String(chat.caller || "").startsWith("peer:")) return chat.caller;
  if (chat.person_id) {
    const user = store.getPerson?.(chat.person_id)?.access?.peerAgent?.user;
    return user ? `peer:${user}` : `person:${chat.person_id}`;
  }
  return null;
}

export function channelOf(store, chat) {
  return store.linksForChat?.(chat.id)?.length ? "تلگرام" : String(chat.caller || "").startsWith("peer:") ? "اتصال MCP ایجنت همکار" : "وب";
}

// Open = something is still happening there (a run, a delegated subtask owed, a question waiting).
// Only those: a finished chat's channel may no longer deliver a late answer.
export function openWorkFor(store, chat, { isOpen }) {
  const key = requesterKey(store, chat);
  if (!key) return [];
  return store
    .listChats({ archived: false })
    .filter((c) => c.id !== chat.id && !c.parent_chat_id && !c.side_of && !c.job_id && !c.sim)
    .filter((c) => requesterKey(store, c) === key && isOpen(c.id))
    .slice(0, 5)
    .map((c) => ({ id: c.id, title: String(c.title || "").slice(0, 120), channel: channelOf(store, c), updatedAt: c.updated_at }));
}

export function relatedRules(open, here) {
  if (!open.length) return "";
  return `
Open work for this same requester in other conversations (other channels) — authoritative:
${open.map((o) => `- chat ${o.id} «${o.title}» (via ${o.channel}, last activity ${o.updatedAt})`).join("\n")}
If this message is about one of those, do NOT start the work again here: hand it over with
${RELATED_TOOL} {chat, text} (the message and anything new in it) and answer here in one line, e.g.
«همین را از مسیر ${open[0].channel} دارم دنبال می‌کنم؛ نتیجه همان‌جا می‌آید.» — this conversation is via ${here}.
Only if it is clearly a different request, work on it here as usual.
`;
}

export function createRelatedTool({ store, runner, chat, open }) {
  const here = channelOf(store, chat);
  return {
    description:
      "Hand this requester's message over to their OTHER open conversation (listed in your rules) where the same work is already running, instead of starting it again here. Then reply here in one line saying where it is being followed.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "id of one of the requester's open conversations from your rules" },
        text: { type: "string", description: "the requester's message / what is new, in their words" },
      },
      required: ["chat", "text"],
      additionalProperties: false,
    },
    async execute(args) {
      const target = open.find((o) => o.id === String(args?.chat || ""));
      if (!target) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "not one of this requester's open conversations", open: open.map((o) => o.id) }) }] };
      const text = `[همان درخواست‌کننده از مسیر ${here} — پیام تازه دربارهٔ همین کار]\n\n${String(args?.text || "").trim()}`;
      const out = await runner.send(target.id, { text, images: [], intent: runner.isActive(target.id) ? "steer" : "send" });
      return { content: [{ type: "text", text: JSON.stringify({ delivered: out?.delivered || "run", chat: target.id, channel: target.channel }) }] };
    },
  };
}
