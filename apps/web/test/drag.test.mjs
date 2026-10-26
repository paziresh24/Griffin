// Drag and drop in the sidebar (drag.js): moving in a list, «بدون گروه» among the groups, what a
// dropped chat changes, and the top sections' order.
import test from "node:test";
import assert from "node:assert/strict";
import { DRAG_CHAT, DRAG_GROUP, LOOSE, chatDropPatch, dragKind, groupOrder, moveItem, orderNav } from "../src/drag.js";
import { groupSections } from "../src/chat-groups.js";
import { layoutChats } from "../src/karsara-chat-list.js";

test("moveItem: before or after the target; a missing id or itself changes nothing", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(moveItem(["a", "b", "c"], "a", "c", true), ["b", "c", "a"]);
  assert.deepEqual(moveItem(["a", "b", "c"], "a", "b", true), ["b", "a", "c"]);
  const same = ["a", "b"];
  assert.equal(moveItem(same, "a", "a"), same);
  assert.equal(moveItem(same, "x", "a"), same);
});

test("groupOrder puts «بدون گروه» at its place, last when never moved", () => {
  const groups = [{ id: "g1" }, { id: "g2" }];
  assert.deepEqual(groupOrder(groups, null), ["g1", "g2", LOOSE]);
  assert.deepEqual(groupOrder(groups, 0), [LOOSE, "g1", "g2"]);
  assert.deepEqual(groupOrder(groups, 9), ["g1", "g2", LOOSE]);
});

test("a dropped chat: into a group, out of all of them, pinned; its own place changes nothing", () => {
  assert.deepEqual(chatDropPatch({ groupId: null }, { kind: "group", id: "g" }), { groupId: "g" });
  assert.equal(chatDropPatch({ groupId: "g" }, { kind: "group", id: "g" }), null);
  assert.deepEqual(chatDropPatch({ groupId: "g", pinned: true }, { kind: "group", id: "g" }), { groupId: "g", pinned: false });
  assert.deepEqual(chatDropPatch({ groupId: "g" }, { kind: "loose" }), { groupId: null });
  assert.deepEqual(chatDropPatch({ groupId: null, pinned: true }, { kind: "loose" }), { pinned: false });
  assert.equal(chatDropPatch({ groupId: null }, { kind: "loose" }), null);
  assert.deepEqual(chatDropPatch({ pinned: false }, { kind: "pinned" }), { pinned: true });
  assert.equal(chatDropPatch({ pinned: true }, { kind: "pinned" }), null);
  assert.equal(chatDropPatch({}, null), null);
  assert.equal(chatDropPatch({}, { kind: "running" }), null);
});

test("dragKind reads only our own drags", () => {
  assert.equal(dragKind(["text/plain", DRAG_CHAT]), DRAG_CHAT);
  assert.equal(dragKind([DRAG_GROUP]), DRAG_GROUP);
  assert.equal(dragKind(["Files"]), null);
  assert.equal(dragKind(undefined), null);
});

test("orderNav: the dragged order first, sections never ordered keep their place after", () => {
  const items = ["telegram", "jobs", "incidents", "peers"].map((id) => ({ id }));
  assert.deepEqual(orderNav(items, ["peers", "telegram"]).map((i) => i.id), ["peers", "telegram", "jobs", "incidents"]);
  assert.deepEqual(orderNav(items, undefined).map((i) => i.id), ["telegram", "jobs", "incidents", "peers"]);
});

test("«بدون گروه» sits where it was dragged, in both lists", () => {
  const groups = [{ id: "g1", name: "یک" }, { id: "g2", name: "دو" }];
  const chats = [{ id: "a", groupId: "g1" }, { id: "b", groupId: "g2" }, { id: "c", groupId: null }];
  assert.deepEqual(groupSections(chats, groups).map((s) => s.key), ["group:g1", "group:g2", "group:none"]);
  assert.deepEqual(groupSections(chats, groups, { looseAt: 0 }).map((s) => s.key), ["group:none", "group:g1", "group:g2"]);
  assert.deepEqual(groupSections(chats, groups, { looseAt: 1 }).map((s) => s.key), ["group:g1", "group:none", "group:g2"]);
  const one = (looseAt) => layoutChats(chats, "custom", { isUnread: () => false, groups, looseAt }).map((s) => s.key);
  assert.deepEqual(one(null), ["pinned", "group:g1", "group:g2", "recent"]);
  assert.deepEqual(one(0), ["pinned", "recent", "group:g1", "group:g2"]);
  const recent = layoutChats(chats, "custom", { isUnread: () => false, groups, looseAt: 0 }).find((s) => s.key === "recent");
  assert.equal(recent.loose, true);
  assert.equal(recent.looseHead, true);
});

test("«جای بخش‌ها»: every choice round-trips, the presets stay the rows they were", async () => {
  const { NAV_STYLES, cleanPrefs, navStyleChoice, navStyleFlags, presetOf } = await import("../src/ui-prefs.js");
  for (const look of ["griffin", "karsara"]) {
    const flags = presetOf(look).flags;
    assert.equal(flags.navStyle, undefined, `${look}: no new default`);
    assert.equal(flags.railPinned, undefined);
    assert.equal(navStyleChoice(flags), "list");
  }
  for (const { id } of NAV_STYLES) assert.equal(navStyleChoice({ ...navStyleFlags(id) }), id);
  assert.deepEqual(cleanPrefs({ flags: { navStyle: "rail", railPinned: false } }).flags, { navStyle: "rail", railPinned: false });
  assert.deepEqual(cleanPrefs({ flags: { navStyle: "<x>", railPinned: "yes" } }).flags, {});
});

test("by repository: the owner's groups show beside the repo sections, which keep the order he dragged", async () => {
  const { groupChats } = await import("../src/chat-list.js");
  const groups = [{ id: "g", name: "خالی" }];
  const chats = [
    { id: "a", repo: "x", pinned: true },
    { id: "b", repo: "x" },
    { id: "c", repo: "y" },
    { id: "d", repo: "y", groupId: "g" },
  ];
  const keys = (opts) => groupChats(chats, "repo", { groups, scope: "manual", ...opts }).map((s) => s.key);
  assert.deepEqual(keys({}), ["pinned", "group:g", "repo:x", "repo:y"]);
  assert.deepEqual(keys({ sectionOrder: ["repo:y"] }), ["pinned", "group:g", "repo:y", "repo:x"]);
  assert.deepEqual(keys({ looseAt: 0 }), ["pinned", "repo:x", "repo:y", "group:g"]);
  // Another tab (Telegram, jobs) has no groups: as before.
  assert.deepEqual(groupChats(chats, "repo", { groups, scope: "telegram" }).map((s) => s.key), ["pinned", "repo:x", "repo:y"]);
});

test("sectionDrag: groups move among groups and the ungrouped block; repo sections among themselves", async () => {
  const { sectionDrag, LOOSE } = await import("../src/drag.js");
  const group = sectionDrag({ key: "group:g", groupId: "g" }, { groupBy: "repo", groupsOrder: ["g", LOOSE], hasGroups: true });
  assert.deepEqual(group.handle, { id: "g", scope: "groups" });
  const repo = sectionDrag({ key: "repo:x", loose: true }, { groupBy: "repo", groupsOrder: ["g", LOOSE], hasGroups: true, sectionKeys: ["repo:x"] });
  assert.deepEqual(repo.handle, { id: "repo:x", scope: "sections:repo" });
  assert.deepEqual(repo.slots.map((s) => [s.scope, s.id]), [["sections:repo", "repo:x"], ["groups", LOOSE]]);
  const none = sectionDrag({ key: "group:none", loose: true }, { groupBy: "custom", groupsOrder: ["g", LOOSE], hasGroups: true });
  assert.deepEqual(none.handle, { id: LOOSE, scope: "groups" });
  const date = sectionDrag({ key: "date:today", loose: true }, { groupBy: "date", hasGroups: false });
  assert.equal(date.handle, null, "today/yesterday keep their own order");
  assert.deepEqual(sectionDrag({ key: "pinned" }, { groupBy: "repo" }), { handle: null, slots: [] });
});
