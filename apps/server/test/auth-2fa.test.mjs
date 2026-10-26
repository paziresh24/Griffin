import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { createAuth } from "../src/auth.mjs";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";
import { createSecretStore } from "../src/secrets.mjs";
import { base32Decode, base32Encode, recoveryHash, stepAt, totpCode, totpMatch } from "../src/totp.mjs";

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-2fa-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const secrets = createSecretStore({ dataDir: dir });
  const runner = createRunner({ store, sdk: {}, agentOptions: () => ({}), log: {} });
  const events = [];
  const app = createApp({ store, runner, auth: createAuth({ dataDir: dir, store, secrets, onEvent: (e) => events.push(e), ...options }) });
  const token = fs.readFileSync(path.join(dir, "owner.token"), "utf8").trim();
  const cleanup = () => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, store, secrets, token, dir, events, cleanup };
}

const origin = "http://localhost";
const remote = (ip = "203.0.113.7") => ({ incoming: { socket: { remoteAddress: ip, localAddress: "192.168.1.2" } } });
const shell = () => ({ incoming: { socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" } } });
const post = (app, url, { body, cookie, bearer, env = remote() } = {}) =>
  app.request(
    `${origin}${url}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body || {}),
    },
    env,
  );
const get = (app, url, { cookie, bearer, env = remote() } = {}) =>
  app.request(`${origin}${url}`, { headers: { ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } }, env);
const cookieOf = (res) => res.headers.getSetCookie().find((c) => c.startsWith("griffin_session=")).split(";")[0];

// Signs in, turns two-step on, and returns the app secret, the recovery codes and this page's cookie.
async function enable(app, token) {
  const first = cookieOf(await post(app, "/api/auth/login", { body: { token } }));
  const setup = await post(app, "/api/auth/2fa/setup", { cookie: first });
  assert.equal(setup.status, 200);
  const { secret, uri, svg } = await setup.json();
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(svg, /^<svg/);
  const on = await post(app, "/api/auth/2fa/enable", { cookie: first, body: { code: totpCode(secret, stepAt() - 1) } });
  assert.equal(on.status, 200);
  const { recoveryCodes } = await on.json();
  return { secret, recoveryCodes, first, cookie: cookieOf(on) };
}

test("totp matches RFC 6238 and refuses junk", () => {
  // RFC 6238 appendix B, SHA1 seed "12345678901234567890", T=59s → 94287082 (last 6: 287082).
  const seed = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(base32Decode(seed).toString(), "12345678901234567890");
  assert.equal(totpCode(seed, 1), "287082");
  assert.equal(totpCode(seed, Math.floor(1111111109 / 30)), "081804");
  assert.equal(totpMatch(seed, "287082", 59_000), 1);
  assert.equal(totpMatch(seed, "287083", 59_000), null);
  assert.equal(totpMatch(seed, "abc", 59_000), null);
  assert.equal(recoveryHash("ABCDE-fghjk"), recoveryHash("abcdefghjk"));
});

test("with two-step on, the token alone no longer signs in from the network", async () => {
  const { app, token, events, cleanup } = setup();
  try {
    const { secret, first, cookie } = await enable(app, token);
    // Other sessions (whoever held the token) are out; this page stays in.
    assert.equal((await get(app, "/api/chats", { cookie: first })).status, 401);
    assert.equal((await get(app, "/api/chats", { cookie })).status, 200);
    assert.ok(events.some((e) => e.kind === "2fa-on"));

    const bare = await post(app, "/api/auth/login", { body: { token } });
    assert.equal(bare.status, 401);
    assert.equal((await bare.json()).needCode, true);
    assert.equal(bare.headers.get("set-cookie"), null);

    const wrong = await post(app, "/api/auth/login", { body: { token, code: "000000" } });
    assert.equal(wrong.status, 401);
    assert.ok(events.some((e) => e.kind === "code-miss"), "a right token with a wrong code tells the owner");

    const code = totpCode(secret, stepAt());
    const ok = await post(app, "/api/auth/login", { body: { token, code } });
    assert.equal(ok.status, 200);
    assert.equal((await get(app, "/api/chats", { cookie: cookieOf(ok) })).status, 200);
    assert.ok(events.some((e) => e.kind === "login" && e.via === "totp"));

    // The same code cannot be used twice.
    assert.equal((await post(app, "/api/auth/login", { body: { token, code } })).status, 401);
    // A wrong token is still just a wrong token.
    assert.equal((await (await post(app, "/api/auth/login", { body: { token: "nope", code } })).json()).error, "invalid token");
  } finally {
    cleanup();
  }
});

test("recovery codes work once each", async () => {
  const { app, token, cleanup } = setup();
  try {
    const { recoveryCodes } = await enable(app, token);
    assert.equal(recoveryCodes.length, 10);
    const ok = await post(app, "/api/auth/login", { body: { token, code: recoveryCodes[0].toUpperCase() } });
    assert.equal(ok.status, 200);
    assert.equal((await post(app, "/api/auth/login", { body: { token, code: recoveryCodes[0] } })).status, 401);
    const state = await (await get(app, "/api/auth/2fa", { cookie: cookieOf(ok) })).json();
    assert.deepEqual([state.enabled, state.recoveryLeft], [true, 9]);
  } finally {
    cleanup();
  }
});

test("the owner token as Bearer works only from this machine while two-step is on", async () => {
  const { app, token, cleanup } = setup();
  try {
    assert.equal((await get(app, "/api/chats", { bearer: token })).status, 200);
    await enable(app, token);
    assert.equal((await get(app, "/api/chats", { bearer: token })).status, 401);
    assert.equal((await get(app, "/api/chats", { bearer: token, env: shell() })).status, 200);
    // Through a proxy on the same machine is the network, not the machine.
    const proxied = await app.request(`${origin}/api/chats`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "198.51.100.4" } }, shell());
    assert.equal(proxied.status, 401);
    // The server's own scripts still sign in with the token alone (deploy/fleet: HealthSession).
    assert.equal((await post(app, "/api/auth/login", { body: { token }, env: shell() })).status, 200);
  } finally {
    cleanup();
  }
});

test("turning it off needs a code, or the token from this machine", async () => {
  const { app, token, events, secrets, cleanup } = setup();
  try {
    const { secret, cookie } = await enable(app, token);
    assert.equal((await post(app, "/api/auth/2fa/disable", { cookie, body: { code: "123456" } })).status, 400);
    assert.equal((await post(app, "/api/auth/2fa/disable", { bearer: token })).status, 401);
    assert.equal((await post(app, "/api/auth/2fa/disable", { cookie, body: { code: totpCode(secret, stepAt()) } })).status, 200);
    assert.ok(!secrets.get("auth/totp"));
    assert.equal((await post(app, "/api/auth/login", { body: { token } })).status, 200);

    const again = await enable(app, token);
    assert.equal((await post(app, "/api/auth/2fa/disable", { bearer: token, env: shell() })).status, 200);
    assert.ok(events.some((e) => e.kind === "2fa-off" && e.via === "local"));
    assert.equal((await get(app, "/api/auth/2fa", { cookie: again.cookie })).status, 200);
  } finally {
    cleanup();
  }
});

test("setup and enable need the page's cookie, not the token", async () => {
  const { app, token, cleanup } = setup();
  try {
    assert.equal((await post(app, "/api/auth/2fa/setup", { bearer: token })).status, 401);
    assert.equal((await post(app, "/api/auth/2fa/enable", { bearer: token, body: { code: "123456" } })).status, 401);
    assert.equal((await get(app, "/api/auth/2fa")).status, 401);
    const cookie = cookieOf(await post(app, "/api/auth/login", { body: { token } }));
    // A code from no setup at all is refused.
    assert.equal((await post(app, "/api/auth/2fa/enable", { cookie, body: { code: "123456" } })).status, 410);
  } finally {
    cleanup();
  }
});

test("required: a new sign-in can only set two-step up, then everything opens", async () => {
  const { app, token, cleanup } = setup({ requireTwoStep: true });
  try {
    const first = cookieOf(await post(app, "/api/auth/login", { body: { token } }));
    assert.deepEqual(await (await get(app, "/api/auth/me", { cookie: first })).json(), { authenticated: true, setupRequired: true });
    const blocked = await get(app, "/api/chats", { cookie: first });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).setupRequired, true);
    // The server's own scripts are not held up.
    assert.equal((await get(app, "/api/chats", { bearer: token, env: shell() })).status, 200);
    assert.equal((await (await get(app, "/api/auth/2fa", { cookie: first })).json()).required, true);

    const setupRes = await post(app, "/api/auth/2fa/setup", { cookie: first });
    const { secret } = await setupRes.json();
    const on = await post(app, "/api/auth/2fa/enable", { cookie: first, body: { code: totpCode(secret, stepAt() - 1) } });
    assert.equal(on.status, 200);
    const cookie = cookieOf(on);
    assert.deepEqual(await (await get(app, "/api/auth/me", { cookie })).json(), { authenticated: true });
    assert.equal((await get(app, "/api/chats", { cookie })).status, 200);

    // The page cannot turn it off; the server's shell can (a lost phone), and the next sign-in sets it up again.
    assert.equal((await post(app, "/api/auth/2fa/disable", { cookie, body: { code: totpCode(secret, stepAt()) } })).status, 409);
    assert.equal((await post(app, "/api/auth/2fa/disable", { bearer: token, env: shell() })).status, 200);
    const again = cookieOf(await post(app, "/api/auth/login", { body: { token } }));
    assert.equal((await get(app, "/api/chats", { cookie: again })).status, 403);
  } finally {
    cleanup();
  }
});
