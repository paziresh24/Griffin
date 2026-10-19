// Telegram send ledger (from Karsara, owner install). Every telegram_send from the owner's account
// is written down with the chat that sent it, the peer and the Telegram message id; telegram_ledger
// reads it back, so an answer that arrives later can be traced to the chat that asked instead of
// guessed from its text. Per-install switch TELEGRAM_LEDGER (off by default, index.mjs): off, nothing
// is written and no chat has the tool, exactly as before.
//
// Who reads it: the owner's own chats only (owner-chat-tools.mjs isOwnerChat) — it names his chats
// and whom he wrote to. Writing happens on every telegram_send while the switch is on, whichever chat
// (or the /api/telegram/send route, with no chat) sent it.
import { isOwnerChat } from "./owner-chat-tools.mjs";

export const TELEGRAM_LEDGER_CONFIG = "TELEGRAM_LEDGER";
export const LEDGER_TOOL = "telegram_ledger";

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (message) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: message }) }] });

/** The record callback createAccountTools takes, or null when the install keeps no ledger. */
export function ledgerRecorder({ store, chatId = null, enabled }) {
  if (!enabled) return null;
  return ({ peerId, messageId }) => store.recordTelegramSend({ peerId, chatId, messageId });
}

/** The telegram_ledger tool for this chat: {} unless the switch is on and it is an owner chat. */
export function ledgerTools({ store, chat, enabled }) {
  if (!enabled || !chat || !isOwnerChat(store, chat)) return {};
  return {
    [LEDGER_TOOL]: {
      description:
        "The send ledger: recent messages chats here sent from the owner's Telegram account to one peer (numeric peer id, as telegram_send returns it) — which chat sent it (id + title), the Telegram message id, and when. Use it to find the chat an incoming answer belongs to.",
      inputSchema: {
        type: "object",
        properties: { peerId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } },
        required: ["peerId"],
        additionalProperties: false,
      },
      async execute(args) {
        const peerId = String(args?.peerId ?? "").trim();
        if (!/^-?\d+$/.test(peerId)) return fail("peerId (numeric) is required");
        return text({ peerId, sends: store.listTelegramSends({ peerId, limit: Math.min(Number(args?.limit) || 20, 100) }), source: "send ledger" });
      },
    },
  };
}
