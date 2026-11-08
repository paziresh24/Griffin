import test from "node:test";
import assert from "node:assert/strict";
import { EGRESS_DOWN_CODE, explainEgress } from "../src/egress-down.mjs";

const PROXY = "http://127.0.0.1:18118";
const dead = async () => false;
const alive = async () => true;

test("a login-looking error with a dead proxy becomes egress_down", async () => {
  const out = await explainEgress({ code: "auth_failed", message: "Failed to refresh OAuth token" }, { provider: "claude-3", proxyUrl: PROXY, probe: dead });
  assert.equal(out.code, EGRESS_DOWN_CODE);
  assert.match(out.message, /وی‌پی‌ان این سرور کار نمی‌کند/);
  assert.match(out.message, /api\.anthropic\.com/);
});

test("a raw network error with a dead proxy becomes egress_down", async () => {
  const out = await explainEgress({ message: "Unable to connect to API (ETIMEDOUT)" }, { proxyUrl: PROXY, probe: dead });
  assert.equal(out.code, EGRESS_DOWN_CODE);
});

test("a working proxy leaves the error alone (the login really is refused)", async () => {
  const error = { code: "auth_failed", message: "Failed to authenticate. API Error: 401" };
  assert.equal(await explainEgress(error, { proxyUrl: PROXY, probe: alive }), error);
});

test("a first miss is retried once", async () => {
  let calls = 0;
  const flaky = async () => ++calls > 1;
  const error = { message: "fetch failed" };
  assert.equal(await explainEgress(error, { proxyUrl: PROXY, probe: flaky }), error);
});

test("no proxy, other engines, plan limits and unrelated errors are not touched", async () => {
  const probe = async () => assert.fail("must not probe");
  for (const [error, opts] of [
    [{ message: "fetch failed" }, { proxyUrl: "" }],
    [{ message: "fetch failed" }, { proxyUrl: PROXY, provider: "openai" }],
    [{ code: "plan_limit", message: "network timeout" }, { proxyUrl: PROXY }],
    [{ message: "Prompt is too long" }, { proxyUrl: PROXY }],
  ]) assert.equal(await explainEgress(error, { probe, ...opts }), error);
});
