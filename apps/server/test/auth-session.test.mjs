// Session ids, server-side logout, Karsara cookie migration, the global failed-login cap, Secure
// detection behind a proxy, PUBLIC_URL origin, and SSE streams closing on revocation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serializeSigned } from "hono/utils/cookie";
import { createApp } from "../src/app.mjs";
import { createAuth } from "../src/auth.mjs";
import { parseTrustedProxies } from "../src/listen.mjs";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";

function setup({ auth = {}, app: appOptions = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-auths-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const runner = createRunner({ store, sdk: {}, agentOptions: () => ({}), log: {} });
  const app = createApp({ store, runner, auth: createAuth({ dataDir: dir, store, ...auth }), ...appOptions });
  const token = fs.readFileSync(path.join(dir, "owner.token"), "utf8").trim();
  const cleanup = () => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, store, token, cleanup };
}

const origin = "http://localhost";
const loginRes = (app, token, { headers = {}, env } = {}) =>
  app.request(
    `${origin}/api/auth/login`,
    { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify({ token }) },
    env,
  );
const login = async (app, token) => (await loginRes(app, token)).headers.get("set-cookie").split(";")[0];
const chats = (app, cookie) => app.request(`${origin}/api/chats`, { headers: { cookie } });
const signed = async (store, name, value) => (await serializeSigned(name, value, store.getKv("session_secret"))).split(";")[0];

test("a sign-in lasts 24 hours from when it was made", async () => {
  const { app, token, store, cleanup } = setup();
  try {
    const res = await loginRes(app, token);
    assert.match(res.headers.get("set-cookie"), /Max-Age=86400/);
    const v = store.getKv("session_version") || 1;
    assert.equal((await chats(app, await signed(store, "griffin_session", `${Date.now() - 23 * 3_600_000}.${v}.a`))).status, 200);
    assert.equal((await chats(app, await signed(store, "griffin_session", `${Date.now() - 25 * 3_600_000}.${v}.b`))).status, 401);
  } finally {
    cleanup();
  }
});

test("logout revokes the session id server-side; other sessions live on", async () => {
  const { app, token, store, cleanup } = setup();
  try {
    const a = await login(app, token);
    const b = await login(app, token);
    await app.request(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie: a, origin } });
    assert.equal((await chats(app, a)).status, 401, "a copied cookie dies with logout");
    assert.equal((await chats(app, b)).status, 200);
    assert.equal(Object.keys(store.getKv("session_revoked")).length, 1);
  } finally {
    cleanup();
  }
});

test("Karsara's revoked ids (map and per-key format) still apply; ids older than the lifetime are pruned", async () => {
  const { app, token, store, cleanup } = setup();
  try {
    const v = store.getKv("session_version") || 1;
    store.setKv("session_revoked", { gone: Date.now() - 1000, ancient: Date.now() - 31 * 86_400_000 });
    store.setKv("session_revoked:old", Date.now());
    assert.equal((await chats(app, await signed(store, "karsara_session", `${Date.now()}.${v}.gone`))).status, 401);
    assert.equal((await chats(app, await signed(store, "karsara_session", `${Date.now()}.${v}.old`))).status, 401);
    const cookie = await login(app, token);
    await app.request(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie, origin } });
    const revoked = store.getKv("session_revoked");
    assert.ok(!("ancient" in revoked) && "gone" in revoked);
  } finally {
    cleanup();
  }
});

test("a valid Karsara cookie is accepted and re-issued as Griffin's, keeping its session id", async () => {
  const { app, store, cleanup } = setup();
  try {
    const v = store.getKv("session_version") || 1;
    const karsara = await signed(store, "karsara_session", `${Date.now()}.${v}.sidK`);
    const res = await chats(app, karsara);
    assert.equal(res.status, 200);
    const set = res.headers.getSetCookie();
    const griffin = set.find((c) => c.startsWith("griffin_session=")).split(";")[0];
    assert.ok(set.some((c) => c.startsWith("karsara_session=;")), "the Karsara cookie is cleared");
    assert.match(decodeURIComponent(griffin), /\.sidK\./);
    assert.equal((await chats(app, griffin)).status, 200);
    // Logging out the re-issued cookie also kills the old Karsara one (same id).
    await app.request(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie: griffin, origin } });
    assert.equal((await chats(app, karsara)).status, 401);

    // No session id, older than a day, or another version → refused.
    assert.equal((await chats(app, await signed(store, "karsara_session", `${Date.now()}.${v}`))).status, 401);
    assert.equal((await chats(app, await signed(store, "karsara_session", `${Date.now() - 25 * 3_600_000}.${v}.x`))).status, 401);
    assert.equal((await chats(app, await signed(store, "karsara_session", `${Date.now()}.${v + 1}.x`))).status, 401);
    // Even when the first request a migrated device makes is a live stream.
    const stream = await app.request(`${origin}/api/stream`, { headers: { cookie: await signed(store, "karsara_session", `${Date.now()}.${v}.z`) } });
    assert.ok(stream.headers.getSetCookie().some((c) => c.startsWith("griffin_session=")));
    await stream.body.cancel();
    const me = await app.request(`${origin}/api/auth/me`, { headers: { cookie: await signed(store, "karsara_session", `${Date.now()}.${v}.y`) } });
    assert.equal((await me.json()).authenticated, true);
  } finally {
    cleanup();
  }
});

test("an id-less Griffin cookie from before session ids still works and gets an id", async () => {
  const { app, store, cleanup } = setup();
  try {
    const legacy = await signed(store, "griffin_session", `${Date.now()}.${store.getKv("session_version") || 1}`);
    const res = await chats(app, legacy);
    assert.equal(res.status, 200);
    const fresh = res.headers.getSetCookie().find((c) => c.startsWith("griffin_session=")).split(";")[0];
    assert.equal(decodeURIComponent(fresh.split("=")[1]).split(".").length, 4, "issued.version.id.signature");
  } finally {
    cleanup();
  }
});

test("a failed login tells how many tries are left, and a blocked one how long to wait", async () => {
  const { app, token, cleanup } = setup();
  try {
    const bodies = [];
    for (let i = 0; i < 5; i += 1) bodies.push(await (await loginRes(app, "wrong")).json());
    assert.deepEqual(bodies.map((b) => b.remaining), [4, 3, 2, 1, 0]);
    assert.equal(bodies[4].retryAfter, 900);
    const blocked = await loginRes(app, token);
    assert.equal(blocked.status, 429);
    const wait = Number(blocked.headers.get("retry-after"));
    assert.ok(wait > 890 && wait <= 900);
    assert.equal((await blocked.json()).retryAfter, wait);
  } finally {
    cleanup();
  }
});

test("a flood of failed logins across addresses slows every attempt but locks no one out", async () => {
  const { app, token, cleanup } = setup({ auth: { globalFailureCap: 3, globalOverflowDelayMs: 150 } });
  try {
    const from = (peer) => ({ env: { incoming: { socket: { remoteAddress: peer }, headers: {} } } });
    for (let i = 0; i < 3; i += 1) assert.equal((await loginRes(app, "wrong", from(`198.51.100.${i}`))).status, 401);
    const started = Date.now();
    assert.equal((await loginRes(app, token, from("203.0.113.9"))).status, 200);
    assert.ok(Date.now() - started >= 140, "delayed while the flood lasts");
  } finally {
    cleanup();
  }
});

test("Secure cookie on the PUBLIC_URL host or via a trusted proxy's x-forwarded-proto, not a forged one", async () => {
  const { app, token, cleanup } = setup({ auth: { publicUrl: "https://griffin.example.com", trustedProxies: parseTrustedProxies("203.0.113.0/24") } });
  try {
    const cookieOf = async (opts) => (await loginRes(app, token, opts)).headers.get("set-cookie");
    assert.doesNotMatch(await cookieOf(), /Secure/);
    assert.match(await cookieOf({ headers: { host: "griffin.example.com" } }), /Secure/);
    const env = (peer) => ({ incoming: { socket: { remoteAddress: peer }, headers: {} } });
    assert.match(await cookieOf({ headers: { "x-forwarded-proto": "https" }, env: env("203.0.113.10") }), /Secure/);
    assert.doesNotMatch(await cookieOf({ headers: { "x-forwarded-proto": "https" }, env: env("198.51.100.1") }), /Secure/);
  } finally {
    cleanup();
  }
});

test("state-changing requests may come from the PUBLIC_URL origin, not another one", async () => {
  const { app, token, cleanup } = setup({ auth: { publicUrl: "https://griffin.example.com" } });
  try {
    assert.equal((await loginRes(app, token, { headers: { origin: "https://griffin.example.com" } })).status, 200);
    assert.equal((await loginRes(app, token, { headers: { origin: "https://evil.example.com" } })).status, 403);
  } finally {
    cleanup();
  }
});

test("the owner token as Bearer still authenticates", async () => {
  const { app, token, cleanup } = setup();
  try {
    assert.equal((await app.request(`${origin}/api/chats`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await app.request(`${origin}/api/chats`, { headers: { authorization: "Bearer nope" } })).status, 401);
  } finally {
    cleanup();
  }
});

async function readUntilClosed(response, ms) {
  const reader = response.body.getReader();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const next = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), end - Date.now()))]);
    if (next.timeout) break;
    if (next.done) return true;
  }
  await reader.cancel().catch(() => {});
  return false;
}

test("open SSE streams close once their session is revoked, and carry no-transform / x-accel-buffering", async () => {
  const { app, store, token, cleanup } = setup({ app: { sessionRecheckMs: 30 } });
  try {
    const cookie = await login(app, token);
    const chat = store.createChat({ title: "t" });
    const list = await app.request(`${origin}/api/stream`, { headers: { cookie } });
    const events = await app.request(`${origin}/api/chats/${chat.id}/stream`, { headers: { cookie } });
    for (const res of [list, events]) {
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
      assert.equal(res.headers.get("x-accel-buffering"), "no");
    }
    // A stream from another session stays open.
    const other = await app.request(`${origin}/api/stream`, { headers: { cookie: await login(app, token) } });
    await app.request(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie, origin } });
    const [a, b, c] = await Promise.all([readUntilClosed(list, 1500), readUntilClosed(events, 1500), readUntilClosed(other, 300)]);
    assert.ok(a, "the chat-list stream closed");
    assert.ok(b, "the chat event stream closed");
    assert.ok(!c, "another session's stream is untouched");
  } finally {
    cleanup();
  }
});

test("the SSE session re-check runs every 60 s by default", () => {
  const source = fs.readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");
  assert.match(source, /sessionRecheckMs = 60_000/);
});
