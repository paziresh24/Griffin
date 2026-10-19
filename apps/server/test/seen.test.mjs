import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { openStore } from "../src/db.mjs";
import { mergeSeen, seenRoutes } from "../src/seen.mjs";

const put = (app, body) => app.request("/api/seen", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = async (app, query = "") => (await app.request(`/api/seen${query}`)).json();
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

test("read state is kept per install: first upload is a baseline, later reads merge, a stale device cannot undo a read", async () => {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-seen-")), "db.sqlite"));
  const app = new Hono();
  seenRoutes(app, { store });
  assert.deepEqual(await get(app), { seen: null, rev: 0 });

  const t1 = "2026-10-19T05:00:00.000Z";
  const t2 = "2026-10-19T06:00:00.000Z";
  const first = await (await put(app, { set: { [A]: t1, [B]: t1 }, init: true })).json();
  assert.equal(first.rev, 1);
  assert.deepEqual(first.seen, { [A]: t1, [B]: t1 });

  // a second device loading at the same time never replaces what the first saved
  const second = await (await put(app, { set: { [A]: "2026-10-01T00:00:00.000Z" }, init: true })).json();
  assert.deepEqual(second.seen, { [A]: t1, [B]: t1 });
  assert.equal(second.rev, 1);

  // the phone reads A at its new time; the desktop, with an old list, later reports the older time
  await put(app, { set: { [A]: t2 } });
  await put(app, { set: { [A]: t1 } });
  assert.equal((await get(app)).seen[A], t2);

  // a hand-made mark always wins; opening the chat clears it
  await put(app, { set: { [B]: "unread" } });
  assert.equal((await get(app)).seen[B], "unread");
  await put(app, { set: { [B]: t2 } });
  assert.equal((await get(app)).seen[B], t2);

  // polling with the revision it holds costs nothing when nothing changed
  const now = await get(app);
  assert.deepEqual(await get(app, `?have=${now.rev}`), { unchanged: true, rev: now.rev });
  const same = await (await put(app, { set: { [A]: t2 } })).json();
  assert.equal(same.rev, now.rev, "a write that changes nothing does not bump the revision");
});

test("read state ignores junk and rejects a body without set", async () => {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-seen-")), "db.sqlite"));
  const app = new Hono();
  seenRoutes(app, { store });
  assert.equal((await put(app, { nope: 1 })).status, 400);
  assert.equal((await put(app, { set: [] })).status, 400);
  await put(app, { set: { [A]: "not a time", "bad id!": "2026-10-19T05:00:00.000Z", [B]: 5 } });
  assert.deepEqual((await get(app)).seen, {});
});

test("mergeSeen keeps the later time and lets a hand-made mark through", () => {
  assert.equal(mergeSeen(undefined, "2026-10-19T05:00:00.000Z"), "2026-10-19T05:00:00.000Z");
  assert.equal(mergeSeen("2026-10-19T06:00:00.000Z", "2026-10-19T05:00:00.000Z"), "2026-10-19T06:00:00.000Z");
  assert.equal(mergeSeen("2026-10-19T06:00:00.000Z", "unread"), "unread");
  assert.equal(mergeSeen("unread", "2026-10-19T05:00:00.000Z"), "2026-10-19T05:00:00.000Z");
});

test("a passive look from another device never clears an unread mark; opening the chat does", async () => {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-seen-")), "db.sqlite"));
  const app = new Hono();
  seenRoutes(app, { store });
  const t1 = "2026-10-19T05:00:00.000Z";
  const t2 = "2026-10-19T06:00:00.000Z";
  await put(app, { set: { [A]: t1 } });
  await put(app, { set: { [A]: "unread" } });
  // the phone has the chat open on a stale copy and looks at it again (tab back, new content)
  await put(app, { set: {}, soft: { [A]: t2 } });
  assert.equal((await get(app)).seen[A], "unread");
  // a passive look on a chat that is not marked still moves the seen time
  await put(app, { set: {}, soft: { [B]: t1 } });
  assert.equal((await get(app)).seen[B], t1);
  // opening it (forced) clears the mark
  await put(app, { set: { [A]: t2 } });
  assert.equal((await get(app)).seen[A], t2);
});
