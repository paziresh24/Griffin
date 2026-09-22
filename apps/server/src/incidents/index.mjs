import { randomUUID } from "node:crypto";
import { groupAlerts, severityRank } from "./group.mjs";

// Incident intake: polls every cluster's Alertmanager through the broker (no LLM), folds alerts into
// incidents by key (see group.mjs) and reports only *state changes* — opened, reopened, escalated,
// resolved. Repeats of the same alert only bump counters, so a storm is one incident.
//
// Rules that keep it honest:
// - an incident resolves only when every cluster that reported it was read successfully and the key
//   has been absent for `resolveGraceMs` (flapping alerts do not open/close every poll);
// - a key that comes back within `reopenWindowMs` reopens the same incident (flaps++);
// - a cluster we cannot read is itself an incident (AlertSourceUnreachable), and a cluster we can
//   read whose Watchdog is missing means its alert pipeline is broken (AlertPipelineWatchdogMissing).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  cluster TEXT NOT NULL,
  alertname TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL,
  owner TEXT,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  members_json TEXT NOT NULL DEFAULT '[]',
  seen_from_json TEXT NOT NULL DEFAULT '[]',
  member_peak INTEGER NOT NULL DEFAULT 0,
  flaps INTEGER NOT NULL DEFAULT 0,
  polls INTEGER NOT NULL DEFAULT 0,
  baseline INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  resolved_at TEXT,
  triage_json TEXT,
  triaged_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_key ON incidents(key, first_seen);
CREATE INDEX IF NOT EXISTS incidents_status ON incidents(status, last_seen);
CREATE TABLE IF NOT EXISTS incident_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incident_log_incident ON incident_log(incident_id, id);
CREATE TABLE IF NOT EXISTS incident_acks (
  key TEXT NOT NULL,
  member TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  until TEXT,
  PRIMARY KEY (key, member)
);
`;

// Long opaque tokens (keys, JWTs, passwords pasted in chat) never go into the incident store.
export const redact = (text) => String(text || "").replace(/[A-Za-z0-9_\-+/=.]{28,}/g, "[redacted]");

const parse = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

export function incidentView(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    cluster: row.cluster,
    alertname: row.alertname,
    scope: row.scope,
    severity: row.severity,
    owner: row.owner,
    summary: row.summary,
    status: row.status,
    members: parse(row.members_json, []),
    memberPeak: row.member_peak,
    flaps: row.flaps,
    polls: row.polls,
    baseline: Boolean(row.baseline),
    startsAt: row.starts_at,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    resolvedAt: row.resolved_at,
    triage: parse(row.triage_json, null),
    ack: row.ack || null,
    triagedAt: row.triaged_at,
  };
}

export function createIncidentStore(db, { now = () => new Date() } = {}) {
  db.exec(SCHEMA);
  const q = {
    open: db.prepare("SELECT * FROM incidents WHERE status = 'open'"),
    lastByKey: db.prepare("SELECT * FROM incidents WHERE key = ? ORDER BY first_seen DESC LIMIT 1"),
    get: db.prepare("SELECT * FROM incidents WHERE id = ?"),
    count: db.prepare("SELECT COUNT(*) AS n FROM incidents"),
    insert: db.prepare(`INSERT INTO incidents (id, key, cluster, alertname, scope, severity, owner, summary, status, members_json, seen_from_json, member_peak, polls, baseline, starts_at, first_seen, last_seen, updated_at)
      VALUES (@id, @key, @cluster, @alertname, @scope, @severity, @owner, @summary, 'open', @members, @seenFrom, @peak, 1, @baseline, @startsAt, @at, @at, @at)`),
    seen: db.prepare(`UPDATE incidents SET severity = @severity, owner = COALESCE(owner, @owner), summary = @summary, members_json = @members, seen_from_json = @seenFrom,
      member_peak = MAX(member_peak, @peak), polls = polls + 1, last_seen = @at, updated_at = @at WHERE id = @id`),
    reopen: db.prepare("UPDATE incidents SET status = 'open', resolved_at = NULL, flaps = flaps + 1, last_seen = @at, updated_at = @at WHERE id = @id"),
    resolve: db.prepare("UPDATE incidents SET status = 'resolved', resolved_at = @at, updated_at = @at WHERE id = @id"),
    triage: db.prepare("UPDATE incidents SET triage_json = @triage, triaged_at = @at, updated_at = @at WHERE id = @id"),
    log: db.prepare("INSERT INTO incident_log (incident_id, kind, data, at) VALUES (?, ?, ?, ?)"),
    list: db.prepare("SELECT * FROM incidents WHERE (@status = 'all' OR status = @status) ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen DESC LIMIT @limit"),
    logs: db.prepare("SELECT kind, data, at FROM incident_log WHERE incident_id = ? ORDER BY id DESC LIMIT ?"),
    prune: db.prepare("DELETE FROM incident_log WHERE incident_id IN (SELECT id FROM incidents WHERE status = 'resolved' AND resolved_at < ?)"),
    pruneIncidents: db.prepare("DELETE FROM incidents WHERE status = 'resolved' AND resolved_at < ?"),
    ackUpsert: db.prepare("INSERT INTO incident_acks (key, member, reason, by, created_at, until) VALUES (@key, @member, @reason, @by, @at, @until) ON CONFLICT(key, member) DO UPDATE SET reason = @reason, by = @by, created_at = @at, until = @until"),
    ackDelete: db.prepare("DELETE FROM incident_acks WHERE key = ? AND member = ?"),
    acksFor: db.prepare("SELECT * FROM incident_acks WHERE key = ?"),
    history: db.prepare("SELECT * FROM incidents WHERE key = ? ORDER BY first_seen DESC LIMIT ?"),
  };
  const iso = () => now().toISOString();

  return {
    isEmpty: () => q.count.get().n === 0,
    // "This is intentional" from the owner, per incident key and optionally one member
    // (e.g. "<cluster>|PublicAdminEndpointDown|" + the failing url). member "" = the whole key.
    ack({ key, member = "", reason, by = "owner", until = null }) {
      q.ackUpsert.run({ key, member: member || "", reason: String(reason).slice(0, 500), by, at: iso(), until });
      return q.acksFor.all(key);
    },
    unack: (key, member = "") => q.ackDelete.run(key, member || "").changes > 0,
    acksFor(key) {
      const t = now().getTime();
      return q.acksFor.all(key).filter((a) => !a.until || new Date(a.until).getTime() > t);
    },
    isAcked(row) {
      const acks = this.acksFor(row.key);
      if (!acks.length) return false;
      if (acks.some((a) => a.member === "")) return true;
      const members = parse(row.members_json, []);
      const covered = new Set(acks.map((a) => a.member));
      return members.length > 0 && members.every((m) => covered.has(m));
    },
    history: (key, limit = 10) => q.history.all(key, Math.min(Math.max(Number(limit) || 10, 1), 50)),
    open: () => q.open.all(),
    lastByKey: (key) => q.lastByKey.get(key) || null,
    get: (id) => q.get.get(String(id)) || null,
    insert(group, { baseline = false } = {}) {
      const id = randomUUID();
      q.insert.run({
        id,
        key: group.key,
        cluster: group.cluster,
        alertname: group.alertname,
        scope: group.scope || "",
        severity: group.severity,
        owner: group.owner || null,
        summary: group.summary || "",
        members: JSON.stringify(group.members.slice(0, 200)),
        seenFrom: JSON.stringify(group.seenFrom),
        peak: group.members.length,
        baseline: baseline ? 1 : 0,
        startsAt: group.startsAt || null,
        at: iso(),
      });
      return q.get.get(id);
    },
    seen(id, group) {
      q.seen.run({
        id,
        severity: group.severity,
        owner: group.owner || null,
        summary: group.summary || "",
        members: JSON.stringify(group.members.slice(0, 200)),
        seenFrom: JSON.stringify(group.seenFrom),
        peak: group.members.length,
        at: iso(),
      });
    },
    reopen: (id) => q.reopen.run({ id, at: iso() }),
    resolve: (id) => q.resolve.run({ id, at: iso() }),
    setTriage(id, triage) {
      q.triage.run({ id: String(id), triage: JSON.stringify(triage), at: iso() });
      return q.get.get(String(id)) || null;
    },
    log: (id, kind, data = {}) => q.log.run(id, kind, JSON.stringify(data), iso()),
    // A teammate asked the owner for help: a human signal. One incident per person per day; the
    // ops room checks whether a machine signal already covered it (and if not, it was a miss).
    recordHuman({ personId, name, text }) {
      const day = iso().slice(0, 10);
      const key = `human|TeamReport|${personId}|${day}`;
      const snippet = redact(text).slice(0, 300);
      const open = q.lastByKey.get(key);
      if (open && open.status === "open") {
        const members = [...parse(open.members_json, []), snippet].slice(-10);
        q.seen.run({ id: open.id, severity: open.severity, owner: null, summary: snippet, members: JSON.stringify(members), seenFrom: open.seen_from_json, peak: members.length, at: iso() });
        return { kind: "reopened", incident: q.get.get(open.id), again: true };
      }
      const id = randomUUID();
      q.insert.run({ id, key, cluster: "human", alertname: "TeamReport", scope: name || personId, severity: "warning", owner: null, summary: snippet, members: JSON.stringify([snippet]), seenFrom: JSON.stringify(["human"]), peak: 1, baseline: 0, startsAt: iso(), at: iso() });
      q.log.run(id, "opened", JSON.stringify({ personId }), iso());
      return { kind: "opened", incident: q.get.get(id) };
    },
    resolveStaleHuman(maxAgeMs = 24 * 3_600_000) {
      for (const row of q.open.all()) {
        if (row.cluster === "human" && now().getTime() - new Date(row.last_seen).getTime() > maxAgeMs) q.resolve.run({ id: row.id, at: iso() });
      }
    },
    list: ({ status = "open", limit = 50 } = {}) => q.list.all({ status, limit: Math.min(Math.max(Number(limit) || 50, 1), 500) }),
    logs: (id, limit = 50) => q.logs.all(String(id), limit).map((r) => ({ ...r, data: parse(r.data, {}) })),
    prune(olderThanDays = 30) {
      const cutoff = new Date(now().getTime() - olderThanDays * 86_400_000).toISOString();
      q.prune.run(cutoff);
      q.pruneIncidents.run(cutoff);
    },
  };
}

// A direct message from a teammate that is long enough to be a request (not a thanks/emoji/ok).
// Groups, channels, bots and people not categorized as team are not human signals.
export function isTeamReport(person, text) {
  if (!person || person.category !== "team") return false;
  // Telegram groups/channels have negative peer ids (channels were once stored as chatType "user").
  if (!/^\d+$/.test(String(person.external_id ?? ""))) return false;
  if (person.meta?.chatType && person.meta.chatType !== "user") return false;
  if (/bot$/i.test(person.username || "") || /(^|\s)(bot|بات)$/i.test(String(person.display_name || "").trim())) return false;
  if (String(person.display_name || "").trim() === "Owner") return false;
  const t = String(text || "").trim();
  if (t.startsWith("/")) return false;
  return t.replace(/[\s\p{P}\p{S}]/gu, "").length >= 20;
}

// Meta incidents about the alert pipeline itself.
function metaGroup(cluster, alertname, summary) {
  return { key: `${cluster}|${alertname}|`, cluster, alertname, severity: "warning", scope: "", owner: null, summary, members: [cluster], seenFrom: [cluster], startsAt: null };
}

export function createIntake({
  incidents,
  fetchAlerts, // async () => { clusters: { name: { ok, error? } }, alerts: [...] }
  onChanges = () => {},
  log = console,
  now = () => new Date(),
  pollMs = 60_000,
  resolveGraceMs = 5 * 60_000,
  reopenWindowMs = 60 * 60_000,
  unreachableAfter = 3,
}) {
  const absentSince = new Map(); // incident id -> ms when first seen missing
  const failures = new Map(); // cluster -> consecutive read failures
  const status = { lastPollAt: null, lastOkAt: null, clusters: {}, error: null, openIncidents: 0 };
  let timer = null;
  let polling = false;

  async function poll() {
    if (polling) return [];
    polling = true;
    try {
      const at = now();
      const data = await fetchAlerts();
      const bootstrap = incidents.isEmpty();
      const readable = new Set();
      const groups = groupAlerts(data.alerts || []);

      for (const [cluster, info] of Object.entries(data.clusters || {})) {
        if (info.ok) {
          readable.add(cluster);
          failures.set(cluster, 0);
          if (info.watchdog === false) continue; // not an Alertmanager (e.g. business source)
          const watchdog = (data.alerts || []).some((a) => a.alertname === "Watchdog" && a.seenFrom === cluster);
          if (!watchdog) {
            const g = metaGroup(cluster, "AlertPipelineWatchdogMissing", `Alertmanager ${cluster} جواب می‌دهد ولی Watchdog ندارد؛ یعنی Prometheus این کلاستر آلارم نمی‌فرستد (کور).`);
            groups.set(g.key, g);
          }
        } else {
          const n = (failures.get(cluster) || 0) + 1;
          failures.set(cluster, n);
          if (n >= unreachableAfter) {
            const g = metaGroup(cluster, "AlertSourceUnreachable", `منبع ${cluster} از .46 خوانده نمی‌شود: ${String(info.error || "").slice(0, 200)}`);
            g.seenFrom = ["griffin"];
            groups.set(g.key, g);
          }
        }
      }
      readable.add("griffin"); // meta incidents raised by the poller itself

      const changes = [];
      const openRows = incidents.open();
      const openByKey = new Map(openRows.map((r) => [r.key, r]));

      for (const group of groups.values()) {
        const open = openByKey.get(group.key);
        if (open) {
          absentSince.delete(open.id);
          incidents.seen(open.id, group);
          if (severityRank(group.severity) > severityRank(open.severity)) {
            incidents.log(open.id, "escalated", { from: open.severity, to: group.severity });
            changes.push({ kind: "escalated", incident: incidents.get(open.id) });
          }
          continue;
        }
        const last = incidents.lastByKey(group.key);
        if (last && last.status === "resolved" && at - new Date(last.resolved_at) < reopenWindowMs) {
          incidents.reopen(last.id);
          incidents.seen(last.id, group);
          incidents.log(last.id, "reopened", { members: group.members.length });
          changes.push({ kind: "reopened", incident: incidents.get(last.id) });
          continue;
        }
        const row = incidents.insert(group, { baseline: bootstrap });
        incidents.log(row.id, bootstrap ? "baseline" : "opened", { members: group.members.length });
        changes.push({ kind: bootstrap ? "baseline" : "opened", incident: row });
      }

      incidents.resolveStaleHuman();
      for (const row of openRows) {
        if (row.cluster === "human") continue;
        if (groups.has(row.key)) continue;
        const from = parse(row.seen_from_json, []);
        // Unknown is not resolved: keep it open while any cluster that reported it is unreadable.
        if (!from.length || !from.every((c) => readable.has(c))) continue;
        const since = absentSince.get(row.id) ?? at.getTime();
        absentSince.set(row.id, since);
        // A flapping alert must stay quiet longer before we call it resolved (max 1h).
        const grace = Math.min(resolveGraceMs * (1 + (row.flaps || 0)), 60 * 60_000);
        if (at.getTime() - since < grace) continue;
        absentSince.delete(row.id);
        incidents.resolve(row.id);
        incidents.log(row.id, "resolved", {});
        changes.push({ kind: "resolved", incident: incidents.get(row.id) });
      }

      Object.assign(status, {
        lastPollAt: at.toISOString(),
        lastOkAt: readable.size > 1 ? at.toISOString() : status.lastOkAt,
        clusters: data.clusters || {},
        error: null,
        openIncidents: incidents.open().length,
      });
      if (changes.length) {
        try {
          await onChanges(changes, { bootstrap });
        } catch (error) {
          log.error?.(`[incidents] onChanges: ${error.message}`);
        }
      }
      return changes;
    } catch (error) {
      status.lastPollAt = now().toISOString();
      status.error = error.message;
      log.error?.(`[incidents] poll: ${error.message}`);
      return [];
    } finally {
      polling = false;
    }
  }

  return {
    poll,
    status: () => ({ ...status }),
    start() {
      if (timer) return;
      setTimeout(() => poll(), 5_000).unref?.();
      timer = setInterval(() => poll(), pollMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
