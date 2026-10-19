import test from "node:test";
import assert from "node:assert/strict";
import { createDownWatch, isDownAnswer, DOWN_EVERY_MS, UP_EVERY_MS } from "../src/server-down.js";

test("the CDN's 502/503/504 and no answer are a server away; a 401 or 200 is not", () => {
  for (const s of [0, undefined, 502, 503, 504]) assert.equal(isDownAnswer(s), true, String(s));
  for (const s of [200, 401, 404, 500]) assert.equal(isDownAnswer(s), false, String(s));
});

test("two misses in a row cover the page, one answer uncovers it, and a lone miss says nothing", async () => {
  const answers = [200, 503, 200, 503, "throw", 503, 200];
  const seen = [];
  const tick = createDownWatch({
    ping: async () => {
      const a = answers.shift();
      if (a === "throw") throw new TypeError("Failed to fetch");
      return a;
    },
    onDown: () => seen.push("down"),
    onBack: () => seen.push("back"),
  });
  const waits = [];
  for (let i = 0; i < 7; i += 1) waits.push(await tick());
  assert.deepEqual(seen, ["down", "back"]);
  // A miss is followed up quickly; a healthy server is asked rarely.
  assert.deepEqual(waits, [UP_EVERY_MS, DOWN_EVERY_MS, UP_EVERY_MS, DOWN_EVERY_MS, DOWN_EVERY_MS, DOWN_EVERY_MS, UP_EVERY_MS]);
});
