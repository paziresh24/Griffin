import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { fillPersianNames } from "../src/integrations/fa-names.mjs";
import { syncMotherNames } from "../src/integrations/mother.mjs";

// The Telegram page shows every person by a Persian name.
const tmpStore = () => openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-fa-")), "db.sqlite"));
const quiet = { info() {}, error() {} };

test("the owner's Persian name survives the person's next message; an empty one hands it back", () => {
  const store = tmpStore();
  const { id } = store.upsertPerson({ externalId: "1", name: "Sara Karimi", username: "skarimi" });
  store.updatePerson(id, { name: "سارا کریمی" });
  store.upsertPerson({ externalId: "1", name: "Sara Karimi", username: "skarimi" });
  store.updatePerson(id, { category: "team" }); // a later unrelated patch does not write it into display_name
  let p = store.getPerson(id);
  assert.equal(p.display_name, "سارا کریمی");
  assert.equal(p.tg_name, "Sara Karimi");
  assert.equal(p.category, "team");
  store.updatePerson(id, { name: "" });
  p = store.getPerson(id);
  assert.equal(p.display_name, "Sara Karimi");
  assert.equal(p.fa_name, null);
  store.close();
});

test("a message whose sender could not be read keeps the saved name and username", () => {
  const store = tmpStore();
  const { id } = store.upsertPerson({ externalId: "2", name: "Mina", username: "mina" });
  store.upsertPerson({ externalId: "2", name: null });
  const p = store.getPerson(id);
  assert.equal(p.display_name, "Mina");
  assert.equal(p.username, "mina");
  store.close();
});

test("fillPersianNames: Latin names filled, Persian/numeric/owner-set untouched, junk rejected", async () => {
  const store = tmpStore();
  const sara = store.upsertPerson({ externalId: "10", name: "Sara Karimi", username: "skarimi" });
  const junk = store.upsertPerson({ externalId: "11", name: "Xyz Three" });
  const group = store.upsertPerson({ externalId: "-100", name: "Ops Alerts" });
  const persian = store.upsertPerson({ externalId: "12", name: "مینا" });
  const numeric = store.upsertPerson({ externalId: "12345", name: "12345" });
  const owned = store.upsertPerson({ externalId: "13", name: "Owner Set" });
  store.updatePerson(owned.id, { name: "اسم صاحب" });
  store.setKv("owner-names", { "sara-karimi": "خانم کریمی" });
  const prompts = [];
  const generate = async (prompt) => {
    prompts.push(prompt);
    return `باشه:\n${JSON.stringify({ [sara.id]: "سارا کریمی", [group.id]: "هشدارهای عملیات", [junk.id]: "abc", [owned.id]: "نباید", "not-in-batch": "غریبه" })}`;
  };
  const filled = await fillPersianNames({ store, generate, log: quiet });
  assert.equal(filled, 2);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Sara Karimi/);
  assert.match(prompts[0], /@skarimi/);
  assert.match(prompts[0], /sara-karimi = خانم کریمی/);
  assert.match(prompts[0], new RegExp(`${group.id} \\| Ops Alerts \\| - \\| گروه`));
  assert.doesNotMatch(prompts[0].split("id | Telegram name")[1], /Owner Set|مینا|12345/);
  assert.equal(store.getPerson(sara.id).display_name, "سارا کریمی");
  assert.equal(store.getPerson(group.id).display_name, "هشدارهای عملیات");
  assert.equal(store.getPerson(junk.id).fa_name, null);
  assert.equal(store.getPerson(persian.id).fa_name, null);
  assert.equal(store.getPerson(numeric.id).fa_name, null);
  assert.equal(store.getPerson(owned.id).display_name, "اسم صاحب");
  // Batches: one call per 40.
  for (let i = 0; i < 45; i++) store.upsertPerson({ externalId: String(1000 + i), name: `Person ${i}` });
  prompts.length = 0;
  await fillPersianNames({ store, generate, log: quiet, batch: 40 });
  assert.equal(prompts.length, 2);
  store.close();
});

test("an answer that is not JSON fills nothing and does not throw; a failed batch does not stop the next", async () => {
  const store = tmpStore();
  const p = store.upsertPerson({ externalId: "20", name: "Ali Moradi" });
  assert.equal(await fillPersianNames({ store, generate: async () => "گفتگو", log: quiet }), 0);
  assert.equal(store.getPerson(p.id).fa_name, null);
  const q = store.upsertPerson({ externalId: "21", name: "Reza" });
  let n = 0;
  const generate = async (prompt) => {
    if (n++ === 0) throw new Error("boom");
    return JSON.stringify({ [q.id]: "رضا" });
  };
  assert.equal(await fillPersianNames({ store, generate, log: quiet, batch: 1 }), 1);
  assert.equal(store.getPerson(q.id).display_name, "رضا");
  store.close();
});

test("lists and chat owner labels read the Persian name", () => {
  const store = tmpStore();
  const p = store.upsertPerson({ externalId: "30", name: "Mina Ahmadi" });
  store.updatePerson(p.id, { name: "مینا احمدی" });
  const light = store.listPersonsLight().find((x) => x.id === p.id);
  assert.equal(light.display_name, "مینا احمدی");
  assert.equal(light.tg_name, "Mina Ahmadi");
  assert.equal(store.listPersons({ query: "احمدی" }).length, 1);
  assert.equal(store.listPersons({ query: "Ahmadi" }).length, 1);
  const chat = store.createChat({ title: "x", caller: "team", personId: p.id });
  assert.equal(store.listChatsBySource().find((c) => c.id === chat.id).owner_label, "مینا احمدی");
  store.close();
});

test("syncMotherNames renames the mother kv and its untouched title", () => {
  const store = tmpStore();
  const p = store.upsertPerson({ externalId: "1", name: "Sara Karimi" });
  const chat = store.createChat({ title: "👤 Sara Karimi", caller: "team", personId: p.id });
  store.setKv(`motherof:${chat.id}`, { integrationId: "i", key: "1", personId: p.id, name: "Sara Karimi" });
  assert.equal(syncMotherNames(store), 0);
  store.updatePerson(p.id, { name: "سارا کریمی" });
  assert.equal(syncMotherNames(store), 1);
  assert.equal(store.getChat(chat.id).title, "👤 سارا کریمی");
  assert.equal(store.getKv(`motherof:${chat.id}`).name, "سارا کریمی");
  assert.equal(syncMotherNames(store), 0);
  store.close();
});

test("syncMotherNames reads names in one light query, never a person's history", () => {
  const store = tmpStore();
  const p = store.upsertPerson({ externalId: "1", name: "Sara Karimi" });
  const chat = store.createChat({ title: "👤 Sara Karimi", caller: "team", personId: p.id });
  store.setKv(`motherof:${chat.id}`, { integrationId: "i", key: "1", personId: p.id, name: "Sara Karimi" });
  store.updatePerson(p.id, { name: "سارا کریمی" });
  store.getPerson = () => {
    throw new Error("getPerson parses history_json");
  };
  assert.equal(syncMotherNames(store), 1);
  assert.equal(store.getKv(`motherof:${chat.id}`).name, "سارا کریمی");
  store.close();
});

test("fillPersianNames: a pass that filled nothing does not resync the mothers; ids limits it to those persons", async () => {
  const store = tmpStore();
  const a = store.upsertPerson({ externalId: "1", name: "Ali Moradi" });
  const b = store.upsertPerson({ externalId: "2", name: "Reza" });
  let reads = 0;
  const light = store.listPersonsLight.bind(store);
  store.listPersonsLight = (...args) => (reads++, light(...args));
  assert.equal(await fillPersianNames({ store, generate: async () => "{}", log: quiet }), 0);
  assert.equal(reads, 0, "nothing filled, nothing to sync");
  const prompts = [];
  const generate = async (prompt) => (prompts.push(prompt), JSON.stringify({ [a.id]: "علی مرادی", [b.id]: "رضا" }));
  assert.equal(await fillPersianNames({ store, generate, log: quiet, ids: [a.id] }), 1);
  assert.doesNotMatch(prompts[0].split("id | Telegram name")[1], /Reza/);
  assert.equal(store.getPerson(a.id).display_name, "علی مرادی");
  assert.equal(store.getPerson(b.id).fa_name, null);
  assert.equal(reads, 1);
  store.close();
});
