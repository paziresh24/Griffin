// The sidebar's chat list as pure functions: what state a chat is in, and how a tab's list is
// filtered, sorted and grouped. The component only draws the result. Griffin keeps its own tabs per
// source, so there is no «origin» grouping; «owner» (whose threads, for Telegram and peer tabs) and
// the owner's own groups stay.
import { groupSections } from "./chat-groups.js";
import { locale, num, t } from "./i18n.js";

export const SORTS = [
  { id: "updated", label: t("جدیدترین") },
  { id: "unread", label: t("خوانده‌نشده اول") },
  { id: "running", label: t("در حال اجرا اول") },
  { id: "title", label: t("نام (الفبا)") },
];

export const GROUPS = [
  { id: "none", label: t("بدون گروه‌بندی") },
  { id: "custom", label: t("گروه‌های خودم") },
  { id: "owner", label: t("بر اساس صاحب") },
  { id: "state", label: t("بر اساس وضعیت") },
  { id: "read", label: t("خوانده‌شده / نشده") },
  { id: "date", label: t("بر اساس تاریخ") },
  { id: "agent", label: t("بر اساس ایجنت") },
  { id: "repo", label: t("بر اساس مخزن") },
  { id: "model", label: t("بر اساس مدل") },
];

export const FILTERS = [
  { id: "all", label: t("همه") },
  { id: "unread", label: t("خوانده‌نشده") },
  { id: "ask", label: t("منتظر پاسخ شما") },
  { id: "running", label: t("در حال کار") },
  { id: "error", label: t("دارای خطا") },
  { id: "pinned", label: t("سنجاق‌شده") },
];

const STATES = { ask: t("منتظر پاسخ شما"), running: t("در حال کار"), error: t("خطا"), unread: t("خوانده‌نشده"), read: t("خوانده‌شده") };
const STATE_ORDER = ["ask", "running", "error", "unread", "read"];

/** The one state a chat is in, most pressing first. `waitingForOwner` comes from the server when it has it. */
export function chatState(chat, isUnread) {
  const unread = Boolean(isUnread(chat));
  let id = "read";
  if (chat?.waitingForOwner) id = "ask";
  else if (chat?.runStatus === "running") id = "running";
  else if (chat?.runStatus === "error") id = "error";
  else if (unread) id = "unread";
  return { id, label: STATES[id], unread };
}

// `keepId`: the chat on screen stays listed whatever the filter — opening an unread chat marks it
// read, and it must not vanish from under the pointer.
export function filterChats(list, filter, isUnread, { keepId = null } = {}) {
  if (!filter || filter === "all") return [...list];
  const tests = { pinned: (c) => Boolean(c.pinned), unread: (c) => Boolean(isUnread(c)) };
  const test = tests[filter] || ((c) => chatState(c, isUnread).id === filter);
  return list.filter((c) => c.id === keepId || test(c));
}

const newest = (a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));

export function sortChats(list, sort, isUnread) {
  const first = (test) => (a, b) => Number(test(b)) - Number(test(a)) || newest(a, b);
  const items = [...list];
  if (sort === "title") return items.sort((a, b) => String(a.title).localeCompare(String(b.title), locale));
  if (sort === "unread") return items.sort(first((c) => isUnread(c)));
  if (sort === "running") return items.sort(first((c) => c.runStatus === "running"));
  return items.sort(newest);
}

// Calendar days between two instants in the owner's timezone (the browser's by default).
function daysAgo(stamp, now, timeZone) {
  const day = (d) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) return Infinity;
  return Math.round((Date.parse(day(now)) - Date.parse(day(at))) / 86_400_000);
}

function bucket(list, keyOf, order = null) {
  const map = new Map();
  for (const chat of list) {
    const key = keyOf(chat);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(chat);
  }
  const keys = order ? order.filter((k) => map.has(k)) : [...map.keys()];
  return keys.map((key) => ({ key, chats: map.get(key) }));
}

/**
 * Sections of the list: [{ key, title, chats, collapsible?, groupId? }], empty ones left out (the
 * owner's own empty groups stay unless `narrowed`). The chats keep the order they came in.
 * "none" gives running → pinned → the rest: background work must be impossible to miss.
 */
export function groupChats(list, groupBy, { isUnread = () => false, now = new Date(), timeZone, agentLabel = (id) => id, groups = [], narrowed = false, scope = "" } = {}) {
  if (groupBy === "custom") return groupSections(list, groups, { narrowed });
  if (groupBy === "owner") {
    // Whose threads (Telegram, peers): each person's can be folded away.
    const map = new Map();
    for (const chat of list) {
      const key = chat.ownerKey || "none";
      if (!map.has(key)) map.set(key, { key: `${scope}:${key}`, title: chat.ownerLabel || t("بدون صاحب"), chats: [], collapsible: true });
      map.get(key).chats.push(chat);
    }
    return [...map.values()];
  }
  if (groupBy === "state") {
    return bucket(list, (c) => chatState(c, isUnread).id, STATE_ORDER).map((s) => ({ key: `state:${s.key}`, title: STATES[s.key], chats: s.chats }));
  }
  if (groupBy === "read") {
    return bucket(list, (c) => (isUnread(c) ? "unread" : "read"), ["unread", "read"]).map((s) => ({ key: `read:${s.key}`, title: STATES[s.key], chats: s.chats }));
  }
  if (groupBy === "date") {
    const names = { today: t("امروز"), yesterday: t("دیروز"), week: t("{n} روز اخیر", { n: num(7) }), older: t("قدیمی‌تر") };
    const keyOf = (c) => {
      const d = daysAgo(c.updatedAt || c.createdAt, now, timeZone);
      return d <= 0 ? "today" : d === 1 ? "yesterday" : d <= 7 ? "week" : "older";
    };
    return bucket(list, keyOf, ["today", "yesterday", "week", "older"]).map((s) => ({ key: `date:${s.key}`, title: names[s.key], chats: s.chats }));
  }
  if (groupBy === "agent") return bucket(list, (c) => c.agent || "griffin").map((s) => ({ key: `agent:${s.key}`, title: agentLabel(s.key), chats: s.chats }));
  if (groupBy === "repo") {
    const sections = bucket(list, (c) => c.repo || "").map((s) => ({ key: `repo:${s.key}`, title: s.key || t("بدون مخزن"), chats: s.chats, none: !s.key }));
    return sections.sort((a, b) => Number(a.none) - Number(b.none)).map(({ none, ...s }) => s);
  }
  if (groupBy === "model") return bucket(list, (c) => c.model || "").map((s) => ({ key: `model:${s.key}`, title: s.key || t("مدل پیش‌فرض"), chats: s.chats }));
  const running = list.filter((c) => c.runStatus === "running");
  const others = list.filter((c) => c.runStatus !== "running");
  return [
    { key: "running", title: running.length > 1 ? t("در حال اجرا ({n})", { n: num(running.length) }) : t("در حال اجرا"), chats: running },
    { key: "pinned", title: t("سنجاق‌شده"), chats: others.filter((c) => c.pinned) },
    { key: "rest", title: null, chats: others.filter((c) => !c.pinned) },
  ].filter((s) => s.chats.length);
}

// Short, muted relative time for a chat row («الان», «۵ دقیقه», «۲ ساعت», «۳ روز», «۲ ماه»).
export function ago(stamp, now = Date.now()) {
  const at = stamp ? new Date(stamp).getTime() : NaN;
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return t("الان");
  if (minutes < 60) return t("{n} دقیقه", { n: num(minutes) });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("{n} ساعت", { n: num(hours) });
  const days = Math.round(hours / 24);
  if (days < 30) return t("{n} روز", { n: num(days) });
  return t("{n} ماه", { n: num(Math.round(days / 30)) });
}
