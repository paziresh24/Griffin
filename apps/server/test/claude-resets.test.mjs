import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimReset, fetchResets, parseResets, readLogin } from "../src/claude-resets.mjs";

// The cedar_ember block as Anthropic answered it for a Max login at its weekly limit (2026-11-11).
const BLOCK = {
  eligible: true,
  at_limit: true,
  exhausted: ["seven_day"],
  grants: [
    { id: "full-reset-2611", label: "One full limit reset (November 2026)", resets_total: 1, resets_left: 1, ends_at: "2026-12-10T22:00:00+00:00", clears: ["seven_day", "seven_day_overage_included"], paused: false, usable_now: true, use_requires_limit: false, blocking: [] },
    { id: "launch-2610-fable", label: "New model launch: one Fable reset", resets_total: 1, resets_left: 1, ends_at: "2027-03-09T07:59:00+00:00", clears: ["seven_day_overage_included"], paused: false, usable_now: false, blocking: ["seven_day"] },
    { id: "spent", label: "used", resets_total: 1, resets_left: 0, usable_now: false },
    { id: "BAD ID", resets_left: 1 },
  ],
  next_grant_id: "full-reset-2611",
  weekly_resets_at: "2026-11-11T10:00:00+00:00",
};

test("parseResets keeps grants with resets left and a valid id", () => {
  const r = parseResets(BLOCK);
  assert.equal(r.available, true);
  assert.equal(r.atLimit, true);
  assert.deepEqual(r.grants.map((g) => g.id), ["full-reset-2611", "launch-2610-fable"]);
  assert.equal(r.grants[0].usableNow, true);
  assert.deepEqual(r.grants[1].blocking, ["seven_day"]);
  assert.equal(r.grants[0].endsAt, "2026-12-10T22:00:00.000Z");
  assert.equal(r.nextGrantId, "full-reset-2611");
  assert.equal(parseResets(null).available, false);
});

test("fetchResets and claimReset send the login's token and the program", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return url.includes("reset_rate_limits")
      ? { ok: true, status: 200, json: async () => ({ result: "reset", resets_left: 0, cleared: ["seven_day"] }) }
      : { ok: true, status: 200, json: async () => ({ cedar_ember: BLOCK }) };
  };
  const login = { token: "tok", org: "org-1" };
  assert.equal((await fetchResets(login, { fetchImpl })).grants.length, 2);
  const r = await claimReset(login, "full-reset-2611", { fetchImpl });
  assert.deepEqual(r, { result: "reset", reason: null, left: 0, cleared: ["seven_day"] });
  assert.match(calls[1].url, /\/api\/organizations\/org-1\/reset_rate_limits$/);
  assert.equal(calls[1].init.headers.authorization, "Bearer tok");
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.program, "cedar_ember");
  assert.equal(body.grant_id, "full-reset-2611");
  assert.match(body.request_id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal((await claimReset(login, "../x", { fetchImpl })).result, "unavailable");
  assert.equal((await claimReset({ token: "tok", org: null }, "full-reset-2611", { fetchImpl })).result, "auth_error");
  assert.equal(calls.length, 2);
});

test("readLogin reads the token and the organization of a login folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resets-"));
  assert.equal(readLogin(dir), null);
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 } }));
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org-1" } }));
  assert.deepEqual(readLogin(dir), { token: "tok", org: "org-1" });
  fs.rmSync(dir, { recursive: true });
});
