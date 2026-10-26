// A chat someone else starts — a colleague's Telegram chat (caller "team"), a colleague's agent
// (peer:*) — opens on a cheap model (TEAM_MODEL / PEER_MODEL) and moves itself to a stronger one
// only when the message is real work (owner 2026-10-25: «با مدل ضعیف‌تری شروع بشن، اگر واقعاً کار
// بود مدلشون رو خودشون سوییچ کنن»). The cheap model calls upgrade_model and ends its turn; the
// runner (runner.mjs execute) then goes on in the SAME run and the same session on UPGRADE_MODEL,
// so the colleague gets one answer and every run.finished reader sees one run. The next message
// starts on the cheap model again.

export const UPGRADE_TOOL = "upgrade_model";
const REASON_MAX = 300;

const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }] });

// The engine message that starts the second leg. The session already holds the colleague's message
// and what the cheap model did; this only says who takes over and why.
export function upgradeNote(reason) {
  const why = String(reason || "").trim();
  return [
    "[ارتقای مدل] مدل سبک این نوبت را به تو سپرد" + (why ? ` — دلیل: ${why}` : "") + ".",
    "همان آخرین پیام بالا را از همان‌جا که مانده کامل انجام بده و جواب نهایی را بنویس؛ کاری را که در این نوبت انجام شده دوباره نکن.",
    "این پیام از طرف هیچ آدمی نیست؛ به آن جواب نده.",
  ].join("\n");
}

/**
 * State shared by the tool (index.mjs, per chat) and the runner: target(chatId) -> { model, effort }
 * or null when this chat may not move (not a colleague's chat, no UPGRADE_MODEL, already on it).
 */
export function createUpgrades({ target = () => null } = {}) {
  const asked = new Map(); // chatId -> { model, effort, reason } for the leg that is running now
  const upgraded = new Set(); // chatIds whose current run is already on the stronger model
  return {
    target,
    request(chatId, reason) {
      if (upgraded.has(chatId)) return { error: "already on the stronger model for this message: go on and answer" };
      const to = target(chatId);
      if (!to) return { error: "no stronger model is set up for this chat: answer with what you have" };
      asked.set(chatId, { ...to, reason: String(reason || "").trim().slice(0, REASON_MAX) });
      return { accepted: true, model: to.model };
    },
    // The runner, when the first leg ends: the upgrade asked during it (once), else null.
    take(chatId) {
      const up = asked.get(chatId) || null;
      asked.delete(chatId);
      if (up) upgraded.add(chatId);
      return up;
    },
    // The runner, when the run ends for any reason: the next message starts cheap again.
    end(chatId) {
      asked.delete(chatId);
      upgraded.delete(chatId);
    },
    isUpgraded: (chatId) => upgraded.has(chatId),
  };
}

export function upgradeTool(upgrades, chatId) {
  return {
    description:
      "You are on a fast, light model. Call this FIRST — before writing any reply — when the message is real work: " +
      "looking into a system or a problem (logs, metrics, a cluster, a database, code), more than two or three tool calls, " +
      "a change or a request with risk or ambiguity, or whenever you are not sure your answer would be right. " +
      "Call it instead of starting that work yourself and before handing anything on with delegate or ask_agent: the stronger model " +
      "decides that. This same message then continues on it with this whole conversation. After calling it, end your turn " +
      "at once: no text, no other tool. Do NOT call it for a greeting, thanks, a short factual answer or a single quick lookup.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "one short line: why this message needs the stronger model" } },
      required: ["reason"],
      additionalProperties: false,
    },
    async execute(args) {
      const reason = typeof args?.reason === "string" ? args.reason : "";
      if (!reason.trim()) return fail("reason is required: one short line on why this message needs the stronger model");
      const r = upgrades.request(chatId, reason);
      if (r.error) return fail(r.error);
      return ok({ ...r, next: "End your turn now with no text and no other tool call; the stronger model continues this message." });
    },
  };
}
