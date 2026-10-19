import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsNextStep, dismissNextStep, enterPicks, fastNote, filterCommands, forkRunId, isClearCommand, moveIndex, nextStepReturnsOn, pickCommand, setNextStepReturns, shownNextStep, slashQuery,
} from "../src/assist.js";

test("«/» list: a lone /word filters, exact and prefix first; Enter completes only an unfinished name", () => {
  assert.equal(slashQuery("/rev"), "rev");
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/review the diff"), null, "an argument is being written");
  assert.equal(slashQuery("/etc/hosts"), null, "a path");
  const list = [{ name: "compact", description: "" }, { name: "review", description: "diff" }, { name: "pr-review", description: "" }, { name: "x", description: "review it", aliases: [] }];
  assert.deepEqual(filterCommands(list, "review").map((c) => c.name), ["review", "pr-review", "x"]);
  assert.deepEqual(filterCommands(list, "").length, 4);
  assert.equal(enterPicks(list[1], "rev", false), true);
  assert.equal(enterPicks(list[1], "review", false), false, "a finished name is sent as written");
  assert.equal(enterPicks(list[3], "review", false), false, "a description-only match is not completed by Enter");
  assert.equal(enterPicks(list[3], "review", true), true, "unless the owner moved to it");
  assert.equal(pickCommand(list[1]), "/review ");
  assert.equal(moveIndex(0, 3, -1), 2);
  assert.equal(moveIndex(5, 3, 1), 0);
  assert.equal(isClearCommand(" /clear "), true);
  assert.equal(isClearCommand("/clear now"), false);
});

test("next-message suggestion: shown only in an empty, idle box; typing puts it aside; plain Tab accepts", () => {
  assert.equal(shownNextStep({ suggestion: " تست کن ", text: "", running: false, dismissed: null }), "تست کن");
  assert.equal(shownNextStep({ suggestion: "تست کن", text: " ", running: false }), null);
  assert.equal(shownNextStep({ suggestion: "تست کن", text: "", running: true }), null);
  const dismissed = dismissNextStep(null, { suggestion: "تست کن", text: "x" });
  assert.equal(shownNextStep({ suggestion: "تست کن", text: "", running: false, dismissed }), null, "clearing the box does not bring it back");
  assert.equal(dismissNextStep(dismissed, { suggestion: "تست کن", text: "", running: true }), null, "a turn in between starts over");
  assert.equal(acceptsNextStep({ key: "Tab" }), true);
  assert.equal(acceptsNextStep({ key: "Tab", shiftKey: true }), false);
});

test("fast mode note and fork availability", () => {
  assert.equal(fastNote({ fast: false }), null);
  assert.equal(fastNote({ fast: true, fastState: { state: "on" } }), null);
  assert.equal(fastNote({ fast: true, fastState: { state: "off", reason: "extra_usage_disabled" } }), "مصرف اضافه روی این حساب Claude خاموش است");
  assert.equal(fastNote({ fast: true, model: "claude:sonnet" }), "فقط روی Opus");
  const owner = { caller: "owner" };
  assert.equal(forkRunId({ runId: "r1", status: "finished" }, owner), "r1");
  assert.equal(forkRunId({ runId: "r1", status: "running" }, owner), null);
  assert.equal(forkRunId({ runId: "r1", status: "error" }, { caller: "owner", sideOf: "p" }), null);
  assert.equal(forkRunId({ runId: "r1", status: "finished" }, { caller: "team" }), null);
});

test("next step: off (default) typing puts it aside for good; NEXT_STEP_RETURNS on brings it back once the box is empty", () => {
  const suggestion = "آزمون‌ها را اجرا کن";
  const dismissed = dismissNextStep(null, { suggestion, text: "س" });
  assert.equal(shownNextStep({ suggestion, text: "", running: false, dismissed }), null);
  assert.equal(shownNextStep({ suggestion, text: "س", running: false, dismissed, returns: true }), null, "still hidden while typing");
  assert.equal(shownNextStep({ suggestion, text: "", running: false, dismissed, returns: true }), suggestion);
  assert.equal(shownNextStep({ suggestion, text: "", running: true, dismissed, returns: true }), null, "not while a turn runs");
  assert.equal(nextStepReturnsOn(), false, "off until the chat list says otherwise");
  setNextStepReturns(true);
  assert.equal(nextStepReturnsOn(), true);
  setNextStepReturns("on");
  assert.equal(nextStepReturnsOn(), false, "only true turns it on");
});
