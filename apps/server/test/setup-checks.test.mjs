// What a new user still has to set up for full use, read from real server state: a GitLab login git can use, the VPN when Telegram is not reachable directly, the
// speech-to-text key, and the company secrets (Infisical) signed in with the user's own account.
// Every secret given here is stored, checked and never handed back to the browser or a log.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createSecretStore } from "../src/secrets.mjs";
import { createVpn, linkToOutbound, outboundId } from "../src/vpn.mjs";
import { GITLAB_HOST, VAULT_BASE, createSetupChecks, decodeVaultPaste, localVaultRoute, secretSlots, selfHome, setupChecksRoutes, setupRoutes } from "../src/setup-checks.mjs";

// Built at runtime: a literal token-shaped fixture trips secret scanners.
const GL = (rest) => ["glpat", rest].join("-");
const GL_TOKEN = GL("SECRETgitlabTOKEN-1234");
const tmp = (p = "griffin-setup-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
// A JWT-shaped token with an expiry (payload only matters; nothing here verifies the signature).
const jwt = (payload) => ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify(payload)).toString("base64url"), "c2lnbmF0dXJlU0VDUkVU"].join(".");
const LIVE_JWT = jwt({ authTokenType: "accessToken", userId: "u1", exp: Math.floor(Date.now() / 1000) + 86_400 });
const OLD_JWT = jwt({ authTokenType: "accessToken", userId: "u1", exp: Math.floor(Date.now() / 1000) - 60 });
// What the Infisical page shows for manual paste: base64 of {JTWToken, email, privateKey}.
const pasteOf = (token) => Buffer.from(JSON.stringify({ JTWToken: token, email: "me@example.com", privateKey: "" })).toString("base64");

// A git with its own HOME: never the host user's real credentials.
function gitEnv() {
  const home = tmp("griffin-home-");
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") };
}

// Fake GitLab + Infisical: only the calls the checks make.
function fakeFetch({ gitlab = {}, vault = {} } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    calls.push({ url: String(url), headers });
    const u = new URL(url);
    if (u.pathname === "/api/v4/user") {
      if (gitlab.down) throw new Error("connect ECONNREFUSED");
      const ok = headers.get("private-token") === (gitlab.token ?? GL_TOKEN);
      return new Response(JSON.stringify(ok ? { username: "me", email: "me@example.com" } : { message: "401 Unauthorized" }), { status: ok ? 200 : 401 });
    }
    if (u.pathname === "/api/v2/users/me") {
      if (vault.down) throw new Error("connect ECONNREFUSED");
      const ok = headers.get("authorization") === `Bearer ${vault.token ?? LIVE_JWT}`;
      return new Response(JSON.stringify(ok ? { user: { email: "me@example.com" } } : { message: "Token missing" }), { status: ok ? 200 : 401 });
    }
    return new Response("{}", { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

function checksFor({ fetchFn = fakeFetch(), env = gitEnv(), home = null, run, applyProxy, sttReady } = {}) {
  const dataDir = tmp();
  const keyStore = secretSlots(createSecretStore({ dataDir }));
  const checks = createSetupChecks({ keyStore, fetchFn, env, home, ...(run ? { run } : {}), ...(applyProxy ? { applyProxy } : {}), ...(sttReady ? { sttReady } : {}) });
  return { checks, keyStore, dataDir, env };
}

function appFor(checks) {
  const app = new Hono();
  setupRoutes(app, { checks });
  return app;
}
const post = (app, url, body) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function captureLogs(fn) {
  const lines = [];
  const orig = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    orig[k] = console[k];
    console[k] = (...args) => lines.push(args.map(String).join(" "));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return lines.join("\n");
}

// ---------- GitLab ----------

test("gitlab: no stored git credential is «missing»", async () => {
  const { checks } = checksFor();
  assert.equal((await checks.status()).gitlab.state, "missing");
});

test("gitlab: a token pasted in the app is checked, stored for git and never sent back", async () => {
  const { checks, env } = checksFor();
  const app = appFor(checks);
  let res;
  const logs = await captureLogs(async () => {
    res = await post(app, "/api/setup/gitlab", { token: GL_TOKEN });
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.ok(!text.includes(GL_TOKEN) && !text.includes("SECRETgitlab"), "the token is in the response");
  assert.ok(!logs.includes("SECRETgitlab"), "the token is in a log line");
  assert.equal(JSON.parse(text).gitlab.state, "ok");
  // git itself now answers with it, as a command-line login would have left it.
  const filled = execFileSync("git", ["credential", "fill"], { input: `protocol=https\nhost=${GITLAB_HOST}\n\n`, env: { ...env, GIT_TERMINAL_PROMPT: "0" } }).toString();
  assert.match(filled, /^username=me$/m);
  assert.match(filled, new RegExp(`^password=${GL_TOKEN}$`, "m"));
  assert.equal(execFileSync("git", ["config", "--global", "user.name"], { env }).toString().trim(), "me");
  assert.equal(execFileSync("git", ["config", "--global", "user.email"], { env }).toString().trim(), "me@example.com");
  const status = JSON.stringify(await (await app.request("/api/setup/status")).json());
  assert.ok(!status.includes("SECRETgitlab"));
  assert.match(status, /"gitlab":\{"state":"ok"/);
});

test("gitlab: a token GitLab refuses is not stored", async () => {
  const { checks, env } = checksFor();
  const res = await post(appFor(checks), "/api/setup/gitlab", { token: GL("wrong-token") });
  assert.equal(res.status, 400);
  assert.ok(!(await res.text()).includes(GL("wrong")));
  assert.equal((await checks.status()).gitlab.state, "missing");
  assert.throws(() => execFileSync("git", ["credential", "fill"], { input: `protocol=https\nhost=${GITLAB_HOST}\n\n`, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, stdio: "pipe" }));
});

test("gitlab: a stored credential GitLab now refuses is «broken»; the answer is cached", async () => {
  const env = gitEnv();
  execFileSync("git", ["config", "--global", "credential.helper", "store"], { env });
  execFileSync("git", ["credential", "approve"], { input: `protocol=https\nhost=${GITLAB_HOST}\nusername=me\npassword=${GL("revoked")}\n\n`, env });
  const fetchFn = fakeFetch();
  const { checks } = checksFor({ env, fetchFn });
  assert.equal((await checks.status()).gitlab.state, "broken");
  const asked = fetchFn.calls.length;
  assert.ok(fetchFn.calls.some((c) => c.headers.get("authorization") === `Bearer ${GL("revoked")}`), "an OAuth-style token is tried as Bearer too");
  await checks.status();
  assert.equal(fetchFn.calls.length, asked, "GitLab asked once, not on every poll");
});

test("gitlab: a stored credential that answers 200 is «ok» with the user name", async () => {
  const env = gitEnv();
  execFileSync("git", ["config", "--global", "credential.helper", "store"], { env });
  execFileSync("git", ["credential", "approve"], { input: `protocol=https\nhost=${GITLAB_HOST}\nusername=me\npassword=${GL_TOKEN}\n\n`, env });
  const { checks } = checksFor({ env });
  const status = await checks.status();
  assert.deepEqual(status.gitlab, { state: "ok", user: "me" });
  assert.ok(!JSON.stringify(status).includes("SECRETgitlab"));
});

test("gitlab: GitLab out of reach is «unknown», never a nag", async () => {
  const env = gitEnv();
  execFileSync("git", ["config", "--global", "credential.helper", "store"], { env });
  execFileSync("git", ["credential", "approve"], { input: `protocol=https\nhost=${GITLAB_HOST}\nusername=me\npassword=${GL_TOKEN}\n\n`, env });
  const { checks } = checksFor({ env, fetchFn: fakeFetch({ gitlab: { down: true } }) });
  assert.equal((await checks.status()).gitlab.state, "unknown");
});

// ---------- Speech to text ----------

test("stt: complete exactly when a speech key is set", async () => {
  let key = "";
  const { checks } = checksFor({ sttReady: () => Boolean(key) });
  assert.equal((await checks.status()).stt.state, "missing");
  key = "sk-stt-SECRET";
  const status = await checks.status();
  assert.equal(status.stt.state, "ok");
  assert.ok(!JSON.stringify(status).includes("sk-stt-SECRET"));
});

// ---------- VPN ----------

const VLESS = "vless://0b1c2d3e-aaaa-bbbb-cccc-SECRETUUID00@vpn.example.com:443?security=tls&type=tcp&sni=vpn.example.com#me";

// Answers for the network probes, by what is asked.
function fakeRun({ direct = false, viaVpn = true, xray = true } = {}) {
  const calls = [];
  const real = async (cmd, args, opts = {}) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.on("error", (error) => resolve({ code: 127, stdout, stderr: String(error.message) }));
      // A child that exits before reading its stdin (a fake xray) must not fail the test with EPIPE.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input || "");
    });
  const fn = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "curl") {
      const viaProxy = args.includes("--socks5-hostname") || args.includes("-x");
      const up = viaProxy ? viaVpn : direct;
      return { code: 0, stdout: up ? "302" : "000", stderr: "" };
    }
    if (cmd === "pgrep") return { code: xray ? 0 : 1, stdout: xray ? "123\n" : "", stderr: "" };
    if (cmd === "pkill") return { code: 1, stdout: "", stderr: "" };
    return real(cmd, args, opts);
  };
  fn.calls = calls;
  return fn;
}

test("vpn: no kit installed (a dev or container host): nothing to offer", async () => {
  const { checks } = checksFor({ home: null, run: fakeRun() });
  assert.equal((await checks.status()).vpn.kit, false);
});

// ---------- Company data (Infisical) ----------

test("vault: the pasted browser token (base64 JSON) and a bare JWT both decode; junk does not", () => {
  assert.equal(decodeVaultPaste(pasteOf(LIVE_JWT)), LIVE_JWT);
  assert.equal(decodeVaultPaste(`  ${pasteOf(LIVE_JWT).replace(/(.{40})/g, "$1\n")}  `), LIVE_JWT, "wrapped when copied");
  assert.equal(decodeVaultPaste(LIVE_JWT), LIVE_JWT);
  assert.equal(decodeVaultPaste("hello"), null);
  assert.equal(decodeVaultPaste(Buffer.from('{"JTWToken":"x"}').toString("base64")), null);
});

test("vault: not signed in is «missing»", async () => {
  const { checks } = checksFor();
  assert.equal((await checks.status()).vault.state, "missing");
});

test("vault: a pasted token is checked with Infisical, kept in the encrypted box, never returned or logged", async () => {
  const fetchFn = fakeFetch();
  const { checks, keyStore, dataDir } = checksFor({ fetchFn });
  const app = appFor(checks);
  let res;
  const logs = await captureLogs(async () => {
    res = await post(app, "/api/setup/vault", { token: pasteOf(LIVE_JWT) });
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const secretPart = LIVE_JWT.split(".")[1];
  assert.ok(!text.includes(secretPart) && !logs.includes(secretPart), "the token came back");
  assert.deepEqual(JSON.parse(text).vault.state, "ok");
  assert.equal(JSON.parse(text).vault.email, "me@example.com");
  assert.ok(fetchFn.calls.some((c) => c.url === `${VAULT_BASE}/api/v2/users/me`));
  assert.equal(keyStore.getInternal("infisical_token"), LIVE_JWT);
  assert.ok(!fs.readFileSync(path.join(dataDir, "secrets.json"), "utf8").includes(secretPart), "stored in plain text");
  const status = await (await app.request("/api/setup/status")).text();
  assert.ok(!status.includes(secretPart));
});

test("vault: a token Infisical refuses is not stored", async () => {
  const { checks, keyStore } = checksFor({ fetchFn: fakeFetch({ vault: { token: "other" } }) });
  const res = await post(appFor(checks), "/api/setup/vault", { token: pasteOf(LIVE_JWT) });
  assert.equal(res.status, 400);
  assert.equal(keyStore.getInternal("infisical_token"), null);
});

test("vault: an expired token is «broken» (sign in again), without asking Infisical", async () => {
  const fetchFn = fakeFetch();
  const { checks, keyStore } = checksFor({ fetchFn });
  keyStore.setInternal("infisical_token", OLD_JWT);
  assert.equal((await checks.status()).vault.state, "broken");
  assert.equal(fetchFn.calls.length, 0);
});

test("vault: a token Infisical now answers 401 is «broken»", async () => {
  const { checks, keyStore } = checksFor({ fetchFn: fakeFetch({ vault: { token: "other" } }) });
  keyStore.setInternal("infisical_token", LIVE_JWT);
  assert.equal((await checks.status()).vault.state, "broken");
});

test("vault: sign out removes the token", async () => {
  const { checks, keyStore } = checksFor();
  keyStore.setInternal("infisical_token", LIVE_JWT);
  const res = await appFor(checks).request("/api/setup/vault", { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal(keyStore.getInternal("infisical_token"), null);
});

// The one place the token leaves the server: the local `vault-run` command, on this machine, with
// the owner token. Never through a proxy, never without the owner token.
function localApp(checks, dataDir) {
  fs.writeFileSync(path.join(dataDir, "owner.token"), "owner-SECRET-token\n", { mode: 0o600 });
  const app = new Hono();
  localVaultRoute(app, { checks, ownerTokenFile: path.join(dataDir, "owner.token") });
  return app;
}
const local = (app, { token = "owner-SECRET-token", peer = "127.0.0.1", headers = {} } = {}) =>
  app.request("/local/v1/vault-token", { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }, { incoming: { socket: { remoteAddress: peer, localAddress: "127.0.0.1" } } });

test("vault local route: only this machine, only with the owner token, never through a proxy", async () => {
  const { checks, keyStore, dataDir } = checksFor();
  keyStore.setInternal("infisical_token", LIVE_JWT);
  const app = localApp(checks, dataDir);
  const ok = await local(app);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { token: LIVE_JWT, base: VAULT_BASE });
  assert.equal((await local(app, { token: null })).status, 401);
  assert.equal((await local(app, { token: "owner-SECRET-tokeX" })).status, 401);
  assert.equal((await local(app, { peer: "192.0.2.20" })).status, 403);
  assert.equal((await local(app, { headers: { "x-forwarded-for": "8.8.8.8" } })).status, 403, "a reverse proxy on this host");
  keyStore.setInternal("infisical_token", OLD_JWT);
  assert.equal((await local(app)).status, 401, "expired: sign in again");
  keyStore.removeInternal("infisical_token");
  assert.equal((await local(app)).status, 404);
});

// ---------- vault-run ----------

// A fake Griffin (the local route) and a fake Infisical on one port.

// ---------- review round (2026-10-14) ----------

test("gitlab: next to a memory-only helper (cache), the token is also stored for this host", async () => {
  const env = gitEnv();
  execFileSync("git", ["config", "--global", "credential.helper", "cache --timeout=1"], { env });
  const { checks } = checksFor({ env });
  const res = await post(appFor(checks), "/api/setup/gitlab", { token: GL_TOKEN });
  assert.equal(res.status, 200, await res.text());
  assert.equal(execFileSync("git", ["config", "--global", `credential.https://${GITLAB_HOST}.helper`], { env }).toString().trim(), "store");
  assert.match(fs.readFileSync(path.join(env.HOME, ".git-credentials"), "utf8"), new RegExp(GITLAB_HOST.replace(/\./g, "\\.")));
  spawn("git", ["credential-cache", "exit"], { env, stdio: "ignore" });
});

test("vault local route over a real socket: this machine with the owner token gets it; the browser's API never does", async () => {
  const { getRequestListener } = await import("@hono/node-server");
  const { checks, keyStore, dataDir } = checksFor();
  keyStore.setInternal("infisical_token", LIVE_JWT);
  const app = localApp(checks, dataDir);
  setupRoutes(app, { checks });
  const server = http.createServer(getRequestListener(app.fetch));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/local/v1/vault-token`, { headers: { authorization: "Bearer owner-SECRET-token" } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).token, LIVE_JWT);
    const viaCdn = await fetch(`${base}/local/v1/vault-token`, { headers: { authorization: "Bearer owner-SECRET-token", "true-client-ip": "8.8.8.8" } });
    assert.equal(viaCdn.status, 403);
    const status = await (await fetch(`${base}/api/setup/status`)).text();
    assert.ok(!status.includes(LIVE_JWT.split(".")[1]));
  } finally {
    server.close();
  }
});

// ---------- Griffin wiring ----------

test("setupChecksRoutes: the checklist and the loopback vault route on one call; secrets under setup/*", async () => {
  const dataDir = tmp();
  const secrets = createSecretStore({ dataDir });
  const app = new Hono();
  setupChecksRoutes(app, { secrets, dataDir, sttReady: () => true, env: gitEnv() });
  const status = await (await app.request("/api/setup/status")).json();
  assert.equal(status.stt.state, "ok");
  assert.equal(status.vault.state, "missing");
  assert.equal(status.vpn.kit, false);
  secretSlots(secrets).setInternal("infisical_token", LIVE_JWT);
  assert.ok(secrets.has("setup/infisical_token"));
  // No socket here: never served to a caller that is not this machine.
  assert.equal((await app.request("/local/v1/vault-token", { headers: { authorization: "Bearer x" } })).status, 403);
});

test("selfHome: GRIFFIN_HOME, else the data folder's parent when the VPN kit is there, else none", () => {
  const home = tmp("griffin-self-");
  fs.mkdirSync(path.join(home, "vpn"));
  fs.mkdirSync(path.join(home, "data"));
  assert.equal(selfHome(path.join(home, "data"), {}), null);
  fs.writeFileSync(path.join(home, "vpn", "link2config.py"), "");
  assert.equal(selfHome(path.join(home, "data"), {}), home);
  assert.equal(selfHome(path.join(home, "data"), { GRIFFIN_HOME: "/elsewhere" }), "/elsewhere");
});

test("vpn (built-in): the list shows every server added, one can be removed, and a stranger's id is a 404", async () => {
  const dataDir = tmp("griffin-vpnlist-");
  const dir = path.join(dataDir, "vpn");
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "fake-xray");
  fs.writeFileSync(bin, '#!/bin/sh\ncase "$*" in *-test*) exit 0;; esac\nexec sleep 30\n', { mode: 0o755 });
  const good = linkToOutbound(VLESS);
  const bad = linkToOutbound("trojan://pw-SECRET@t.example.com:443?sni=t.example.com#spare");
  const row = (o, live) => ({ id: outboundId(o), outbound: o, remark: o.remark || "", addedAt: 1, live, ms: live ? 250 : null, claude: live, telegram: live, checkedAt: 9 });
  fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify({ servers: [row(good, true), row(bad, false)], used: [outboundId(good)], hosts: [] }));
  const vpn = createVpn({ dataDir, env: { GRIFFIN_XRAY: bin }, log: { info() {}, error() {} } });
  const keyStore = secretSlots(createSecretStore({ dataDir }));
  const checks = createSetupChecks({ keyStore, fetchFn: fakeFetch(), env: gitEnv(), home: null, vpn });
  const app = appFor(checks);
  try {
    const listed = await (await app.request("/api/setup/vpn")).json();
    assert.deepEqual(listed.vpn.servers.map((x) => [x.name, x.state]), [["me", "live"], ["spare", "dead"]]);
    assert.ok(!JSON.stringify(listed).includes("SECRET"), "no server secret in the list");
    assert.equal((await app.request("/api/setup/vpn/servers/nope", { method: "DELETE" })).status, 404);
    const gone = await (await app.request(`/api/setup/vpn/servers/${listed.vpn.servers[1].id}`, { method: "DELETE" })).json();
    assert.deepEqual(gone.vpn.servers.map((x) => x.name), ["me"]);
    const cleared = await (await app.request("/api/setup/vpn", { method: "DELETE" })).json();
    assert.deepEqual(cleared.vpn.servers, []);
  } finally {
    await vpn.stop();
  }
});

test("vpn (built-in): no built-in VPN on this server: the list is empty and a removal is refused", async () => {
  const { checks } = checksFor({});
  const app = appFor(checks);
  assert.deepEqual((await (await app.request("/api/setup/vpn")).json()).vpn, { builtin: false, servers: [] });
  assert.equal((await app.request("/api/setup/vpn/servers/x", { method: "DELETE" })).status, 409);
});

test("vpn (built-in): the owner's direct / VPN routes are saved from the app, and a refused line is named", async () => {
  const dataDir = tmp("griffin-vpnrules-");
  fs.mkdirSync(path.join(dataDir, "vpn"), { recursive: true });
  const vpn = createVpn({ dataDir, env: { GRIFFIN_XRAY: "/nonexistent/xray" }, log: { info() {}, error() {} } });
  const keyStore = secretSlots(createSecretStore({ dataDir }));
  const app = appFor(createSetupChecks({ keyStore, fetchFn: fakeFetch(), env: gitEnv(), home: null, vpn }));
  const put = (body) => app.request("/api/setup/vpn/rules", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ok = await put({ direct: "Svc.Example.com\n10.20.0.0/16", proxied: "tool.example.net" });
  assert.equal(ok.status, 200);
  const view = (await ok.json()).vpn;
  assert.deepEqual([view.routing.direct, view.routing.proxied], [["svc.example.com", "10.20.0.0/16"], ["tool.example.net"]]);
  assert.deepEqual((await (await app.request("/api/setup/vpn")).json()).vpn.routing.direct, ["svc.example.com", "10.20.0.0/16"]);
  const bad = await put({ direct: "fine.example.com\n10.0.0.0/40" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /10\.0\.0\.0\/40/);
  assert.deepEqual((await (await app.request("/api/setup/vpn")).json()).vpn.routing.direct, ["svc.example.com", "10.20.0.0/16"], "nothing changed");
  // No built-in VPN on this install: refused, not silently accepted.
  const none = appFor(checksFor({}).checks);
  assert.equal((await none.request("/api/setup/vpn/rules", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status, 409);
});
