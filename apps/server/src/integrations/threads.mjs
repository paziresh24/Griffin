import { OWNER_NAME } from "../owner.mjs";
import { CALL_WORD } from "../persona.mjs";

// How a colleague's Telegram conversation is put to a mother chat (mother.mjs, desk.mjs). The
// classifier that once decided whether a message opened a thread is gone: every
// watched person's message goes to their mother chat, and that chat decides (Telegram v2).

const REOPEN = new RegExp(`^\\s*(?:\\/griffin\\b|@?${CALL_WORD})`, "iu");

/** The colleague (or their assistant) calling the assistant by name: past the pickup window. */
export function wantsGriffin(text) {
  return REOPEN.test(String(text || ""));
}

// The owner's own line in a colleague chat hands the work to the assistant only when it says so
// («گریفین …», «بهتون کمک می‌کنه»); anything else («الان», an answer, a question) is the owner
// taking the conversation himself.
const HANDS_TO_GRIFFIN = new RegExp(`${CALL_WORD}|کمک\\S*\\s*می[\\u200c\\s]?کن`, "iu");
export function handsToGriffin(text) {
  return HANDS_TO_GRIFFIN.test(String(text || ""));
}

// How a message is framed is the only thing a message carries. What to do with it is in the run's
// rules once (prompt.mjs TEAM_CONTEXT, mother.mjs motherContext), not repeated on every message.

/** A colleague's message. */
export function threadInboundPrompt({ name, text }) {
  return `«${name || "همکار"}»: ${String(text || "").trim()}`;
}

/** A message the owner typed by hand in Telegram to that colleague. */
export function threadOwnerPrompt({ name, text }) {
  return `«${OWNER_NAME} در تلگرام به ${name || "همکار"}»: ${String(text || "").trim()}`;
}
