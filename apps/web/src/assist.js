// What the composer offers around the box. Pure logic, so node tests import it directly.
import { t } from "./i18n.js";
//   GET    /api/commands?chat=:id          -> { commands: [{ name, description, argumentHint, local? }] }
//   POST   /api/chats/:id/fork { runId }   -> { chat }   (a new chat holding the conversation up to that reply)
//   DELETE /api/chats/:id/limit-resume              (the chat no longer continues by itself after the limit)
//   PATCH  /api/chats/:id { fast }                  (Claude fast mode, from the chat's next run)

// --- «/» list: Claude Code's commands and skills, and Griffin's own (/clear, /compact) ---

// The text after the slash while the box holds a lone /word; null otherwise (an argument is
// being written, or it is a path).
export function slashQuery(text) {
  const match = /^\/([^\s/]*)$/.exec(text || "");
  return match ? match[1] : null;
}

const MAX_SHOWN = 50;

// Exact name first, then names that start with the typed text, then names, aliases and descriptions containing it.
export function filterCommands(list, query) {
  if (!Array.isArray(list)) return [];
  const q = String(query || "").toLowerCase();
  if (!q) return list.slice(0, MAX_SHOWN);
  const rank = (c) => {
    const name = c.name.toLowerCase();
    if (name === q) return -1;
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if ((c.aliases || []).some((a) => a.toLowerCase().includes(q))) return 2;
    if (String(c.description || "").toLowerCase().includes(q)) return 3;
    return null;
  };
  return list
    .map((c, i) => ({ c, i, r: rank(c) }))
    .filter((x) => x.r != null)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, MAX_SHOWN)
    .map((x) => x.c);
}

// Does Enter complete the highlighted command? Yes while its name is still being typed, or once
// the owner moved to it with the arrows. A finished name, or a line that only matched a
// description, is sent as written (Tab still completes).
export function enterPicks(command, query, moved) {
  if (!command) return false;
  if (moved) return true;
  const name = command.name.toLowerCase();
  const q = String(query || "").toLowerCase();
  return name !== q && name.includes(q);
}

// The command, with a space after it for its argument. Nothing is sent.
export const pickCommand = (command) => `/${command.name} `;

export function moveIndex(index, length, step) {
  if (!length) return 0;
  if (index >= length) return 0;
  return (index + step + length) % length;
}

// «/clear» typed alone starts a new chat instead of being sent.
export const isClearCommand = (text) => String(text || "").trim() === "/clear";

// --- the suggested next message (Claude's prompt suggestions, chat.suggestion) ---

// What to show, or null. Anything in the box — even a space — is the owner's own text.
// returns (the NEXT_STEP_RETURNS setting): clearing the box brings it
// back, so Tab writes it in again (as in Claude Code) — what was put aside is ignored.
export function shownNextStep({ suggestion, text, running, dismissed, returns = false }) {
  const next = typeof suggestion === "string" ? suggestion.trim() : "";
  if (!next || running || text || (!returns && next === dismissed)) return null;
  return next;
}

// The NEXT_STEP_RETURNS setting as the chat list last reported it (api.js useChats); off until then.
let nextStepReturns = false;
export const setNextStepReturns = (on) => {
  nextStepReturns = on === true;
};
export const nextStepReturnsOn = () => nextStepReturns;

// Typing puts the current suggestion aside for good: clearing the box does not bring it back
// (unless NEXT_STEP_RETURNS is on).
// A turn in between starts over, so the same words suggested again show again.
export function dismissNextStep(dismissed, { suggestion, text, running = false }) {
  if (running) return null;
  const next = typeof suggestion === "string" ? suggestion.trim() : "";
  return next && text ? next : dismissed;
}

// Only a plain Tab accepts; Shift+Tab still moves focus back.
export function acceptsNextStep(event) {
  if (event.key !== "Tab" || event.isComposing) return false;
  return !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
}

// --- fast mode: the chat's switch (chat.fast) against what Claude Code last reported (chat.fastState) ---

const FAST_REASONS = {
  extra_usage_disabled: t("مصرف اضافه روی این حساب Claude خاموش است"),
  sdk_opt_in_required: t("از نوبت بعد"),
  model_not_allowed: t("این مدل حالت سریع ندارد"),
  not_first_party: t("فقط با ورود مستقیم به Claude"),
  preference: t("در تنظیمات Claude خاموش است"),
};

// Why the switch is on but fast mode is not, or null.
export function fastNote({ fast, fastState, model }) {
  if (!fast || fastState?.state === "on") return null;
  if (fastState?.state === "cooldown") return t("بعد از سقف سرعت، موقتاً عادی");
  const reason = fastState?.reason || "";
  if (FAST_REASONS[reason]) return FAST_REASONS[reason];
  // An empty model is the agent's default; only a named non-Opus model is known to miss out.
  if (model && !/opus/i.test(model)) return t("فقط روی Opus");
  return reason || t("از نوبت بعد");
}

// --- «ادامه در گفتگوی تازه از اینجا» ---

// The run to fork from, or null where the action does not belong (a run still going, a side chat,
// a subtask, a chat someone other than the owner started).
export function forkRunId(run, chat) {
  if (!chat || chat.sideOf || chat.parentChatId || (chat.caller && chat.caller !== "owner")) return null;
  if (!run?.runId || run.status === "running") return null;
  return run.runId;
}
