// The owner's own chat groups: named groups, chats moved into them, a new chat
// started in one. Temp DB only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-groups-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const runner = { isActive: () => false, activeCount: () => 0, send: async () => ({ delivered: "run" }) };
  const app = createApp({ store, runner });
  const events = [];
  store.bus.on("chats", (e) => events.push(e));
  return { store, app, events };
}
const send = (app, url, body, method = "POST") => app.request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const groups = async (app) => (await (await app.request("/api/groups")).json()).groups;
const newGroup = async (app, name) => {
  const res = await send(app, "/api/groups", { name });
  assert.equal(res.status, 201);
  return (await res.json()).group;
};
const chatOf = async (app, id) => (await (await app.request(`/api/chats/${id}`)).json()).chat;

test("groups list in creation order; names are trimmed, capped at 60, never blank", async () => {
  const { app } = setup();
  assert.deepEqual(await groups(app), []);
  const a = await newGroup(app, "  سرچ  ");
  const b = await newGroup(app, "ب".repeat(80));
  assert.equal(a.name, "سرچ");
  assert.equal(b.name, "ب".repeat(60));
  assert.ok(a.position < b.position);
  assert.deepEqual((await groups(app)).map((g) => g.id), [a.id, b.id]);
  for (const body of [{}, { name: "" }, { name: "   " }]) assert.equal((await send(app, "/api/groups", body)).status, 400);
  assert.equal((await groups(app)).length, 2);
});

test("rename: unknown id 404, blank 400", async () => {
  const { app } = setup();
  const g = await newGroup(app, "قدیمی");
  assert.equal((await (await send(app, `/api/groups/${g.id}`, { name: " تازه " }, "PATCH")).json()).group.name, "تازه");
  assert.equal((await send(app, "/api/groups/nope", { name: "x" }, "PATCH")).status, 404);
  assert.equal((await send(app, `/api/groups/${g.id}`, { name: " " }, "PATCH")).status, 400);
  assert.equal((await groups(app))[0].name, "تازه");
});

test("a chat moves into a group, keeps it across other patches and the archive, and leaves it with null", async () => {
  const { store, app } = setup();
  const g = await newGroup(app, "سرچ");
  const chat = store.createChat({ title: "چت" });
  assert.equal((await chatOf(app, chat.id)).groupId, null);
  assert.equal((await send(app, `/api/chats/${chat.id}`, { groupId: g.id }, "PATCH")).status, 200);
  assert.equal((await send(app, `/api/chats/${chat.id}`, { groupId: "nope" }, "PATCH")).status, 400);
  await send(app, `/api/chats/${chat.id}`, { title: "نام تازه", archived: true }, "PATCH");
  const archived = (await (await app.request("/api/chats?archived=1")).json()).chats.find((c) => c.id === chat.id);
  assert.equal(archived.groupId, g.id);
  await send(app, `/api/chats/${chat.id}`, { groupId: null }, "PATCH");
  assert.equal((await chatOf(app, chat.id)).groupId, null);
});

test("deleting a group ungroups its chats, never deletes or archives them", async () => {
  const { store, app } = setup();
  const g = await newGroup(app, "موقت");
  const keep = await newGroup(app, "ماندگار");
  const inside = store.createChat({ title: "داخل" });
  const other = store.createChat({ title: "دیگری" });
  await send(app, `/api/chats/${inside.id}`, { groupId: g.id }, "PATCH");
  await send(app, `/api/chats/${other.id}`, { groupId: keep.id }, "PATCH");
  assert.equal((await app.request(`/api/groups/${g.id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual((await groups(app)).map((x) => x.id), [keep.id]);
  const after = await chatOf(app, inside.id);
  assert.equal(after.groupId, null);
  assert.equal(after.archived, false);
  assert.equal((await chatOf(app, other.id)).groupId, keep.id);
  assert.equal((await app.request(`/api/groups/${g.id}`, { method: "DELETE" })).status, 404);
});

test("«+» on a group: POST /api/chats with groupId starts the chat in it; an unknown group makes no chat", async () => {
  const { store, app } = setup();
  const g = await newGroup(app, "سرچ");
  const res = await send(app, "/api/chats", { text: "سلام", groupId: g.id, repo: "" });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).chat.groupId, g.id);
  const before = store.listChats().length;
  assert.equal((await send(app, "/api/chats", { text: "سلام", groupId: "nope", repo: "" })).status, 400);
  assert.equal(store.listChats().length, before);
});

test("group changes and moves tell open pages to refresh the list", async () => {
  const { store, app, events } = setup();
  const chat = store.createChat({ title: "چت" });
  let seen = events.length;
  const g = await newGroup(app, "سرچ");
  for (const step of [
    () => send(app, `/api/groups/${g.id}`, { name: "۲" }, "PATCH"),
    () => send(app, `/api/chats/${chat.id}`, { groupId: g.id }, "PATCH"),
    () => app.request(`/api/groups/${g.id}`, { method: "DELETE" }),
  ]) {
    assert.ok(events.length > seen);
    seen = events.length;
    await step();
  }
  assert.ok(events.length > seen);
});

test("drag and drop order: groups and «بدون گروه» take the order given; a wrong list changes nothing", async () => {
  const { app, events } = setup();
  const a = await newGroup(app, "الف");
  const b = await newGroup(app, "ب");
  assert.equal((await (await app.request("/api/groups")).json()).looseAt, null);
  const res = await send(app, "/api/groups/order", { order: ["none", b.id, a.id] }, "PUT");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.groups.map((g) => g.id), [b.id, a.id]);
  assert.equal(body.looseAt, 0);
  assert.ok(events.some((e) => e.type === "groups"));
  for (const order of [[a.id], [a.id, a.id, b.id], [a.id, b.id, "x"], [a.id, b.id, "none", "none"], "nope"]) {
    assert.equal((await send(app, "/api/groups/order", { order }, "PUT")).status, 400);
  }
  const now = await (await app.request("/api/groups")).json();
  assert.deepEqual(now.groups.map((g) => g.id), [b.id, a.id]);
  assert.equal(now.looseAt, 0);
  // Without "none" the ungrouped chats go back to the end; a new group lands last.
  await send(app, "/api/groups/order", { order: [a.id, b.id] }, "PUT");
  const c = await newGroup(app, "پ");
  const last = await (await app.request("/api/groups")).json();
  assert.deepEqual(last.groups.map((g) => g.id), [a.id, b.id, c.id]);
  assert.equal(last.looseAt, null);
});
