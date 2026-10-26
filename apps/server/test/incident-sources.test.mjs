import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createIncidentStore, createIntake, incidentBucket, incidentView } from "../src/incidents/index.mjs";
import { createCollector, createSourceStore, normalizeSeverity, parseAlertText, sourceView, textAlertName, webhookItems } from "../src/incidents/sources.mjs";
import { createSourceTools, findTelegramChat, OPS_SUGGEST_PER_DAY } from "../src/incidents/tools.mjs";
import { PEER_NEVER_TOOLS, APP_TOOL_NAMES } from "../src/agents/profiles.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-sources-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  let clock = new Date("2026-10-25T08:00:00Z");
  const now = () => clock;
  const incidents = createIncidentStore(store.db, { now });
  const secretsMap = new Map();
  const secrets = { get: (n) => secretsMap.get(n) || "", has: (n) => secretsMap.has(n), set: (n, v) => secretsMap.set(n, v), delete: (n) => secretsMap.delete(n) };
  const sources = createSourceStore(store.db, { now, secrets });
  return { store, incidents, sources, secrets, secretsMap, now, advance: (ms) => (clock = new Date(clock.getTime() + ms)) };
}
const call = async (tool, args) => {
  const r = await tool.execute(args);
  return { error: r.isError ? r.content[0].text : null, value: r.isError ? null : JSON.parse(r.content[0].text) };
};

test("text alerts: Alertmanager/Grafana/Kuma templates and free text, firing and resolved share a key", () => {
  const am = parseAlertText("[FIRING:2] KubePodCrashLooping (sentry)\nalertname = KubePodCrashLooping\npod = a\nseverity = critical\nalertname = KubePodCrashLooping\npod = b");
  assert.equal(am.status, "firing");
  assert.deepEqual(am.items.map((i) => [i.alertname, i.member, i.severity]), [["KubePodCrashLooping", "a", "critical"], ["KubePodCrashLooping", "b", "critical"]]);
  assert.equal(parseAlertText("[RESOLVED] KubePodCrashLooping").status, "resolved");
  const kumaDown = parseAlertText("[Payment API] [🔴 Down] timeout of 48000ms exceeded");
  const kumaUp = parseAlertText("[Payment API] [✅ Up] 200 - OK");
  assert.deepEqual([kumaDown.status, kumaDown.items[0].alertname, kumaUp.status, kumaUp.items[0].alertname], ["firing", "Payment API", "resolved", "Payment API"]);
  const down = parseAlertText("🔴 Payment gateway down, 503 errors");
  const up = parseAlertText("✅ Payment gateway is up");
  assert.equal(down.items[0].alertname, up.items[0].alertname);
  assert.equal(parseAlertText("سلام، جلسه ساعت ۴ است"), null, "chatter is not an alert");
  assert.equal(parseAlertText("گزارش روزانه آماده است", { everyMessage: true }).status, "firing");
  assert.equal(textAlertName("🚨 [FIRING:3] disk 91% on db-1 https://x.y/z"), "disk on db");
});

test("severity words normalize; a source without severity is a warning, not dropped", () => {
  assert.deepEqual(["critical", "P1", "high", "warn", "info", "", "weird"].map((s) => normalizeSeverity(s)), ["critical", "critical", "critical", "warning", "info", "warning", "warning"]);
  const items = webhookItems({ alerts: [{ status: "firing", labels: { alertname: "HighCPU", instance: "db1" }, annotations: { summary: "cpu 95%" } }, { status: "resolved", labels: { alertname: "DiskFull" } }] });
  assert.deepEqual(items.map((e) => [e.status, e.item.alertname, e.item.member, e.item.severity]), [["firing", "HighCPU", "db1", "warning"], ["resolved", "DiskFull", "-", "warning"]]);
  assert.deepEqual(webhookItems({ title: "Backup failed", severity: "critical" })[0].item.severity, "critical");
});

test("a Telegram source turns messages into incidents and a resolved message closes them", async () => {
  const t = setup();
  const person = t.store.upsertPerson({ integrationId: "x", externalId: "-100123", name: "Alerts Channel", data: { platform: "telegram", chatType: "channel" } });
  const source = t.sources.add({ kind: "telegram", name: "کانال آلارم", config: { personId: person.id } });
  const collect = createCollector({ sources: t.sources, secrets: t.secrets, now: t.now });
  const intake = createIntake({ incidents: t.incidents, fetchAlerts: collect, now: t.now, log: { error() {} } });
  await intake.poll(); // baseline (empty)
  t.sources.push(source, parseAlertText("[My API] [🔴 Down] timeout"));
  const opened = await intake.poll();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].incident.cluster, source.id);
  assert.equal(opened[0].incident.source_id, source.id);
  assert.equal(opened[0].incident.severity, "critical");

  t.sources.push(source, parseAlertText("[My API] [✅ Up] 200 - OK"));
  t.advance(6 * 60_000);
  await intake.poll();
  t.advance(6 * 60_000);
  const resolved = await intake.poll();
  assert.deepEqual(resolved.map((c) => c.kind), ["resolved"]);
});

test("pushed alerts survive a restart and expire after ttlHours without a repeat", () => {
  const t = setup();
  const hook = t.sources.add({ kind: "webhook", name: "hook", config: { ttlHours: 2 } });
  t.sources.push(hook, { status: "firing", items: [{ alertname: "X", member: "a" }] });
  const again = createSourceStore(t.store.db, { now: t.now });
  assert.equal(again.pushed(again.get(hook.id)).length, 1);
  t.advance(3 * 3_600_000);
  assert.equal(again.pushed(again.get(hook.id)).length, 0);
  assert.ok(t.sources.byToken(hook.config.token));
  assert.equal(t.sources.byToken("nope"), null);
});

test("HTTP sources read Alertmanager, Grafana and Prometheus with the secret from the store", async () => {
  const t = setup();
  t.secretsMap.set("grafana-token", "tok123");
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, auth: opts.headers.authorization });
    if (url.includes("/api/v1/alerts")) return { ok: true, json: async () => ({ data: { alerts: [{ state: "firing", labels: { alertname: "Up" } }, { state: "pending", labels: { alertname: "Later" } }] } }) };
    return { ok: true, json: async () => [{ labels: { alertname: "HighCPU", severity: "critical", namespace: "app" }, annotations: { summary: "cpu" }, fingerprint: "f1" }] };
  };
  t.sources.add({ kind: "grafana", name: "team grafana", id: "team-grafana", config: { url: "https://grafana.example.com/", secret: "grafana-token" } });
  t.sources.add({ kind: "prometheus", name: "prom", config: { url: "http://prom:9090" } });
  const collect = createCollector({ sources: t.sources, secrets: t.secrets, fetchImpl, now: t.now });
  const r = await collect();
  assert.equal(seen.find((s) => s.url.startsWith("https://grafana.example.com/api/alertmanager/grafana/api/v2/alerts")).auth, "Bearer tok123");
  assert.deepEqual(r.alerts.map((a) => `${a.cluster}:${a.alertname}:${a.severity}`).sort(), ["prom:Up:warning", "team-grafana:HighCPU:critical"]);
  assert.equal(r.clusters["team-grafana"].watchdog, false, "no Watchdog expected unless asked");
  const failing = createCollector({ sources: t.sources, secrets: t.secrets, fetchImpl: async () => ({ ok: false, status: 401 }), now: t.now });
  const bad = await failing();
  assert.equal(bad.clusters.prom.ok, false);
  assert.match(bad.clusters.prom.error, /401/);
});

test("built-in sources keep the clusters' own names (old incident keys stay the same)", async () => {
  const t = setup();
  t.sources.add({ id: "clusters", kind: "clusters", name: "Clusters" });
  const collect = createCollector({ sources: t.sources, builtins: { clusters: async () => ({ clusters: { east: { ok: true } }, alerts: [{ cluster: "east", seenFrom: "east", alertname: "Watchdog", severity: "none", labels: {} }, { cluster: "east", seenFrom: "east", alertname: "KubeJobFailed", severity: "warning", labels: { namespace: "x" } }] }) }, now: t.now });
  const r = await collect();
  assert.deepEqual(Object.keys(r.clusters), ["east"]);
  assert.equal(r.alerts[1].sourceId, "clusters");
  assert.throws(() => t.sources.add({ id: "vault", kind: "webhook", name: "x" }), /reserved/);
});

test("a key that was noise last time comes back as noise (inherited), without a new triage", async () => {
  const t = setup();
  let payload = { clusters: { west: { ok: true, watchdog: false } }, alerts: [] };
  const intake = createIntake({ incidents: t.incidents, fetchAlerts: async () => payload, now: t.now, log: { error() {} } });
  await intake.poll();
  const a = { cluster: "west", seenFrom: "west", alertname: "HpaNearMax", severity: "warning", labels: { namespace: "p" } };
  payload = { ...payload, alerts: [a] };
  const [opened] = await intake.poll();
  t.incidents.setTriage(opened.incident.id, { cause: "HPA در حد بالا؛ عادی", noise: true, confidence: "high" });
  payload = { ...payload, alerts: [] };
  t.advance(6 * 60_000);
  await intake.poll();
  t.advance(6 * 60_000);
  await intake.poll();
  t.advance(2 * 3_600_000); // past the reopen window: a new incident
  payload = { ...payload, alerts: [a] };
  const [again] = await intake.poll();
  assert.equal(again.kind, "opened");
  assert.notEqual(again.incident.id, opened.incident.id);
  const triage = JSON.parse(again.incident.triage_json);
  assert.equal(triage.noise, true);
  assert.equal(triage.inherited, opened.incident.id);
  assert.equal(incidentBucket(incidentView(again.incident), { now: t.now() }), "noise");
});

test("buckets: noise/ack, assigned, chronic, critical vs warning, people, resolved", () => {
  const now = new Date("2026-10-25T08:00:00Z");
  const base = { cluster: "east", status: "open", severity: "warning", firstSeen: "2026-10-25T07:00:00Z", triage: null, ack: null, chatId: null };
  assert.equal(incidentBucket({ ...base, severity: "critical" }, { now }), "attention");
  assert.equal(incidentBucket(base, { now }), "watch");
  assert.equal(incidentBucket({ ...base, firstSeen: "2026-10-20T00:00:00Z" }, { now }), "chronic");
  assert.equal(incidentBucket({ ...base, chatId: "c" }, { now }), "tracking");
  assert.equal(incidentBucket({ ...base, chatId: "c", triage: { noise: true } }, { now }), "noise");
  assert.equal(incidentBucket({ ...base, ack: [{}] }, { now }), "noise");
  assert.equal(incidentBucket({ ...base, cluster: "human" }, { now }), "people");
  assert.equal(incidentBucket({ ...base, status: "resolved" }, { now }), "resolved");
});

test("chat tools: add a Telegram source by @username, refuse secret values, test, disable, remove", async () => {
  const t = setup();
  t.store.upsertPerson({ integrationId: "x", externalId: "-1001", name: "Team Alerts", username: "team_alerts", data: { platform: "telegram", chatType: "channel" } });
  const chat = t.store.createChat({ title: "owner chat", agent: "griffin" });
  const tools = createSourceTools({ store: t.store, incidents: t.incidents, sources: t.sources, secrets: t.secrets, chatId: chat.id });
  const added = await call(tools.incident_source_set, { action: "add", kind: "telegram", chat: "@team_alerts" });
  assert.equal(added.error, null);
  assert.equal(added.value.source.config.chatTitle, "Team Alerts");
  assert.equal(added.value.test.ok, true);
  const id = added.value.source.id;

  const noSecret = await call(tools.incident_source_set, { action: "add", kind: "alertmanager", name: "am", url: "https://am.example.com", secret: "missing" });
  assert.match(noSecret.error, /never take the value in chat/);
  const badUrl = await call(tools.incident_source_set, { action: "add", kind: "alertmanager", name: "am2", url: "not a url" });
  assert.match(badUrl.error, /url/);

  assert.equal((await call(tools.incident_source_set, { action: "disable", id })).value.source.enabled, false);
  const listed = await call(tools.incident_sources, {});
  assert.equal(listed.value.sources.length, 1);
  assert.equal((await call(tools.incident_source_set, { action: "remove", id })).value.removed, id);
  assert.equal(t.sources.list().length, 0);
});

test("findTelegramChat: by id, by title, ambiguous, unknown", () => {
  const t = setup();
  t.store.upsertPerson({ integrationId: "x", externalId: "-1", name: "Ops Alerts", data: { platform: "telegram" } });
  t.store.upsertPerson({ integrationId: "x", externalId: "-2", name: "Ops Alerts 2", data: { platform: "telegram" } });
  assert.equal(findTelegramChat(t.store, "-1").person.display_name, "Ops Alerts");
  assert.equal(findTelegramChat(t.store, "Ops Alerts").person.external_id, "-1");
  assert.match(findTelegramChat(t.store, "Ops").error, /matches 2/);
  assert.match(findTelegramChat(t.store, "nothing").error, /no Telegram chat/);
});

test("assign and suggest: the card's start assigns the chat; ops cards are capped and skip noise", async () => {
  const t = setup();
  const chat = t.store.createChat({ title: "owner chat", agent: "griffin" });
  const row = t.incidents.insert({ key: "east|DiskFull|x", cluster: "east", alertname: "DiskFull", scope: "x", severity: "critical", members: ["n1"], seenFrom: ["east"], summary: "disk 95%" });
  const tools = createSourceTools({ store: t.store, incidents: t.incidents, sources: t.sources, chatId: chat.id });

  const assigned = await call(tools.incident_assign, { id: row.id.slice(0, 8) });
  assert.equal(assigned.value.chat, chat.id);
  assert.equal(t.incidents.byChat(chat.id).length, 1);
  assert.match((await call(tools.incident_suggest, { id: row.id })).error, /already assigned/);
  await call(tools.incident_assign, { id: row.id, remove: true });

  const sug = await call(tools.incident_suggest, { id: row.id });
  assert.equal(sug.error, null);
  const card = t.store.getSuggestion(sug.value.suggestion);
  assert.match(card.prompt, /DiskFull/);
  assert.match(card.title, /DiskFull/);
  assert.match((await call(tools.incident_suggest, { id: row.id })).error, /already on the workspace/);
  const started = t.store.createChat({ title: card.title, agent: "griffin" });
  t.store.settleSuggestion(card.id, "started", started.id);
  assert.equal(t.incidents.adoptSuggestion(card.id, started.id), 1);
  assert.equal(t.incidents.get(row.id).chat_id, started.id);

  const ops = createSourceTools({ store: t.store, incidents: t.incidents, sources: t.sources, chatId: null, caller: "ops", now: t.now });
  const noisy = t.incidents.insert({ key: "east|Hpa|y", cluster: "east", alertname: "Hpa", scope: "y", severity: "warning", members: ["-"], seenFrom: ["east"] });
  t.incidents.setTriage(noisy.id, { cause: "x", noise: true, confidence: "high" });
  assert.match((await call(ops.incident_suggest, { id: noisy.id })).error, /noise/);
  for (let n = 0; n < OPS_SUGGEST_PER_DAY; n += 1) {
    const r = t.incidents.insert({ key: `east|A${n}|`, cluster: "east", alertname: `A${n}`, severity: "critical", members: ["-"], seenFrom: ["east"] });
    assert.equal((await call(ops.incident_suggest, { id: r.id })).error, null);
  }
  const over = t.incidents.insert({ key: "east|Over|", cluster: "east", alertname: "Over", severity: "critical", members: ["-"], seenFrom: ["east"] });
  assert.match((await call(ops.incident_suggest, { id: over.id })).error, /daily cap/);
});

test("webhook token is shown only where asked; secrets never", () => {
  const t = setup();
  const hook = t.sources.add({ kind: "webhook", name: "hook" });
  const am = t.sources.add({ kind: "alertmanager", name: "am", config: { url: "https://am.example.com", secret: "incident-source:am" } });
  assert.ok(!JSON.stringify(sourceView(hook, { baseUrl: "https://g.example" })).includes(hook.config.token));
  assert.ok(sourceView(hook, { baseUrl: "https://g.example", withToken: true }).webhookUrl.endsWith(hook.config.token));
  assert.equal(sourceView(am).config.secret, "(در خزانهٔ این نصب)");
});

test("tool catalog: listed for owner chats, write tools never for a colleague chain", () => {
  for (const name of ["incident_sources", "incident_source_set", "incident_assign", "incident_suggest"]) assert.ok(APP_TOOL_NAMES.includes(name), name);
  for (const name of ["incident_source_set", "incident_assign", "incident_suggest"]) assert.ok(PEER_NEVER_TOOLS.includes(name), name);
});
