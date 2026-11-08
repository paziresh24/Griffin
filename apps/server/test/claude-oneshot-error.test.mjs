import test from "node:test";
import assert from "node:assert/strict";
import { oneShotError, AUTH_FAILED_CODE } from "../src/providers/claude.mjs";

test("a refused login from a one-shot is auth_failed, so the caller moves to the next account", () => {
  const e = oneShotError("Failed to authenticate: OAuth session expired and could not be refreshed");
  assert.equal(e.code, AUTH_FAILED_CODE);
});

test("two processes refreshing at once is not a refused login", () => {
  assert.equal(oneShotError("another process is refreshing it or exited mid-refresh").code, undefined);
});

test("any other failure keeps no code and a short message", () => {
  const e = oneShotError("x".repeat(500));
  assert.equal(e.code, undefined);
  assert.equal(e.message.length, 120);
});
