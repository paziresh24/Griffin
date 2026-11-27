import { DEFAULT_TZ } from "../src/jobs/cron.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { aggregateFleet, buildReport, cleanReport, companyRoster, coverageAlerts, createAccounting, fleetAlerts, fleetCoverage, installCoverage, keyFingerprint, KV_COMPANY, rosterCandidates } from "../src/accounting.mjs";
import { companyChecks } from "../src/doctor.mjs";

const NOW = new Date("2026-10-19T12:00:00Z");
const ago = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const turn = (h, provider, input, output = 0, cacheRead = 0) => ({ at: ago(h), provider, model: "opus", usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead } });
const weekReset = "2026-10-22T08:00:00.000Z";

function report(install, owner, { fp, rows, reset = weekReset, weekly = 40, limit = null, broken = null }) {
  return cleanReport(
    buildReport({
      rows,
      accounts: [{ id: "claude", kind: "claude", enabled: true, fingerprint: fp, windows: [{ label: "هفتگی", percentage: weekly, resetAt: Date.parse(reset) }, { label: "۵ ساعته", percentage: 10, resetAt: Date.parse("2026-10-19T14:00:00Z") }], windowsAt: ago(0.2), limit, broken }],
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
  assert.deepEqual(kinds, ["forecast", "limit", "share", "spike", "stale", "weekly"]); // forecast: account c used 40% of its week in 1.5 days
  assert.equal(alerts.find((a) => a.key.startsWith("weekly")).level, "critical");
});

function memStore() {
  const kv = new Map();
  return { getKv: (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null), setKv: (k, v) => kv.set(k, structuredClone(v)), deleteKv: (k) => kv.delete(k) };
}
function fakeApp() {
  const routes = {};
  const reg = (m) => (path, h) => (routes[`${m} ${path}`] = h);
  return { routes, get: reg("GET"), post: reg("POST"), put: reg("PUT"), delete: reg("DELETE") };
}
const ctx = (body, auth = "Bearer x") => {
  let out;
  return { req: { header: (h) => (h === "authorization" ? auth : null), json: async () => body }, json: (b, status = 200) => (out = { b, status }), get out() { return out; } };
};

test("only the hub keeps reports and shows the page; a member reports for itself only, alerts once", async () => {
  const store = memStore();
  const sent = [];
  let self = "hub.example.com";
  const acc = createAccounting({ store, supportHost: () => "hub.example.com", selfHost: () => self, collect: async () => null, notify: async (t) => sent.push(t), now: () => NOW });
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
  self = "node-x.example.com";
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

test("a fingerprint shared by logins of different accounts joins nothing; the email and the id name the account", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const as = (r, patch) => ({ ...r, accounts: r.accounts.map((a) => ({ ...a, ...patch })) });
  // An older install's folder-login marker: the same fingerprint everywhere, whoever is signed in.
  const fp = "f0f0f0f0f0f0";
  const reports = [
    as(report("a.example.com", "الف", { fp, rows: [turn(1, "claude", 1000)], reset: "2026-10-22T08:00:00Z" }), { email: "one@x.com" }),
    as(report("b.example.com", "ب", { fp, rows: [turn(1, "claude", 2000)], reset: "2026-10-23T08:00:00Z" }), { email: "two@x.com" }),
    as(report("c.example.com", "ج", { fp, rows: [turn(1, "claude", 10)], reset: "2026-10-25T08:00:00Z" }), {}),
    // A token login of account one: its id, no email; the same weekly reset says it is one@x.com.
    as(report("d.example.com", "د", { fp: "dddddddddddd", rows: [turn(1, "claude", 500)], reset: "2026-10-22T08:02:00Z" }), { org: A }),
    // Account two signed in on another install: the email joins it.
    as(report("e.example.com", "ه", { fp: "eeeeeeeeeeee", rows: [turn(1, "claude", 700)], reset: "2026-10-23T08:00:00Z" }), { email: "TWO@x.com" }),
  ];
  const fleet = aggregateFleet(reports, { now: NOW });
  const of = (install) => fleet.accounts.find((g) => g.installs.some((m) => m.install === install));
  assert.equal(fleet.accounts.length, 3);
  assert.equal(of("a.example.com").title, "one@x.com");
  assert.equal(of("d.example.com"), of("a.example.com"));
  assert.equal(of("a.example.com").inferred, true);
  assert.equal(of("e.example.com"), of("b.example.com"));
  assert.equal(of("b.example.com").inferred, false);
  assert.notEqual(of("c.example.com"), of("a.example.com"));
  assert.notEqual(of("c.example.com"), of("b.example.com"));
});

test("a full account is one message naming its installs, in Tehran time; an old report raises no spike and counts in no total", () => {
  const until = "2026-10-20T01:00:00.000Z"; // 04:30 Tehran, the next day
  const full = (install, owner) => report(install, owner, { fp: "aaaaaaaaaaaa", rows: [turn(1, "claude", 1e6)], weekly: 100, reset: until, limit: { at: ago(0.5), until } });
  const spikeRows = [turn(1, "claude", 20e6), ...[2, 3, 4, 5, 6, 7].map((d) => turn(d * 24 + 1, "claude", 1e6))];
  const old = { ...report("z.example.com", "ز", { fp: "zzzzzzzzzzzz", rows: spikeRows }), at: ago(30) };
  const reports = [full("a.example.com", "الف"), full("b.example.com", "ب"), full("c.example.com", "ج"), old];
  const fleet = aggregateFleet(reports, { now: NOW });
  const alerts = fleetAlerts(fleet, { now: NOW });
  const limits = alerts.filter((a) => a.key.startsWith("limit"));
  assert.equal(limits.length, 1);
  assert.match(limits[0].text, /سقف هفتگی/);
  const hm = new Intl.DateTimeFormat("fa-IR", { timeZone: DEFAULT_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(until));
  assert.ok(limits[0].text.includes(`فردا ساعت ${hm}`), limits[0].text);
  assert.match(limits[0].text, /الف، ب، ج/);
  assert.ok(!alerts.some((a) => /\d{4}-\d\d-\d\dT/.test(a.text)), "no UTC timestamps");
  assert.ok(!alerts.some((a) => a.key.startsWith("weekly")), "the full week is already the limit message");
  assert.ok(!alerts.some((a) => a.key.startsWith("spike")), "no spike from a day-old report");
  assert.equal(fleet.totals.last24h.input, 3e6);
  assert.ok(!fleet.accounts.some((g) => g.installs.some((m) => m.install === "z.example.com")));
  assert.equal(fleet.installs.find((i) => i.install === "z.example.com").stale, true);
});

test("pricing: model aliases and list prices; cache reads are priced, not ignored", async () => {
  const { priceOf, costOf } = await import("../src/pricing.mjs");
  assert.equal(priceOf("opus").label, "Opus 5.5");
  assert.equal(priceOf("claude-opus-5-5").input, 4);
  assert.equal(priceOf("claude-sonnet-5").label, "Sonnet 5.5");
  assert.equal(priceOf("claude-haiku-5-5").output, 0.5);
  assert.equal(priceOf("claude-sonnet-4-6").input, 3);
  assert.equal(priceOf("opus[1m]").label, "Opus 5.5");
  assert.equal(priceOf("glm-4.6"), null);
  assert.equal(priceOf("opus").weight, 2);
  // 1M of each part on Opus 5.5: 4 + 20 + 5 (write = 1.25x input) + 0.2
  assert.equal(costOf({ input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 }, "opus"), 29.2);
  assert.equal(costOf({ input: 1e6 }, "glm-4.6"), 0);
});

test("the report and the fleet carry cost per model, account and install, and a plan to read it against", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const at = "2026-11-01T10:00:00Z";
  const rows = [
    { at, provider: "claude-1", model: "opus", usage: { input_tokens: 0, output_tokens: 1e6, cache_read_input_tokens: 10e6, cache_creation_input_tokens: 1e6 } },
    { at, provider: "claude-1", model: "sonnet", usage: { input_tokens: 1e6, output_tokens: 0 } },
  ];
  const acc = [{ id: "claude-1", kind: "claude", label: "x", fingerprint: "a".repeat(12), org: "00000000-0000-4000-8000-000000000001" }];
  const report = buildReport({ rows, accounts: acc, install: "a.example", now });
  // opus: 20 + 5 + 2 = 27; sonnet: 2
  assert.equal(report.usage.byModel.opus.cost.last24h, 27);
  assert.equal(report.usage.cost.last7d, 29);
  assert.equal(report.usage.byAccount["claude-1"].cost.last24h, 29);
  const fleet = aggregateFleet([cleanReport(report, now)], { now });
  assert.equal(fleet.totals.cost.last24h, 29);
  assert.equal(fleet.models[0].model, "opus");
  assert.equal(fleet.models[0].weight, 2);
  assert.equal(fleet.accounts[0].cost.last24h, 29);
  assert.equal(fleet.installs[0].cost.last24h, 29);
  assert.equal(fleet.plan.weeklyUsd, 0); // the test account has no name or email: not a paid plan
  // an install of an older version reports no cost: the hub prices its parts
  const old = cleanReport(report, now);
  delete old.usage.cost;
  for (const v of Object.values(old.usage.byModel)) v.cost = null;
  for (const v of Object.values(old.usage.byAccount)) v.cost = null;
  const f2 = aggregateFleet([old], { now });
  assert.equal(f2.installs[0].cost.last24h, 29);
  assert.equal(Math.round(f2.accounts[0].cost.last24h), 29);
});

test("an account stopped by payment or an expired login is one early alert naming its installs", () => {
  const broken = { state: "credit", since: ago(1) };
  const mk = (install, owner, b) => report(install, owner, { fp: "bbbbbbbbbbbb", rows: [turn(1, "claude", 1e6)], broken: b });
  const fleet = aggregateFleet([mk("a.example.com", "الف", broken), mk("b.example.com", "ب", broken), mk("c.example.com", "ج", null)], { now: NOW });
  const alerts = fleetAlerts(fleet, { now: NOW }).filter((a) => a.key.startsWith("broken:"));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, "critical");
  assert.match(alerts[0].text, /روی 2 نصب خراب است/);
  assert.ok(!/ج/.test(alerts[0].text.split("(").pop()));
  const auth = aggregateFleet([mk("a.example.com", "الف", { state: "auth", since: ago(1) })], { now: NOW });
  assert.match(fleetAlerts(auth, { now: NOW }).find((a) => a.key.startsWith("broken:")).text, /نشست ورودش منقضی/);
  // an old mark (older than two days) is not news
  const stale = aggregateFleet([mk("a.example.com", "الف", { state: "credit", since: ago(60) })], { now: NOW });
  assert.equal(fleetAlerts(stale, { now: NOW }).filter((a) => a.key.startsWith("broken:")).length, 0);
});

test("forecast: the week will fill before its reset at the current pace, said once, below the 80% line", () => {
  // 3.5 of 7 days gone, 60% used -> ~120% at reset
  const reset = new Date(NOW.getTime() + 3.5 * 86_400_000).toISOString();
  const r = (weekly, rs = reset) => report("a.example.com", "الف", { fp: "cccccccccccc", rows: [turn(1, "claude", 1e6)], weekly, reset: rs });
  const hit = fleetAlerts(aggregateFleet([r(60)], { now: NOW }), { now: NOW }).filter((a) => a.key.startsWith("forecast:"));
  assert.equal(hit.length, 1);
  assert.match(hit[0].text, /پیش از ریست/);
  // slow pace: no forecast; first day: no forecast; already past 80%: the normal alert speaks
  assert.equal(fleetAlerts(aggregateFleet([r(40)], { now: NOW }), { now: NOW }).filter((a) => a.key.startsWith("forecast:")).length, 0);
  const day1 = new Date(NOW.getTime() + 6.9 * 86_400_000).toISOString();
  assert.equal(fleetAlerts(aggregateFleet([r(35, day1)], { now: NOW }), { now: NOW }).filter((a) => a.key.startsWith("forecast:")).length, 0);
  assert.equal(fleetAlerts(aggregateFleet([r(85)], { now: NOW }), { now: NOW }).filter((a) => a.key.startsWith("forecast:")).length, 0);
});

// The company's accounts (owner 2026-11-23): an account with an email on three installs is one the
// company handed out; each install is measured against them and told about itself.
const ORGS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const slot = (id, org, extra = {}) => ({ id, kind: "claude", enabled: true, fingerprint: org ? org.slice(0, 12).replace(/-/g, "a") : "abcdefabcdef", org, ...extra });
const fleetOf = (installs) => installs.map(([install, accounts]) => cleanReport(buildReport({ accounts, install, owner: install.split(".")[0], now: NOW }), NOW));

test("roster: an account with an email on three installs is the company's; a personal one is not, unless pinned", () => {
  const reports = fleetOf([
    ["a.example.com", [slot("claude", ORGS[0], { email: "One@x.com" }), slot("claude-2", ORGS[1], { email: "two@x.com" }), slot("claude-3", ORGS[2], { email: "mine@x.com" })]],
    ["b.example.com", [slot("claude", ORGS[0]), slot("claude-2", ORGS[1])]],
    ["c.example.com", [slot("claude-5", ORGS[0]), slot("claude-6", ORGS[1], { email: "two@x.com" }), slot("claude-7", ORGS[2])]],
  ]);
  const roster = companyRoster(reports, { now: NOW });
  assert.deepEqual(roster.map((r) => r.email), ["one@x.com", "two@x.com"]);
  // ORGS[2] is on two installs only: a candidate the owner may pin.
  assert.deepEqual(rosterCandidates(reports, roster, { now: NOW }).map((c) => c.org), [ORGS[2]]);
  assert.equal(companyRoster(reports, { overrides: { add: [ORGS[2]] }, now: NOW }).length, 3);
  assert.equal(companyRoster(reports, { overrides: { drop: [ORGS[0]] }, now: NOW }).length, 1);
  // A day-old report says nothing about now.
  const old = reports.map((r) => ({ ...r, at: ago(30) }));
  assert.equal(companyRoster(old, { now: NOW }).length, 0);
});

test("coverage: each company account is ok, broken or missing; other slots are named for what they are", () => {
  const roster = [{ org: ORGS[0], email: "one@x.com", name: "one@x.com" }, { org: ORGS[1], email: "two@x.com", name: "two@x.com" }, { org: ORGS[2], email: "three@x.com", name: "three@x.com" }];
  const [r] = fleetOf([[
    "a.example.com",
    [
      slot("claude", ORGS[0]),
      slot("claude-2", null, { email: "two@x.com", broken: { state: "auth", since: ago(1) } }),
      slot("claude-3", "44444444-4444-4444-8444-444444444444", { email: "me@y.com" }),
      slot("claude-4", null),
      { id: "claude-5", kind: "claude", enabled: true, fingerprint: null },
      { id: "openai", kind: "openai", enabled: true },
    ],
  ]]);
  const c = installCoverage(r, roster);
  assert.equal(c.have, 1);
  assert.equal(c.total, 3);
  assert.deepEqual(c.accounts.map((a) => a.state), ["ok", "broken", "missing"]);
  assert.equal(c.accounts[1].broken, "auth");
  assert.deepEqual(c.extras.map((e) => [e.id, e.why]), [["claude-3", "other"], ["claude-4", "noid"], ["claude-5", "empty"]]);
});

test("coverage alerts: one message a day for the gaps; an account broken on every install is the account's fault", () => {
  const roster = [{ org: ORGS[0], email: "one@x.com", name: "one@x.com" }, { org: ORGS[1], email: "two@x.com", name: "two@x.com" }];
  const reports = fleetOf([
    ["a.example.com", [slot("claude", ORGS[0]), slot("claude-2", ORGS[1], { broken: { state: "auth", since: ago(1) } })]],
    ["b.example.com", [slot("claude", ORGS[0]), slot("claude-2", ORGS[1], { broken: { state: "auth", since: ago(2) } })]],
    ["c.example.com", [slot("claude", ORGS[0])]],
  ]);
  const cov = fleetCoverage(reports, roster, { now: NOW });
  const alerts = coverageAlerts(cov, roster, { now: NOW });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, "critical");
  assert.match(alerts[0].text, /two@x\.com.*همهٔ نصب‌ها/);
  // One install missing the healthy one: the daily gap message names it.
  const more = fleetOf([["d.example.com", [slot("claude-2", ORGS[1])]]]);
  const cov2 = fleetCoverage([...reports, ...more], roster, { now: NOW });
  const a2 = coverageAlerts(cov2, roster, { now: NOW });
  const gap = a2.find((a) => a.key.startsWith("coverage:"));
  assert.match(gap.text, /^\d+ نصب/);
  assert.match(gap.text, /d: 1 از 2 \(one\)/);
  assert.equal(gap.cooldownMs, 86_400_000);
});

test("the hub answers each member with its own coverage; the member keeps it for its status page", async () => {
  const store = memStore();
  const acc = createAccounting({ store, supportHost: () => "hub.example.com", selfHost: () => "hub.example.com", collect: async () => null, now: () => NOW });
  const app = fakeApp();
  acc.routes(app, { authenticate: () => ({ userId: "net-d-example-com", label: "د" }) });
  acc.ownerRoutes(app);
  for (const r of fleetOf([["a.example.com", [slot("claude", ORGS[0], { email: "one@x.com" })]], ["b.example.com", [slot("claude", ORGS[0])]], ["c.example.com", [slot("claude", ORGS[0])]]])) acc.keep(r);
  const [mine] = fleetOf([["d.example.com", [slot("claude-4", null)]]]);
  const c = ctx({ report: mine });
  await app.routes["POST /api/public/network/usage"](c);
  assert.equal(c.out.status, 200);
  const company = c.out.b.company;
  assert.equal(company.have, 0);
  assert.equal(company.total, 1);
  assert.equal(company.roster[0].email, "one@x.com");
  // On the member: the doctor reads what the hub said.
  const { checks, names } = companyChecks(company, NOW.getTime());
  assert.equal(checks[0].level, "warn");
  assert.equal(checks[0].fix.id, "wizard");
  assert.match(checks[0].detail, /one@x\.com: وارد نشده/);
  assert.equal(checks[1].id, "company-accounts:unknown");
  assert.equal(names["claude-4"], "اکانتش معلوم نیست");
  // A stale answer (two days old) shows nothing rather than an old picture.
  assert.equal(companyChecks({ ...company, at: ago(60) }, NOW.getTime()).checks.length, 0);
  // The owner pins and drops on the hub.
  const g = ctx();
  await app.routes["GET /api/accounting"](g);
  assert.equal(g.out.b.roster.length, 1);
  assert.equal(g.out.b.coverage.find((x) => x.install === "d.example.com").have, 0);
  const p = ctx({ org: ORGS[0], include: false });
  await app.routes["PUT /api/accounting/roster"](p);
  assert.equal(p.out.b.roster.length, 0);
  assert.equal(typeof KV_COMPANY, "string");
});

// The maintainer's announcement (2026-11-24): set on the hub, carried on every usage answer, pushed to
// connected members, accepted by a member only from the hub, gone once it expires.
test("announcement: the hub sets it, members get it from the hub only, it expires", async () => {
  const { cleanAnnouncement, KV_ANNOUNCEMENT } = await import("../src/accounting.mjs");
  const pushed = [];
  const hubStore = memStore();
  const network = { list: () => [{ id: "net-a", connected: true }, { id: "net-b", connected: false }], post: async (id, path, body) => (pushed.push({ id, path, body }), { ok: true }) };
  const hub = createAccounting({ store: hubStore, network, supportHost: () => "hub.example.com", selfHost: () => "hub.example.com", collect: async () => null, now: () => NOW });
  const app = fakeApp();
  hub.routes(app, { authenticate: () => ({ userId: "net-a-example-com", label: "الف" }) });
  hub.ownerRoutes(app);
  let c = ctx({ text: "  اکانت acct1 فعلاً خاموش است  ", level: "warn", hours: 24 });
  await app.routes["PUT /api/announcement"](c);
  assert.equal(c.out.status, 200);
  assert.equal(c.out.b.announcement.text, "اکانت acct1 فعلاً خاموش است");
  assert.equal(c.out.b.sent, 1);
  assert.equal(pushed[0].path, "/api/public/network/announcement");
  c = ctx();
  await app.routes["GET /api/announcement"](c);
  assert.equal(c.out.b.canEdit, true);
  assert.equal(c.out.b.announcement.level, "warn");
  // A member's usage report is answered with it.
  const r = buildReport({ rows: [], install: "a.example.com", owner: "الف", now: NOW });
  c = ctx({ report: r });
  await app.routes["POST /api/public/network/usage"](c);
  assert.equal(c.out.b.announcement.id, hubStore.getKv(KV_ANNOUNCEMENT).id);
  // On a member: only the hub may set it.
  const memberStore = memStore();
  const member = createAccounting({ store: memberStore, supportHost: () => "hub.example.com", selfHost: () => "a.example.com", collect: async () => null, now: () => NOW });
  let who = { userId: "net-x-example-com" };
  const mApp = fakeApp();
  member.routes(mApp, { authenticate: () => who });
  member.ownerRoutes(mApp);
  c = ctx({ announcement: pushed[0].body.announcement });
  await mApp.routes["POST /api/public/network/announcement"](c);
  assert.equal(c.out.status, 403);
  who = { userId: "net-hub-example-com" };
  c = ctx({ announcement: pushed[0].body.announcement });
  await mApp.routes["POST /api/public/network/announcement"](c);
  assert.equal(c.out.status, 200);
  c = ctx();
  await mApp.routes["GET /api/announcement"](c);
  assert.equal(c.out.b.canEdit, false);
  assert.equal(c.out.b.announcement.text, "اکانت acct1 فعلاً خاموش است");
  c = ctx({ text: "x" });
  await mApp.routes["PUT /api/announcement"](c);
  assert.equal(c.out.status, 404);
  // Expired, or junk: nothing.
  assert.equal(cleanAnnouncement({ id: "abcd1234", text: "x", until: ago(1) }, NOW), null);
  assert.equal(cleanAnnouncement({ id: "../x", text: "x" }, NOW), null);
  // Taken back on the hub: members are told null.
  c = ctx();
  await app.routes["DELETE /api/announcement"](c);
  assert.equal(c.out.b.announcement, null);
  assert.equal(pushed.at(-1).body.announcement, null);
});
