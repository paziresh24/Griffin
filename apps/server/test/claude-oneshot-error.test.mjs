import test from "node:test";
import assert from "node:assert/strict";
import { oneShotError, resultFailure, AUTH_FAILED_CODE } from "../src/providers/claude.mjs";
import { classifyEngineError } from "../src/doctor.mjs";

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

const ORG_OFF = "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";

test("an organization that closed Claude Code is a refused login: the one-shot moves to the next account", () => {
  assert.equal(oneShotError(ORG_OFF).code, AUTH_FAILED_CODE);
});

test("a chat run that ends on a closed organization moves on like a refused login", () => {
  const failure = resultFailure({ type: "result", subtype: "success", is_error: true, result: ORG_OFF });
  assert.equal(failure.code, AUTH_FAILED_CODE);
  assert.match(failure.message, /سازمان/);
});

test("the engines test reads a closed organization as a bad login, so the account leaves routing", () => {
  assert.equal(classifyEngineError({ text: ORG_OFF }), "bad_key");
});
