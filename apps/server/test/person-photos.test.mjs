import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { openStore } from "../src/db.mjs";
import { createIntegrations, integrationRoutes } from "../src/integrations/manager.mjs";
import { createAccountChannel } from "../src/integrations/telegram-account.mjs";

// People's Telegram profile photos on the Telegram page.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const tmpStore = () => openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-photo-")), "db.sqlite"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error("timeout");
};

test("store: one photo per person; a person without one is left out of the id map", () => {
  const store = tmpStore();
  const a = store.upsertPerson({ externalId: "1", name: "A" });
  const b = store.upsertPerson({ externalId: "2", name: "B" });
  store.setPersonPhoto(a.id, "555", JPEG);
  store.setPersonPhoto(b.id, "", null);
  assert.equal(store.personPhoto(a.id).photo_id, "555");
  assert.deepEqual(Buffer.from(store.personPhoto(a.id).data), JPEG);
  assert.equal(store.personPhoto(b.id).photo_id, "");
  assert.equal(store.personPhotoIds().get(a.id), "555");
  assert.equal(store.personPhotoIds().has(b.id), false);
  store.setPersonPhoto(a.id, "556", JPEG);
  assert.equal(store.personPhoto(a.id).photo_id, "556");
  store.close();
});

test("route: only the current version is served, with the owner photo's headers", async () => {
  const store = tmpStore();
  const a = store.upsertPerson({ externalId: "1", name: "A" });
  const b = store.upsertPerson({ externalId: "2", name: "B" });
  store.setPersonPhoto(a.id, "555", JPEG);
  store.setPersonPhoto(b.id, "", null);
  const app = new Hono();
  integrationRoutes(app, { store, bridge: {}, desk: {} });
  const res = await app.request(`/api/telegram/persons/${a.id}/photo?v=555`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
  assert.equal((await app.request(`/api/telegram/persons/${a.id}/photo?v=999`)).status, 404);
  assert.equal((await app.request(`/api/telegram/persons/${b.id}/photo?v=`)).status, 404);
  assert.equal((await app.request(`/api/telegram/persons/nobody/photo?v=555`)).status, 404);
  store.close();
});

test("/api/telegram/people: Persian name, Telegram name and the photo address", async () => {
  const store = tmpStore();
  const fake = { kind: "telegram_account", status: { state: "polling" }, start() {}, stop() {} };
  store.createIntegration({ kind: "telegram_account", name: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} });
  const integrations = createIntegrations({ store, runner: { isActive: () => false, send: async () => ({}) }, asks: null, channelFactories: { telegram_account: () => fake }, log: {} });
  integrations.startAll();
  const app = new Hono();
  const filling = [];
  integrationRoutes(app, integrations, { fillNames: (ids) => filling.push(ids) });
  const p = store.upsertPerson({ externalId: "7", name: "Sara Karimi" });
  store.setPersonPhoto(p.id, "555", JPEG);
  const patched = await app.request(`/api/telegram/persons/${p.id}`, { method: "PATCH", body: JSON.stringify({ name: "سارا کریمی" }) });
  assert.equal(patched.status, 200);
  const row = (await (await app.request("/api/telegram/people")).json()).people.find((x) => x.id === p.id);
  assert.equal(row.name, "سارا کریمی");
  assert.equal(row.tgName, "Sara Karimi");
  assert.match(row.photo, /\?v=555$/);
  assert.equal((await app.request(row.photo)).status, 200);
  assert.deepEqual(filling, [], "a name the owner set is not refilled");
  await app.request(`/api/telegram/persons/${p.id}`, { method: "PATCH", body: JSON.stringify({ name: "" }) });
  assert.equal(store.getPerson(p.id).display_name, "Sara Karimi");
  assert.deepEqual(filling, [[p.id]], "handed back to automatic: its Persian name is made now");
  // The startup photo pass looks people up by id and Telegram name only.
  assert.deepEqual({ ...integrations.bridge.personLight("7") }, { id: p.id, tg_name: "Sara Karimi" });
  assert.equal(integrations.bridge.personLight("nobody"), null);
  integrations.stopAll();
  store.close();
});

test("account channel: photos are fetched once per photo id, numeric names repaired, a failed lookup keeps the name", async () => {
  const store = tmpStore();
  const known = store.upsertPerson({ externalId: "43", name: "43" }); // a getEntity that once failed
  const mina = store.upsertPerson({ externalId: "42", name: "Mina", username: "mina" });
  let handler;
  const downloads = [];
  const heavy = [];
  const entities = new Map([["43", { id: 43n, firstName: "Reza", username: "reza3", photo: { photoId: 900n } }]]);
  const client = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "owner" }),
    addEventHandler: (fn) => { handler = fn; },
    sendMessage: async () => ({ id: 1 }), getMessages: async () => [],
    getDialogs: async () => [{ id: 43n, entity: entities.get("43") }],
    getEntity: async (x) => entities.get(String(x)) ?? Promise.reject(new Error("PEER_ID_INVALID")),
    downloadProfilePhoto: async (who) => (downloads.push(who), who.id === 100 ? null : JPEG),
    disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return client; }, StringSession: function () {}, NewMessage: function () {} });
  const desk = new Proxy({}, { get: () => () => {} });
  const bridge = {
    desk,
    integration: () => ({ settings: {} }),
    upsertPerson: (_id, externalId, person) => store.upsertPerson({ externalId, ...person }),
    // The startup pass must not parse 300 histories: findPerson is not called, the light lookup is.
    personByExternal: (key) => (heavy.push(key), store.findPerson(key)),
    personLight: (key) => {
      const p = store.findPerson(key);
      return p && { id: p.id, tg_name: p.tg_name };
    },
    getPerson: (id) => store.getPerson(id),
    addPersonMessage: () => {},
    personPhotoVersion: (id) => store.personPhoto(id)?.photo_id ?? null,
    setPersonPhoto: (id, photoId, data) => store.setPersonPhoto(id, photoId, data),
  };
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge, load, log: {} });
  await channel.start();
  await until(() => store.personPhoto(known.id)?.photo_id === "900");
  assert.equal(store.getPerson(known.id).display_name, "Reza");
  assert.equal(store.getPerson(known.id).username, "reza3");
  assert.deepEqual(heavy, []);

  // Mina's entity cannot be read: her name and username stay.
  await handler({ message: { out: false, chatId: 42n, peerId: { userId: 42n }, id: 11, message: "سلام" } });
  assert.equal(store.getPerson(mina.id).display_name, "Mina");
  assert.equal(store.getPerson(mina.id).username, "mina");
  assert.equal(store.personPhoto(mina.id), null);

  // Reza writes: the same photo id is not downloaded again; a new one is.
  const before = downloads.filter((w) => w.id === 43n).length;
  await handler({ message: { out: false, chatId: 43n, peerId: { userId: 43n }, id: 12, message: "سلام" } });
  await sleep(50);
  assert.equal(downloads.filter((w) => w.id === 43n).length, before);
  entities.set("43", { ...entities.get("43"), photo: { photoId: 901n } });
  await handler({ message: { out: false, chatId: 43n, peerId: { userId: 43n }, id: 13, message: "سلام" } });
  await until(() => store.personPhoto(known.id)?.photo_id === "901");
  // No photo in Telegram: remembered, never downloaded.
  entities.set("42", { id: 42n, firstName: "Mina", username: "mina" });
  await handler({ message: { out: false, chatId: 42n, peerId: { userId: 42n }, id: 14, message: "سلام" } });
  assert.equal(store.personPhoto(mina.id).photo_id, "");
  assert.equal(downloads.filter((w) => w.id === 42n).length, 0);
  await channel.stop?.();
  store.close();
});
