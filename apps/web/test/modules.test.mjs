import test from "node:test";
import assert from "node:assert/strict";
import { optionOf, rowMatches, shelves, actionOutcome, cellText, filterQuery, initialFilters, moduleNavItems, modulePath, parseModuleRoute } from "../src/modules.js";

test("the route of a module page", () => {
  assert.deepEqual(parseModuleRoute("#/m/mr-explainer/mrs"), { module: "mr-explainer", page: "mrs" });
  assert.equal(parseModuleRoute("#/m/mr-explainer"), null);
  assert.equal(parseModuleRoute("#/m/Bad/x"), null);
  assert.equal(parseModuleRoute("#/jobs"), null);
  assert.equal(modulePath("a-b", "c"), "/m/a-b/c");
});

test("the sidebar gets one entry per page of every enabled module", () => {
  const items = moduleNavItems([{ id: "tix", pages: [{ id: "all", title: "درخواست‌ها", icon: "ticket" }, { id: "mine", title: "من", icon: "" }] }, { id: "mr", pages: [{ id: "l", title: "MR", icon: "git-merge" }] }]);
  assert.deepEqual(items.map((i) => i.path), ["/m/tix/all", "/m/tix/mine", "/m/mr/l"]);
  assert.equal(items[0].id, "m:tix:all");
  assert.deepEqual(moduleNavItems(null), []);
});

test("filters: defaults, and a query without empty values", () => {
  assert.deepEqual(initialFilters({ filters: [{ key: "project", default: "" }, { key: "state", default: "opened" }] }), { project: "", state: "opened" });
  assert.equal(filterQuery({ project: " a/b ", state: "opened", x: "" }), "project=a%2Fb&state=opened");
  assert.equal(filterQuery({}), "");
});

test("a cell: a dash for nothing, local time for time", () => {
  assert.equal(cellText({ key: "a" }, {}), "—");
  assert.equal(cellText({ key: "a" }, { a: "x" }), "x");
  assert.equal(cellText({ key: "a", type: "time" }, { a: "not a date" }), "not a date");
  assert.notEqual(cellText({ key: "a", type: "time" }, { a: "2026-10-19T10:00:00Z" }), "2026-10-19T10:00:00Z");
});

test("an action's answer", () => {
  assert.deepEqual(actionOutcome({ openChat: { agent: "a", title: "t", text: "x" } }).kind, "chat");
  assert.deepEqual(actionOutcome({ message: "done" }), { kind: "message", message: "done" });
  assert.deepEqual(actionOutcome({}), { kind: "none" });
});

test("the core sections are modules: off when the module list lacks them, on while it has not arrived", async () => {
  const { pageOff, sectionOn, SECTION_PAGES, moduleNavItems: items } = await import("../src/modules.js");
  assert.equal(sectionOn(null, "telegram"), true, "before the list arrives nothing is hidden");
  assert.equal(sectionOn([{ id: "peers" }], "telegram"), false);
  assert.equal(sectionOn([{ id: "peers" }], "peers"), true);
  assert.equal(pageOff([{ id: "peers" }], "jobs"), true);
  assert.equal(pageOff([{ id: "peers" }], "settings"), false, "settings is not a module section");
  assert.equal(pageOff(null, "jobs"), false);
  assert.deepEqual(SECTION_PAGES, ["telegram", "jobs", "incidents", "peers", "workbench"]);
  assert.equal(pageOff([{ id: "telegram" }], "inbox"), false, "the inbox page is never hidden by a module switch");
  assert.equal(pageOff([{ id: "telegram-inbox" }], "telegram"), true, "only the Telegram section follows its own module");
  assert.deepEqual(items([{ id: "telegram", pages: [{ id: "main", title: "تلگرام", icon: "message-circle", kind: "builtin" }] }]), [], "a builtin page is drawn by the core menu, not added twice");
});

test("the menu preset: «ایجنت‌های همکاران» shows by default, and a module page can be hidden", async () => {
  const ui = await import("../src/ui-prefs.js");
  assert.ok(!ui.presetOf("griffin").flags.navHidden.includes("peers"));
  assert.ok(!ui.presetOf("karsara").flags.navHidden.includes("peers"));
  assert.deepEqual(ui.cleanPrefs({ flags: { navHidden: ["m:mr-explainer:mrs", "m:BAD:x", "jobs"] } }).flags.navHidden, ["m:mr-explainer:mrs", "jobs"]);
});

test("planLines: what the owner reads before confirming a switch", async () => {
  const { planLines, moduleFacts } = await import("../src/modules.js");
  const lines = planLines({
    steps: [
      { kind: "disable", id: "tix", title: "میز کمک", why: "خودتان خاموش کردید", chats: 3, folder: "ماژول میز کمک" },
      { kind: "enable", id: "tg", title: "تلگرام", why: "", restores: 2 },
      { kind: "fix", id: "tg", title: "تلگرام", why: "MODE باید assistant باشد" },
    ],
    config: { MODE: "assistant" },
    notes: ["حساب زنده"],
  });
  assert.deepEqual(lines.map((l) => l.tone), ["off", "note", "on", "note", "fix", "note", "note"]);
  assert.match(lines[1].text, /3 گفتگو.*«ماژول میز کمک»/);
  assert.match(lines[5].text, /MODE.*assistant/);
  assert.deepEqual(planLines(null), []);
  assert.deepEqual(moduleFacts({ builtin: false, adds: { agents: ["ایجنت"], tools: 2, pages: ["MRها"] }, chats: 4, preset: true }), ["ایجنت: ایجنت", "2 ابزار", "صفحه: MRها", "4 گفتگو", "پیش‌فرض این محصول"]);
});

test("shelves: rows on their shelf, counts, search and a single shelf", () => {
  const page = { groupBy: { field: "category", groups: [{ key: "ready", label: "آماده", tone: "ok", hint: "" }, { key: "draft", label: "پیش‌نویس", tone: "muted", hint: "" }] } };
  const rows = [
    { id: "1", title: "feat: login", author: "rezaei", category: "ready" },
    { id: "2", title: "fix: logout", author: "karimi", category: "draft" },
    { id: "3", title: "docs", author: "rezaei", category: "weird" },
  ];
  const all = shelves(page, rows);
  assert.deepEqual(all.shelves.map((s) => s.key), ["ready", "draft", "_other"]);
  assert.deepEqual(all.counts, { ready: 1, draft: 1, _other: 1 });
  assert.equal(all.total, 3);
  const searched = shelves(page, rows, { search: "rezaei" });
  assert.deepEqual(searched.counts, { ready: 1, draft: 0, _other: 1 });
  assert.deepEqual(shelves(page, rows, { only: "draft" }).shelves.map((s) => s.key), ["draft"]);
  assert.deepEqual(shelves({}, rows).shelves[0].rows.length, 3); // no groupBy: one plain shelf
  assert.equal(rowMatches(rows[0], "LOGIN rezaei"), true);
  assert.equal(rowMatches(rows[0], "login karimi"), false);
  assert.deepEqual(optionOf("a"), { value: "a", label: "a" });
  assert.deepEqual(optionOf({ value: "opened", label: "باز" }), { value: "opened", label: "باز" });
});

test("the marketplace: shelves by category, one choice for modules of one slot, on/off filter", async () => {
  const { marketView, titleParts, moduleTags } = await import("../src/modules.js");
  const mods = [
    { id: "telegram", title: "تلگرام (دستیار به جای شما)", description: "a", category: "team", provides: ["telegram-dm"], choice: "چه کسی جواب بدهد؟", enabled: true },
    { id: "telegram-inbox", title: "تلگرام (صندوق)", description: "b", category: "team", provides: ["telegram-dm"], enabled: false },
    { id: "jobs", title: "جاب", description: "c", category: "ops", provides: [], enabled: true },
    { id: "mr", title: "مرج ریکوئست‌ها", description: "d", category: "dev", provides: [], enabled: false },
    { id: "odd", title: "عجیب", description: "", category: "nope", provides: [], enabled: false, error: "x" },
  ];
  const v = marketView(mods);
  assert.deepEqual(v.shelves.map((s) => s.key), ["team", "ops", "dev", "other"]);
  const choice = v.shelves[0].entries[0];
  assert.equal(choice.kind, "choice");
  assert.equal(choice.title, "تلگرام");
  assert.equal(choice.question, "چه کسی جواب بدهد؟");
  assert.deepEqual(choice.options.map((o) => o.label), ["دستیار به جای شما", "صندوق"]);
  assert.equal(choice.enabled.id, "telegram");
  assert.deepEqual(v.counts, { all: 4, on: 2, off: 2 });
  assert.deepEqual(marketView(mods, { show: "off" }).shelves.flatMap((s) => s.entries.map((e) => e.key)), ["mr", "odd"]);
  assert.deepEqual(marketView(mods, { search: "صندوق" }).shelves.flatMap((s) => s.entries.map((e) => e.key)), ["slot:telegram-dm"]);
  assert.deepEqual(titleParts("جاب"), { group: "جاب", option: "جاب" });
  assert.deepEqual(moduleTags({ title: "مرج ریکوئست‌ها", adds: { pages: ["MRها"], agents: ["توضیح‌دهنده"], tools: 1 }, chats: 2 }), ["صفحهٔ «MRها»", "ایجنت «توضیح‌دهنده»", "۱ ابزار", "۲ گفتگو"]);
});

test("a builtin section's page tag that only repeats its name is left out", async () => {
  const { moduleTags } = await import("../src/modules.js");
  assert.deepEqual(moduleTags({ title: "جاب", adds: { pages: ["جاب"] } }), []);
  assert.deepEqual(moduleTags({ title: "تلگرام (صندوق)", adds: { pages: ["صندوق تلگرام"] } }), ["صفحهٔ «صندوق تلگرام»"]);
});

test("a module card's settings: its config rows in order, its own, its flags, its menu pages", async () => {
  const { moduleSettings, settingsCount, ownedFlags } = await import("../src/modules.js");
  const mod = { settings: { config: ["B", "A", "GONE"], flags: ["inboxRow"], own: [{ key: "X" }] }, nav: [{ id: "telegram", builtin: true }, { id: "inbox-x", builtin: true }, { id: "m:mr:mrs", builtin: false }] };
  const s = moduleSettings(mod, { config: [{ key: "A" }, { key: "B" }], flags: [{ key: "inboxRow" }, { key: "other" }], navIds: ["telegram"] });
  assert.deepEqual(s.config.map((r) => r.key), ["B", "A"]);
  assert.deepEqual(s.flags.map((f) => f.key), ["inboxRow"]);
  assert.deepEqual(s.nav.map((p) => p.id), ["telegram", "m:mr:mrs"]);
  assert.equal(settingsCount(s), 6);
  assert.equal(settingsCount(moduleSettings({})), 0);
  assert.deepEqual([...ownedFlags([mod, { settings: {} }, {}])], ["inboxRow"]);
});
