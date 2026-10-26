import { t } from "./i18n.js";

// The owner's own chat groups in the sidebar: one section per group in the owner's
// order, and the chats in none of them where he put them (last by default). An empty group stays (a new one must show up to be used),
// except while a search, a filter or the archive narrows the list.
export function groupSections(list, groups = [], { narrowed = false, looseAt = null } = {}) {
  const known = new Set(groups.map((g) => g.id));
  const sections = groups
    .map((g) => ({ key: `group:${g.id}`, title: g.name, groupId: g.id, chats: list.filter((c) => c.groupId === g.id), collapsible: true }))
    .filter((s) => s.chats.length || !narrowed);
  const loose = list.filter((c) => !known.has(c.groupId));
  if (!loose.length) return sections;
  // «بدون گروه» where the owner dragged it among the groups (drag.js; null = last).
  const at = Number.isInteger(looseAt) && looseAt >= 0 ? sections.filter((s) => groups.findIndex((g) => g.id === s.groupId) < looseAt).length : sections.length;
  return [...sections.slice(0, at), { key: "group:none", title: t("بدون گروه"), chats: loose, loose: true }, ...sections.slice(at)];
}
