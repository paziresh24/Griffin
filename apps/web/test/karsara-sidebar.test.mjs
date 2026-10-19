import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { layoutChats, splitPeerChats } from "../src/karsara-chat-list.js";

// The Karsara skin's list: «سنجاق‌شده», the owner's groups, then «اخیر» — with a "custom" grouping.
test("Karsara list: pinned, the owner's groups (empty ones too), then «اخیر»", () => {
  const chats = [
    { id: "a", title: "a", pinned: true },
    { id: "b", title: "b", groupId: "g1" },
    { id: "c", title: "c" },
    { id: "p", title: "p", caller: "peer:x" },
  ];
  const { own, peers } = splitPeerChats(chats);
  assert.deepEqual(peers.map((c) => c.id), ["p"]);
  const sections = layoutChats(own, "custom", { isUnread: () => false, groups: [{ id: "g1", name: "تست" }, { id: "g2", name: "خالی" }] });
  assert.deepEqual(sections.map((s) => [s.title, s.chats.map((c) => c.id)]), [
    ["سنجاق‌شده", ["a"]],
    ["تست", ["b"]],
    ["خالی", []],
    ["اخیر", ["c"]],
  ]);
});

test("one Sidebar: the one list is a flag inside it, not a second sidebar", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /KarsaraSidebar/);
  const side = readFileSync(new URL("../src/components/Sidebar.jsx", import.meta.url), "utf8");
  assert.match(side, /\{oneList \? \(\s*<OneList /);
  const one = readFileSync(new URL("../src/components/SidebarOneList.jsx", import.meta.url), "utf8");
  assert.match(one, /<SidebarNotes [^>]*\/>\s*<SidebarSuggestions [^>]*\/>/, "notes, then suggestions, under the peers' fold");
});
