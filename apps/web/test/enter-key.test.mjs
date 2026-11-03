import test from "node:test";
import assert from "node:assert/strict";
import { setEnterKey, shiftEnterSends, submitMode } from "../src/touch.js";

test("ENTER_KEY: default Enter sends; shiftEnter makes the library hands-off and Shift+Enter sends", () => {
  setEnterKey(undefined);
  assert.equal(submitMode(false), "enter");
  assert.equal(shiftEnterSends(false, { shiftKey: true }), false);
  setEnterKey("shiftEnter");
  assert.equal(submitMode(false), "none");
  assert.equal(shiftEnterSends(false, { shiftKey: true }), true);
  assert.equal(shiftEnterSends(false, { shiftKey: false }), false, "plain Enter is a new line");
  assert.equal(shiftEnterSends(false, { shiftKey: true, ctrlKey: true }), false, "Ctrl+Shift+Enter stays «فوری»");
  assert.equal(submitMode(true), "ctrlEnter", "touch unchanged");
  setEnterKey("enter");
});
