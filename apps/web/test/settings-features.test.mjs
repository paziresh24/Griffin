// The map of Settings: nothing is lost in the merge, old links still land, and a new setting cannot
// arrive as a bare line — it comes with a title, a «؟» and a place (owner 2026-11-01).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_SCHEMA } from "../../server/src/config.mjs";
import { FLAGS, navStyleFlags } from "../src/ui-prefs.js";
import { FEATURES, FEATURE_GROUPS, blockedBy, featureDepth, featureOf, featureOn, isFresh, isSwitch } from "../src/settings-features.js";
import {
  FLAGS_ELSEWHERE, MERGED_FLAGS, SETTINGS_PAGES, ZONES,
  homeChoice, homeFlags, linkedSection, pageOf, pagesFor, searchSettings, sectionId, settingsIndex, updateChoice, updateFlags, workChoice, workFlags, zoneOfFlag,
} from "../src/settings-map.js";

test("every setting of the server has a title, a «؟» and a group", () => {
  const groups = new Set(FEATURE_GROUPS.map((g) => g.id));
  assert.deepEqual(CONFIG_SCHEMA.map((c) => c.key).filter((key) => !featureOf(key)), [], "add a row to settings-features.js");
  assert.deepEqual(FEATURES.map((f) => f.key).filter((key) => !CONFIG_SCHEMA.some((c) => c.key === key)), [], "a row for a setting the server no longer has");
  for (const f of FEATURES) {
    assert.ok(f.title && f.help && groups.has(f.group), f.key);
    if (f.requires) assert.ok(featureOf(f.requires), `${f.key} requires an unknown key`);
    if (f.since) assert.ok(!Number.isNaN(Date.parse(f.since)), f.key);
  }
});

test("a setting with on/off on the server is a switch here, with its real default", () => {
  for (const c of CONFIG_SCHEMA) {
    if (String(c.options) !== "on,off" && String(c.options) !== "off,on") continue;
    assert.ok(isSwitch(featureOf(c.key)), c.key);
    const said = /پیش‌فرض (روشن|خاموش)/.exec(c.label)?.[1];
    if (said) assert.equal(featureOf(c.key).def, said === "روشن" ? "on" : "off", c.key);
  }
  for (const f of FEATURES) if (f.choices) for (const id of Object.keys(f.choices)) assert.ok(CONFIG_SCHEMA.find((c) => c.key === f.key).options.includes(id), `${f.key}: ${id}`);
});

test("eight pages, and every flag of «ظاهر» still has a place", () => {
  assert.equal(SETTINGS_PAGES.length, 8);
  const drawn = [...ZONES.flatMap((z) => z.flags), ...Object.keys(MERGED_FLAGS), ...Object.values(FLAGS_ELSEWHERE).flat()];
  assert.deepEqual(FLAGS.map((f) => f.key).filter((key) => !drawn.includes(key)), []);
  assert.deepEqual(drawn.filter((key, i) => drawn.indexOf(key) !== i), [], "one place each");
  assert.equal(zoneOfFlag("workInline"), "chat");
  assert.equal(zoneOfFlag("nextGhost"), null);
});

test("links from before the merge land on the right tab", () => {
  const old = { profile: "account", notifications: "chat", composer: "chat", doctor: "health", status: "health", modules: "market", mybrowser: "browser", serverbrowser: "browser", providers: "providers", market: "market", tokens: "tokens", chat: "chat", config: "config", proxy: "proxy", mcp: "mcp", phone: "phone" };
  for (const [from, to] of Object.entries(old)) assert.equal(sectionId(from), to, from);
  assert.equal(sectionId("nothing"), null);
  assert.equal(linkedSection("#/settings/providers"), "providers");
  assert.equal(linkedSection("#/settings/assistant"), "agents", "a page's id opens its first tab");
  assert.equal(linkedSection("#/settings"), null);
  assert.equal(pageOf("providers").id, "assistant");
});

test("a link to a section says it in the address; nothing leaves it in storage for Settings to find", () => {
  const root = new URL("../../..", import.meta.url).pathname;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name === "dist" ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : /\.jsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const left = [...walk(path.join(root, "apps/web/src")), ...walk(path.join(root, "modules"))].filter((file) => !file.endsWith("components/Settings.jsx") && /(?:writeSetting|setItem)\("griffin\.settings\.section"/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(left, []);
});

test("«حسابداری مصرف» is only where the server has it", () => {
  const sections = (hub) => pagesFor(hub).flatMap((p) => p.sections.map((s) => s.id));
  assert.ok(sections(true).includes("accounting"));
  assert.ok(!sections(false).includes("accounting"));
});

test("a merged choice keeps what each old combination did", () => {
  assert.equal(updateChoice({}), "list");
  assert.equal(updateChoice({ updateInSettings: true }), "settings");
  assert.equal(updateChoice({ updateTopButton: true, updateInSettings: true }), "top", "both on was the top button (UpdateNotice.jsx)");
  assert.equal(workChoice({ workInline: true, workLogOpen: true }), "inline", "a narrated log ignores «open while running» (Work.jsx)");
  assert.equal(homeChoice({ homeBoard: false, onePlace: true }), "simple", "no board, nothing to keep in one place");
  for (const [choice, flags, ids] of [[updateChoice, updateFlags, ["list", "top", "settings"]], [workChoice, workFlags, ["fold", "open", "inline"]], [homeChoice, homeFlags, ["simple", "board", "one"]]]) {
    for (const id of ids) assert.equal(choice(flags(id)), id);
  }
  assert.deepEqual(navStyleFlags("icons"), { navStyle: "list", navIcons: true });
});

test("the search finds a setting by its words and says where it is", () => {
  const entries = settingsIndex([{ key: "NETWORK", modules: ["peers"] }]);
  assert.equal(searchSettings("چت کناری", entries)[0].title, "چت کناری");
  assert.ok(searchSettings("پيشنهاد", entries).some((e) => e.focus === "PROMPT_SUGGESTIONS"), "Arabic ی finds Persian ی");
  assert.equal(searchSettings("شبکهٔ ایجنت‌ها", entries)[0].section, "market", "a module's setting opens its card");
  assert.equal(searchSettings("زمان به‌صورت", entries)[0].section, "appearance");
  assert.deepEqual(searchSettings("  ", entries), []);
});

test("what depends on another hangs under it, and waits for it", () => {
  const steer = featureOf("CLAUDE_STEER");
  assert.equal(featureDepth(steer), 2);
  const rows = (value) => [{ key: "CLAUDE_CODE", value }, { key: "CLAUDE_BACKGROUND_TASKS", value: "" }];
  assert.equal(blockedBy(steer, rows("off"))?.key, "CLAUDE_CODE");
  assert.equal(blockedBy(steer, rows("")), null, "unset follows the default");
});

test("«تازه» wears off; an unset switch follows its default", () => {
  const f = { since: "2026-10-01" };
  assert.ok(isFresh(f, Date.parse("2026-10-20")));
  assert.ok(!isFresh(f, Date.parse("2027-01-01")));
  assert.ok(!isFresh({}));
  assert.ok(featureOn({ def: "on" }, { value: "", effective: "" }));
  assert.ok(!featureOn({ def: "on" }, { value: "off" }));
  assert.ok(featureOn({ def: "off" }, { value: "", effective: "on" }), "the env counts");
});
