import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { openStore } from "../src/db.mjs";
import { uiPrefsRoutes, cleanUiPrefs } from "../src/ui-prefs.mjs";

const json = (app, url, body, method) => app.request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("ui prefs: stored per install, merged, a migration never overwrites, reset keeps a marker", async () => {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-ui-")), "db.sqlite"));
  const app = new Hono();
  uiPrefsRoutes(app, { store });
  assert.equal((await (await app.request("/api/ui-prefs")).json()).stored, null);
  await json(app, "/api/ui-prefs", { look: "karsara", flags: { oneList: true, navHidden: ["jobs"] }, migrated: true }, "PUT");
  let { stored } = await (await app.request("/api/ui-prefs")).json();
  assert.equal(stored.look, "karsara");
  assert.equal(stored.migrated, true);
  // A second device's snapshot loses to what is stored.
  await json(app, "/api/ui-prefs", { look: "griffin", flags: {}, migrated: true }, "PUT");
  assert.equal((await (await app.request("/api/ui-prefs")).json()).stored.look, "karsara");
  // The user's own change merges and drops the migration mark.
  ({ stored } = await (await json(app, "/api/ui-prefs", { flags: { homeBoard: true } }, "PUT")).json());
  assert.deepEqual(stored.flags, { oneList: true, navHidden: ["jobs"], homeBoard: true });
  assert.equal(stored.migrated, undefined);
  ({ stored } = await (await app.request("/api/ui-prefs", { method: "DELETE" })).json());
  assert.deepEqual(stored, {});
  assert.deepEqual((await (await app.request("/api/ui-prefs")).json()).stored, {});
  assert.equal((await json(app, "/api/ui-prefs", "x", "PUT")).status, 400);
});

test("ui prefs: junk is dropped", () => {
  assert.deepEqual(cleanUiPrefs({ look: "<x>", flags: { "bad key": true, ok: "yes", n: ["a b"], good: false, nav: ["jobs"] } }), { flags: { good: false, nav: ["jobs"] } });
});

test("ui prefs: a module page's section id is kept (hidden or ordered), a malformed one is dropped", () => {
  const out = cleanUiPrefs({ flags: { navHidden: ["m:helpdesk:list"], navOrder: ["peers", "m:helpdesk:list", "jobs"], bad: ["m:Helpdesk:list"] } });
  assert.deepEqual(out.flags, { navHidden: ["m:helpdesk:list"], navOrder: ["peers", "m:helpdesk:list", "jobs"] });
});

test("ui prefs: a named choice (navStyle) is kept, a malformed one dropped", () => {
  assert.deepEqual(cleanUiPrefs({ flags: { navStyle: "rail", railPinned: false, bad: "Rail!" } }).flags, { navStyle: "rail", railPinned: false });
});

test("list prefs: the dragged order of a grouping's sections is kept per grouping; junk is refused", async () => {
  const { listPrefsRoutes } = await import("../src/list-prefs.mjs");
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-lp-")), "db.sqlite"));
  const app = new Hono();
  listPrefsRoutes(app, { store });
  assert.deepEqual((await (await app.request("/api/list-prefs")).json()).sectionOrder, {});
  await json(app, "/api/list-prefs", { sectionOrder: { repo: ["repo:b", "repo:a"] } }, "PUT");
  await json(app, "/api/list-prefs", { sectionOrder: { agent: ["agent:x"] } }, "PUT");
  const { sectionOrder, sort } = await (await app.request("/api/list-prefs")).json();
  assert.deepEqual(sectionOrder, { repo: ["repo:b", "repo:a"], agent: ["agent:x"] });
  assert.equal(sort, undefined);
  for (const bad of [{ nope: ["x"] }, { repo: "x" }, { repo: [1] }, ["repo"]]) assert.equal((await json(app, "/api/list-prefs", { sectionOrder: bad }, "PUT")).status, 400);
});
