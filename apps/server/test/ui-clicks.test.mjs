// «نقشهٔ کلیک‌ها» on the server (src/ui-clicks.mjs): counts by day, the report, the hub's fleet view,
// and a member that may report only for itself.
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { cleanReport, cleanRow, createClicks, fleetView, rowKey } from "../src/ui-clicks.mjs";

const memStore = () => {
  const kv = new Map();
  return { getKv: (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null), setKv: (k, v) => kv.set(k, structuredClone(v)), deleteKv: (k) => kv.delete(k), kv };
};

test("a row from the page is cut to what may be kept", () => {
  assert.deepEqual(cleanRow({ route: "home", area: "sidebar", kind: "click", key: "  ارسال\nبازخورد ", n: 3 }), { route: "home", area: "sidebar", kind: "click", key: "ارسال بازخورد", n: 3 });
  assert.equal(cleanRow({ route: "home", kind: "typed", key: "x", n: 1 }), null);
  assert.equal(cleanRow({ route: "home", kind: "click", key: "x", n: 0 }), null);
  assert.equal(cleanRow({ route: "home", kind: "pos", key: "not a cell", n: 1 }), null);
  assert.equal(cleanRow({ route: "home", kind: "click", key: "x", n: 99999 }).n, 500);
});

test("counts add up by day, old days go, and the report sums the last 14", () => {
  const store = memStore();
  let now = new Date("2026-10-01T10:00:00Z");
  const clicks = createClicks({ store, context: () => ({ install: "griffin-a.example", owner: "الف" }), now: () => now, log: {} });
  clicks.record([{ route: "home", area: "sidebar", kind: "click", key: "فضای کار", n: 2 }]);
  now = new Date("2026-10-20T10:00:00Z");
  clicks.record([{ route: "home", area: "sidebar", kind: "click", key: "فضای کار", n: 1 }, { route: "home", area: "screen", kind: "pos", key: "1,2", n: 1 }]);
  now = new Date("2026-10-24T10:00:00Z");
  clicks.record([{ route: "home", area: "sidebar", kind: "click", key: "فضای کار", n: 4 }]);
  const r = clicks.report();
  assert.equal(r.install, "griffin-a.example");
  assert.equal(r.days, 2, "the 1st is past the 14 days");
  assert.equal(r.counts[rowKey({ route: "home", area: "sidebar", kind: "click", key: "فضای کار" })], 5);
  now = new Date("2026-11-05T10:00:00Z");
  clicks.record([{ route: "chat", area: "page", kind: "load", key: "page", n: 1 }]);
  assert.equal(store.getKv("clicks:day:2026-10-01"), null, "past 30 days it is deleted");
  assert.ok(store.getKv("clicks:day:2026-10-20"));
});

test("off records nothing", () => {
  const store = memStore();
  const clicks = createClicks({ store, enabled: () => false, log: {} });
  assert.deepEqual(clicks.record([{ route: "home", kind: "click", key: "x", n: 1 }]), { ok: false, off: true });
  assert.equal(store.kv.size, 0);
});

test("the fleet view puts installs together, biggest first, positions and loads apart", () => {
  const k = (kind, key, route = "home") => rowKey({ route, area: "sidebar", kind, key });
  const reports = [
    { install: "a", owner: "الف", counts: { [k("click", "فضای کار")]: 5, [k("dead", "آیکن")]: 2, [k("load", "page")]: 3, [rowKey({ route: "home", area: "screen", kind: "pos", key: "1,1" })]: 4 } },
    { install: "b", owner: "ب", counts: { [k("click", "فضای کار")]: 1, [k("click", "خروج")]: 1, [k("load", "page")]: 2 } },
  ];
  const all = fleetView(reports);
  assert.equal(all.loads, 5);
  assert.deepEqual(all.rows.map((r) => [r.key, r.n, r.installs]), [["فضای کار", 6, 2], ["آیکن", 2, 1], ["خروج", 1, 1]]);
  assert.equal(all.positions.length, 1);
  assert.deepEqual(fleetView(reports, { install: "b" }).rows.map((r) => r.key), ["فضای کار", "خروج"]);
  assert.equal(all.installs.length, 2);
});

test("the hub takes a member's report only for the member's own address", async () => {
  const store = memStore();
  const clicks = createClicks({ store, supportHost: () => "nova.example", selfHost: () => "nova.example", context: () => ({ install: "nova.example" }), log: {} });
  const api = new Hono();
  const peerAuth = { authenticate: (h) => (h === "Bearer good" ? { userId: "net-griffin-a-example", label: "الف" } : { error: "no", status: 401 }) };
  clicks.routes(api, peerAuth);
  const post = (report, auth = "Bearer good") => api.request("/api/public/network/clicks", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ report }) });
  const report = { install: "griffin-a.example", owner: "الف", days: 3, counts: { [rowKey({ route: "home", area: "page", kind: "click", key: "x" })]: 2, junk: 5 } };
  assert.equal((await post(report, "Bearer bad")).status, 401);
  assert.equal((await post({ ...report, install: "griffin-b.example" })).status, 403);
  assert.equal((await post(report)).status, 200);
  const view = await (await api.request("/api/clicks")).json();
  assert.equal(view.hub, true);
  assert.ok(view.installs.some((i) => i.install === "griffin-a.example"));
  assert.deepEqual(view.rows.map((r) => r.key), ["x"], "a key that is no row is dropped");
  assert.equal(cleanReport({ install: "", counts: {} }), null);
});

test("an install that is not the hub refuses reports and shows its own", async () => {
  const store = memStore();
  const clicks = createClicks({ store, supportHost: () => "nova.example", selfHost: () => "griffin-a.example", context: () => ({ install: "griffin-a.example" }), log: {} });
  const api = new Hono();
  clicks.routes(api, { authenticate: () => ({ userId: "net-x" }) });
  assert.equal((await api.request("/api/public/network/clicks", { method: "POST", body: "{}" })).status, 404);
  await api.request("/api/clicks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows: [{ route: "chat", area: "composer", kind: "click", key: "ارسال", n: 1 }] }) });
  const view = await (await api.request("/api/clicks")).json();
  assert.equal(view.hub, false);
  assert.deepEqual(view.rows.map((r) => r.key), ["ارسال"]);
});
