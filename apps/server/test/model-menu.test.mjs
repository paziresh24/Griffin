import test from "node:test";
import assert from "node:assert/strict";
import { parseModelCallback } from "../src/integrations/bots.mjs";

test("parseModelCallback: only `m:<pickId>:<index>` taps parse", () => {
  assert.deepEqual(parseModelCallback("m:ab12cd34:2"), { pickId: "ab12cd34", index: 2 });
  assert.deepEqual(parseModelCallback("m:AB12CD34:0"), { pickId: "ab12cd34", index: 0 });
  assert.equal(parseModelCallback("a:ab12cd34:2"), null);
  assert.equal(parseModelCallback("m:ab12cd34"), null);
  assert.equal(parseModelCallback("m:ab12cd34:x"), null);
  assert.equal(parseModelCallback(""), null);
  assert.equal(parseModelCallback(null), null);
});
