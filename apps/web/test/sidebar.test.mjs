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
  assert.match(side, /<NavButton k=\{k\} active=\{!page && !activeId\}[^>]*label=(\{t\()?"جدید"/, "«جدید» is lit only on the new-chat screen");
  // Both lists: the search and «جدید» (nav.top) above the scrolling <nav>; the section rows (Settings →
  // «ظاهر و بخش‌ها») scroll with the list.
  for (const [file, from] of [["components/Sidebar.jsx", "function TabList("], ["components/SidebarOneList.jsx", "export function OneList("]]) {
    const body = src(file).slice(src(file).indexOf(from));
    const head = body.slice(0, body.indexOf("<nav "));
    const list = body.slice(body.indexOf("<nav "), body.indexOf("</nav>"));
    assert.match(head, /placeholder=(\{t\()?"جستجوی گفتگوها"/, file);
    assert.match(head, /\{nav\??\.top\}/, file);
    assert.match(list, /\{nav\??\.sections\}/, file);
  }
  assert.match(side, /sections: <SidebarNav /);
  const nav = src("ui-prefs.js");
  for (const label of ["تلگرام", "جاب", "حادثه‌ها", "ایجنت‌های همکاران", "میز کار"]) assert.match(nav, new RegExp(`label: t\\("${label}"\\)`));
});

test("the foot holds the profile menu, Settings and log out; agents and token usage live in Settings, no «همتا»", () => {
  const side = src("components/Sidebar.jsx");
  const foot = side.slice(side.indexOf("function UserBar"));
  const aria = (label) => new RegExp(`aria-label=(\\{t\\()?"${label}"`);
  assert.match(foot, aria("تنظیمات"));
  assert.match(foot, aria("خروج"));
  // The profile opens its own menu (edit profile, about, support, feedback), not Settings.
  assert.match(foot, aria("منوی پروفایل"));
  assert.match(foot, /PROFILE_ITEMS\.map/);
  assert.doesNotMatch(side, /UsageBadge|MenuRow/);
  const settings = src("components/Settings.jsx");
  assert.match(settings, /id: "agents"/);
  assert.match(settings, /<UsageBadge open \/>/);
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

test("no sub-agents in the list, error actions in the row menu, filters for this visit only", () => {
  const side = src("components/Sidebar.jsx");
  const app = src("App.jsx");
  for (const gone of ["زیرکار", "گفتگوی باز", "openId"]) assert.ok(!side.includes(gone), gone);
  assert.doesNotMatch(app, /openParent/);
  assert.doesNotMatch(app, /openChat=/);
  assert.match(side, /\/resolve`/);
  assert.match(side, /حل شد/);
  assert.match(side, /\/retry`/);
  assert.ok(!side.includes('useStored("griffin.sidebar.filter"'), "the filter is not kept across reloads");
  assert.ok(side.includes('section === "telegram" ? "all"'), "the Telegram tab ignores the hidden filter");
  assert.match(side, /g-filter-chip/);
});

test("the filter outlives the phone drawer and Settings: App holds it for both sidebars", () => {
  const side = src("components/Sidebar.jsx");
  const app = src("App.jsx");
  assert.doesNotMatch(side, /\[filter, setFilter\] = useState/, "no filter state inside the sidebar (the drawer unmounts it)");
  assert.match(side, /export function Sidebar\(\{[^}]*filter = "all", onFilter/);
  assert.match(app, /const \[sidebarFilter, setSidebarFilter\] = useState\("all"\)/, "per visit: a reload clears it");
  const sidebars = app.split("<Sidebar").slice(1).map((block) => block.slice(0, block.indexOf("/>")));
  assert.equal(sidebars.length, 2, "the desktop sidebar and the phone drawer");
  for (const block of sidebars) {
    assert.match(block, /filter=\{sidebarFilter\}/);
    assert.match(block, /onFilter=\{setSidebarFilter\}/);
  }
});
