import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../src/stall.mjs";

test("a profile reads as time per stack, with the nearest frame of our own code", () => {
  const f = (id, functionName, url = "", children = []) => ({ id, callFrame: { functionName, url, lineNumber: 9 }, children });
  const profile = {
    nodes: [f(1, "(root)", "", [2, 5]), f(2, "handler", "file:///app/apps/server/src/app.mjs", [3]), f(3, "stringify", "", [4]), f(4, "serialize", ""), f(5, "(idle)")],
    samples: [4, 4, 5, 3],
    timeDeltas: [2000, 3000, 9000, 1000],
  };
  assert.deepEqual(summarize(profile), [
    { ms: 9, stack: "(idle)" },
    { ms: 5, stack: "serialize < stringify < handler src/app.mjs:10" },
    { ms: 1, stack: "stringify < handler src/app.mjs:10" },
  ]);
});
