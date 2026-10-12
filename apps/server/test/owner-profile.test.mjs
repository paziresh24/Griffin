import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { profileRoutes } from "../src/profile.mjs";

// The owner's name and photo at the foot of the sidebar: the connected
// Telegram account's name and photo; a name typed in Settings wins over Telegram's; with neither,
// nothing (the page keeps its default).

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

function setup({ telegram = null } = {}) {
  const kv = new Map();
  const store = { getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => kv.set(k, v) };
  const app = new Hono();
  profileRoutes(app, { store, telegramProfile: () => telegram });
  const get = async () => (await app.request("/api/profile")).json();
  const put = (body) => app.request("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, get, put, kv };
}

test("nothing connected and nothing typed: no name, no photo", async () => {
  assert.deepEqual(await setup().get(), { name: null, photo: null, typedName: null, telegramName: null });
});

test("a connected Telegram account gives the name and a photo address", async () => {
  const body = await setup({ telegram: { name: "Alice Example", photo: JPEG } }).get();
  assert.equal(body.name, "Alice Example");
  assert.equal(body.telegramName, "Alice Example");
  assert.match(body.photo, /^\/api\/profile\/photo\?v=[0-9a-f]{8,}$/);
});

test("the photo address serves the Telegram photo as an image", async () => {
  const { app, get } = setup({ telegram: { name: "H", photo: JPEG } });
  const res = await app.request((await get()).photo);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
});

test("no Telegram photo (none set, or not an image): photo null and the address is 404", async () => {
  for (const photo of [null, Buffer.from("<html>")]) {
    const { app, get } = setup({ telegram: { name: "H", photo } });
    assert.equal((await get()).photo, null);
    assert.equal((await app.request("/api/profile/photo")).status, 404);
  }
});

test("a typed name shows without Telegram, and wins over Telegram's name; the photo stays", async () => {
  const alone = setup();
  assert.equal((await alone.put({ name: "  سارا نمونه  " })).status, 200);
  assert.equal((await alone.get()).name, "سارا نمونه");

  const both = setup({ telegram: { name: "Hossein", photo: JPEG } });
  await both.put({ name: "دکتر نمونه" });
  const body = await both.get();
  assert.equal(body.name, "دکتر نمونه");
  assert.equal(body.typedName, "دکتر نمونه");
  assert.ok(body.photo);
});

test("an empty name clears the typed one; a long one is cut; a non-string is refused", async () => {
  const s = setup({ telegram: { name: "Hossein", photo: null } });
  await s.put({ name: "x" });
  await s.put({ name: "   " });
  assert.equal((await s.get()).name, "Hossein");
  assert.equal((await s.get()).typedName, null);
  await s.put({ name: "ن".repeat(200) });
  assert.equal((await s.get()).name.length, 60);
  assert.equal((await s.put({ name: 5 })).status, 400);
  assert.equal((await s.put({})).status, 400);
});

test("bidi and control characters are stripped from a typed name", async () => {
  const s = setup();
  await s.put({ name: "‮نمونه‏\n" });
  assert.equal((await s.get()).name, "نمونه");
});

test("telegram account channel: name and small profile photo are read on start, without blocking it", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  const asked = [];
  const fakeClient = {
    connect: async () => {}, checkAuthorization: async () => true,
    getMe: async () => ({ id: 100, firstName: "Alice", lastName: "Example", username: "alice" }),
    downloadProfilePhoto: async (who, opts) => (asked.push({ who, opts }), JPEG),
    addEventHandler: () => {}, disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return fakeClient; }, StringSession: function () {}, NewMessage: function () {} });
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge: {}, load, log: {} });
  await channel.start();
  await new Promise((r) => setTimeout(r, 10));
  const profile = channel.profile();
  assert.equal(profile.name, "Alice Example");
  assert.deepEqual(profile.photo, JPEG);
  assert.equal(asked[0].who?.id ?? asked[0].who, 100, "the photo of the account itself (its me object)");
  assert.equal(asked[0].opts?.isBig, false);
});

test("telegram account channel: a failing photo download leaves the name and a running channel", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  const fakeClient = {
    connect: async () => {}, checkAuthorization: async () => true,
    getMe: async () => ({ id: 100, firstName: "Hossein" }),
    downloadProfilePhoto: async () => { throw new Error("FLOOD_WAIT"); },
    addEventHandler: () => {}, disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return fakeClient; }, StringSession: function () {}, NewMessage: function () {} });
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge: {}, load, log: {} });
  await channel.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(channel.status.state, "polling");
  assert.deepEqual(channel.profile(), { name: "Hossein", photo: null });
});

test("manager: the profile comes from the running Telegram account only", async () => {
  const { accountProfileOf } = await import("../src/integrations/manager.mjs");
  const running = { kind: "telegram_account", client: {}, status: { state: "polling" }, profileReady: async () => ({ name: "A", photo: null }) };
  const stopped = { kind: "telegram_account", client: null, status: { state: "error" }, profileReady: async () => ({ name: "B", photo: null }) };
  const bot = { kind: "telegram_bot", status: { state: "polling" } };
  assert.deepEqual(await accountProfileOf([bot, stopped, running]), { name: "A", photo: null });
  assert.equal(await accountProfileOf([bot, stopped]), null);
});

// Review fixes.

test("a half-space (ZWNJ) and an emoji joiner survive in a name; an emoji is never cut in half", async () => {
  const s = setup({ telegram: { name: "مهدی‌پور 👨‍💻", photo: null } });
  assert.equal((await s.get()).name, "مهدی‌پور 👨‍💻");
  await s.put({ name: "علی‌زاده" });
  assert.equal((await s.get()).name, "علی‌زاده");
  await s.put({ name: `${"a".repeat(59)}😀` });
  assert.equal((await s.get()).name, `${"a".repeat(59)}😀`);
  await s.put({ name: `${"a".repeat(60)}😀` });
  assert.equal((await s.get()).name, "a".repeat(60));
});

test("the photo is served with nosniff, a sandbox and a long private cache (its address carries a version)", async () => {
  const { app, get } = setup({ telegram: { name: "H", photo: JPEG } });
  const res = await app.request((await get()).photo);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy"), /sandbox/);
  assert.match(res.headers.get("cache-control"), /private.*max-age=\d{6,}/);
});

test("the profile route waits for a photo still on its way (async telegramProfile)", async () => {
  const kv = new Map();
  const app = new Hono();
  profileRoutes(app, { store: { getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => kv.set(k, v) }, telegramProfile: async () => (await new Promise((r) => setTimeout(r, 20)), { name: "H", photo: JPEG }) });
  assert.ok((await (await app.request("/api/profile")).json()).photo);
});

function fakeAccount({ download, me = { id: 100, firstName: "Hossein" } } = {}) {
  const calls = { handlers: 0, downloads: [] };
  const client = {
    connect: async () => {}, checkAuthorization: async () => true,
    getMe: async () => (typeof me === "function" ? me() : me),
    downloadProfilePhoto: (who, opts) => (calls.downloads.push({ who, opts }), download()),
    addEventHandler: () => { calls.handlers++; }, disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return client; }, StringSession: function () {}, NewMessage: function () {} });
  return { calls, load };
}

test("start() does not wait for the photo: a download that never ends still leaves a running channel", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  let settle;
  const { calls, load } = fakeAccount({ download: () => new Promise((r) => { settle = r; }) });
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge: {}, load, log: {} });
  const started = await Promise.race([channel.start().then(() => true), new Promise((r) => setTimeout(r, 200, false))]);
  assert.equal(started, true, "start() resolved while the download hangs");
  assert.equal(channel.status.state, "polling");
  assert.equal(calls.handlers, 1);
  assert.equal(channel.profile().photo, null);
  settle(JPEG);
  assert.deepEqual((await channel.profileReady(100)).photo, JPEG);
});

test("profileReady gives up after its wait, so a stuck download never holds the page", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  const { load } = fakeAccount({ download: () => new Promise(() => {}) });
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge: {}, load, log: {} });
  await channel.start();
  const t = Date.now();
  assert.deepEqual(await channel.profileReady(50), { name: "Hossein", photo: null });
  assert.ok(Date.now() - t < 500);
});

test("a name or photo changed in Telegram is read again once the last read is old", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  let clock = 1_000_000;
  let name = "Hossein";
  const { calls, load } = fakeAccount({ download: async () => JPEG, me: () => ({ id: 100, firstName: name }) });
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge: {}, load, log: {}, now: () => clock });
  await channel.start();
  await channel.profileReady(100);
  name = "Alice Example";
  assert.equal((await channel.profileReady(100)).name, "Hossein", "fresh read is kept");
  clock += 2 * 60 * 60_000;
  await channel.profileReady(100); // serves the held profile at once and reads again behind it
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(channel.profile().name, "Alice Example");
  assert.equal(calls.downloads.length, 2);
});

// Second review.

test("a stuck read is given up after its limit: later requests do not wait, and the hourly re-read runs again", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  let clock = 1_000_000;
  let hang = true;
  const { calls, load } = fakeAccount({ download: () => (hang ? new Promise(() => {}) : Promise.resolve(JPEG)) });
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge: {}, load, log: {}, now: () => clock, profileReadLimitMs: 30 });
  await channel.start();
  await new Promise((r) => setTimeout(r, 60)); // the stuck read hits its limit
  clock += 20_000;
  let t = Date.now();
  await channel.profileReady(2_000);
  assert.ok(Date.now() - t < 500, "no wait once the first read has had its chance");
  hang = false;
  clock += 2 * 60 * 60_000;
  await channel.profileReady(2_000);
  assert.equal(calls.downloads.length, 2, "read again after the hour");
  assert.deepEqual(channel.profile().photo, JPEG);
});

test("a failed read is tried again within minutes, not an hour", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  let clock = 1_000_000;
  let fail = true;
  const { calls, load } = fakeAccount({ download: async () => { if (fail) throw new Error("FLOOD"); return JPEG; } });
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge: {}, load, log: {}, now: () => clock });
  await channel.start();
  await channel.profileReady(100);
  fail = false;
  clock += 10 * 60_000;
  assert.deepEqual((await channel.profileReady(100)).photo, JPEG);
  assert.equal(calls.downloads.length, 2);
});

test("an hourly re-read serves the photo already held at once, and swaps in the new one when it lands", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  let clock = 1_000_000;
  const OTHER = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 9, 9, 0xff, 0xd9]);
  let next = JPEG;
  let release;
  const { load } = fakeAccount({ download: () => (next === JPEG ? Promise.resolve(JPEG) : new Promise((r) => { release = () => r(OTHER); })) });
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge: {}, load, log: {}, now: () => clock });
  await channel.start();
  await channel.profileReady(100);
  next = OTHER;
  clock += 2 * 60 * 60_000;
  const t = Date.now();
  assert.deepEqual((await channel.profileReady(2_000)).photo, JPEG, "old photo, no wait");
  assert.ok(Date.now() - t < 500);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(channel.profile().photo, OTHER);
});

test("an old photo address is not cached for a year: only the current version is", async () => {
  const { app, get } = setup({ telegram: { name: "H", photo: JPEG } });
  const current = (await get()).photo;
  const ok = await app.request(current);
  assert.match(ok.headers.get("cache-control"), /max-age=31536000/);
  const stale = await app.request("/api/profile/photo?v=000000000000");
  assert.notEqual(stale.status, 200);
});

test("a name is cut between whole characters: a flag or a joined emoji stays whole", async () => {
  const s = setup();
  await s.put({ name: `${"a".repeat(59)}🇮🇷` });
  assert.equal((await s.get()).name, `${"a".repeat(59)}🇮🇷`);
  await s.put({ name: `${"a".repeat(59)}👨‍💻x` });
  assert.equal((await s.get()).name, `${"a".repeat(59)}👨‍💻`);
  await s.put({ name: `${"a".repeat(60)}🇮🇷` });
  assert.equal((await s.get()).name, "a".repeat(60));
});

// Third review.

test("a read given up that lands late never overwrites a newer one", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  let clock = 1_000_000;
  const OLD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]);
  const NEW = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 2, 0xff, 0xd9]);
  const releases = [];
  const { load } = fakeAccount({ download: () => new Promise((r) => releases.push(r)) });
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge: {}, load, log: {}, now: () => clock, profileReadLimitMs: 20 });
  await channel.start();
  await new Promise((r) => setTimeout(r, 40)); // read 1 given up
  clock += 10 * 60_000;
  const second = channel.profileReady(1_000); // read 2 starts
  await new Promise((r) => setTimeout(r, 5));
  releases[1](NEW);
  await second;
  releases[0](OLD); // read 1 lands late
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(channel.profile().photo, NEW);
});

test("a rejection without a message is logged, never an unhandled rejection", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  const logged = [];
  const { load } = fakeAccount({ download: () => Promise.reject(undefined) });
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge: {}, load, log: { error: (m) => logged.push(m) } });
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e ?? "undefined"; };
  process.on("unhandledRejection", onUnhandled);
  await channel.start();
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, null);
  assert.equal(logged.filter((m) => m.includes("profile:")).length, 1);
});

test("a failed read waits its few minutes and a good one its hour before the next read", async () => {
  const { createAccountChannel } = await import("../src/integrations/telegram-account.mjs");
  let clock = 1_000_000;
  let fail = true;
  const { calls, load } = fakeAccount({ download: async () => { if (fail) throw new Error("x"); return JPEG; } });
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge: {}, load, log: {}, now: () => clock });
  await channel.start();
  await channel.profileReady(100);
  clock += 2 * 60_000;
  await channel.profileReady(100);
  assert.equal(calls.downloads.length, 1, "no retry after 2 minutes");
  fail = false;
  clock += 4 * 60_000;
  await channel.profileReady(100);
  assert.equal(calls.downloads.length, 2, "retried after the few minutes");
  clock += 10 * 60_000;
  await channel.profileReady(100);
  assert.equal(calls.downloads.length, 2, "a good read is not repeated after 10 minutes");
});

test("a huge typed name is cut quickly and a single over-long character is not stored whole", async () => {
  const s = setup();
  const t = Date.now();
  await s.put({ name: "ن".repeat(3_000_000) });
  assert.ok(Date.now() - t < 1_500, `took ${Date.now() - t} ms`);
  assert.equal((await s.get()).name.length, 60);
  await s.put({ name: `a${"́".repeat(100_000)}` });
  assert.ok((await s.get()).name.length <= 200);
});
