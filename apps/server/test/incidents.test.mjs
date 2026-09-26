import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { groupAlerts, incidentKey } from "../src/incidents/group.mjs";
import { createIncidentStore, createIntake } from "../src/incidents/index.mjs";
import { createIncidentTools, createOpsRoom, digestMessage, OPS_CHARTER } from "../src/incidents/opsroom.mjs";
import { resolveEnabledTools, rootCallerOf } from "../src/agents/profiles.mjs";
import { seedExampleAgents } from "./fixture-agents.mjs";

const alert = (over = {}) => ({
  fingerprint: Math.random().toString(16).slice(2),
  cluster: "dr",
  seenFrom: "dr",
  alertname: "KubePodNotReady",
  severity: "warning",
  owner: null,
  labels: { namespace: "sentry", pod: "sentry-worker-1" },
  summary: "pod not ready",
  startsAt: "2026-09-18T08:00:00Z",
  ...over,
});
const watchdog = (cluster) => alert({ cluster, seenFrom: cluster, alertname: "Watchdog", severity: "none", labels: {} });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-incidents-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  seedExampleAgents(store);
  let clock = new Date("2026-09-18T10:00:00Z");
  const now = () => clock;
  const incidents = createIncidentStore(store.db, { now });
  let payload = { clusters: {}, alerts: [] };
  const batches = [];
  const intake = createIntake({
    incidents,
    now,
    fetchAlerts: async () => payload,
    onChanges: (changes, meta) => batches.push({ changes, meta }),
    log: { error() {} },
  });
  return {
    store,
    incidents,
    intake,
    batches,
    set: (p) => (payload = p),
    advance: (ms) => (clock = new Date(clock.getTime() + ms)),
  };
}

const ok = (...names) => Object.fromEntries(names.map((n) => [n, { ok: true }]));

test("a storm of the same alert is one incident with members", () => {
  const groups = groupAlerts([
    alert({ labels: { namespace: "sentry", pod: "a" } }),
    alert({ labels: { namespace: "sentry", pod: "b" } }),
    alert({ labels: { namespace: "sentry", pod: "b" } }),
    alert({ labels: { namespace: "other", pod: "c" } }),
    alert({ alertname: "PodLoggedErrors24h", severity: "none" }),
    watchdog("dr"),
  ]);
  assert.equal(groups.size, 2);
  assert.deepEqual(groups.get("dr|KubePodNotReady|sentry").members, ["a", "b"]);
});

test("per-cluster alerts and owner labels choose the key", () => {
  assert.equal(incidentKey(alert({ alertname: "TLSCertExpiringSoon", labels: { namespace: "x", instance: "a.example.com" } })), "dr|TLSCertExpiringSoon|");
  assert.equal(incidentKey(alert({ alertname: "GatewayAppHttp5xxHigh", owner: "omid-rad", labels: { app_name: "patient" } })), "dr|GatewayAppHttp5xxHigh|omid-rad");
  assert.equal(incidentKey(alert({ alertname: "SeaweedOwnerBucketHuge", severity: "critical", labels: { bucket: "salireza-sadr" } })), "dr|SeaweedOwnerBucketHuge|salireza-sadr");
});

test("first poll is a silent baseline; later polls only report state changes", async () => {
  const t = setup();
  t.set({ clusters: ok("dr"), alerts: [alert(), watchdog("dr")] });
  const first = await t.intake.poll();
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "baseline");
  assert.equal(t.batches[0].meta.bootstrap, true);

  // same alert again: no change, polls counted
  assert.deepEqual(await t.intake.poll(), []);
  assert.equal(t.incidents.open()[0].polls, 2);

  // new alert → opened
  t.set({ clusters: ok("dr"), alerts: [alert(), alert({ alertname: "KubePodCrashLooping" }), watchdog("dr")] });
  const next = await t.intake.poll();
  assert.deepEqual(next.map((c) => c.kind), ["opened"]);

  // escalation
  t.set({ clusters: ok("dr"), alerts: [alert({ severity: "critical" }), alert({ alertname: "KubePodCrashLooping" }), watchdog("dr")] });
  assert.deepEqual((await t.intake.poll()).map((c) => c.kind), ["escalated"]);
});

test("resolves only after a grace period, and a flap reopens the same incident", async () => {
  const t = setup();
  t.set({ clusters: ok("dr"), alerts: [alert(), watchdog("dr")] });
  await t.intake.poll();
  const id = t.incidents.open()[0].id;

  t.set({ clusters: ok("dr"), alerts: [watchdog("dr")] });
  assert.deepEqual(await t.intake.poll(), [], "absent but still in grace");
  t.advance(6 * 60_000);
  const resolved = await t.intake.poll();
  assert.deepEqual(resolved.map((c) => c.kind), ["resolved"]);

  t.advance(10 * 60_000);
  t.set({ clusters: ok("dr"), alerts: [alert(), watchdog("dr")] });
  const back = await t.intake.poll();
  assert.deepEqual(back.map((c) => c.kind), ["reopened"]);
  assert.equal(back[0].incident.id, id);
  assert.equal(back[0].incident.flaps, 1);
});

test("an unreadable cluster keeps its incidents open and becomes an incident itself", async () => {
  const t = setup();
  t.set({ clusters: ok("dr", "prod"), alerts: [alert(), watchdog("dr"), watchdog("prod")] });
  await t.intake.poll();
  t.set({ clusters: { dr: { ok: false, error: "timeout" }, prod: { ok: true } }, alerts: [watchdog("prod")] });
  t.advance(10 * 60_000);
  assert.deepEqual(await t.intake.poll(), [], "not resolved while dr is unknown");
  await t.intake.poll();
  const third = await t.intake.poll();
  assert.deepEqual(third.map((c) => `${c.kind}:${c.incident.alertname}`), ["opened:AlertSourceUnreachable"]);
  assert.equal(t.incidents.open().some((r) => r.alertname === "KubePodNotReady"), true);
});

test("a readable cluster without Watchdog means its alert pipeline is blind", async () => {
  const t = setup();
  t.set({ clusters: ok("edge"), alerts: [] });
  const changes = await t.intake.poll();
  assert.equal(changes[0].incident.alertname, "AlertPipelineWatchdogMissing");
});

test("ops room: one pinned chat per day, charter once, critical sooner, resolved waits", async () => {
  const t = setup();
  const sent = [];
  const runner = { isActive: () => false, send: async (chatId, input) => sent.push({ chatId, text: input.text }) };
  const room = createOpsRoom({ store: t.store, runner, incidents: t.incidents, now: () => new Date("2026-09-18T10:00:00Z"), log: { error() {} } });
  t.set({ clusters: ok("dr"), alerts: [alert(), watchdog("dr")] });
  const changes = await t.intake.poll();
  room.push(changes, { bootstrap: true });
  await room.flush();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.startsWith(OPS_CHARTER));
  assert.match(sent[0].text, /از قبل باز بودند/);
  const chat = t.store.getChat(sent[0].chatId);
  assert.equal(chat.caller, "ops");
  assert.equal(chat.agent, "griffin");

  room.push([{ kind: "resolved", incident: t.incidents.open()[0] }]);
  await room.flush();
  assert.equal(sent.length, 2, "flush sends whatever is pending");
  assert.ok(!sent[1].text.startsWith(OPS_CHARTER), "charter only once per room");
  assert.equal(sent[1].chatId, sent[0].chatId, "same room the same day");
});

test("digest lists members compactly", () => {
  const t = setup();
  const row = t.incidents.insert({ key: "dr|X|ns", cluster: "dr", alertname: "X", severity: "critical", scope: "ns", owner: null, summary: "s", members: ["a", "b", "c"], seenFrom: ["dr"], startsAt: null });
  const text = digestMessage([{ kind: "opened", incident: row }], { openCount: 1, bootstrap: false });
  assert.match(text, /3 مورد \(a، b، c\)/);
});

test("incident_update records triage by short id", async () => {
  const t = setup();
  const row = t.incidents.insert({ key: "k", cluster: "dr", alertname: "X", severity: "warning", scope: "", owner: null, summary: "", members: ["-"], seenFrom: ["dr"], startsAt: null });
  const tools = createIncidentTools({ incidents: t.incidents });
  const out = await tools.incident_update.execute({ id: row.id.slice(0, 8), cause: "replicas scaled down on standby", confidence: "high", noise: true });
  assert.equal(JSON.parse(out.content[0].text).incident.triage.noise, true);
  assert.equal(t.incidents.logs(row.id)[0].kind, "triage");
});

// A delegated specialist works with the quota its caller has on it, whoever started the chain —
// an agent that cannot reach its own tools cannot do the work. The root caller decides who gets
// asked before an irreversible call (and whether anyone is there at all), not what the tools are.
test("a delegated child keeps its own caller's quota; the root caller only says who is watching", () => {
  const t = setup();
  const root = t.store.createChat({ title: "job", agent: "griffin", caller: "scheduler" });
  const child = t.store.createChat({ title: "peer", agent: "platform", caller: "griffin", parentChatId: root.id });
  assert.equal(rootCallerOf(t.store, t.store.getChat(child.id)), "scheduler");
  const profile = t.store.getAgentProfile("platform");
  const catalog = ["kube_get", "debug_exec", "kube_secret", "mikrotik_remove"];
  const forGriffin = resolveEnabledTools(profile, { caller: "griffin", catalogNames: catalog });
  assert.ok(forGriffin.includes("debug_exec"), "the terminal is there when no tool fits");
  assert.ok(forGriffin.includes("kube_secret"));
  const forScheduler = resolveEnabledTools(profile, { caller: "scheduler", catalogNames: catalog });
  assert.ok(forScheduler.includes("kube_get"));
  assert.ok(!forScheduler.includes("debug_exec") && !forScheduler.includes("kube_secret"), "the scheduler quota stays narrow");
});

test("team DMs become one TeamReport per person per day; chit-chat and groups are ignored; tokens are redacted", async () => {
  const { isTeamReport, redact } = await import("../src/incidents/index.mjs");
  const person = { category: "team", external_id: "165771140", meta: { chatType: "user" }, username: "arad", display_name: "Aboulfazl Rad Infra" };
  assert.equal(isTeamReport({ ...person, external_id: "-5313573984", display_name: "Alerts channel" }, "🟡 PublicAdminEndpointDown on prod, down (1) registry"), false, "channels/groups have negative ids");
  assert.equal(isTeamReport({ ...person, external_id: "8283552983", username: null, display_name: "فروش بات" }, "گزارش روزانهٔ فروش ویزیت آنلاین آماده شد"), false);
  assert.equal(isTeamReport(person, "ممنون ❤️"), false);
  assert.equal(isTeamReport(person, "سلام، دیپلوی اپ ما روی دی‌آر sync نمی‌شود و ارور ImagePull می‌دهد"), true);
  assert.equal(isTeamReport({ ...person, meta: { chatType: "group" } }, "سلام، دیپلوی اپ ما روی دی‌آر sync نمی‌شود"), false);
  assert.equal(isTeamReport({ ...person, category: "unclassified" }, "سلام، دیپلوی اپ ما روی دی‌آر sync نمی‌شود"), false);
  assert.equal(isTeamReport({ ...person, username: "p24alert_bot" }, "سلام، دیپلوی اپ ما روی دی‌آر sync نمی‌شود"), false);
  assert.match(redact("key: bwUEpjkqdqnPCMCqhhbbz6GXBvYocLWjzuug05akLBDsf7F ok"), /key: \[redacted\] ok/);

  const t = setup();
  const first = t.incidents.recordHuman({ personId: "p1", name: "احمدی", text: "دیپلوی روی دی‌آر گیر کرده" });
  const again = t.incidents.recordHuman({ personId: "p1", name: "احمدی", text: "لاگ ImagePullBackOff هم می‌دهد" });
  assert.equal(first.kind, "opened");
  assert.equal(again.incident.id, first.incident.id);
  assert.equal(JSON.parse(again.incident.members_json).length, 2);
  const text = digestMessage([first, again], { openCount: 1, bootstrap: false });
  assert.equal((text.match(/TeamReport/g) || []).length, 1, "shown once");
  assert.match(text, /🆕 تازه/);

  // alert polls never resolve human signals
  t.set({ clusters: ok("dr"), alerts: [watchdog("dr")] });
  t.advance(10 * 60_000);
  await t.intake.poll();
  assert.equal(t.incidents.get(first.incident.id).status, "open");
  t.advance(25 * 3_600_000);
  await t.intake.poll();
  assert.equal(t.incidents.get(first.incident.id).status, "resolved");
});

test("business source: a recorded drop becomes an alert; a silent job is its own incident", async () => {
  const { businessAlerts, createBusinessSource, naiveToDate, visitSql } = await import("../src/incidents/business.mjs");
  const now = new Date("2026-09-18T19:20:00Z"); // 22:50 at +03:30
  const config = { table: "sales_checks", timezoneOffset: "+03:30", compare: ["this_week", "last_week", "two_weeks_ago"], label: "sales drop job" };
  assert.equal(naiveToDate("2026-09-18 22:45:00", "+03:30").toISOString(), "2026-09-18T19:15:00.000Z");
  assert.match(visitSql(config), /^select created_at, alerted, alert_reason, this_week, last_week, two_weeks_ago from sales_checks order by/);
  assert.throws(() => visitSql({ table: "sales; drop table users" }), /invalid table name/);

  assert.deepEqual(businessAlerts({ created_at: "2026-09-18 22:45:00", alerted: "f", this_week: 16, last_week: 20 }, { now, ...config }), []);
  const drop = businessAlerts({ created_at: "2026-09-18 22:45:00", alerted: "t", alert_reason: "critical drop: 45%", this_week: 16, last_week: 20, two_weeks_ago: 22 }, { now, ...config });
  assert.equal(drop[0].alertname, "BusinessSignalDrop");
  assert.equal(drop[0].severity, "critical");
  assert.match(drop[0].summary, /this_week 16/);
  const stale = businessAlerts({ created_at: "2026-09-18 21:00:00", alerted: "t" }, { now, ...config });
  assert.deepEqual(stale.map((a) => a.alertname), ["BusinessSignalStale"], "stale wins over an old drop");

  assert.deepEqual(await createBusinessSource({ query: async () => [], config: null })(), { ok: true, off: true, alerts: [] }, "unconfigured stays off");

  let calls = 0;
  let clock = now;
  const read = createBusinessSource({ config, query: async () => { calls += 1; throw new Error("ssh down"); }, now: () => clock });
  assert.equal((await read()).ok, false);
  await read();
  assert.equal(calls, 1, "cached between polls");
  clock = new Date(now.getTime() + 6 * 60_000);
  await read();
  assert.equal(calls, 2);

  // the intake treats "business" as a source without Watchdog
  const t = setup();
  t.set({ clusters: { dr: { ok: true }, business: { ok: true, watchdog: false } }, alerts: [watchdog("dr"), ...drop] });
  const changes = await t.intake.poll();
  assert.deepEqual(changes.map((c) => c.incident.alertname), ["BusinessSignalDrop"]);
});

test("flaps of a diagnosed incident do not wake Griffin, and flapping alerts resolve more slowly", async () => {
  const t = setup();
  const scheduled = [];
  const runner = { isActive: () => false, send: async () => {} };
  const room = createOpsRoom({ store: t.store, runner, incidents: t.incidents, log: { error() {} }, debounceMs: 50, urgentMs: 10 });
  t.set({ clusters: ok("dr"), alerts: [alert(), watchdog("dr")] });
  await t.intake.poll();
  const row = t.incidents.open()[0];
  t.incidents.setTriage(row.id, { cause: "known", confidence: "high" });
  room.push([{ kind: "reopened", incident: t.incidents.get(row.id) }]);
  assert.equal(room.pendingCount(), 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(room.pendingCount(), 1, "no flush scheduled for a diagnosed flap");

  // flaps=1 → grace doubles (10m)
  t.set({ clusters: ok("dr"), alerts: [watchdog("dr")] });
  await t.intake.poll();
  t.advance(6 * 60_000);
  await t.intake.poll();
  t.advance(6 * 60_000); // resolved at ~6m
  t.set({ clusters: ok("dr"), alerts: [alert(), watchdog("dr")] });
  await t.intake.poll(); // reopened → flaps 1
  t.set({ clusters: ok("dr"), alerts: [watchdog("dr")] });
  await t.intake.poll();
  t.advance(6 * 60_000);
  assert.deepEqual((await t.intake.poll()).map((c) => c.kind), [], "still in the doubled grace");
  t.advance(5 * 60_000);
  assert.deepEqual((await t.intake.poll()).map((c) => c.kind), ["resolved"]);
  void scheduled;
});

test("owner acks: a whole key or one member goes quiet; a new member does not", async () => {
  const t = setup();
  const row = t.incidents.insert({ key: "edge|PublicAdminEndpointDown|", cluster: "edge", alertname: "PublicAdminEndpointDown", severity: "warning", scope: "", owner: null, summary: "", members: ["https://registry.edge.example.com"], seenFrom: ["edge"], startsAt: null });
  const tools = createIncidentTools({ incidents: t.incidents });
  await tools.incident_ack.execute({ id: row.id.slice(0, 8), member: "https://registry.edge.example.com", reason: "Owner: registry لبه عمدا قطع است" });
  assert.equal(t.incidents.isAcked(t.incidents.get(row.id)), true);
  t.incidents.seen(row.id, { severity: "warning", owner: null, summary: "", members: ["https://registry.edge.example.com", "https://argocd-edge.example.com"], seenFrom: ["edge"] });
  assert.equal(t.incidents.isAcked(t.incidents.get(row.id)), false, "another endpoint down is not covered");
  const hist = JSON.parse((await tools.incident_history.execute({ id: row.id })).content[0].text);
  assert.equal(hist.acks.length, 1);
  assert.equal(hist.log[0].kind, "ack");
  await tools.incident_ack.execute({ id: row.id, reason: "x", member: "https://registry.edge.example.com", remove: true });
  assert.equal(t.incidents.acksFor(row.key).length, 0);
});

test("the list puts critical first and says how much it left out", async () => {
  const t = setup();
  t.set({
    clusters: ok("prod-b", "prod-a"),
    alerts: [
      alert({ cluster: "prod-b", seenFrom: "prod-b", labels: { namespace: "a" } }),
      alert({ cluster: "prod-b", seenFrom: "prod-b", labels: { namespace: "b" } }),
      alert({ cluster: "prod-a", seenFrom: "prod-a", alertname: "CNPGPrimaryPostgresDown", severity: "critical", labels: { namespace: "c" } }),
      watchdog("prod-b"),
      watchdog("prod-a"),
    ],
  });
  await t.intake.poll();
  assert.equal(t.incidents.list({ status: "open", limit: 1 })[0].severity, "critical");
  const s = t.incidents.summary({ status: "open" });
  assert.equal(s.total, 3);
  assert.deepEqual(s.byCluster, { "prod-b": { warning: 2 }, "prod-a": { critical: 1 } });
});
