// The sidebar's chat list as pure functions: what state a chat is in, and how a tab's list is
// filtered, sorted and grouped. The component only draws the result. Griffin keeps its own tabs per
// source, so there is no «origin» grouping; «owner» (whose threads, for Telegram and peer tabs) and
// the owner's own groups stay.
import { clockLabel } from "./elapsed.js";
import { groupSections } from "./chat-groups.js";
import { locale, num, t } from "./i18n.js";
import { orderSections } from "./drag.js";

export const SORTS = [
  { id: "updated", label: t("جدیدترین") },
  { id: "state", label: t("وضعیت (منتظر شما و در حال کار اول)") },
  { id: "unread", label: t("خوانده‌نشده اول") },
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

const STATES = { ask: t("منتظر پاسخ شما"), running: t("در حال کار"), unread: t("خوانده‌نشده"), read: t("خوانده‌شده"), error: t("خطادار") };
const STATE_ORDER = ["ask", "running", "unread", "read", "error"];

// The chat failed and the owner has not resolved it («حل شد» makes it "resolved"): the last run ended
// in an error, or a message never reached the agent and was kept — unless the plan limit kept it:
// that one goes again by itself at the reset.
export const failed = (chat) => chat?.runStatus === "error" || Boolean(chat?.kept?.length && !chat?.limitResumeAt);

/**
 * The one state a chat is in, most pressing first: asking the owner → running → unread → read → error.
 * Only a real question (`waitingForOwner`, from the server) asks the owner. Errors never lead: a failure
 * ranks after every read chat, seen or not — the row still shows its red dot, and its unread dot while
 * the owner has not opened it. A parent whose subtask still runs, or that goes on by itself when the plan
 * limit resets, is still at work.
 */
export function chatState(chat, isUnread) {
  const unread = Boolean(isUnread(chat));
  let id = "read";
  if (chat?.waitingForOwner) id = "ask";
  // A background task it left running (a watcher: «sleep» before checking CI) wakes it again.
  else if (chat?.runStatus === "running" || chat?.children?.some((k) => k.runStatus === "running") || chat?.limitResumeAt || Number(chat?.backgroundTasks) > 0) id = "running";
  else if (failed(chat)) id = "error";
  else if (unread) id = "unread";
  return { id, label: STATES[id], unread, failed: failed(chat) };
}

// `keepId`: the chat on screen stays listed whatever the filter — opening an unread chat marks it
// read, and it must not vanish from under the pointer.
// The sidebar's search: a chat matches by its title, or by its messages (bodyIds: the ids the server's
// full-text search returned for the same text, /api/chats/search).
export function searchChats(list, query, bodyIds = null) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => String(c.title || "").toLowerCase().includes(q) || Boolean(bodyIds?.has(c.id)));
}

export function filterChats(list, filter, isUnread, { keepId = null } = {}) {
  if (!filter || filter === "all") return [...list];
  const tests = { pinned: (c) => Boolean(c.pinned), unread: (c) => Boolean(isUnread(c)), error: failed };
  const test = tests[filter] || ((c) => chatState(c, isUnread).id === filter);
  return list.filter((c) => c.id === keepId || test(c));
}

// Stamps compared as times, not strings: the server sends both SQLite («2026-10-07 11:00:00», UTC)
// and ISO («…T10:00:00.000Z») forms, and as strings the space sorts before the «T».
const stampOf = (c) => {
  const v = c.updatedAt || c.createdAt;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const s = String(v || "");
  const ms = Date.parse(/^\d{4}-\d\d-\d\d \d/.test(s) ? `${s.replace(" ", "T")}Z` : s);
  return Number.isFinite(ms) ? ms : 0;
};
const newest = (a, b) => stampOf(b) - stampOf(a);

export function sortChats(list, sort, isUnread) {
  const first = (test) => (a, b) => Number(test(b)) - Number(test(a)) || newest(a, b);
  const items = [...list];
  if (sort === "title") return items.sort((a, b) => String(a.title).localeCompare(String(b.title), locale));
  if (sort === "unread") return items.sort(first((c) => isUnread(c)));
  if (sort === "state") {
    // The same states as the row's dots, so a running subtask or a plan-limit wait counts as work.
    const rank = (c) => STATE_ORDER.indexOf(chatState(c, isUnread).id);
    return items.sort((a, b) => rank(a) - rank(b) || newest(a, b));
  }
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
 * "none" gives asking the owner → running → pinned → the rest: what needs the owner and background work must be
 * impossible to miss; failures sit at the end of pinned and of the rest.
 */
export function groupChats(list, groupBy, options = {}) {
  // By date, agent, repo or model (like Claude Desktop's folders), pinned chats stay on top. The owner's
  // own groups (the main list only) sit beside those sections, where he dragged them (drag.js), so a chat
  // can be dragged into one whatever the grouping (owner 2026-10-24); the sections themselves take the
  // order he dragged them into (`sectionOrder`).
  if (["date", "agent", "repo", "model"].includes(groupBy)) {
    const { groups = [], scope = "", narrowed = false, looseAt = null, sectionOrder = null } = options;
    const owned = scope === "manual" ? groups : [];
    const known = new Set(owned.map((g) => g.id));
    const pinned = list.filter((c) => c.pinned);
    const named = owned
      .map((g) => ({ key: `group:${g.id}`, title: g.name, groupId: g.id, chats: list.filter((c) => !c.pinned && c.groupId === g.id), collapsible: true }))
      .filter((s) => s.chats.length || !narrowed);
    const rest = list.filter((c) => !c.pinned && !known.has(c.groupId));
    const loose = orderSections(attributeGroups(rest, groupBy, options), sectionOrder).map((s, i) => ({ ...s, loose: true, looseHead: i === 0 }));
    const at = Number.isInteger(looseAt) && looseAt >= 0 ? named.filter((s) => owned.findIndex((g) => g.id === s.groupId) < looseAt).length : named.length;
    return [...(pinned.length ? [{ key: "pinned", title: t("سنجاق‌شده"), chats: pinned }] : []), ...named.slice(0, at), ...loose, ...named.slice(at)];
  }
  return attributeGroups(list, groupBy, options);
}

function attributeGroups(list, groupBy, { isUnread = () => false, now = new Date(), timeZone, agentLabel = (id) => id, groups = [], narrowed = false, scope = "", looseAt = null } = {}) {
  if (groupBy === "custom") return groupSections(list, groups, { narrowed, looseAt });
  if (groupBy === "owner") {
    // Whose threads (Telegram, peers): each person's can be folded away.
    const map = new Map();
    // A colleague's agent's chats have no owner key: they are that colleague's (caller «peer:<id>»,
    // label from the server) — before, all of them sat in one «بدون صاحب» heap (owner 2026-10-20).
    for (const chat of list) {
      const peer = !chat.ownerKey && String(chat.caller || "").startsWith("peer:");
      const key = chat.ownerKey || (peer ? chat.caller : "none");
      if (!map.has(key)) map.set(key, { key: `${scope}:${key}`, title: chat.ownerLabel || (peer ? chat.peerLabel || chat.caller.slice(5) : "") || t("بدون صاحب"), chats: [], collapsible: true });
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
    const sections = bucket(list, (c) => c.repo || "").map((s) => ({ key: `repo:${s.key}`, title: s.key || t("بدون مخزن"), chats: s.chats, none: !s.key, ...(s.key ? { repo: s.key } : {}) }));
    return sections.sort((a, b) => Number(a.none) - Number(b.none)).map(({ none, ...s }) => s);
  }
  if (groupBy === "model") return bucket(list, (c) => c.model || "").map((s) => ({ key: `model:${s.key}`, title: s.key || t("مدل پیش‌فرض"), chats: s.chats }));
  const stateOf = (c) => chatState(c, isUnread).id;
  const ask = list.filter((c) => stateOf(c) === "ask");
  const running = list.filter((c) => stateOf(c) === "running");
  // Failures go last in their section, read chats before them.
  const rest = list.filter((c) => stateOf(c) !== "ask" && stateOf(c) !== "running");
  const others = [...rest.filter((c) => stateOf(c) !== "error"), ...rest.filter((c) => stateOf(c) === "error")];
  return [
    { key: "ask", title: ask.length > 1 ? t("منتظر پاسخ شما ({n})", { n: num(ask.length) }) : t("منتظر پاسخ شما"), chats: ask },
    { key: "running", title: running.length > 1 ? t("در حال اجرا ({n})", { n: num(running.length) }) : t("در حال اجرا"), chats: running },
    { key: "pinned", title: t("سنجاق‌شده"), chats: others.filter((c) => c.pinned) },
    { key: "rest", title: null, chats: others.filter((c) => !c.pinned) },
  ].filter((s) => s.chats.length);
}

// A row's time, as a clock (elapsed.js clockLabel) rather than «۵ دقیقه».
export function ago(stamp, now = Date.now()) {
  return clockLabel(stamp, new Date(now));
}

// The sidebar's clock beside a chat with a reminder still to run (owner 10-24: «مثل علامت سوال»).
export const reminderLabel = (at) => {
  const when = clockLabel(at);
  return when ? `یادآور فعال · ${when}` : t("یادآور فعال");
};
