// Drag and drop in the sidebar, like Claude Desktop (owner 2026-10-24: «چت‌ها، آیکن‌های بالا و گروه‌ها به
// راحتی قابل درگ اند دراپ باشند»): a group heading (and «بدون گروه») moves among the groups, a chat moves
// into a group, out of all of them or into «سنجاق‌شده», and the top sections take the order they are
// dropped in. Pure functions here (the node tests import them); the components only wire the events.

// What is being dragged travels as its own type, so a drop zone knows at dragover what it would get
// (the payload itself is only readable on drop).
export const DRAG_CHAT = "application/x-griffin-chat";
export const DRAG_GROUP = "application/x-griffin-group";
export const DRAG_NAV = "application/x-griffin-nav";
export const LOOSE = "none"; // «بدون گروه» in the server's order (PUT /api/groups/order)

/** The kind of a drag (DRAG_CHAT, …) from a dataTransfer's types, or null for a drag from elsewhere. */
export function dragKind(types) {
  const list = Array.from(types || []);
  return [DRAG_CHAT, DRAG_GROUP, DRAG_NAV].find((t) => list.includes(t)) || null;
}

/** `id` moved to just before (or after) `target`; the list unchanged when either is not in it. */
export function moveItem(list, id, target, after = false) {
  if (id === target || !list.includes(id) || !list.includes(target)) return list;
  const rest = list.filter((x) => x !== id);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Where «بدون گروه» sits among the groups: looseAt (0 = first) or after them all. */
export const looseIndex = (groups, looseAt) => (Number.isInteger(looseAt) && looseAt >= 0 ? Math.min(looseAt, groups.length) : groups.length);

/** The sections' order as the server keeps it: every group id, and LOOSE at its place. */
export function groupOrder(groups, looseAt) {
  const ids = (groups || []).map((g) => g.id);
  const at = looseIndex(ids, looseAt);
  return [...ids.slice(0, at), LOOSE, ...ids.slice(at)];
}

/** Which half of a row the pointer is in: true when it is the lower half (drop after). */
export const dropAfter = (event) => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY > box.top + box.height / 2;
};

/**
 * The change a chat dropped on a section makes: into a group, out of every group («بدون گروه» or the
 * plain recent list), or pinned. null when nothing would change (its own section, or a drop zone that
 * takes no chats, like «در حال اجرا»).
 */
export function chatDropPatch(chat, target) {
  if (!chat || !target) return null;
  if (target.kind === "pinned") return chat.pinned ? null : { pinned: true };
  if (target.kind === "group") return chat.groupId === target.id && !chat.pinned ? null : { groupId: target.id, ...(chat.pinned ? { pinned: false } : {}) };
  if (target.kind === "loose") return !chat.groupId && !chat.pinned ? null : { ...(chat.groupId ? { groupId: null } : {}), ...(chat.pinned ? { pinned: false } : {}) };
  return null;
}

/** The sidebar's sections in the order the owner dragged them into; ones never ordered keep their place after. */
export function orderNav(items, order = []) {
  const rank = new Map((order || []).map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (rank.get(a.item.id) ?? order.length + a.i) - (rank.get(b.item.id) ?? order.length + b.i))
    .map(({ item }) => item);
}

/** Sections (by repository, agent, …) in the order the owner dragged them into; new ones keep their place after. */
export function orderSections(sections, order) {
  if (!order?.length) return sections;
  return orderNav(sections.map((section) => ({ id: section.key, section })), order).map(({ section }) => section);
}

// The groupings whose sections the owner may put in his own order (a date or a state has its own).
const ORDERABLE = new Set(["agent", "repo", "model", "owner", "origin"]);

/**
 * How a section of the list takes part in drag and drop: `handle` (what dragging its heading carries,
 * { id, scope }, or null) and `slots` (the headings a drop on it takes, SidebarDrag.jsx useSectionDrop).
 * The owner's groups move among themselves and the block of ungrouped chats («بدون گروه»/«اخیر», LOOSE);
 * the sections of a grouping (by repository, …) move among themselves (`onOrder` saves them).
 */
export function sectionDrag(section, { groupBy, groupsOrder = [], hasGroups = false, sectionKeys = [], onOrder = null } = {}) {
  if (section.groupId) return { handle: { id: section.groupId, scope: "groups" }, slots: [{ scope: "groups", id: section.groupId, order: groupsOrder }] };
  if (!section.loose) return { handle: null, slots: [] };
  const own = ORDERABLE.has(groupBy) && section.key !== "recent" && section.key !== "group:none";
  const slots = hasGroups ? [{ scope: "groups", id: LOOSE, order: groupsOrder }] : [];
  if (own) slots.unshift({ scope: `sections:${groupBy}`, id: section.key, order: sectionKeys, onOrder });
  const handle = own ? { id: section.key, scope: `sections:${groupBy}` } : hasGroups && (section.looseHead ?? true) ? { id: LOOSE, scope: "groups" } : null;
  return { handle, slots };
}
