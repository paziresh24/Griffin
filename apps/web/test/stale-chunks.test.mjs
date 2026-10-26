import test from "node:test";
import assert from "node:assert/strict";
import { isStaleChunk, reloadOnce } from "../src/stale-chunks.js";

test("a lazy piece gone after an update reloads the page once a minute at most", () => {
  assert.ok(isStaleChunk("Failed to fetch dynamically imported module: https://x/assets/a-1.js"));
  assert.ok(!isStaleChunk("TypeError: x is undefined"));
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  let reloads = 0;
  assert.equal(reloadOnce(storage, 1_000_000, () => reloads++), true);
  assert.equal(reloadOnce(storage, 1_030_000, () => reloads++), false);
  assert.equal(reloadOnce(storage, 1_100_000, () => reloads++), true);
  assert.equal(reloads, 2);
});
