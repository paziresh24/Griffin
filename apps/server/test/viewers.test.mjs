import { test } from "node:test";
import assert from "node:assert/strict";
import { isWatched, watchChat } from "../src/viewers.mjs";

test("a chat is watched while at least one page of it is open; closing twice counts once", () => {
  assert.equal(isWatched("c1"), false);
  const a = watchChat("c1");
  const b = watchChat("c1");
  assert.equal(isWatched("c1"), true);
  a();
  a();
  assert.equal(isWatched("c1"), true, "one page is still open");
  b();
  assert.equal(isWatched("c1"), false);
  assert.equal(isWatched(null), false);
});
