import { t } from "./i18n.js";

// The owner's own chat groups in the sidebar: one section per group in the owner's
// order, then the chats in none of them. An empty group stays (a new one must show up to be used),
// except while a search, a filter or the archive narrows the list.
export function groupSections(list, groups = [], { narrowed = false } = {}) {
  const known = new Set(groups.map((g) => g.id));
  const sections = groups
    .map((g) => ({ key: `group:${g.id}`, title: g.name, groupId: g.id, chats: list.filter((c) => c.groupId === g.id), collapsible: true }))
    .filter((s) => s.chats.length || !narrowed);
  const loose = list.filter((c) => !known.has(c.groupId));
  return loose.length ? [...sections, { key: "group:none", title: t("بدون گروه"), chats: loose }] : sections;
}
