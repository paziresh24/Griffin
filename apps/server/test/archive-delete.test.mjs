import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";

function setup(active = new Set()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-archdel-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const runner = { isActive: (id) => active.has(id), activeCount: () => 0, send: async () => ({ delivered: "run" }) };
  return { store, app: createApp({ store, runner }) };
}
const del = (app, id) => app.request(`/api/chats/${id}`, { method: "DELETE" });
const bulk = (app, body) => app.request("/api/chats/delete-archived", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("only an archived chat can be deleted for good", async () => {
  const { store, app } = setup();
  const chat = store.createChat({ title: "a" });
  assert.equal((await del(app, chat.id)).status, 409, "a live chat is archived first");
  assert.ok(store.getChat(chat.id));
  store.updateChat(chat.id, { archived: true });
  assert.equal((await del(app, chat.id)).status, 200);
  assert.equal(store.getChat(chat.id), null);
  assert.equal((await del(app, chat.id)).status, 404);
});

test("a running archived chat is not deleted", async () => {
  const active = new Set();
  const { store, app } = setup(active);
  const chat = store.createChat({ title: "a" });
  store.updateChat(chat.id, { archived: true });
  active.add(chat.id);
  assert.equal((await del(app, chat.id)).status, 409);
  assert.ok(store.getChat(chat.id));
});

test("bulk delete drops every archived chat and leaves the live ones", async () => {
  const active = new Set();
  const { store, app } = setup(active);
  const live = store.createChat({ title: "live" });
  const a = store.createChat({ title: "a" });
  const b = store.createChat({ title: "b" });
  const busy = store.createChat({ title: "busy" });
  for (const c of [a, b, busy]) store.updateChat(c.id, { archived: true });
  active.add(busy.id);
  const out = await (await bulk(app, {})).json();
  assert.deepEqual(out.deleted.sort(), [a.id, b.id].sort());
  assert.deepEqual(out.skipped, [busy.id]);
  assert.ok(store.getChat(live.id));
  assert.ok(store.getChat(busy.id));
  const chosen = await (await bulk(app, { ids: [live.id] })).json();
  assert.deepEqual(chosen, { deleted: [], skipped: [live.id] }, "ids that are not archived are skipped");
});
