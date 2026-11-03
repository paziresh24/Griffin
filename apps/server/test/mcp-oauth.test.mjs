import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpServers } from "../src/mcp-servers.mjs";
import { MCP_OAUTH_CALLBACK, callbackUrl, createMcpOauth, registerMcpOauthCallback } from "../src/mcp-oauth.mjs";
import { createApp } from "../src/app.mjs";
import { createAuth } from "../src/auth.mjs";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";
import { createSecretStore } from "../src/secrets.mjs";

const REDIRECT = "https://g.example/api/public/mcp-oauth/callback";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpo-"));
  const mcp = createMcpServers({ file: path.join(dir, ".claude.json") });
  mcp.save({ name: "tracker", server: { type: "http", url: "https://f.example/mcp" } });
  const secrets = createSecretStore({ dataDir: dir });
  const calls = [];
  let tokenCount = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, init });
    const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (u.endsWith("/.well-known/oauth-protected-resource/mcp") || u.endsWith("/.well-known/oauth-protected-resource")) return json(404, {});
    if (u.endsWith("/.well-known/oauth-authorization-server")) return json(200, { authorization_endpoint: "https://f.example/oauth/authorize", token_endpoint: "https://f.example/oauth/token", registration_endpoint: "https://f.example/oauth/register" });
    if (u.endsWith("/oauth/register")) return json(201, { client_id: "cid-1" });
    if (u.endsWith("/oauth/token")) {
      tokenCount += 1;
      return json(200, { access_token: `at-${tokenCount}`, refresh_token: "rt-1", token_type: "Bearer", expires_in: 3600 });
    }
    return json(404, {});
  };
  let t = 1_000_000;
  const oauth = createMcpOauth({ mcp, secrets, fetchImpl, now: () => t });
  return { mcp, secrets, oauth, calls, advance: (ms) => (t += ms) };
}

test("sign-in: discovery, registration, PKCE, code exchange; token only in the entry header and the secret store", async () => {
  const { mcp, oauth, calls } = setup();
  const { url } = await oauth.start({ name: "tracker", redirectUri: REDIRECT });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://f.example/oauth/authorize");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("client_id"), "cid-1");
  assert.equal(u.searchParams.get("redirect_uri"), REDIRECT);
  await assert.rejects(oauth.finish({ state: "nope", code: "c" }), /expired/);
  await oauth.finish({ state: u.searchParams.get("state"), code: "the-code" });
  const exchange = calls.find((c) => c.u.endsWith("/oauth/token"));
  const body = new URLSearchParams(exchange.init.body);
  assert.equal(body.get("code"), "the-code");
  assert.ok(body.get("code_verifier"));
  assert.equal(mcp.get("tracker").headers.Authorization, "Bearer at-1");
  assert.equal(oauth.status("tracker").signedIn, true);
  assert.ok(!JSON.stringify(mcp.list()).includes("Bearer"));
  // a state works once
  await assert.rejects(oauth.finish({ state: u.searchParams.get("state"), code: "c" }), /expired/);
});

test("ensureFresh renews a token about to expire, leaves a fresh one, and rejects bad redirect / stdio", async () => {
  const { mcp, oauth, advance } = setup();
  const { url } = await oauth.start({ name: "tracker", redirectUri: REDIRECT });
  await oauth.finish({ state: new URL(url).searchParams.get("state"), code: "c" });
  await oauth.ensureFresh();
  assert.equal(mcp.get("tracker").headers.Authorization, "Bearer at-1");
  advance(3500_000);
  await oauth.ensureFresh();
  assert.equal(mcp.get("tracker").headers.Authorization, "Bearer at-2");
  await assert.rejects(oauth.start({ name: "tracker", redirectUri: "https://x/evil" }), /redirect/);
  await assert.rejects(oauth.start({ name: "tracker", redirectUri: "https://g.example/api/mcp-oauth/callback" }), /redirect/, "the old, session-only path is not handed out any more");
  mcp.save({ name: "local", server: { type: "stdio", command: "npx" } });
  await assert.rejects(oauth.start({ name: "local", redirectUri: REDIRECT }), /http\/sse/);
  oauth.forget("tracker");
  assert.equal(oauth.status("tracker").signedIn, false);
});

test("the callback is public: a browser without a Griffin session finishes the sign-in; state still binds it", async () => {
  const { mcp, oauth, secrets } = setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpo-app-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const runner = createRunner({ store, sdk: {}, agentOptions: () => ({}), log: {} });
  const app = createApp({ store, runner, auth: createAuth({ dataDir: dir, store }), extraRoutes: (api) => registerMcpOauthCallback(api, oauth) });
  try {
    assert.equal(callbackUrl("https://g.example/some/page"), REDIRECT);
    assert.ok(MCP_OAUTH_CALLBACK.startsWith("/api/public/"));
    // no cookie, no token: the rest of the API still says no
    assert.equal((await app.request("http://localhost/api/chats")).status, 401);
    const { url } = await oauth.start({ name: "tracker", redirectUri: REDIRECT });
    const state = new URL(url).searchParams.get("state");
    // a made-up state is refused (page, not a token), and does not spend the real one
    const forged = await app.request(`http://localhost${MCP_OAUTH_CALLBACK}?state=forged&code=c`);
    assert.equal(forged.status, 200);
    assert.match(await forged.text(), /ورود انجام نشد/);
    assert.equal(mcp.get("tracker").headers?.Authorization, undefined);
    const done = await app.request(`http://localhost${MCP_OAUTH_CALLBACK}?state=${encodeURIComponent(state)}&code=the-code`);
    assert.equal(done.status, 200);
    assert.match(await done.text(), /ورود انجام شد/);
    assert.equal(done.headers.get("cache-control"), "no-store");
    assert.equal(mcp.get("tracker").headers.Authorization, "Bearer at-1");
    // the same state twice: refused
    assert.match(await (await app.request(`http://localhost${MCP_OAUTH_CALLBACK}?state=${encodeURIComponent(state)}&code=x`)).text(), /ورود انجام نشد/);
    // the old path is still behind the session
    assert.equal((await app.request(`http://localhost/api/mcp-oauth/callback?state=x&code=y`)).status, 401);
    assert.ok(secrets);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
