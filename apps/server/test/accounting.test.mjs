import test from "node:test";
import assert from "node:assert/strict";
import { aggregateFleet, buildReport, cleanReport, createAccounting, fleetAlerts, keyFingerprint } from "../src/accounting.mjs";

const NOW = new Date("2026-10-19T12:00:00Z");
const ago = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const turn = (h, provider, input, output = 0, cacheRead = 0) => ({ at: ago(h), provider, model: "opus", usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead } });
const weekReset = "2026-10-22T08:00:00.000Z";

function report(install, owner, { fp, rows, reset = weekReset, weekly = 40, limit = null }) {
  return cleanReport(
    buildReport({
      rows,
      accounts: [{ id: "claude", kind: "claude", enabled: true, fingerprint: fp, windows: [{ label: "هفتگی", percentage: weekly, resetAt: Date.parse(reset) }, { label: "۵ ساعته", percentage: 10, resetAt: Date.parse("2026-10-19T14:00:00Z") }], windowsAt: ago(0.2), limit }],
      install,
      owner,
      now: NOW,
    }),
    NOW,
  );
}

test("the key never leaves: only a 12-hex fingerprint", () => {
  const fp = keyFingerprint("sk-ant-oat01-secret");
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(keyFingerprint(""), null);
  const r = buildReport({ accounts: [{ id: "claude", kind: "claude", fingerprint: fp }], install: "a.example.com", now: NOW });
  assert.ok(!JSON.stringify(r).includes("secret"));
});

test("a report counts 24h and 7 days per account and model", () => {
  const r = buildReport({ rows: [turn(1, "claude", 100, 50, 1000), turn(30, "claude", 10), turn(200, "openai", 999), turn(2, "openai", 7)], install: "A.example.com", now: NOW });
  assert.equal(r.install, "a.example.com");
  assert.equal(r.usage.last24h.total, 1157);
  assert.equal(r.usage.last7d.total, 1167);
  assert.equal(r.usage.byAccount.claude.last24h.cacheRead, 1000);
  assert.equal(r.usage.byAccount.openai.last7d.total, 7);
  assert.equal(r.usage.days.length, 14);
});

test("logins with different tokens but the same weekly reset are one account; a name joins them too", () => {
  const reports = [
    report("a.example.com", "الف", { fp: "aaaaaaaaaaaa", rows: [turn(1, "claude", 1000)] }),
    report("b.example.com", "ب", { fp: "bbbbbbbbbbbb", rows: [turn(1, "claude", 3000)], reset: "2026-10-22T08:01:00Z" }),
    report("c.example.com", "ج", { fp: "cccccccccccc", rows: [turn(1, "claude", 10)], reset: "2026-10-24T08:00:00Z" }),
    report("d.example.com", "د", { fp: "dddddddddddd", rows: [], reset: "2026-10-25T00:00:00Z" }),
  ];
  let fleet = aggregateFleet(reports, { now: NOW });
  assert.equal(fleet.accounts.length, 3);
  assert.deepEqual(fleet.accounts[0].fingerprints, ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  assert.equal(fleet.accounts[0].installs[0].install, "b.example.com");
  fleet = aggregateFleet(reports, { now: NOW, labels: { cccccccccccc: "اکانت ۲", dddddddddddd: "اکانت ۲" } });
  assert.equal(fleet.accounts.length, 2);
  assert.ok(fleet.accounts.some((a) => a.title === "اکانت ۲" && a.installs.length === 2));
  assert.equal(fleet.installs[0].install, "b.example.com");
});

test("alerts: weekly window, a limit hit, a spike, one install eating a shared account, a quiet install", () => {
  const spikeRows = [turn(1, "claude", 20e6), ...[2, 3, 4, 5, 6, 7].map((d) => turn(d * 24 + 1, "claude", 1e6))];
  const reports = [
    report("a.example.com", "الف", { fp: "aaaaaaaaaaaa", rows: spikeRows, weekly: 96, limit: { at: ago(0.5), until: new Date(NOW.getTime() + 3600_000).toISOString() } }),
    report("b.example.com", "ب", { fp: "aaaaaaaaaaaa", rows: [turn(1, "claude", 1e6)] }),
  ];
  reports.push({ ...report("c.example.com", "ج", { fp: "cccccccccccc", rows: [], reset: "2026-10-25T00:00:00Z" }), at: ago(5) });
  const alerts = fleetAlerts(aggregateFleet(reports, { now: NOW }), { now: NOW });
  const kinds = alerts.map((a) => a.key.split(":")[0]).sort();
  assert.deepEqual(kinds, ["limit", "share", "spike", "stale", "weekly"]);
  assert.equal(alerts.find((a) => a.key.startsWith("weekly")).level, "critical");
});

function memStore() {
  const kv = new Map();
  return { getKv: (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null), setKv: (k, v) => kv.set(k, structuredClone(v)), deleteKv: (k) => kv.delete(k) };
}
function fakeApp() {
  const routes = {};
  const reg = (m) => (path, h) => (routes[`${m} ${path}`] = h);
  return { routes, get: reg("GET"), post: reg("POST"), put: reg("PUT") };
}
const ctx = (body, auth = "Bearer x") => {
  let out;
  return { req: { header: (h) => (h === "authorization" ? auth : null), json: async () => body }, json: (b, status = 200) => (out = { b, status }), get out() { return out; } };
};

test("only the hub keeps reports and shows the page; a member reports for itself only, alerts once", async () => {
  const store = memStore();
  const sent = [];
  let self = "support.example.com";
  const acc = createAccounting({ store, supportHost: () => "support.example.com", selfHost: () => self, collect: async () => null, notify: async (t) => sent.push(t), now: () => NOW });
  const app = fakeApp();
  acc.routes(app, { authenticate: () => ({ userId: "net-a-example-com", label: "الف" }) });
  acc.ownerRoutes(app);
  const r = buildReport({ rows: [turn(1, "claude", 30e6)], install: "a.example.com", owner: "الف", now: NOW });
  let c = ctx({ report: { ...r, install: "b.example.com" } });
  await app.routes["POST /api/public/network/usage"](c);
  assert.equal(c.out.status, 403);
  c = ctx({ report: r });
  await app.routes["POST /api/public/network/usage"](c);
  assert.equal(c.out.status, 200);
  await acc.check();
  await acc.check();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /الف/);
  c = ctx();
  await app.routes["GET /api/accounting"](c);
  assert.equal(c.out.b.installs[0].install, "a.example.com");
  self = "karsara-x.example.com";
  c = ctx();
  await app.routes["GET /api/accounting"](c);
  assert.equal(c.out.status, 404);
  c = ctx({ report: r });
  await app.routes["POST /api/public/network/usage"](c);
  assert.equal(c.out.status, 404);
});

test("the account id groups logins exactly: one id joins, two ids never join even with the same reset; a name sticks to the id", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const withOrg = (r, org) => ({ ...r, accounts: r.accounts.map((a) => ({ ...a, org })) });
  const reports = [
    withOrg(report("a.example.com", "الف", { fp: "aaaaaaaaaaaa", rows: [turn(1, "claude", 1000)], reset: "2026-10-22T08:00:00Z" }), A),
    withOrg(report("b.example.com", "ب", { fp: "bbbbbbbbbbbb", rows: [turn(1, "claude", 10)], reset: "2026-10-25T00:00:00Z" }), A),
    withOrg(report("c.example.com", "ج", { fp: "cccccccccccc", rows: [], reset: "2026-10-22T08:00:00Z" }), B),
  ];
  const fleet = aggregateFleet(reports, { now: NOW, labels: { [A]: "x@example.com" } });
  assert.equal(fleet.accounts.length, 2);
  const a = fleet.accounts.find((g) => g.key === A);
  assert.equal(a.title, "x@example.com");
  assert.equal(a.installs.length, 2);
  assert.equal(a.inferred, false);
  assert.ok(cleanReport(reports[0], NOW).accounts[0].org === A);
});
