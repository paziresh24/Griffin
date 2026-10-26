import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.document = { documentElement: { dataset: {} } };
store.set("griffin.lang", "fa"); // i18n.js sees a document: keep the Persian keys (no Vite glob in node)
const ui = await import("../src/ui-prefs.js");

test("presets: every flag has both values; the two presets differ only where the products do", () => {
  for (const f of ui.FLAGS) {
    assert.equal(typeof f.griffin, "boolean", f.key);
    assert.equal(typeof f.karsara, "boolean", f.key);
    assert.ok(f.label && f.hint && f.area, f.key);
  }
  const g = ui.presetOf("griffin");
  const k = ui.presetOf("karsara");
  assert.equal(g.look, "griffin");
  assert.equal(k.flags.oneList, true);
  assert.equal(g.flags.homeBoard, true);
  assert.deepEqual(g.flags.navHidden, ["telegram", "jobs", "incidents", "workbench"], "Griffin: «ایجنت‌های همکاران» shows by default, the rest under «بیشتر»");
  assert.deepEqual(k.flags.navHidden, ["telegram", "incidents", "workbench"], "Karsara: «جاب» and «ایجنت‌های همکاران»");
  assert.equal(ui.presetOf("nope").look, "griffin");
});

test("precedence: the user's choice > the migration snapshot > the install's preset", () => {
  // Nothing stored: the install's preset.
  assert.deepEqual(ui.resolvePrefs(null, "karsara"), ui.presetOf("karsara"));
  // A snapshot of a Griffin browser on a Karsara install stays Griffin.
  const snap = { ...ui.migrationSnapshot({ savedSkin: "griffin", installLook: "karsara" }), rev: ui.PREFS_REV };
  assert.deepEqual(ui.resolvePrefs(snap, "karsara"), ui.presetOf("griffin"));
  // The user's later switch wins over the snapshot.
  const mine = { ...snap, flags: { ...snap.flags, oneList: true } };
  assert.equal(ui.resolvePrefs(mine, "karsara").flags.oneList, true);
  // A flag added after the snapshot falls back to the install's preset.
  const old = { look: "griffin", flags: { homeBoard: true } };
  assert.equal(ui.resolvePrefs(old, "karsara").flags.workLogOpen, ui.presetOf("karsara").flags.workLogOpen);
  // Junk never reaches the page.
  assert.deepEqual(ui.cleanPrefs({ look: "x", flags: { oneList: "yes", navHidden: ["jobs", "x"], bogus: true } }), { flags: { navHidden: ["jobs"] } });
});

test("a preset change reaches copies saved before it once; a choice made after it stays", () => {
  assert.equal(ui.presetOf("griffin").flags.laterButton, true, "«بعداً» in Griffin's preset too");
  const before = { look: "griffin", flags: { ...ui.presetOf("griffin").flags, laterButton: false } };
  assert.equal(ui.resolvePrefs(before, "griffin").flags.laterButton, true, "saved before rev 1: the new preset applies");
  const after = { ...before, rev: ui.PREFS_REV };
  assert.equal(ui.resolvePrefs(after, "griffin").flags.laterButton, false, "turned off after rev 1: his choice");
});

test("rev 2: Karsara's usage ring, run footer, model names, non-Claude hint and edit links reach Griffin's saved copies once", () => {
  const keys = ["composerStats", "runFooterDetailed", "modelLabels", "nonClaudeHint", "editLinks"];
  const g = ui.presetOf("griffin").flags;
  for (const key of keys) assert.equal(g[key], true, key);
  const off = Object.fromEntries(keys.map((k) => [k, false]));
  const before = { look: "griffin", rev: 1, flags: { ...g, ...off } };
  for (const key of keys) assert.equal(ui.resolvePrefs(before, "griffin").flags[key], true, `${key}: saved at rev 1, the new preset applies`);
  const after = { ...before, rev: ui.PREFS_REV };
  for (const key of keys) assert.equal(ui.resolvePrefs(after, "griffin").flags[key], false, `${key}: turned off after rev 2 stays off`);
});

test("migration: what this browser showed — its saved skin, else the install's — and its own sidebar sections", () => {
  // Followed the install's default (no saved skin): the install's preset, exactly.
  assert.deepEqual(ui.migrationSnapshot({ savedSkin: null, installLook: "karsara" }), ui.presetOf("karsara"));
  assert.deepEqual(ui.migrationSnapshot({ savedSkin: null, installLook: "griffin" }), ui.presetOf("griffin"));
  // Chose Karsara on a Griffin install (or the reverse): the chosen one.
  assert.deepEqual(ui.migrationSnapshot({ savedSkin: "karsara", installLook: "griffin" }), ui.presetOf("karsara"));
  // Griffin's sidebar sections, as set on this browser (griffin.sidebar.nav.v2).
  const g = ui.migrationSnapshot({ installLook: "griffin", nav: { style: "icons", hidden: ["workbench", "nope"] } });
  assert.deepEqual(g.flags.navHidden, ["workbench"]);
  assert.equal(g.flags.navIcons, true);
  // The Karsara sidebar never read them: ignored there.
  assert.deepEqual(ui.migrationSnapshot({ installLook: "karsara", nav: { style: "icons", hidden: [] } }), ui.presetOf("karsara"));
});

test("first load after the update: the snapshot paints at once and is saved once; later loads take the server's copy", async () => {
  store.clear();
  store.set("griffin.skin", "karsara");
  store.set("griffin.sidebar.nav.v2", JSON.stringify({ style: "list", hidden: [] }));
  ui.setInstallLook("griffin");
  assert.equal(document.documentElement.dataset.look, "karsara", "painted before the server answers");
  const calls = [];
  let server = null;
  const request = async (url, opts = {}) => {
    calls.push([opts.method || "GET", opts.body]);
    if (opts.method === "PUT") server = opts.body;
    return { stored: server };
  };
  await ui.loadUiPrefs({ request });
  assert.deepEqual(calls.map((c) => c[0]), ["GET", "PUT"]);
  assert.equal(server.migrated, true);
  assert.equal(server.look, "karsara");
  assert.deepEqual(server.flags, ui.presetOf("karsara").flags);
  // Another device (no saved skin, a Griffin install) gets the same.
  store.clear();
  ui.setInstallLook("griffin");
  calls.length = 0;
  await ui.loadUiPrefs({ request });
  assert.deepEqual(calls.map((c) => c[0]), ["GET"], "nothing saved again");
  assert.equal(document.documentElement.dataset.look, "karsara");
  assert.equal(JSON.parse(store.get("griffin.ui")).look, "karsara", "cached for the next first paint");
});

test("repoChipsAlways: on in Griffin's preset, off in Karsara's; a copy saved before rev 4 follows the preset, a later choice stays", () => {
  assert.equal(ui.presetOf("griffin").flags.repoChipsAlways, true);
  assert.equal(ui.resolvePrefs({ rev: 3, flags: { repoChipsAlways: false } }, "griffin").flags.repoChipsAlways, true);
  assert.equal(ui.resolvePrefs({ rev: ui.PREFS_REV, flags: { repoChipsAlways: false } }, "griffin").flags.repoChipsAlways, false);
  assert.equal(ui.presetOf("karsara").flags.repoChipsAlways, false);
  assert.equal(ui.resolvePrefs({ rev: ui.PREFS_REV, flags: { repoChipsAlways: true } }, "griffin").flags.repoChipsAlways, true);
});
