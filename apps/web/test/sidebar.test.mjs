// The sidebar: the owner's own chat groups, the fixed head («جدید» and the search only), labels,
// and its place on the start side of the page (the right of the RTL page).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { groupSections } from "../src/chat-groups.js";

const src = (file) => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const chat = (id, groupId) => ({ id, title: id, groupId });
const shape = (sections) => sections.map((s) => [s.title, s.chats.map((c) => c.id)]);

test("groups: one section per group in the owner's order, empty ones too, then the ungrouped", () => {
  const groups = [{ id: "g2", name: "زیرساخت" }, { id: "g1", name: "سرچ" }, { id: "g3", name: "خالی" }];
  const list = [chat("a", "g1"), chat("b", null), chat("c", "g2"), chat("d", "g1"), chat("e", "deleted")];
  assert.deepEqual(shape(groupSections(list, groups)), [["زیرساخت", ["c"]], ["سرچ", ["a", "d"]], ["خالی", []], ["بدون گروه", ["b", "e"]]]);
  assert.ok(groupSections(list, groups).filter((s) => s.groupId).every((s) => s.collapsible), "a group folds");
});

test("groups: a search, a filter or the archive hides the empty ones; nothing to show, no sections", () => {
  const groups = [{ id: "g1", name: "سرچ" }, { id: "g3", name: "خالی" }];
  assert.deepEqual(shape(groupSections([chat("a", "g1")], groups, { narrowed: true })), [["سرچ", ["a"]]]);
  assert.deepEqual(groupSections([], [], {}), []);
});

test("only «جدید» and the search stay fixed; the pages scroll with the list", () => {
  const side = src("components/Sidebar.jsx");
  const head = side.slice(side.indexOf("<aside"), side.indexOf("<nav "));
  const list = side.slice(side.indexOf("<nav "), side.indexOf("</nav>"));
  assert.match(head, /placeholder=\{t\("جستجوی گفتگوها"\)\}/);
  assert.match(head, /<NavButton active=\{!page && !activeId\}[^>]*label=\{t\("جدید"\)\}/, "«جدید» is lit only on the new-chat screen");
  for (const label of ["تلگرام", "جاب", "حادثه‌ها", "ایجنت‌های همکاران", "میز کار"]) {
    assert.doesNotMatch(head, new RegExp(`label=\\{t\\("${label}"\\)\\}`));
    assert.match(list, new RegExp(`label=\\{t\\("${label}"\\)\\}`));
  }
});

test("labels: token usage under the settings menu, no «همتا» shown anywhere", () => {
  const side = src("components/Sidebar.jsx");
  const menu = side.slice(side.indexOf("function UserBar"), side.indexOf("function MenuRow"));
  assert.match(menu, /<UsageBadge \/>\s*<MenuRow icon=\{Settings2\} label=\{t\("تنظیمات"\)\}/);
  assert.doesNotMatch(src("App.jsx"), /UsageBadge/, "token usage left the chat header");
  const code = (text) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  for (const file of ["components/Sidebar.jsx", "components/Peers.jsx", "tab-title.js"]) assert.doesNotMatch(code(src(file)), /همتا/, file);
});

test("a group's «+» is gone in the archive; the owner's name and photo sit at the foot", () => {
  const side = src("components/Sidebar.jsx");
  assert.match(side, /onNewChat=\{showArchived \? null : startChat\}/);
  assert.match(side, /src=\{owner\.photo\}/);
});

test("the sidebar is on the right of the RTL page and the side chat on the left", () => {
  const app = src("App.jsx");
  assert.match(fs.readFileSync(new URL("../index.html", import.meta.url), "utf8"), /<html[^>]*dir="rtl"/);
  assert.doesNotMatch(app, /flex-row-reverse/);
  assert.ok(app.indexOf("<Sidebar") < app.indexOf("<main ") && app.indexOf("<main ") < app.indexOf("<SidePanel"), "sidebar, chat, side chat in the RTL row");
  assert.match(app, /absolute inset-y-0 start-0/, "the phone drawer opens from the right (start) edge");
  const header = app.slice(app.indexOf("<header"), app.indexOf("</header>"));
  assert.ok(header.indexOf('aria-label={t("منو")}') < header.indexOf("<h1"), "the menu button is first in the RTL row, on the right");
});
