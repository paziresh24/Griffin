import test from "node:test";
import assert from "node:assert/strict";
import { cleanPane, diffRows, emptyPane, missingViews, paneReducer, planSummary, PANE_VIEWS } from "../src/chat-pane.js";

const run = (state, ...actions) => actions.reduce(paneReducer, state);

test("the pinned view stays first, has no close, and the panel opens on it", () => {
  let s = run(emptyPane(), { type: "tab", id: "changes" }, { type: "tab", id: "terminal" });
  assert.deepEqual(s.tabs, ["plan", "changes", "terminal"]);
  assert.equal(run(s, { type: "closeTab", id: "plan" }).tabs.includes("plan"), true);
  s = run(s, { type: "pin", id: "changes" });
  assert.deepEqual([s.pinned, s.tabs[0]], ["changes", "changes"]);
  s = run(s, { type: "close" }, { type: "toggle" });
  assert.deepEqual([s.open, s.tab], [true, "changes"]);
  s = run(s, { type: "pin", id: "changes" });
  assert.equal(s.pinned, null);
});

test("closing the last view closes the panel; opening again brings a view", () => {
  let s = run({ open: true, tabs: ["terminal"], tab: "terminal", pinned: null }, { type: "closeTab", id: "terminal" });
  assert.deepEqual([s.open, s.tabs], [false, []]);
  s = run(s, { type: "toggle" });
  assert.deepEqual([s.open, s.tabs, s.tab], [true, ["plan"], "plan"]);
});

test("closing the view on screen falls to the pinned one", () => {
  const s = run({ open: true, tabs: ["plan", "changes", "side"], tab: "side", pinned: "plan" }, { type: "closeTab", id: "side" });
  assert.equal(s.tab, "plan");
});

test("plus offers only what is not open", () => {
  const s = { tabs: ["plan", "changes"] };
  assert.deepEqual(missingViews(s), ["terminal", "browser", "side"]);
  assert.deepEqual(missingViews(s, ["plan", "changes", "terminal"]), ["terminal"]);
  assert.deepEqual(missingViews({ tabs: [...PANE_VIEWS] }), []);
});

test("a stored state is cleaned", () => {
  assert.deepEqual(cleanPane(null), emptyPane());
  const s = cleanPane({ open: 1, tabs: ["side", "bad", "side"], tab: "gone", pinned: "plan" });
  assert.deepEqual(s, { open: true, tabs: ["plan", "side"], tab: "plan", pinned: "plan" });
  assert.equal(cleanPane({ tabs: ["plan"], pinned: null }).pinned, null);
});

test("plan summary: the current subtask is the marked one, else the next", () => {
  const sub = (id, status) => ({ id, title: id, status });
  const plan = (state, ...subs) => ({ state, tasks: [{ id: "t", title: "t", subs }] });
  assert.equal(planSummary(null).none, true);
  assert.equal(planSummary(plan("proposed", sub("a", "pending"))).current, null);
  assert.equal(planSummary(plan("active", sub("a", "done"), sub("b", "pending"))).current.id, "b");
  assert.equal(planSummary(plan("active", sub("a", "pending"), sub("b", "in_progress"))).current.id, "b");
  assert.equal(planSummary(plan("active", sub("a", "done"))).finished, true);
});

test("diff rows drop the file header", () => {
  const rows = diffRows("diff --git a b\nindex 1\n--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n same\n");
  assert.deepEqual(rows.map((r) => r.kind), ["hunk", "del", "add", "same"]);
});
