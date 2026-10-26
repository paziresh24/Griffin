// «بعداً یادم بنداز» for the agent itself (owner 2026-10-21): a promise to a colleague («تا ۱۲ خبرتان
// می‌کنم») was lost because nothing woke the chat later; a sleep in Bash dies at 2 minutes and a job
// delivers to the owner, not back into the chat. This writes a timed note into the SAME chat (the
// notes table and its 20-second timer already exist); when due, the chat gets the reminder as its
// own note — framed as the agent's reminder, never as the owner's words.
const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const MAX_MS = 30 * UNITS.d;
const MAX_OPEN = 20;
export const REMINDER_MARK = "یادآوری‌ای که خودت گذاشتی";

export function parseIn(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([mhd])\s*$/i.exec(String(text || ""));
  return m ? Math.round(Number(m[1]) * UNITS[m[2].toLowerCase()]) : NaN;
}

export function laterTool({ store, chatId, now = () => Date.now() }) {
  return {
    description:
      "Wake THIS chat later with a reminder you write now: a promise to someone («خبرتان می‌کنم»), a check after CI/a backup/a deploy, a follow-up tomorrow. Survives restarts. Give `in` (\"30m\", \"2h\", \"1d\") or `at` (ISO time); `text` = what to do then, in Persian, with enough context (who, what, where). At that time the chat runs with it as your own reminder. Use this instead of sleeping in Bash or a one-off job.",
    inputSchema: {
      type: "object",
      properties: {
        in: { type: "string", description: "delay like 30m, 2h, 1d (max 30d)" },
        at: { type: "string", description: "ISO time instead of in" },
        text: { type: "string", description: "what to do when it fires" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(args) {
      const text = String(args?.text || "").trim();
      if (!text) return { isError: true, content: [{ type: "text", text: "text is empty" }] };
      const t = args?.at ? Date.parse(args.at) : now() + parseIn(args?.in);
      if (!Number.isFinite(t) || t <= now() || t - now() > MAX_MS) return { isError: true, content: [{ type: "text", text: "give in (30m/2h/1d, up to 30d) or a future ISO at" }] };
      const open = (store.listNotes?.({ limit: 500 }) || []).filter((n) => n.chat_id === chatId && n.status === "open").length;
      if (open >= MAX_OPEN) return { isError: true, content: [{ type: "text", text: `this chat already has ${open} pending reminders` }] };
      const note = store.createNote({ text, chatId, options: { reminder: true, setAt: new Date(now()).toISOString() }, runAt: new Date(t).toISOString() });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, id: note.id, runAt: note.run_at }) }] };
    },
  };
}

const noteOptions = (row) => {
  try { return row?.options ? JSON.parse(row.options) : {}; } catch { return {}; }
};

/** The agent's own reminder (laterTool), not a note the person left: it belongs to its chat only. */
export const isReminder = (row) => Boolean(noteOptions(row).reminder);

/** The message a due reminder brings into the chat. */
export function reminderMessage(row) {
  const opts = noteOptions(row);
  if (!opts.reminder) return null;
  return `[${REMINDER_MARK} (${opts.setAt || row.created_at}) — حرف Owner نیست؛ حالا وقتش است]\n${row.text}`;
}
