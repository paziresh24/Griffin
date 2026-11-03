// Files go ahead of their message a piece at a time, and the message names them by id; a message of
// many pictures keeps the session as light as before (from the owner, 2026-10-31).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { MAX_PIECE_BYTES } from "../src/uploads.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-up-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const calls = [];
  const runner = { isActive: () => false, activeCount: () => 0, send: async (chatId, input) => (calls.push(input), { delivered: "run" }) };
  const uploadsDir = path.join(dir, "uploads");
  return { store, calls, uploadsDir, app: createApp({ store, runner, uploadsDir }) };
}
const json = (app, url, body, method = "POST") => app.request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const piece = (app, id, offset, bytes) => app.request(`/api/uploads/${id}?offset=${offset}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes });
async function upload(app, name, mimeType, bytes) {
  const { id } = await (await json(app, "/api/uploads", { name, mimeType, size: bytes.length })).json();
  assert.equal((await piece(app, id, 0, bytes)).status, 200);
  return id;
}
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

test("pieces are stored in order and each answer says what is on disk", async () => {
  const { app } = setup();
  const created = await json(app, "/api/uploads", { name: "a.zip", mimeType: "application/zip", size: 6 });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.deepEqual(await (await piece(app, id, 0, Buffer.from("abc"))).json(), { received: 3 });
  const replay = await piece(app, id, 0, Buffer.from("abc"));
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).received, 3, "a retry of a stored piece learns where to go on");
  assert.equal((await piece(app, id, 5, Buffer.from("f"))).status, 409, "no gap");
  assert.equal((await piece(app, id, 3, Buffer.from("defg"))).status, 413, "no more than it said");
  assert.deepEqual(await (await piece(app, id, 3, Buffer.from("def"))).json(), { received: 6 });
});

test("size and id are checked", async () => {
  const { app, uploadsDir } = setup();
  assert.equal((await json(app, "/api/uploads", { name: "a", size: 51 * 1024 * 1024 })).status, 413);
  assert.equal((await json(app, "/api/uploads", { name: "a", size: 0 })).status, 400);
  assert.equal((await piece(app, "../../etc/passwd", 0, Buffer.from("x"))).status, 404);
  const { id } = await (await json(app, "/api/uploads", { name: "a", size: 2 * MAX_PIECE_BYTES })).json();
  assert.equal((await piece(app, id, 0, Buffer.alloc(MAX_PIECE_BYTES + 1))).status, 413);
  assert.equal((await app.request(`/api/uploads/${id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual(fs.readdirSync(uploadsDir), []);
});

test("a message names its files by id, and a resend finds them still there", async () => {
  const { app, store, calls } = setup();
  const text = Buffer.from("سلام");
  const id = await upload(app, "n.txt", "text/plain", text);
  const chat = store.createChat({ title: "t" });
  const body = { text: "بخوان", clientId: "c1", files: [{ uploadId: id, name: "n.txt", mimeType: "text/plain", bytes: text.length }] };
  assert.equal((await json(app, `/api/chats/${chat.id}/messages`, body)).status, 202);
  assert.equal(calls[0].files[0].name, "n.txt");
  assert.equal(Buffer.from(calls[0].files[0].data, "base64").toString(), "سلام");
  assert.equal((await json(app, `/api/chats/${chat.id}/messages`, body)).status, 202);
});

test("a file that is missing or not all here is refused, never sent cut short", async () => {
  const { app, store } = setup();
  const chat = store.createChat({ title: "t" });
  const { id } = await (await json(app, "/api/uploads", { name: "a.txt", mimeType: "text/plain", size: 10 })).json();
  await piece(app, id, 0, Buffer.from("abc"));
  const partial = await json(app, `/api/chats/${chat.id}/messages`, { text: "x", files: [{ uploadId: id }] });
  assert.equal(partial.status, 400);
  assert.match((await partial.json()).error, /دوباره پیوستش کنید/);
  assert.equal((await json(app, `/api/chats/${chat.id}/messages`, { text: "x", images: [{ uploadId: "00000000-0000-4000-8000-000000000000" }] })).status, 400);
});

test("twenty pictures go: four inside the message, the rest kept as files under their own names", async () => {
  const { app, store, calls } = setup();
  const images = [];
  for (let i = 0; i < 20; i += 1) images.push({ uploadId: await upload(app, `p${i}.png`, "image/png", PNG) });
  const chat = store.createChat({ title: "t" });
  assert.equal((await json(app, `/api/chats/${chat.id}/messages`, { text: "ببین", images })).status, 202);
  assert.equal(calls[0].images.length, 4);
  assert.equal(calls[0].files.length, 16);
  assert.equal(calls[0].files[0].name, "p4.png");
  assert.equal(calls[0].files[0].kept, true);
  const tooMany = [...images, images[0]];
  assert.equal((await json(app, `/api/chats/${chat.id}/messages`, { text: "ببین", images: tooMany })).status, 400);
});

test("the four files of a message are still counted apart from its pictures", async () => {
  const { app, store } = setup();
  const chat = store.createChat({ title: "t" });
  const files = [];
  for (let i = 0; i < 5; i += 1) files.push({ uploadId: await upload(app, `f${i}.txt`, "text/plain", Buffer.from("x")) });
  assert.equal((await json(app, `/api/chats/${chat.id}/messages`, { text: "x", files })).status, 400);
});
