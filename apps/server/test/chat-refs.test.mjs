// A chat can point at things in other systems (a Board task, …): chat_refs. A module opens a chat for a
// task and says so (`refs` on POST /api/chats, or POST /api/chats/:id/refs later); the module's page asks
// «which chats are about these tasks» and a chat asks «which tasks am I about».
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-refs-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const runner = { isActive: () => false, activeCount: () => 0, send: async () => ({ delivered: "run" }) };
  return { store, app: createApp({ store, runner }) };
}
const post = (app, url, body) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const chatOf = (store, title) => store.createChat({ title, mode: "auto", agent: "griffin", provider: "claude" });

test("store: a chat's refs and a kind's refs, each with its chat; same ref twice is one; bad input is dropped", () => {
  const { store } = setup();
  const a = chatOf(store, "یک");
  const b = chatOf(store, "دو");
  store.addChatRefs(a.id, [{ kind: "board-app-task", ref: "t1", title: "کار یک" }, { kind: "board-app-task", ref: "t1", title: "کار یک" }, { kind: "Bad Kind", ref: "x" }, { kind: "board-app-task", ref: "../x" }, { kind: "board-app-task", ref: "" }]);
  store.addChatRefs(b.id, [{ kind: "board-app-task", ref: "t1" }, { kind: "board-app-task", ref: "t2", title: "کار دو" }]);
  assert.deepEqual(store.chatRefsOf(a.id).map((r) => [r.kind, r.ref, r.title]), [["board-app-task", "t1", "کار یک"]]);
  const byRef = store.chatsByRefKind("board-app-task");
  assert.deepEqual(byRef.t1.map((c) => c.id).sort(), [a.id, b.id].sort());
  assert.deepEqual(byRef.t2.map((c) => c.title), ["دو"]);
  assert.equal(byRef.t1.find((c) => c.id === a.id).refTitle, "کار یک", "the task's own title travels with each chat");
  store.addChatRefs(a.id, [{ kind: "board-app-task", ref: "x".repeat(81) }, { kind: "board-app-task", ref: "dot.id" }]);
  assert.deepEqual(store.chatRefsOf(a.id).map((r) => r.ref), ["t1", "dot.id"], "an id the router could not open is not stored; a dotted one is");
  assert.deepEqual(Object.keys(byRef).sort(), ["t1", "t2"]);
  assert.equal(store.chatsByRefKind("other")?.t1, undefined);
});

test("store: deleting a chat takes its refs with it; an archived chat's ref stays, marked archived", () => {
  const { store } = setup();
  const a = chatOf(store, "یک");
  const b = chatOf(store, "دو");
  store.addChatRefs(a.id, [{ kind: "board-app-task", ref: "t1" }]);
  store.addChatRefs(b.id, [{ kind: "board-app-task", ref: "t1" }]);
  store.updateChat(b.id, { archived: 1 });
  assert.deepEqual(store.chatsByRefKind("board-app-task").t1.map((c) => [c.id, c.archived]).sort(), [[a.id, 0], [b.id, 1]].sort());
  store.deleteChat(a.id);
  assert.deepEqual(store.chatsByRefKind("board-app-task").t1.map((c) => c.id), [b.id]);
  assert.deepEqual(store.chatRefsOf(a.id), []);
});

test("routes: link later, read a chat's refs, read a kind's refs", async () => {
  const { store, app } = setup();
  const a = chatOf(store, "گفتگوی کار");
  const put = await post(app, `/api/chats/${a.id}/refs`, { refs: [{ kind: "board-app-task", ref: "t9", title: "کار نه" }] });
  assert.equal(put.status, 200);
  const mine = await (await app.request(`/api/chats/${a.id}/refs`)).json();
  assert.deepEqual(mine.refs.map((r) => [r.kind, r.ref, r.title]), [["board-app-task", "t9", "کار نه"]]);
  const all = await (await app.request("/api/chat-refs?kind=board-app-task")).json();
  assert.deepEqual(all.refs.t9.map((c) => c.title), ["گفتگوی کار"]);
  assert.equal((await post(app, "/api/chats/nope/refs", { refs: [] })).status, 404);
  assert.equal((await app.request("/api/chat-refs?kind=BAD KIND")).status, 400);
});

test("unlink: one ref goes, the chat and its other refs stay; routes DELETE it", async () => {
  const { store, app } = setup();
  const a = chatOf(store, "گفتگو");
  store.addChatRefs(a.id, [{ kind: "board-app-task", ref: "t1" }, { kind: "board-app-task", ref: "t2" }]);
  assert.equal(store.removeChatRef(a.id, "board-app-task", "t1"), 1);
  assert.equal(store.removeChatRef(a.id, "board-app-task", "t1"), 0);
  assert.deepEqual(store.chatRefsOf(a.id).map((r) => r.ref), ["t2"]);
  const res = await app.request(`/api/chats/${a.id}/refs?kind=board-app-task&ref=t2`, { method: "DELETE" });
  assert.deepEqual(await res.json(), { removed: 1 });
  assert.deepEqual(store.chatRefsOf(a.id), []);
  assert.equal((await app.request(`/api/chats/${a.id}/refs?kind=BAD&ref=t2`, { method: "DELETE" })).status, 400);
  assert.equal((await app.request(`/api/chats/nope/refs?kind=board-app-task&ref=t2`, { method: "DELETE" })).status, 404);
});
