import { randomBytes } from "node:crypto";

// Incident data sources, Grafana-style (owner 2026-10-25). Each install keeps its own list: the
// broker's clusters are one source, a colleague's Telegram alert channel or Grafana is another. Two shapes:
//   - poll: read the firing set every minute (Alertmanager, Grafana alerting, Prometheus, and the
//     built-ins clusters/business/vault that existed before this table);
//   - push: alerts arrive (a webhook POST, a message in a Telegram group/channel) and stay firing until
//     a resolved message names them or they go quiet for `ttlHours`. Kept in the DB so a restart does
//     not resolve every pushed incident at once.
// Every alert carries cluster/seenFrom = the source id (built-in clusters keeps the real cluster names),
// so the intake's grouping, resolve and flap logic is the same for all of them.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incident_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incident_push_alerts (
  source_id TEXT NOT NULL,
  akey TEXT NOT NULL,
  alert_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (source_id, akey)
);
`;

export const SOURCE_KINDS = {
  clusters: { label: "آلارم‌های کلاسترهای بروکر", mode: "poll", builtin: true },
  business: { label: "سیگنال کسب‌وکار", mode: "poll", builtin: true },
  vault: { label: "خزانهٔ ابزارهای این نصب", mode: "poll", builtin: true },
  alertmanager: { label: "Alertmanager", mode: "poll", url: true },
  grafana: { label: "Grafana Alerting", mode: "poll", url: true },
  prometheus: { label: "Prometheus", mode: "poll", url: true },
  webhook: { label: "وبهوک (Alertmanager، Grafana یا JSON ساده)", mode: "push" },
  telegram: { label: "گروه یا کانال تلگرام", mode: "push" },
};
export const ADDABLE_KINDS = Object.keys(SOURCE_KINDS).filter((k) => !SOURCE_KINDS[k].builtin);

export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
// Ids the intake already uses for itself or that built-ins own.
const RESERVED = new Set(["griffin", "human", "clusters", "business", "vault", "shared"]);

const parse = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

export const slugify = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

// ——— normalization ———

const SEVERITY_WORDS = [
  [/^(critical|crit|disaster|high|page|p0|p1|error|fatal|emergency|bad)$/i, "critical"],
  [/^(warning|warn|medium|average|p2|p3|minor|major)$/i, "warning"],
  [/^(info|information|low|p4|p5|none|ok|debug)$/i, "info"],
];
// A source that does not label severity (most Grafana rules, Telegram text) is a warning, not
// "none": none/info are dropped by the grouping as context.
export function normalizeSeverity(value, fallback = "warning") {
  const s = String(value ?? "").trim();
  if (!s) return fallback;
  for (const [re, level] of SEVERITY_WORDS) if (re.test(s)) return level;
  return fallback;
}

const KEEP = ["alertname", "severity", "namespace", "service", "job", "bucket", "persistentvolumeclaim", "app_name", "app", "owner", "team", "instance", "pod", "deployment", "statefulset", "node", "host", "monitor", "grafana_folder", "rulename"];

/** Any Alertmanager-shaped alert (v2 API, webhook payload, Grafana, Prometheus /api/v1/alerts) → intake alert. */
export function normalizeGeneric(raw, sourceId) {
  const labels = raw?.labels || {};
  const annotations = raw?.annotations || {};
  const kept = {};
  for (const key of KEEP) if (labels[key]) kept[key] = String(labels[key]).slice(0, 200);
  const alertname = String(labels.alertname || labels.rulename || annotations.title || raw?.title || "alert").slice(0, 120);
  return {
    fingerprint: raw?.fingerprint || null,
    cluster: sourceId,
    seenFrom: sourceId,
    sourceId,
    alertname,
    severity: normalizeSeverity(labels.severity || labels.priority || raw?.severity),
    owner: labels.owner || labels.team || null,
    labels: kept,
    summary: String(annotations.summary || annotations.description || annotations.message || raw?.message || "").slice(0, 300),
    startsAt: raw?.startsAt || raw?.activeAt || null,
  };
}

// ——— Telegram / plain-text alerts ———

const FIRING_MARK = /(\[\s*firing|\bfiring\b|🔥|🔴|🚨|❗|‼️|⛔|❌|\bproblem\b|\balert(ing)?\b|\bdown\b|\bcritical\b|\berror\b|\bfail(ed|ing|ure)?\b|قطع|خطا|بحرانی|هشدار)/i;
const RESOLVED_MARK = /(\[\s*resolved|\bresolved\b|\brecovered\b|✅|🟢|\bback up\b|\bis up\b|\[\s*✅?\s*up\s*\]|\bok\b|برطرف|رفع شد|وصل شد|برگشت)/i;
const STATUS_WORDS = /\b(firing|resolved|recovered|problems?|alert(s|ing)?|down|up|ok|back|is|are|was|now|critical|warnings?|errors?|fail(s|ed|ing|ures?)?)\b|قطع شد|قطع|وصل شد|رفع شد|برطرف شد|برطرف|خطا|بحرانی|هشدار/gi;

/** A stable name for a free-text alert: status words, emoji, numbers, links and brackets stripped. */
export function textAlertName(line) {
  const name = String(line || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[[^\]]*:\s*\d+\]/g, " ") // [FIRING:2]
    .replace(STATUS_WORDS, " ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/[\d٠-٩۰-۹]+([.,:/][\d٠-٩۰-۹]+)*\s*%?/g, " ")
    .replace(/[[\](){}<>*_`#|"']/g, " ")
    .replace(/[:\-–—.,;!?]+(\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name.slice(0, 80) || "پیام هشدار";
}

/**
 * One Telegram (or any plain-text) alert message → { status, items[] } or null when it does not look
 * like an alert. Knows Alertmanager's and Grafana's Telegram templates ([FIRING:n] Name, "alertname =
 * X" label lines) and Uptime Kuma's ([Monitor] [🔴 Down]); anything else is keyed by its first line.
 */
export function parseAlertText(text, { everyMessage = false } = {}) {
  const body = String(text || "").trim();
  if (!body) return null;
  const firstLine = body.split("\n").find((l) => l.trim()) || "";
  const head = body.slice(0, 400);

  // Uptime Kuma: "[My API] [🔴 Down] timeout" / "[My API] [✅ Up] 200 - OK"
  const kuma = firstLine.match(/^\s*\[([^\]]+)\]\s*\[\s*(🔴|✅|🟢)?\s*(down|up)\s*\]\s*(.*)$/i);
  if (kuma) {
    const resolved = /up/i.test(kuma[3]);
    return { status: resolved ? "resolved" : "firing", items: [{ alertname: kuma[1].trim().slice(0, 120), member: "-", severity: "critical", summary: kuma[4].trim().slice(0, 300) }] };
  }

  const bracket = head.match(/\[\s*(firing|resolved)(?:\s*:\s*\d+)?\s*\]\s*([^\s(\n]+)?/i);
  let status = null;
  if (bracket) status = /resolved/i.test(bracket[1]) ? "resolved" : "firing";
  else if (RESOLVED_MARK.test(firstLine)) status = "resolved";
  else if (FIRING_MARK.test(head)) status = "firing";
  else if (everyMessage) status = "firing";
  if (!status) return null;

  const severityOf = (chunk) => {
    const label = chunk.match(/severity\s*[=:]\s*([A-Za-z0-9]+)/i);
    if (label) return normalizeSeverity(label[1]);
    return /critical|disaster|بحرانی|🚨|🔴|\bp1\b/i.test(chunk) ? "critical" : "warning";
  };
  const bodySeverity = severityOf(body);
  const memberOf = (chunk) => {
    const m = chunk.match(/\b(instance|pod|host|node|monitor|service)\s*[=:]\s*([^\s,]+)/i);
    return m ? m[2].slice(0, 200) : "-";
  };

  // Grafana/Alertmanager label blocks: one item per "alertname = X" line.
  const names = [...body.matchAll(/alertname\s*[=:]\s*([^\s,]+)/gi)];
  if (names.length) {
    const items = names.map((m, i) => {
      const chunk = body.slice(m.index, names[i + 1]?.index ?? body.length);
      return { alertname: m[1].slice(0, 120), member: memberOf(chunk), severity: /severity\s*[=:]/i.test(chunk) ? severityOf(chunk) : bodySeverity, summary: (chunk.match(/summary\s*[=:]\s*(.+)/i)?.[1] || "").trim().slice(0, 300) };
    });
    return { status, items };
  }
  if (bracket?.[2]) {
    return { status, items: [{ alertname: bracket[2].replace(/[*_`]/g, "").slice(0, 120), member: memberOf(body), severity: severityOf(body), summary: body.split("\n").slice(1).join(" ").trim().slice(0, 300) }] };
  }
  return { status, items: [{ alertname: textAlertName(firstLine), member: memberOf(body), severity: severityOf(head), summary: body.slice(0, 300) }] };
}

// ——— the store ———

const pushKey = (alert) => `${alert.alertname}|${alert.member || "-"}`;

export function createSourceStore(db, { now = () => new Date(), secrets = null } = {}) {
  db.exec(SCHEMA);
  const q = {
    all: db.prepare("SELECT * FROM incident_sources ORDER BY created_at"),
    get: db.prepare("SELECT * FROM incident_sources WHERE id = ?"),
    insert: db.prepare("INSERT INTO incident_sources (id, kind, name, config_json, enabled, created_by, created_at, updated_at) VALUES (@id, @kind, @name, @config, @enabled, @by, @at, @at)"),
    update: db.prepare("UPDATE incident_sources SET name = @name, config_json = @config, enabled = @enabled, updated_at = @at WHERE id = @id"),
    remove: db.prepare("DELETE FROM incident_sources WHERE id = ?"),
    pushUpsert: db.prepare("INSERT INTO incident_push_alerts (source_id, akey, alert_json, updated_at, expires_at) VALUES (@source, @akey, @alert, @at, @expires) ON CONFLICT(source_id, akey) DO UPDATE SET alert_json = @alert, updated_at = @at, expires_at = @expires"),
    pushDelete: db.prepare("DELETE FROM incident_push_alerts WHERE source_id = ? AND akey = ?"),
    pushDeleteName: db.prepare("DELETE FROM incident_push_alerts WHERE source_id = ? AND akey LIKE ? || '|%'"),
    pushOf: db.prepare("SELECT * FROM incident_push_alerts WHERE source_id = ?"),
    pushExpire: db.prepare("DELETE FROM incident_push_alerts WHERE expires_at < ?"),
    pushClear: db.prepare("DELETE FROM incident_push_alerts WHERE source_id = ?"),
  };
  const iso = () => now().toISOString();
  const row2 = (row) => (row ? { ...row, config: parse(row.config_json, {}), enabled: Boolean(row.enabled) } : null);
  const status = new Map(); // id -> { ok, error, count, at, lastEventAt }

  function cleanConfig(kind, input = {}, previous = {}) {
    const c = { ...previous };
    const spec = SOURCE_KINDS[kind];
    if (spec.url) {
      const url = String(input.url ?? c.url ?? "").trim().replace(/\/+$/, "");
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error("url (http/https) is required");
      c.url = url;
      if ("secret" in input) c.secret = input.secret ? String(input.secret).trim() : null;
      if ("auth" in input) c.auth = ["bearer", "basic", "header"].includes(input.auth) ? input.auth : "bearer";
      if ("header" in input) c.header = input.header ? String(input.header).trim().slice(0, 80) : null;
      if ("watchdog" in input) c.watchdog = Boolean(input.watchdog);
      if ("insecure" in input) c.insecure = Boolean(input.insecure);
    }
    if (kind === "webhook") {
      c.token = c.token || randomBytes(18).toString("base64url");
      c.ttlHours = clampTtl(input.ttlHours ?? c.ttlHours ?? 24);
    }
    if (kind === "telegram") {
      if (input.personId) c.personId = String(input.personId);
      if (!c.personId) throw new Error("telegram source needs the chat (personId)");
      if (input.chatTitle) c.chatTitle = String(input.chatTitle).slice(0, 120);
      c.ttlHours = clampTtl(input.ttlHours ?? c.ttlHours ?? 6);
      if ("everyMessage" in input) c.everyMessage = Boolean(input.everyMessage);
    }
    return c;
  }
  const clampTtl = (h) => Math.min(Math.max(Number(h) || 6, 1), 24 * 7);

  const api = {
    list: () => q.all.all().map(row2),
    get: (id) => row2(q.get.get(String(id || ""))),
    enabled: () => q.all.all().map(row2).filter((s) => s.enabled),
    byKind: (kind) => q.all.all().map(row2).filter((s) => s.kind === kind),
    isEmpty: () => q.all.all().length === 0,
    add({ id, kind, name, config = {}, enabled = true, by = "owner" }) {
      if (!SOURCE_KINDS[kind]) throw new Error(`unknown kind ${kind}; one of ${Object.keys(SOURCE_KINDS).join(", ")}`);
      const sid = String(id || slugify(name) || `${kind}-${randomBytes(3).toString("hex")}`);
      if (!SOURCE_ID.test(sid)) throw new Error("id: 2-40 chars, a-z 0-9 and -");
      if (RESERVED.has(sid) && !SOURCE_KINDS[kind].builtin) throw new Error(`id «${sid}» is reserved`);
      if (q.get.get(sid)) throw new Error(`a source «${sid}» already exists`);
      const cleaned = cleanConfig(kind, config);
      q.insert.run({ id: sid, kind, name: String(name || sid).slice(0, 80), config: JSON.stringify(cleaned), enabled: enabled ? 1 : 0, by, at: iso() });
      return api.get(sid);
    },
    update(id, { name, config, enabled } = {}) {
      const cur = api.get(id);
      if (!cur) throw new Error(`no source ${id}`);
      const next = config ? cleanConfig(cur.kind, config, cur.config) : cur.config;
      q.update.run({ id: cur.id, name: name ? String(name).slice(0, 80) : cur.name, config: JSON.stringify(next), enabled: enabled === undefined ? (cur.enabled ? 1 : 0) : enabled ? 1 : 0, at: iso() });
      if (enabled === false) q.pushClear.run(cur.id);
      return api.get(cur.id);
    },
    remove(id) {
      const cur = api.get(id);
      if (!cur) return false;
      q.remove.run(cur.id);
      q.pushClear.run(cur.id);
      if (cur.config?.secret?.startsWith?.("incident-source:")) secrets?.delete?.(cur.config.secret);
      status.delete(cur.id);
      return true;
    },
    /** A webhook source by its URL token. */
    byToken: (token) => api.byKind("webhook").find((s) => s.enabled && s.config.token && s.config.token === String(token || "")) || null,
    byPerson: (personId) => api.byKind("telegram").filter((s) => s.enabled && s.config.personId === String(personId)),

    // ——— push alerts ———
    /** firing: upsert each alert (refreshing its TTL); resolved: drop it (by member, or every member of the name). */
    push(source, { status: st, items }) {
      const at = now();
      const ttl = (source.config.ttlHours || 6) * 3_600_000;
      let n = 0;
      for (const item of items || []) {
        const alert = { alertname: String(item.alertname || "alert").slice(0, 120), member: String(item.member || "-").slice(0, 200), severity: normalizeSeverity(item.severity), summary: String(item.summary || "").slice(0, 300), labels: item.labels || {}, owner: item.owner || null, startsAt: item.startsAt || null };
        if (st === "resolved") {
          if (alert.member === "-") q.pushDeleteName.run(source.id, alert.alertname);
          else q.pushDelete.run(source.id, pushKey(alert));
        } else {
          const prev = q.pushOf.all(source.id).find((r) => r.akey === pushKey(alert));
          const startsAt = parse(prev?.alert_json, {})?.startsAt || alert.startsAt || at.toISOString();
          q.pushUpsert.run({ source: source.id, akey: pushKey(alert), alert: JSON.stringify({ ...alert, startsAt }), at: at.toISOString(), expires: new Date(at.getTime() + ttl).toISOString() });
        }
        n += 1;
      }
      const s = status.get(source.id) || {};
      status.set(source.id, { ...s, lastEventAt: at.toISOString() });
      return n;
    },
    pushed(source) {
      q.pushExpire.run(iso());
      return q.pushOf.all(source.id).map((r) => {
        const a = parse(r.alert_json, {});
        return { fingerprint: `${source.id}:${r.akey}`, cluster: source.id, seenFrom: source.id, sourceId: source.id, alertname: a.alertname, severity: a.severity, owner: a.owner || null, labels: { ...(a.labels || {}), ...(a.member && a.member !== "-" ? { instance: a.member } : {}) }, summary: a.summary || "", startsAt: a.startsAt || r.updated_at };
      });
    },
    setStatus: (id, s) => status.set(id, { ...(status.get(id) || {}), ...s, at: iso() }),
    status: (id) => status.get(id) || null,
  };
  return api;
}

// ——— poll readers ———

function authHeaders(source, secrets) {
  const c = source.config;
  const value = c.secret ? secrets?.get?.(c.secret) : "";
  if (c.secret && !value) throw new Error(`secret «${c.secret}» is empty in this install's secret store`);
  if (!value) return {};
  if (c.auth === "basic") return { authorization: `Basic ${Buffer.from(value).toString("base64")}` };
  if (c.auth === "header" && c.header) return { [c.header]: value };
  return { authorization: `Bearer ${value}` };
}

async function getJson(url, headers, fetchImpl, timeoutMs = 15_000) {
  const res = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`http ${res.status} from ${new URL(url).host}`);
  return res.json();
}

/** One poll of an HTTP source → { ok, alerts, watchdog?, error? } */
export async function readHttpSource(source, { secrets, fetchImpl = fetch } = {}) {
  const headers = authHeaders(source, secrets);
  const base = source.config.url;
  if (source.kind === "prometheus") {
    const body = await getJson(`${base}/api/v1/alerts`, headers, fetchImpl);
    const list = (body?.data?.alerts || []).filter((a) => a.state === "firing");
    return list.map((a) => normalizeGeneric(a, source.id));
  }
  const path = source.kind === "grafana" ? "/api/alertmanager/grafana/api/v2/alerts" : "/api/v2/alerts";
  const body = await getJson(`${base}${path}?active=true&silenced=false&inhibited=false`, headers, fetchImpl);
  return (Array.isArray(body) ? body : []).map((a) => normalizeGeneric(a, source.id));
}

/** A webhook body → push items. Alertmanager/Grafana webhook ({alerts:[…]}) or a plain {title, status, severity}. */
export function webhookItems(body) {
  if (Array.isArray(body?.alerts)) {
    return body.alerts.map((a) => {
      const g = normalizeGeneric(a, "x");
      return { status: a.status === "resolved" ? "resolved" : "firing", item: { alertname: g.alertname, member: a.labels?.instance || a.labels?.pod || a.labels?.host || "-", severity: g.severity, summary: g.summary, labels: g.labels, owner: g.owner, startsAt: g.startsAt } };
    });
  }
  const title = String(body?.title || body?.alertname || body?.name || body?.text || "").trim();
  if (!title) return [];
  const resolved = /^(resolved|ok|up|recovered)$/i.test(String(body?.status || body?.state || ""));
  return [{ status: resolved ? "resolved" : "firing", item: { alertname: title.slice(0, 120), member: String(body?.member || body?.instance || "-"), severity: normalizeSeverity(body?.severity), summary: String(body?.message || body?.summary || "").slice(0, 300) } }];
}

/**
 * The intake's fetchAlerts over every enabled source. `builtins` reads the sources that existed before
 * this table: clusters → broker alerts_active (its clusters keep their names and Watchdog check),
 * business → the business signal, vault → broker health.
 */
export function createCollector({ sources, secrets, builtins = {}, fetchImpl = fetch, pollEveryMs = 60_000, now = () => new Date() }) {
  const cache = new Map(); // id -> { at, value }
  return async function collect() {
    const clusters = {};
    const alerts = [];
    const tasks = sources.enabled().map(async (source) => {
      const spec = SOURCE_KINDS[source.kind];
      if (!spec) return;
      if (spec.mode === "push") {
        const list = sources.pushed(source);
        clusters[source.id] = { ok: true, watchdog: false, count: list.length, kind: source.kind, source: source.id };
        alerts.push(...list);
        sources.setStatus(source.id, { ok: true, error: null, count: list.length });
        return;
      }
      if (spec.builtin) {
        const read = builtins[source.kind];
        if (!read) {
          clusters[source.id] = { ok: false, error: "not available on this install", watchdog: false, kind: source.kind };
          sources.setStatus(source.id, { ok: false, error: "not available on this install", count: 0 });
          return;
        }
        try {
          const r = await read();
          for (const [name, info] of Object.entries(r.clusters || {})) clusters[name] = { ...info, kind: source.kind, source: source.id };
          alerts.push(...(r.alerts || []).map((a) => ({ ...a, sourceId: source.id })));
          const bad = Object.values(r.clusters || {}).filter((c) => !c.ok);
          sources.setStatus(source.id, { ok: bad.length === 0, error: bad.map((c) => c.error).filter(Boolean).join("; ").slice(0, 300) || null, count: (r.alerts || []).length });
        } catch (error) {
          clusters[source.id] = { ok: false, error: String(error.message).slice(0, 300), watchdog: false, kind: source.kind };
          sources.setStatus(source.id, { ok: false, error: String(error.message).slice(0, 300), count: 0 });
        }
        return;
      }
      const t = now().getTime();
      const hit = cache.get(source.id);
      let value = hit && t - hit.at < pollEveryMs - 5_000 && hit.updated === source.updated_at ? hit.value : null;
      if (!value) {
        try {
          const list = await readHttpSource(source, { secrets, fetchImpl });
          value = { ok: true, alerts: list };
        } catch (error) {
          value = { ok: false, error: String(error.message).slice(0, 300), alerts: [] };
        }
        cache.set(source.id, { at: t, value, updated: source.updated_at });
      }
      clusters[source.id] = { ok: value.ok, error: value.error, count: value.alerts.length, watchdog: source.config.watchdog ? undefined : false, kind: source.kind, source: source.id };
      alerts.push(...value.alerts);
      sources.setStatus(source.id, { ok: value.ok, error: value.error || null, count: value.alerts.length });
    });
    await Promise.all(tasks);
    return { clusters, alerts };
  };
}

/** Test a source once, now (the form's «تست اتصال» and the chat tool's action:test). */
export async function testSource(source, { secrets, builtins = {}, fetchImpl = fetch, sources = null } = {}) {
  const spec = SOURCE_KINDS[source.kind];
  try {
    if (spec.mode === "push") {
      const firing = sources ? sources.pushed(source).length : 0;
      const last = sources?.status(source.id)?.lastEventAt || null;
      return { ok: true, firing, lastEventAt: last, note: source.kind === "telegram" ? "هر پیام تازهٔ همان چت خوانده می‌شود" : "منتظر POST به آدرس وبهوک" };
    }
    if (spec.builtin) {
      const r = await builtins[source.kind]?.();
      if (!r) return { ok: false, error: "not available on this install" };
      const bad = Object.entries(r.clusters || {}).filter(([, c]) => !c.ok);
      return { ok: bad.length === 0, firing: (r.alerts || []).length, error: bad.map(([n, c]) => `${n}: ${c.error}`).join("; ") || null };
    }
    const list = await readHttpSource(source, { secrets, fetchImpl });
    return { ok: true, firing: list.length, sample: list.slice(0, 5).map((a) => `${a.severity} ${a.alertname}`) };
  } catch (error) {
    return { ok: false, error: String(error.message).slice(0, 300) };
  }
}

/** What the API and the chat tool show: never a secret value; the webhook token only where asked. */
export function sourceView(source, { status = null, baseUrl = "", withToken = false } = {}) {
  if (!source) return null;
  const c = { ...source.config };
  const view = { id: source.id, kind: source.kind, kindLabel: SOURCE_KINDS[source.kind]?.label || source.kind, name: source.name, enabled: source.enabled, createdBy: source.created_by, createdAt: source.created_at, updatedAt: source.updated_at, status };
  if (c.secret) c.secret = c.secret.startsWith("incident-source:") ? "(در خزانهٔ این نصب)" : c.secret;
  if (source.kind === "webhook") {
    const token = c.token;
    delete c.token;
    view.webhookUrl = withToken ? `${baseUrl}/api/public/incidents/hook/${token}` : `${baseUrl}/api/public/incidents/hook/…${String(token).slice(-4)} (آدرس کامل در صفحهٔ منابع)`;
  }
  view.config = c;
  return view;
}
