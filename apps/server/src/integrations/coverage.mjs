import { guardTools } from "../guard.mjs";
import { OWNER_NAME } from "../owner.mjs";

// A colleague's Telegram chat (caller "team"): the /agent commands, the owner's web note, end_agent
// for the pre-v2 threads, and the hard gate on dangerous / irreversible tool calls (in code, not prompt).

export const COVERAGE_CALLER = "team";
export const END_AGENT_TOOL = "end_agent";

// The owner in a colleague's chat: /agent turns the watcher on, /agent off turns it off (desk.mjs).
const START = /^\s*\/agent\s*$/i;
const END = /^\s*\/agent\s+off\s*$/i;

export function coverageCommand(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (START.test(s)) return "start";
  if (END.test(s)) return "end";
  return null;
}

/**
 * The owner typing in a coverage chat from the web UI. Without a frame the agent took it for the
 * colleague and its answer went to them: «چه جوابی داده؟ متنش رو بفرست» reached the colleague.
 */
// How the owner's web-UI note to a covered thread starts (the bridge recognizes it as internal).
// Older notes said «… از داخل گریفین»; both are still recognized.
export const OWNER_NOTE_PREFIX = `«${OWNER_NAME} از داخل اپ`;
export const OWNER_NOTE_PREFIXES = [OWNER_NOTE_PREFIX, `«${OWNER_NAME} از داخل گریفین`];
export const isOwnerNote = (text) => OWNER_NOTE_PREFIXES.some((p) => String(text || "").startsWith(p));

export function coverageOwnerNote(peerName, text) {
  return `${OWNER_NOTE_PREFIX} — برای تو، نه برای ${peerName || "همکار"}»: ${String(text || "").trim()}`;
}

export function createEndAgentTool({ onEnd }) {
  return {
    description:
      "Call after you have written the final goodbye / summary to the teammate. Closes this /agent session so later messages are ignored until the owner starts /agent again.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string", description: "optional short note for the owner" } },
      additionalProperties: false,
    },
    async execute(args) {
      onEnd?.(typeof args?.note === "string" ? args.note : "");
      return { content: [{ type: "text", text: JSON.stringify({ ended: true }) }] };
    },
  };
}
// Teammate coverage talks to a colleague in their chat: on top of the general irreversible gate
// (guard.mjs), these need the owner too. Replying in the same chat is free.
export const TEAM_MUTATING = new Set(["arvan_cache_purge", "telegram_send", "knowledge_write"]);

export { isDestructiveShell, isDestructiveSql, isYes } from "../guard.mjs";

export function guardTeamTools(tools, { chatId, asks, store = null, peerChat = null } = {}) {
  return guardTools(tools, {
    chatId,
    asks,
    store,
    caller: COVERAGE_CALLER,
    extra: TEAM_MUTATING,
    allowPass: (name, args) => {
      if (name !== "telegram_send" || !peerChat) return false;
      const target = String(args?.chat || "").trim();
      return target === String(peerChat) || target.includes(String(peerChat));
    },
  });
}
