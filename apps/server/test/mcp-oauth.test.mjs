import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpServers } from "../src/mcp-servers.mjs";
import { createMcpOauth } from "../src/mcp-oauth.mjs";
import { createSecretStore } from "../src/secrets.mjs";

const REDIRECT = "https://g.example/api/mcp-oauth/callback";

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
  mcp.save({ name: "local", server: { type: "stdio", command: "npx" } });
  await assert.rejects(oauth.start({ name: "local", redirectUri: REDIRECT }), /http\/sse/);
  oauth.forget("tracker");
  assert.equal(oauth.status("tracker").signedIn, false);
});
