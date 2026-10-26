import { t } from "./i18n.js";
// Karsara's sidebar list as pure functions, copied verbatim from Karsara (karsara-live apps/web/src/
// chat-list.js): the Karsara skin draws its list with these, Griffin's skin keeps chat-list.js.
import { orderSections } from "./drag.js";

export const SORTS = [
  { id: "updated", label: t("آخرین به‌روزرسانی") },
  { id: "created", label: t("تاریخ ساخت") },
  { id: "unread", label: t("خوانده‌نشده اول") },
  { id: "running", label: t("در حال اجرا اول") },
  { id: "title", label: t("نام (الفبا)") },
];

export const GROUPS = [
  { id: "none", label: t("بدون گروه‌بندی") },
  { id: "state", label: t("بر اساس وضعیت") },
  { id: "read", label: t("خوانده‌شده / نشده") },
  { id: "date", label: t("بر اساس تاریخ") },
  { id: "agent", label: t("بر اساس ایجنت") },
  { id: "repo", label: t("بر اساس مخزن") },
  { id: "model", label: t("بر اساس مدل") },
  { id: "origin", label: t("بر اساس منشأ (خودم / جاب)") },
];

export const FILTERS = [
  { id: "all", label: t("همه") },
  { id: "unread", label: t("خوانده‌نشده") },
  { id: "ask", label: t("منتظر پاسخ شما") },
  { id: "running", label: t("در حال کار") },
  { id: "background", label: t("منتظر کار پس‌زمینه") },
  { id: "error", label: t("دارای خطا") },
  { id: "pinned", label: t("سنجاق‌شده") },
  { id: "mine", label: t("گفتگوهای خودم") },
  { id: "jobs", label: t("گفتگوهای جاب") },
];

const STATES = {
  ask: t("منتظر پاسخ شما"),
  running: t("در حال کار"),
  background: t("منتظر کار پس‌زمینه"),
  error: t("خطا"),
  unread: t("خوانده‌نشده"),
  read: t("خوانده‌شده"),
};
const STATE_ORDER = ["ask", "running", "background", "error", "unread", "read"];

/**
 * The one state a chat is in, most pressing first: it asks the owner something; it is working;
 * its turn ended but a background task of its own is still running (more will come); its last run
 * failed; it holds something unseen; nothing is pending. `unread` rides along, because a chat can
 * both hold a new message and still wait for its task.
 */
export function chatState(chat, isUnread) {
  const unread = Boolean(isUnread(chat));
  const background = Number(chat?.backgroundTasks) || 0;
  let id = "read";
  if (chat?.waitingForOwner) id = "ask";
  else if (chat?.runStatus === "running") id = "running";
  else if (background > 0) id = "background";
  else if (chat?.runStatus === "error") id = "error";
  else if (unread) id = "unread";
  const label =
    id === "background"
      ? t("{v}منتظر {v2} است", { v: unread ? t("پیام تازه دارد و ") : "", v2: background > 1 ? t("{toLocaleString} کار پس‌زمینه", { toLocaleString: background.toLocaleString("fa-IR") }) : t("یک کار پس‌زمینه") })
      : STATES[id];
  return { id, label, unread, background };
}

// A chat another agent (a colleague's Karsara) opened here: caller `peer:<user>` (server peer-auth.mjs).
export const isPeerChat = (chat) => typeof chat?.caller === "string" && chat.caller.startsWith("peer:");

// Peer chats leave the main list and sit, collapsed, under the sidebar's «ایجنت‌های همکاران» row (owner, 2026-10-10).
export function splitPeerChats(list) {
  const own = [];
  const peers = [];
  for (const chat of list) (isPeerChat(chat) ? peers : own).push(chat);
  return { own, peers };
}

// `keepId`: the chat on screen stays listed whatever the filter — opening an unread chat marks it
// read, and it must not vanish from under the pointer.
export function filterChats(list, filter, isUnread, { keepId = null } = {}) {
  if (!filter || filter === "all") return [...list];
  const tests = {
    pinned: (c) => Boolean(c.pinned),
    unread: (c) => Boolean(isUnread(c)),
    jobs: (c) => Boolean(c.jobId), // started by a job, one chat per run
    mine: (c) => !c.jobId && !isPeerChat(c),
  };
  const test = tests[filter] || ((c) => chatState(c, isUnread).id === filter);
  return list.filter((c) => c.id === keepId || test(c));
}

const newest = (a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));

// `reverse` flips whichever order the sort names (oldest first, Z→A, read first).
export function sortChats(list, sort, isUnread, { reverse = false } = {}) {
  const first = (test) => (a, b) => Number(test(b)) - Number(test(a)) || newest(a, b);
  const items = [...list];
  if (sort === "title") items.sort((a, b) => String(a.title).localeCompare(String(b.title), "fa"));
  else if (sort === "created") items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  else if (sort === "unread") items.sort(first((c) => isUnread(c)));
  else if (sort === "running") items.sort(first((c) => c.runStatus === "running"));
  else items.sort(newest);
  return reverse ? items.reverse() : items;
}

// Calendar days between two instants in the owner's timezone.
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
 * Sections of the list: [{ key, title, chats }] in a fixed order, empty ones left out. The chats keep
 * the order they came in (already sorted). `agentLabel` names an agent id.
 */
export function groupChats(list, groupBy, { isUnread, now = new Date(), timeZone = "Asia/Tehran", agentLabel = (id) => id } = {}) {
  if (groupBy === "state") {
    return bucket(list, (c) => chatState(c, isUnread).id, STATE_ORDER).map((s) => ({ key: `state:${s.key}`, title: STATES[s.key], chats: s.chats }));
  }
  if (groupBy === "read") {
    return bucket(list, (c) => (isUnread(c) ? "unread" : "read"), ["unread", "read"]).map((s) => ({ key: `read:${s.key}`, title: STATES[s.key], chats: s.chats }));
  }
  if (groupBy === "date") {
    const names = { today: t("امروز"), yesterday: t("دیروز"), week: t("۷ روز اخیر"), older: t("قدیمی‌تر") };
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
  if (groupBy === "origin") {
    const names = new Map();
    for (const c of list) if (c.jobId) names.set(`job:${c.jobId}`, c.jobName || t("بی‌نام"));
    return bucket(list, (c) => (c.jobId ? `job:${c.jobId}` : "owner"))
      .sort((a, b) => Number(a.key !== "owner") - Number(b.key !== "owner"))
      .map((s) => ({ key: `origin:${s.key}`, title: s.key === "owner" ? t("گفتگوهای خودم") : t("جاب: {get}", { get: names.get(s.key) }), chats: s.chats }));
  }
  return null; // "none": the rest stays one list
}

/**
 * The whole list as sections, top to bottom: running chats (only while nothing else groups the rest),
 * the pinned ones, each of the owner's groups (empty ones too: a new group must show up to be used),
 * then everything else, grouped by `groupBy`. A chat sits in exactly one section — pinned wins over
 * its group — so pinning and the owner's groups never hide each other. Chats keep the order they
 * came in (already sorted).
 */
export function layoutChats(list, groupBy, { isUnread, groups = [], agentLabel, now, timeZone, looseAt = null, sectionOrder = null } = {}) {
  const owned = groups || [];
  const known = new Set(owned.map((g) => g.id));
  const sections = [];
  // Running chats lead the list wherever they would sit (even in a folded group): work in the
  // background must be impossible to miss.
  const lead = !groupBy || groupBy === "none" ? list.filter((c) => c.runStatus === "running") : [];
  const others = lead.length ? list.filter((c) => c.runStatus !== "running") : list;
  if (lead.length) sections.push({ key: "running", title: lead.length > 1 ? t("در حال اجرا ({toLocaleString})", { toLocaleString: lead.length.toLocaleString("fa-IR") }) : t("در حال اجرا"), chats: lead, counted: true });
  const pinned = others.filter((c) => c.pinned);
  const unpinned = others.filter((c) => !c.pinned);
  const rest = unpinned.filter((c) => !known.has(c.groupId));
  sections.push({ key: "pinned", title: t("سنجاق‌شده"), chats: pinned, pinned: true });
  const named = owned.map((g) => ({ key: `group:${g.id}`, title: g.name, groupId: g.id, chats: unpinned.filter((c) => c.groupId === g.id) }));
  // The chats in no group («اخیر», or its groupings) are one block the owner drags among his groups (drag.js).
  const groupedRaw = groupBy && groupBy !== "none" ? groupChats(rest, groupBy, { isUnread, agentLabel, now, timeZone }) : null;
  const grouped = groupedRaw ? orderSections(groupedRaw, sectionOrder) : null;
  const loose = (grouped || [{ key: "recent", title: pinned.length || owned.length ? t("اخیر") : null, chats: rest }]).map((s, i) => ({ ...s, loose: true, looseHead: i === 0 }));
  const at = Number.isInteger(looseAt) && looseAt >= 0 ? Math.min(looseAt, named.length) : named.length;
  sections.push(...named.slice(0, at), ...loose, ...named.slice(at));
  return sections;
}
