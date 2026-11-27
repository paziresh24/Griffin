// The one catalogue of settings (settings-catalog.js) that «بپرس» and settings_suggest read: everything a
// person can change is in it, and «اعمال» does exactly one thing — never a careful setting, never one that
// needs a restart, never a free value.
import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA } from "../../server/src/config.mjs";
import { FEATURES } from "../src/settings-features.js";
import { FLAGS, resolvePrefs } from "../src/ui-flags.js";
import { MERGED_FLAGS, settingsIndex } from "../src/settings-map.js";
import { NO_CLICK, applyPlan, scopeLabel, settingsCatalog, undoPatch, valueLabel } from "../src/settings-catalog.js";

const rowsWith = (values = {}) => CONFIG_SCHEMA.map((c) => ({ key: c.key, value: values[c.key] || "", effective: values[c.key] || "" }));
const catalog = (values = {}, flags = {}) => settingsCatalog({ rows: rowsWith(values), prefs: resolvePrefs({ flags }, "griffin") });
const entry = (list, id) => list.find((e) => e.id === id);

test("every server setting, every switch of «ظاهر» and every page tab is in the catalogue, once", () => {
  const list = catalog();
  const ids = list.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "an id twice");
  for (const c of CONFIG_SCHEMA) assert.ok(ids.includes(`set:${c.key}`), c.key);
  for (const f of FLAGS) assert.ok(MERGED_FLAGS[f.key] || ids.includes(`flag:${f.key}`), f.key);
  for (const id of ["choice:look", "choice:nav", "choice:update", "choice:home", "choice:work"]) assert.ok(ids.includes(id), id);
  // The same ids as the search, so «برو به تنظیم» opens the same row.
  const searchIds = new Set(settingsIndex(rowsWith()).map((e) => e.id));
  for (const e of list.filter((x) => x.kind === "config" || x.kind === "flag")) assert.ok(searchIds.has(e.id), e.id);
  for (const e of list) {
    assert.ok(e.title && e.where && e.section, e.id);
    if (e.kind !== "place") assert.ok(scopeLabel(e.scope), `${e.id} says where it lands`);
  }
});

test("the catalogue reads what is on now: saved, else the env, else the default; flags from the resolved look", () => {
  const list = catalog({ ENTER_KEY: "shiftEnter" }, { timeAgo: true });
  assert.equal(entry(list, "set:ENTER_KEY").current, "shiftEnter");
  assert.equal(entry(list, "set:AUTO_CONTINUE").current, "on");
  assert.equal(entry(list, "flag:timeAgo").current, "on");
  assert.equal(entry(list, "choice:look").current, "griffin");
  assert.equal(valueLabel(entry(list, "set:ENTER_KEY"), "shiftEnter"), "شیفت+اینتر");
  assert.equal(entry(settingsCatalog(), "set:ENTER_KEY").current, null, "unknown when the rows are not read");
});

test("one click sets exactly the suggested value, and turns on the switch it hangs on", () => {
  const list = catalog({ PROMPT_SUGGESTIONS: "off" });
  assert.deepEqual(applyPlan(entry(list, "set:ENTER_KEY"), "shiftEnter", list), { ok: true, patch: { config: { ENTER_KEY: "shiftEnter" } }, also: [] });
  const plan = applyPlan(entry(list, "set:NEXT_STEP_RETURNS"), "on", list);
  assert.deepEqual(plan.patch, { config: { NEXT_STEP_RETURNS: "on", PROMPT_SUGGESTIONS: "on" } });
  assert.equal(plan.also.length, 1);
  assert.deepEqual(applyPlan(entry(list, "flag:timeAgo"), "on", list).patch, { flags: { timeAgo: true } });
  // Griffin's preset narrates the work log («روایت»); «یک خط» folds it.
  assert.equal(entry(list, "choice:work").current, "inline");
  assert.deepEqual(applyPlan(entry(list, "choice:work"), "fold", list).patch, { flags: { workInline: false, workLogOpen: false } });
  assert.deepEqual(applyPlan(entry(list, "choice:look"), "karsara", list).patch, { look: "karsara" });
});

test("never in one click: careful, restart, free values, unknown values, the value it already has", () => {
  const list = catalog();
  for (const f of FEATURES.filter((x) => x.careful)) {
    const e = entry(list, `set:${f.key}`);
    for (const o of e.options || []) if (o.value !== e.current) assert.equal(applyPlan(e, o.value, list).why, "careful", f.key);
  }
  assert.equal(applyPlan(entry(list, "set:SELF_HEAL"), "on", list).why, "restart");
  assert.equal(applyPlan(entry(list, "set:BACKUP_S3_URL"), "https://x", list).why, "text");
  assert.equal(applyPlan(entry(list, "set:ENTER_KEY"), "ctrlEnter", list).why, "text");
  assert.equal(applyPlan(entry(list, "set:ENTER_KEY"), "enter", list).why, "same");
  assert.equal(applyPlan(entry(list, "tab:connections"), "", list).why, "place");
  // A child of a careful switch that is off: the card says which one to turn on first.
  const off = catalog({ CLAUDE_CODE: "off" });
  assert.deepEqual(applyPlan(entry(off, "set:RTK"), "off", off).ok, true, "turning a child off needs nothing above it");
  const blocked = catalog({ CLAUDE_CODE: "off", RTK: "off" });
  const plan = applyPlan(entry(blocked, "set:RTK"), "on", blocked);
  assert.equal(plan.why, "blocked");
  assert.match(NO_CLICK.blocked.replace("{by}", plan.by), /Claude Code کامل/);
});

test("the guards, the network, the agent's reach and stored data are careful", () => {
  for (const key of ["STATE_GUARD", "GIT_IDENTITY_GUARD", "PEER_BRIDGE_GUARD", "TELEGRAM_INSTRUCTION_GUARD", "NETWORK", "NETWORK_ADMIT", "CLAUDE_CODE", "CLAUDE_HOST", "KNOWLEDGE_AUTO_APPROVE", "COMPACT_EVENTS"]) {
    assert.ok(FEATURES.find((f) => f.key === key).careful, key);
  }
});

test("«برگردان» puts back what was saved, not the default as a pinned value", () => {
  const list = catalog({ PROMPT_SUGGESTIONS: "off" });
  const e = entry(list, "set:NEXT_STEP_RETURNS");
  const plan = applyPlan(e, "on", list);
  assert.deepEqual(undoPatch(e, plan, list), { config: { NEXT_STEP_RETURNS: "", PROMPT_SUGGESTIONS: "off" } });
  const work = entry(list, "choice:work");
  assert.deepEqual(undoPatch(work, applyPlan(work, "fold", list), list), { flags: { workInline: true, workLogOpen: false } });
  assert.equal(undoPatch(e, { ok: false }, list), null);
});
