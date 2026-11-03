// Starting a suggested chat (chat_suggest / handoff_to_owner card): its prompt as the first message,
// on the suggestion's repo and model. The owner's «شروع» on the card (app.mjs) and a handoff he
// already said yes to (handoff.mjs) both come here, so the two start the same way.

import { DEFAULT_AGENT } from "./agents/registry.mjs";
import { settleSuggestion, withOwnerNote } from "./chat-tools.mjs";
import { handoffStarted } from "./handoff.mjs";
import { normalizeProvider, splitModel } from "./providers/ids.mjs";
import { isInboxOrigin, markInboxOrigin } from "./telegram-inbox.mjs";

/**
 * Creates the chat for suggestion `row` and sends its prompt. model: undefined = the suggested one,
 * "" = automatic. Returns { chat, sent } or null when the suggestion was already started elsewhere.
 */
export async function startSuggestedChat({ store, runner, row, model, note = "", notePosition }) {
  const chosen = typeof model === "string" ? model : row.model || "";
  const profile = store.getAgentProfile?.(DEFAULT_AGENT);
  const chat = store.createChat({
    title: row.title,
    model: chosen || profile?.model || null,
    agent: DEFAULT_AGENT,
    provider: normalizeProvider(splitModel(chosen)?.provider || profile?.provider),
  });
  if (row.repo) store.updateChat(chat.id, { repo: row.repo });
  // A chat started from a suggestion of the Telegram inbox holds a colleague's words: it carries the
  // Telegram-origin marker itself (telegram-inbox.mjs), so every check that reads the chat's own row
  // (knowledge auto-trust, the owner chat tools, the ledger) treats it as such, not only chat-origin's walk.
  if (row.from_chat_id && isInboxOrigin(store, row.from_chat_id)) markInboxOrigin(store, chat.id, "suggest");
  // Claimed before the run starts: a double click starts one chat, not two.
  if (!settleSuggestion(store, row.id, "started", chat.id)) {
    store.deleteChat(chat.id);
    return null;
  }
  // A colleague chain's handoff (handoff.mjs): its text is theirs (the Telegram-origin marker keeps
  // the owner's instruction files out of reach), and each finished run reports back there.
  if (handoffStarted(store, row.id, chat.id)) markInboxOrigin(store, chat.id, "handoff");
  const sent = await runner.send(chat.id, { text: withOwnerNote(row.prompt, note, notePosition), images: [] });
  return { chat: store.getChat(chat.id), sent };
}
