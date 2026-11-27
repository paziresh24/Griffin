import test from "node:test";
import assert from "node:assert/strict";
import { admission, claudeSafety, hardenedEnv, isSubscriptionKey, sendSettings } from "../src/claude-safety.mjs";

// genv stand-in with defaults from the module, override what a test needs.
const env = (kv = {}) => (key, fallback = "") => (key in kv ? String(kv[key]) : fallback);

test("the quiet behaviour is the default for every loud switch", () => {
  const f = claudeSafety(env());
  assert.equal(f.usagePoll, false, "the 15-minute plan poll must be off by default");
  assert.equal(f.healthProbe, false, "spending a real message to test an account must be opt-in");
  assert.equal(f.tokenKeeper, false);
  assert.equal(f.orgLookup, false, "the raw /v1/models call every 6h must be off by default");
  assert.equal(f.languageFlag, false, "settings.language is opt-in by default, matching config.mjs");
  assert.equal(f.telemetry, false);
  assert.equal(f.promptAppend, true);
  assert.equal(f.backgroundOff, true, "background work stays off subscription accounts by default");
  assert.equal(f.warmup, true);
});

test("every switch can be put back to the loud behaviour", () => {
  const f = claudeSafety(
    env({
      CLAUDE_USAGE_POLL: "on",
      CLAUDE_PROBE: "on",
      CLAUDE_TOKEN_KEEPER: "on",
      CLAUDE_ORG_LOOKUP: "on",
      CLAUDE_LANGUAGE_FLAG: "on",
      CLAUDE_TELEMETRY: "on",
      CLAUDE_PROMPT_APPEND: "off",
      CLAUDE_BACKGROUND_OFF: "off",
      CLAUDE_WARMUP: "off",
    }),
  );
  assert.equal(f.usagePoll, true);
  assert.equal(f.healthProbe, true);
  assert.equal(f.tokenKeeper, true);
  assert.equal(f.orgLookup, true);
  assert.equal(f.languageFlag, true);
  assert.equal(f.telemetry, true);
  assert.equal(f.promptAppend, false);
  assert.equal(f.backgroundOff, false);
  assert.equal(f.warmup, false);
});

test("only «on» turns a switch on, like every other setting", () => {
  const f = claudeSafety(env({ CLAUDE_USAGE_POLL: "yes", CLAUDE_PROBE: "1" }));
  assert.equal(f.usagePoll, false);
  assert.equal(f.healthProbe, false);
});

test("maxConcurrent falls back to 2 for junk values", () => {
  assert.equal(claudeSafety(env()).maxConcurrent, 2);
  assert.equal(claudeSafety(env({ CLAUDE_MAX_CONCURRENT: "1" })).maxConcurrent, 1);
  assert.equal(claudeSafety(env({ CLAUDE_MAX_CONCURRENT: "0" })).maxConcurrent, 2);
  assert.equal(claudeSafety(env({ CLAUDE_MAX_CONCURRENT: "abc" })).maxConcurrent, 2);
});

test("telemetry keys are only added when telemetry is off", () => {
  const quiet = hardenedEnv({ PATH: "/bin" }, claudeSafety(env()));
  assert.equal(quiet.DISABLE_TELEMETRY, "1");
  assert.equal(quiet.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(quiet.PATH, "/bin", "the run's own env must survive");
  const loud = hardenedEnv({ PATH: "/bin" }, claudeSafety(env({ CLAUDE_TELEMETRY: "on" })));
  assert.equal(loud.DISABLE_TELEMETRY, undefined);
});

test("settings.language is omitted by default and sent only when CLAUDE_LANGUAGE_FLAG=on", () => {
  // Default off: the request looks like a plain session's (Persian stays enforced by hooks/prompt).
  assert.deepEqual(sendSettings(claudeSafety(env()), { language: "Persian", fastMode: true }), {
    fastMode: true,
  });
  // CLAUDE_LANGUAGE_FLAG=on restores settings.language explicitly.
  assert.deepEqual(sendSettings(claudeSafety(env({ CLAUDE_LANGUAGE_FLAG: "on" })), { language: "Persian", fastMode: true }), {
    language: "Persian",
    fastMode: true,
  });
});

test("isSubscriptionKey matches setup-token AND full login-dir OAuth accounts, never API keys", () => {
  assert.equal(isSubscriptionKey("sk-ant-oat01-xyz"), true);
  assert.equal(isSubscriptionKey("claude-login:claude-2"), true);
  assert.equal(isSubscriptionKey("claude-code-login"), true);
  assert.equal(isSubscriptionKey("sk-ant-api03-xyz"), false);
  assert.equal(isSubscriptionKey(""), false);
});

test("a one-shot skips an account past the soft cap, but never drops it", async () => {
  const { roomiestAccount, SOFT_CAP } = await import("../src/account-balance.mjs");
  const loads = { a: 30, b: SOFT_CAP + 3 };
  // Both usable: the one past the cap is skipped even though it is listed and usable.
  assert.equal(roomiestAccount(["b", "a"], { usable: () => true, loadOf: (id) => loads[id], softCap: SOFT_CAP }), "a");
  // Nothing left but the capped one: it still runs (a feature is never dropped).
  assert.equal(roomiestAccount(["b"], { usable: () => true, loadOf: (id) => loads[id], softCap: SOFT_CAP }), "b");
  // Without a cap the old behaviour is untouched.
  assert.equal(roomiestAccount(["a", "b"], { usable: () => true, loadOf: (id) => loads[id] }), "a");
});

test("concurrency cap and warm-up gate", () => {
  const f = claudeSafety(env({ CLAUDE_MAX_CONCURRENT: "2" }));
  assert.equal(admission(f, { concurrent: 1 }).ok, true);
  assert.equal(admission(f, { concurrent: 2 }).ok, false);
  assert.equal(admission(f, { concurrent: 2 }).reason, "concurrent");
  // A new account above the soft daily cap waits; after the warm-up days it does not.
  assert.equal(admission(f, { concurrent: 0, ageDays: 1, load: 60 }).reason, "warmup");
  assert.equal(admission(f, { concurrent: 0, ageDays: 10, load: 60 }).ok, true);
  // Unknown load or age never blocks.
  assert.equal(admission(f, { concurrent: 0, ageDays: null, load: null }).ok, true);
});

test("the account's clock and the reply language are independent", async () => {
  const { accountEgressEnv } = await import("../src/account-egress.mjs");
  // Pinning the clock for one account must not touch the Persian answer: the language comes from the
  // prompt rules, and TZ only moves the run's own clock to the place its exit sits in.
  const f = claudeSafety(env({ CLAUDE_LANGUAGE_FLAG: "off" }));
  assert.deepEqual(sendSettings(f, { language: "Persian" }), {});
  const out = accountEgressEnv({ LANG: "C.UTF-8" }, { proxyUrl: "socks5://1.2.3.4:1080", timezone: "America/Toronto" });
  assert.equal(out.TZ, "America/Toronto");
  assert.equal(out.LANG, "C.UTF-8", "the locale must survive");
});
