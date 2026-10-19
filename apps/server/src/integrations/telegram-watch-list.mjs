// telegram_watch_list: which Telegram chats the watcher («واچر») is on, read from Griffin's own
// database (persons + the per-person switch, mother.mjs `watching`). Read-only, no Telegram call,
// nothing secret in the result — so a daily job can build its work on exactly these chats.
import { DEFAULT_TZ } from "../jobs/cron.mjs";
import { watching } from "./mother.mjs";

export const WATCH_LIST_TOOL = "telegram_watch_list";

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const local = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleString("sv-SE", { timeZone: DEFAULT_TZ }) : null;
};

export function watchListTools({ store }) {
  return {
    [WATCH_LIST_TOOL]: {
      description:
        "The Telegram chats Griffin's watcher is switched on for (settings in Griffin's own database): Telegram chat id (use it with telegram_read), title, type (user|group) and the time of the last message seen there (the owner's time zone). Read-only.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const chats = store
          .listPersonsLight({ source: "telegram" })
          .filter((p) => watching(p) && p.access?.enabled !== false)
          .map((p) => ({
            id: String(p.external_id),
            title: p.display_name || p.username || String(p.external_id),
            type: String(p.external_id).startsWith("-") ? "group" : "user",
            username: p.username || null,
            lastMessageAt: local(p.last_seen_at),
          }));
        return text({ chats, count: chats.length, source: "griffin watcher settings" });
      },
    },
  };
}
