// Loading speed (2026-10-29): every open page reloaded the ~900 KB chat list on the same «chats»
// event, uncompressed, and opening one chat read every child chat of the install. One built list
// now serves all pages until the next change, /api answers are gzipped, and a chat's page reads
// only its own children.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-listreuse-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const app = createApp({ store, runner: { isActive: () => false, activeCount: () => 0 } });
  return { store, app, done: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("one built chat list serves every page until the next «chats» event", async () => {
  const { store, app, done } = setup();
  try {
    const chat = store.createChat({ title: "اول", mode: "agent" });
    const titleOf = async () => (await (await app.request("/api/chats")).json()).chats.find((c) => c.id === chat.id)?.title;
    assert.equal(await titleOf(), "اول");
    // A change that announces nothing: the list built a moment ago still answers.
    store.db.prepare("UPDATE chats SET title = ? WHERE id = ?").run("دوم", chat.id);
    assert.equal(await titleOf(), "اول");
    // The event every change of the list sends: the next read builds it anew.
    store.bus.emit("chats", { type: "updated", chatId: chat.id });
    assert.equal(await titleOf(), "دوم");
    // A chat created after a build is listed at once (createChat emits the event itself).
    const fresh = store.createChat({ title: "تازه", mode: "agent" });
    const { chats } = await (await app.request("/api/chats")).json();
    assert.ok(chats.some((c) => c.id === fresh.id));
    // The archive is its own list.
    const archived = await (await app.request("/api/chats?archived=1")).json();
    assert.deepEqual(archived.chats, []);
  } finally {
    done();
  }
});

test("/api answers are gzipped for a client that accepts it; the plain answer is unchanged", async () => {
  const { store, app, done } = setup();
  try {
    for (let i = 0; i < 20; i += 1) store.createChat({ title: `گفتگوی شمارهٔ ${i} با عنوانی کمی بلندتر`, mode: "agent" });
    const plain = await app.request("/api/chats");
    assert.equal(plain.headers.get("content-encoding"), null);
    const body = await plain.text();
    const zipped = await app.request("/api/chats", { headers: { "accept-encoding": "gzip, br" } });
    assert.equal(zipped.headers.get("content-encoding"), "gzip");
    assert.equal(gunzipSync(Buffer.from(await zipped.arrayBuffer())).toString(), body);
    // The live stream is never buffered by compression.
    const ac = new AbortController();
    const stream = await app.request("/api/stream", { headers: { "accept-encoding": "gzip" }, signal: ac.signal });
    assert.equal(stream.headers.get("content-encoding"), null);
    ac.abort();
  } finally {
    done();
  }
});

test("a chat's page lists its own children, newest first, with their total", async () => {
  const { store, app, done } = setup();
  try {
    const parent = store.createChat({ title: "مادر", mode: "agent" });
    const other = store.createChat({ title: "دیگری", mode: "agent" });
    const kids = [];
    for (let i = 0; i < 3; i += 1) {
      kids.push(store.createChat({ title: `فرزند ${i}`, mode: "agent", parentChatId: parent.id }));
      store.db.prepare("UPDATE chats SET created_at = ? WHERE id = ?").run(`2026-10-29T10:00:0${i}.000Z`, kids[i].id);
    }
    store.createChat({ title: "فرزند دیگری", mode: "agent", parentChatId: other.id });
    const own = (await (await app.request(`/api/chats/${parent.id}`)).json()).chat;
    assert.equal(own.childCount, 3);
    assert.deepEqual(own.children.map((c) => c.title), ["فرزند 2", "فرزند 1", "فرزند 0"]);
    assert.deepEqual(store.listChildChatsOf(parent.id, 2).map((c) => c.id), [kids[2].id, kids[1].id]);
    assert.equal(store.listChildChatsOf(parent.id, 2).total, 3);
    const lonely = store.createChat({ title: "بی‌فرزند", mode: "agent" });
    const none = (await (await app.request(`/api/chats/${lonely.id}`)).json()).chat;
    assert.equal(none.children, undefined);
  } finally {
    done();
  }
});
