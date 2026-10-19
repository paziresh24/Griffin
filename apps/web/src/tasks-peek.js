import { num, t } from "./i18n.js";

// Config CLAUDE_BACKGROUND_TASKS: the chat's background tasks above the composer (TasksPeek.jsx).
export const TASKS_LABEL = t("در پس‌زمینه");
// How often the list is asked for: often while something runs, rarely while nothing does.
export const pollMs = (count) => (count ? 4_000 : 20_000);

// "۳ دقیقه" / "۴۵ ثانیه" since a task started.
export function runningFor(startedAt, now = Date.now()) {
  const s = Math.max(0, Math.round((now - (startedAt == null ? now : Number(startedAt))) / 1000));
  if (s < 60) return t("{n} ثانیه", { n: num(s) });
  const m = Math.floor(s / 60);
  if (m < 60) return t("{n} دقیقه", { n: num(m) });
  return t("{n} ساعت", { n: num(Math.floor(m / 60)) });
}

const KIND = {
  local_bash: t("ترمینال"),
  local_agent: t("ایجنت"),
  remote_agent: t("ایجنت"),
  local_workflow: t("گردش‌کار"),
  monitor_mcp: t("پایش"),
  dream: t("پایش"),
};
export const taskKind = (type) => KIND[type] || (/monitor/i.test(String(type || "")) ? t("پایش") : t("کار"));

// A row's name: its own description, else what it is («پایش · bed7m8cnd») — never the bare id alone.
export function taskTitle(task) {
  const own = String(task?.description || "").trim();
  if (own) return own;
  const id = String(task?.id || "");
  return `${taskKind(task?.type)}${id ? ` · ${id.slice(0, 12)}` : ""}`;
}

// Sub-agents of this chat (delegate / ask_agent children) that run now: they sit in the same list.
export const runningChildren = (children) =>
  (Array.isArray(children) ? children : []).filter((c) => c?.id && c.runStatus === "running");

// The list as the server sends it, oldest first; a task stopped here is hidden at once.
export function visibleTasks(tasks, gone = new Set()) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task?.id && !gone.has(task.id))
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

// Ended tasks that left an output (a background shell's log) stay a while, so its end can be read.
export const ENDED_SHOWN_MS = 10 * 60_000;
const ENDED = { completed: t("تمام شد"), failed: t("شکست خورد"), stopped: t("متوقف شد"), killed: t("متوقف شد") };
export const endedLabel = (status) => ENDED[status] || t("تمام شد");
export function recentEnded(ended, now = Date.now(), windowMs = ENDED_SHOWN_MS) {
  return (Array.isArray(ended) ? ended : []).filter((task) => task?.id && now - Number(task.endedAt || 0) < windowMs);
}
