// Karsara's account / usage routes on Griffin's engine accounts (account-routes.mjs), the Z.ai
// sign-in service on Griffin's secret store (zai-account.mjs), and the auth gate on /api/auth/zai.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { accountRoutes, checkCustomEndpoint, claudeAccountId } from "../src/account-routes.mjs";
import { createSecretStore } from "../src/secrets.mjs";
import { createZaiAccount } from "../src/zai-account.mjs";
import { createApp } from "../src/app.mjs";
import { createAuth } from "../src/auth.mjs";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-acct-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---- Z.ai sign-in service (from Karsara zai-account-service.test.mjs) ----
const INIT = { code: 0, data: { flow_id: "f1", authorize_url: "https://chat.z.ai/authorize?x=1", expires_at: 9999999999, poll_interval_sec: 3 } };
const READY = { code: 0, data: { status: "ready", token: "zcode-jwt", zai: { access_token: "oauth-tok" }, user: { user_id: "u1", name: "Owner", email: "o@x.ir" } } };
const STATUS_OK = { code: 0, data: { available_five_hour_resets: [{ expire_at: 1791154665128 }], available_week_resets: [] } };

function zaiService(t, request) {
  const secrets = createSecretStore({ dataDir: tmp(t) });
  let info = null;
  const zai = createZaiAccount({ secrets, info: { get: () => info, set: (v) => (info = v) }, request });
  return { zai, secrets };
}

test("Z.ai sign-in stores both JWTs in the secret store, names the account, and signs out", async (t) => {
  const { zai, secrets } = zaiService(t, async (url) => {
    if (url.endsWith("/cli/init")) return INIT;
    if (url.includes("/cli/poll/")) return READY;
    if (url.endsWith("/api/auth/z/login")) return { code: 200, success: true, data: { access_token: "biz-jwt" } };
    throw new Error(`unexpected ${url}`);
  });
  assert.deepEqual(await zai.poll(), { status: "idle" });
  assert.equal((await zai.start()).authorizeUrl, "https://chat.z.ai/authorize?x=1");
  assert.deepEqual(await zai.poll(), { status: "ready", name: "Owner" });
  assert.equal(secrets.get("zai/zcode-jwt"), "zcode-jwt");
  assert.equal(secrets.get("zai/account-jwt"), "biz-jwt");
  assert.deepEqual(zai.connected(), { connected: true, name: "Owner", email: "o@x.ir" });
  assert.doesNotMatch(JSON.stringify(secrets.list()), /biz-jwt/, "the list never carries a value");
  zai.signOut();
  assert.equal(secrets.get("zai/zcode-jwt"), "");
  assert.deepEqual(zai.connected(), { connected: false, name: null, email: null });
});

test("Z.ai reset cards: counted, and use() refuses an empty window without calling /use", async (t) => {
  const calls = [];
  const { zai } = zaiService(t, async (url, init = {}) => {
    calls.push(url);
    if (url.endsWith("/cli/init")) return INIT;
    if (url.includes("/cli/poll/")) return READY;
    if (url.endsWith("/api/auth/z/login")) return { code: 0, data: { access_token: "biz-jwt" } };
    if (url.endsWith("/reset/status")) return structuredClone(STATUS_OK);
    if (url.endsWith("/reset/use")) return { code: 0 };
    throw new Error(`unexpected ${init.method} ${url}`);
  });
  assert.deepEqual(await zai.resetSummary(), { connected: false });
  await zai.start();
  await zai.poll();
  const summary = await zai.resetSummary();
  assert.equal(summary.fiveHour, 1);
  assert.equal(summary.week, 0);
  assert.deepEqual(await zai.use({ resetType: "WEEK" }), { error: "no_reset_available" });
  assert.equal(calls.filter((u) => u.endsWith("/reset/use")).length, 0);
  assert.deepEqual(await zai.use({ resetType: "FIVE_HOUR" }), { used: true });
});

// ---- routes on a fake engine registry ----
function fakeEngines() {
  const state = { accounts: [{ id: "claude", kind: "claude", label: "", endpoint: null }, { id: "cursor", kind: "cursor", label: "", endpoint: null }], keys: {}, config: {}, active: "claude", busy: new Set() };
  const engines = {
    isAccount: (id) => state.accounts.some((a) => a.id === id),
    claudeAccounts: () => state.accounts.filter((a) => a.kind === "claude" && !a.endpoint).map((a) => ({ id: a.id, label: a.label, hasKey: Boolean(state.keys[a.id]) })),
    addAccount: (kind, { slug = "", label = "", endpoint = null } = {}) => {
      let id = slug ? `${kind}-${slug}` : `${kind}-2`;
      for (let n = 2; engines.isAccount(id); n += 1) id = `${kind}-${slug || ""}${n}`;
      state.accounts.push({ id, kind, label, endpoint });
      return id;
    },
    removeAccount: (id) => (state.accounts = state.accounts.filter((a) => a.id !== id)),
    inUse: (id) => state.busy.has(id),
    activeClaude: () => state.active,
    setActiveClaude: (id) => (state.active = id),
    endpointAccount: (endpoint) => state.accounts.find((a) => a.endpoint === endpoint)?.id || null,
    setKey: (id, key) => (state.keys[id] = key),
    removeKey: (id) => delete state.keys[id],
    setConfig: (id, patch) => (state.config[id] = { ...state.config[id], ...patch }),
  };
  return { state, engines };
}
const fakeSignin = () => {
  let pendingFor = null;
  return {
    available: () => true,
    pending: (id) => pendingFor === id,
    start: async (id) => ((pendingFor = id), { url: "https://claude.ai/oauth/authorize?x" }),
    submit: async (id, code) => {
      if (code !== "good#code") throw new Error("Claude did not accept the code");
      pendingFor = null;
    },
    cancel: () => (pendingFor = null),
  };
};
const json = (body, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("Claude accounts: list, add (Karsara name -> claude-<x>), switch active, remove; main stays", async () => {
  const { state, engines } = fakeEngines();
  const api = new Hono();
  accountRoutes(api, { engines, signin: fakeSignin() });
  let list = await (await api.request("/api/providers/claude/accounts")).json();
  assert.deepEqual(list.accounts.map((a) => [a.id, a.main, a.active, a.loggedIn]), [["claude", true, true, false]]);
  const added = await api.request("/api/providers/claude/accounts", json({ id: "work" }));
  assert.equal(added.status, 201);
  assert.equal((await added.json()).id, "claude-work");
  assert.equal((await api.request("/api/providers/claude/accounts", json({ id: "work" }))).status, 409);
  list = await (await api.request("/api/providers/claude/accounts/active", json({ id: "work" }, "PUT"))).json();
  assert.equal(list.active, "claude-work");
  assert.equal(state.active, "claude-work");
  assert.equal((await api.request("/api/providers/claude/accounts/main", { method: "DELETE" })).status, 400);
  state.busy.add("claude-work");
  assert.equal((await api.request("/api/providers/claude/accounts/work", { method: "DELETE" })).status, 409);
  state.busy.clear();
  assert.equal((await api.request("/api/providers/claude/accounts/claude-work", { method: "DELETE" })).status, 200);
  assert.equal(engines.isAccount("claude-work"), false);
});

test("Claude login: start hands the address out, a bad code says what to do, a good one logs in", async () => {
  const { state, engines } = fakeEngines();
  const signin = fakeSignin();
  const realSubmit = signin.submit;
  signin.submit = async (id, code) => {
    await realSubmit(id, code);
    state.keys[id] = "sk-ant-oat-x";
  };
  const api = new Hono();
  accountRoutes(api, { engines, signin });
  assert.equal((await api.request("/api/providers/claude/login?account=nope")).status, 404);
  const start = await (await api.request("/api/providers/claude/login/start", { method: "POST" })).json();
  assert.match(start.url, /^https:\/\/claude\.ai\/oauth/);
  assert.equal((await (await api.request("/api/providers/claude/login")).json()).pending, true);
  const bad = await api.request("/api/providers/claude/login/code", json({ code: "nope" }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /دوباره|از نو/);
  const good = await (await api.request("/api/providers/claude/login/code", json({ code: "good#code" }))).json();
  assert.equal(good.loggedIn, true);
  assert.doesNotMatch(JSON.stringify(good), /sk-ant/);
});

test("keys: Karsara ids map to endpoint accounts (made once), keys never come back, custom config is checked", async () => {
  const { state, engines } = fakeEngines();
  const api = new Hono();
  accountRoutes(api, { engines, signin: fakeSignin() });
  assert.equal((await api.request("/api/providers/nope/key", json({ key: "x" }, "PUT"))).status, 400);
  assert.equal((await api.request("/api/providers/zai/key", json({ key: "has space" }, "PUT"))).status, 400);
  const put = await api.request("/api/providers/zai/key", json({ key: "zai-secret-key" }, "PUT"));
  const text = await put.text();
  assert.doesNotMatch(text, /zai-secret-key/);
  assert.equal(JSON.parse(text).id, "claude-zai");
  await api.request("/api/providers/zai/key", json({ key: "zai-secret-2" }, "PUT"));
  assert.equal(state.accounts.filter((a) => a.endpoint === "zai").length, 1, "the second key goes to the same account");
  assert.equal(state.keys["claude-zai"], "zai-secret-2");
  await api.request("/api/providers/cursor/key", json({ key: "crsr" }, "PUT"));
  assert.equal(state.keys.cursor, "crsr");
  assert.equal((await api.request("/api/providers/zai/key", { method: "DELETE" })).status, 200);
  assert.equal(state.keys["claude-zai"], undefined);
  assert.equal((await api.request("/api/providers/openrouter/key", { method: "DELETE" })).status, 404);
  assert.equal((await api.request("/api/providers/custom/config", json({ baseUrl: "http://evil.example" }, "PUT"))).status, 400);
  const ok = await (await api.request("/api/providers/custom/config", json({ baseUrl: "https://api.example.com/anthropic/", model: "m1", smallModel: "m0" }, "PUT"))).json();
  assert.equal(ok.id, "claude-custom");
  assert.deepEqual(state.config["claude-custom"], { baseUrl: "https://api.example.com/anthropic", model: "m1", smallModel: "m0" });
});

test("usage routes: limits and Z.ai degrade politely; reset is guarded and refreshes the quota", async () => {
  let invalidated = 0;
  const zaiQuota = Object.assign(async () => ({ available: true, rows: [{ id: "five_hour" }] }), { invalidate: () => (invalidated += 1) });
  const zaiAccount = {
    connected: () => ({ connected: true, name: "Owner", email: null }),
    resetSummary: async () => ({ connected: true, fiveHour: 1, week: 0 }),
    use: async ({ resetType }) => (resetType === "FIVE_HOUR" ? { used: true } : { error: "no_reset_available" }),
    start: async () => ({ authorizeUrl: "u" }),
    poll: async () => ({ status: "pending" }),
    cancelSignIn() {},
    signOut() {},
  };
  const bare = new Hono();
  accountRoutes(bare, { engines: fakeEngines().engines, signin: null });
  assert.deepEqual(await (await bare.request("/api/usage/limits")).json(), { available: false, reason: "not configured" });
  assert.deepEqual((await (await bare.request("/api/usage/zai")).json()).resets, { connected: false });
  assert.equal((await bare.request("/api/usage/zai/reset", json({ resetType: "FIVE_HOUR" }))).status, 503);

  const api = new Hono();
  accountRoutes(api, { engines: fakeEngines().engines, signin: null, zaiQuota, zaiAccount, planLimits: async () => ({ available: true, rows: [] }) });
  assert.equal((await (await api.request("/api/usage/limits")).json()).available, true);
  const usage = await (await api.request("/api/usage/zai")).json();
  assert.equal(usage.resets.fiveHour, 1);
  assert.equal((await api.request("/api/usage/zai/reset", json({ resetType: "daily" }))).status, 400);
  assert.equal((await api.request("/api/usage/zai/reset", json({ resetType: "WEEK" }))).status, 409);
  assert.equal((await api.request("/api/usage/zai/reset", json({ resetType: "FIVE_HOUR" }))).status, 200);
  assert.equal(invalidated, 1);
  assert.equal((await (await api.request("/api/auth/zai")).json()).connected, true);
});

test("/api/auth/zai sits behind the owner session; the sign-in routes stay public", async (t) => {
  const dir = tmp(t);
  const store = openStore(path.join(dir, "db.sqlite"));
  t.after(() => store.close());
  const runner = createRunner({ store, sdk: {}, agentOptions: () => ({}), log: {} });
  const app = createApp({ store, runner, auth: createAuth({ dataDir: dir, store }), extraRoutes: (api) => accountRoutes(api, { engines: fakeEngines().engines, signin: null }) });
  assert.equal((await app.request("http://localhost/api/auth/zai")).status, 401);
  assert.equal((await app.request("http://localhost/api/auth/zai/poll")).status, 401);
  assert.equal((await app.request("http://localhost/api/usage/zai")).status, 401);
  assert.equal((await app.request("http://localhost/api/auth/me")).status, 200);
});

test("Karsara account names and custom endpoint checks", () => {
  assert.equal(claudeAccountId("main"), "claude");
  assert.equal(claudeAccountId(undefined), "claude");
  assert.equal(claudeAccountId("Work-1"), "claude-work1");
  assert.equal(claudeAccountId("claude-2"), "claude-2");
  assert.equal(claudeAccountId("!!"), null);
  assert.ok(checkCustomEndpoint({ baseUrl: "http://localhost:8080" }).config);
  assert.ok(checkCustomEndpoint({ baseUrl: "https://u:p@x.example" }).error);
  assert.deepEqual(checkCustomEndpoint({}).config, { baseUrl: "", model: "", smallModel: "" });
});
