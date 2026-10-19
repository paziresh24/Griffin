import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBusinessLogin,
  parseCliInit,
  parseCliPoll,
  parseResetStatus,
} from "../src/zai-account.mjs";

// Shapes verified against the open-source ZCode client (github.com/zai-org/ZCode, read
// 2026-10-04): oauthService.ts cli/init + cli/poll, zaiBusinessTokenResolver.ts, and
// bigmodelUsageQuotaProvider.ts coding-plan/reset/status. The plain API key answers 401 on
// these endpoints (probed live 2026-10-04) — this is account-JWT territory, not keys.

test("parseCliInit reads the sign-in flow the server hands out", () => {
  const parsed = parseCliInit({
    code: 0,
    data: { flow_id: "flow-1", authorize_url: "https://chat.z.ai/api/oauth/authorize?a=1", expires_at: 200, poll_interval_sec: 3 },
  });
  assert.deepEqual(parsed, {
    flowId: "flow-1",
    authorizeUrl: "https://chat.z.ai/api/oauth/authorize?a=1",
    expiresAtMs: 200_000,
    pollIntervalMs: 3_000,
  });
  assert.equal(parseCliInit({ code: 1, msg: "no" }).error, "no");
  assert.equal(parseCliInit(null).error, "invalid response");
  assert.equal(parseCliInit({ code: 0, data: { flow_id: "" } }).error, "invalid response");
});

test("parseCliPoll distinguishes pending, failed and ready (with the two tokens)", () => {
  assert.deepEqual(parseCliPoll({ code: 0, data: { status: "pending" } }), { status: "pending" });
  assert.deepEqual(parseCliPoll({ code: 0, data: { status: "failed" } }), { status: "failed", error: "OAuth flow 授权失败" });
  const ready = parseCliPoll({
    code: 0,
    data: {
      status: "ready",
      token: "zcode-jwt",
      zai: { access_token: "oauth-token" },
      user: { user_id: "u1", name: "Owner", email: "o@x.ir", avatar: "a.png" },
    },
  });
  assert.deepEqual(ready, {
    status: "ready",
    zcodeJwt: "zcode-jwt",
    oauthToken: "oauth-token",
    user: { id: "u1", name: "Owner", email: "o@x.ir", avatar: "a.png" },
  });
  assert.equal(parseCliPoll({ code: 0, data: { status: "ready", token: "" } }).error, "invalid response");
  assert.equal(parseCliPoll({ code: 5, msg: "expired" }).error, "expired");
});

test("parseBusinessLogin reads the platform JWT out of /api/auth/z/login", () => {
  assert.deepEqual(parseBusinessLogin({ code: 0, success: true, data: { access_token: "biz-jwt", expires_in: 3600 } }), {
    token: "biz-jwt",
  });
  assert.equal(parseBusinessLogin({ code: 0, success: true, data: { accessToken: "alt" } }).token, "alt");
  // Z.ai answers code 200 (probed 2026-10-05: the owner's sign-in reached Authorization
  // Successful and the API replied {code:200,...}); ZCode's isSuccessfulZaiBusinessCode accepts
  // 0/200 as number or string, and a missing code. The old parser accepted only 0.
  assert.equal(parseBusinessLogin({ code: 200, msg: "success", data: { access_token: "jwt" } }).token, "jwt");
  assert.equal(parseBusinessLogin({ code: "200", data: { access_token: "jwt" } }).token, "jwt");
  assert.equal(parseBusinessLogin({ msg: "ok", data: { access_token: "jwt" } }).token, "jwt");
  // Failures name their cause instead of collapsing into one label.
  assert.match(parseBusinessLogin({ code: 401, msg: "token invalid" }).error, /401|invalid/);
  assert.match(parseBusinessLogin({ code: 0, success: false, msg: "denied" }).error, /denied|failed/);
  assert.match(parseBusinessLogin({ code: 0, data: {} }).error, /access_token/);
  assert.equal(parseBusinessLogin(null).error, "invalid response");
});

test("parseResetStatus turns the envelope into counts with expiry", () => {
  const parsed = parseResetStatus({
    code: 200,
    msg: "Operation successful",
    data: {
      available_five_hour_resets: [{ expire_at: 1791154665128 }],
      available_week_resets: [{ expire_at: 1791696635983 }, { expire_at: 1792300000000 }],
      latest_five_hour_reset_history: null,
      latest_week_reset_history: { used_at: 1790000000000 },
      has_unread_history: false,
    },
    success: true,
  });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.fiveHour.length, 1);
  assert.equal(parsed.fiveHour[0].expireAt, 1791154665128);
  assert.equal(parsed.week.length, 2);
  assert.equal(parsed.latestWeekAt, 1790000000000);
  assert.equal(parsed.latestFiveHourAt, null);
  // Tolerant of the bare data object too.
  const bare = parseResetStatus({ available_five_hour_resets: [], available_week_resets: [], latest_five_hour_reset_history: null, latest_week_reset_history: null, has_unread_history: true });
  assert.equal(bare.fiveHour.length, 0);
  assert.equal(bare.week.length, 0);
  assert.equal(parseResetStatus({ code: 401 }).error, "HTTP 401");
});
