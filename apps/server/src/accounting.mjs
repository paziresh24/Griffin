// Central usage accounting: one install (the hub, SUPPORT_AGENT) sees what every install of a fleet
// spends, per install and per shared Claude account, and alerts its owner.
//
// Every install builds a report from its own database (the `usage` events of the last 14 days, by
// engine account and model) plus what it knows of each Claude login: a fingerprint of the key (never
// the key), the plan windows its last run saw, and the last limit it hit. It posts the report every
// 15 minutes to the hub install (SUPPORT_AGENT, as feedback.mjs; unset = nothing is sent) over the agents' network,
// with the token that install gave it. Only there — the hub — the reports are kept, put together
// (per install, per Claude account) and watched: GET /api/accounting answers 404 everywhere else.
//
// Shared accounts: installs signed in with the same token share its fingerprint; a fresh
// setup-token per install does not, so logins whose weekly window resets at the same moment are taken
// as one account too (the window is the account's own). The owner names each account on the hub.
import crypto from "node:crypto";
import { agentId } from "./network.mjs";
import { usageParts } from "./token-usage.mjs";

export const REPORT_DAYS = 14;
const DAY = 86_400_000;
const PUSH_MS = 15 * 60_000;
const ALERT_COOLDOWN_MS = 6 * 3600_000;
const STALE_MS = 3 * 3600_000;
const SAME_RESET_MS = 5 * 60_000;
const KV_REPORT = (host) => `accounting:report:${host}`;
const KV_INSTALLS = "accounting:installs";
const KV_LABELS = "accounting:labels";
const KV_ALERTED = "accounting:alerted";
const KV_HISTORY = "accounting:alerts";

const str = (v, max) => String(v ?? "").slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const empty = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, turns: 0 });
const addParts = (into, p) => {
  for (const k of ["input", "output", "cacheWrite", "cacheRead", "total"]) into[k] += num(p[k]);
  into.turns += num(p.turns ?? 1);
};
// Tokens that load an account: a cache read is cheap for a plan, the rest is not.
export const fresh = (p) => num(p?.total) - num(p?.cacheRead);

// The account behind a key: Anthropic names its organization on every API answer
// (anthropic-organization-id). A subscription token gets no profile (email): 403 on the profile
// endpoint. This id is the same for every token of one account.
export const ORG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function accountOrg(key, fetchImpl = globalThis.fetch) {
  const k = String(key || "");
  // A folder login ("claude-login-dir:…") is no key to send: its account is named by its own status.
  if (!k || k === "claude-code-login" || k.startsWith("claude-login-dir:")) return null;
  const oauth = k.startsWith("sk-ant-oat");
  const res = await fetchImpl("https://api.anthropic.com/v1/models?limit=1", {
    headers: { ...(oauth ? { authorization: `Bearer ${k}`, "anthropic-beta": "oauth-2025-04-20" } : { "x-api-key": k }), "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(10_000),
  });
  const org = res.headers.get("anthropic-organization-id");
  return ORG.test(String(org || "")) ? org : null;
}

/** A key's fingerprint: enough to tell logins apart, never enough to rebuild the key. */
export function keyFingerprint(key) {
  const k = String(key || "");
  if (!k) return null;
  if (k === "claude-code-login") return "login";
  return crypto.createHash("sha256").update(k).digest("hex").slice(0, 12);
}

const hostOf = (url) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
};

/**
 * The report of this install. rows: [{ at, provider, model, usage }] (store.usageRows);
 * accounts: [{ id, kind, label, enabled, fingerprint, email, windows, windowsAt, limit }].
 */
export function buildReport({ rows = [], accounts = [], install = "", owner = "", assistant = "", product = "", commit = null, now = new Date() }) {
  const t = now.getTime();
  const days = new Map();
  for (let i = REPORT_DAYS - 1; i >= 0; i -= 1) {
    const date = new Date(t - i * DAY).toISOString().slice(0, 10);
    days.set(date, { date, ...empty() });
  }
  const last24h = empty();
  const last7d = empty();
  const byAccount = {};
  const byModel = {};
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (Number.isNaN(at) || at > t + 60_000) continue;
    const p = usageParts(row.usage);
    if (!p.total) continue;
    const day = days.get(new Date(at).toISOString().slice(0, 10));
    if (day) addParts(day, p);
    const age = t - at;
    const account = str(row.provider || "unknown", 40);
    const model = str(row.model || "unknown", 60);
    byAccount[account] ||= { last24h: empty(), last7d: empty() };
    byModel[model] ||= { last24h: empty(), last7d: empty() };
    if (age <= 7 * DAY) {
      addParts(last7d, p);
      addParts(byAccount[account].last7d, p);
      addParts(byModel[model].last7d, p);
    }
    if (age <= DAY) {
      addParts(last24h, p);
      addParts(byAccount[account].last24h, p);
      addParts(byModel[model].last24h, p);
    }
  }
  return {
    v: 1,
    at: now.toISOString(),
    install: str(install, 120).toLowerCase(),
    owner: str(owner, 80),
    assistant: str(assistant, 40),
    product: str(product, 20),
    commit: commit ? str(commit, 40) : null,
    accounts: accounts.map((a) => ({
      id: str(a.id, 40),
      kind: str(a.kind, 20),
      label: str(a.label, 60),
      enabled: a.enabled !== false,
      fingerprint: a.fingerprint ? str(a.fingerprint, 16) : null,
      org: ORG.test(String(a.org || "")) ? a.org : null,
      email: a.email ? str(a.email, 120) : null,
      windows: cleanWindows(a.windows),
      windowsAt: validIso(a.windowsAt),
      limit: a.limit && validIso(a.limit.until) ? { at: validIso(a.limit.at), until: validIso(a.limit.until) } : null,
    })),
    usage: { last24h, last7d, days: [...days.values()], byAccount, byModel },
  };
}

function validIso(v) {
  if (v == null || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// planWindows rows ([{label, percentage, resetAt}]) or the SDK's {five_hour: {utilization 0-1, resetsAt s}}
// → { five_hour: {percent, resetsAt}, seven_day: {...}, ... }.
const WINDOW_KEYS = { "۵ ساعته": "five_hour", "هفتگی": "seven_day", "هفتگی Opus": "seven_day_opus", "هفتگی Sonnet": "seven_day_sonnet" };
export function cleanWindows(w) {
  const out = {};
  if (Array.isArray(w)) {
    for (const r of w) {
      const key = WINDOW_KEYS[r?.label] || (typeof r?.id === "string" ? r.id : null);
      if (!key || !Number.isFinite(Number(r.percentage ?? r.percent))) continue;
      out[key] = { percent: Math.max(0, Math.min(100, Math.round(Number(r.percentage ?? r.percent)))), resetsAt: validIso(r.resetAt ?? r.resetsAt) };
    }
  } else if (w && typeof w === "object") {
    for (const [key, v] of Object.entries(w)) {
      if (!/^[a-z_]{3,30}$/.test(key) || !v || typeof v !== "object") continue;
      const percent = v.percent ?? (v.utilization != null ? Number(v.utilization) * (Number(v.utilization) <= 1 ? 100 : 1) : null);
      if (!Number.isFinite(Number(percent))) continue;
      const reset = typeof v.resetsAt === "number" && v.resetsAt < 1e12 ? v.resetsAt * 1000 : v.resetsAt;
      out[key] = { percent: Math.max(0, Math.min(100, Math.round(Number(percent)))), resetsAt: validIso(reset) };
    }
  }
  return Object.keys(out).length ? out : null;
}

/** A report from another install, re-cut field by field — it is someone else's data. */
export function cleanReport(raw, now = new Date()) {
  if (!raw || typeof raw !== "object" || !raw.install) return null;
  const cleanParts = (p) => {
    const o = empty();
    for (const k of Object.keys(o)) o[k] = Math.max(0, num(p?.[k]));
    return o;
  };
  const pair = (x) => ({ last24h: cleanParts(x?.last24h), last7d: cleanParts(x?.last7d) });
  const map = (m, max) => Object.fromEntries(Object.entries(m && typeof m === "object" ? m : {}).slice(0, max).map(([k, v]) => [str(k, 60), pair(v)]));
  const u = raw.usage || {};
  return {
    v: 1,
    at: validIso(raw.at) || now.toISOString(),
    install: str(raw.install, 120).toLowerCase(),
    owner: str(raw.owner, 80),
    assistant: str(raw.assistant, 40),
    product: str(raw.product, 20),
    commit: raw.commit ? str(raw.commit, 40) : null,
    accounts: (Array.isArray(raw.accounts) ? raw.accounts : []).slice(0, 20).map((a) => ({
      id: str(a?.id, 40),
      kind: str(a?.kind, 20),
      label: str(a?.label, 60),
      enabled: a?.enabled !== false,
      fingerprint: /^[0-9a-f]{12}$|^login$/.test(String(a?.fingerprint || "")) ? a.fingerprint : null,
      org: ORG.test(String(a?.org || "")) ? a.org : null,
      email: a?.email ? str(a.email, 120) : null,
      windows: cleanWindows(a?.windows),
      windowsAt: validIso(a?.windowsAt),
      limit: a?.limit && validIso(a.limit.until) ? { at: validIso(a.limit.at), until: validIso(a.limit.until) } : null,
    })),
    usage: {
      last24h: cleanParts(u.last24h),
      last7d: cleanParts(u.last7d),
      days: (Array.isArray(u.days) ? u.days : []).slice(-REPORT_DAYS).map((d) => ({ date: str(d?.date, 10), ...cleanParts(d) })),
      byAccount: map(u.byAccount, 20),
      byModel: map(u.byModel, 40),
    },
  };
}

/**
 * The fleet put together: one row per install, one per Claude account (logins grouped by key
 * fingerprint, the owner's name for it, or the same weekly reset), and totals.
 * labels: { fingerprint: name } the owner gave on the hub.
 */
export function aggregateFleet(reports, { labels = {}, now = new Date() } = {}) {
  const t = now.getTime();
  // Claude logins seen anywhere, each a node to group.
  const logins = [];
  for (const r of reports) {
    for (const a of r.accounts || []) {
      if (a.kind !== "claude" || !a.fingerprint || a.enabled === false) continue;
      const use = r.usage?.byAccount?.[a.id] || { last24h: empty(), last7d: empty() };
      logins.push({ install: r.install, owner: r.owner, accountId: a.id, fingerprint: a.fingerprint, org: a.org || null, email: a.email, windows: a.windows, windowsAt: a.windowsAt, limit: a.limit, use, reportAt: r.at });
    }
  }
  // Union-find: same account (organization id), same fingerprint, same owner-given name, same email,
  // or, for reports without the id, the same weekly reset.
  const label = (l) => (l.org && labels[l.org]) || labels[l.fingerprint] || null;
  const parent = logins.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => {
    parent[find(a)] = find(b);
  };
  const weeklyReset = (l) => {
    const r = l.windows?.seven_day?.resetsAt ? Date.parse(l.windows.seven_day.resetsAt) : NaN;
    return Number.isFinite(r) && r > t ? r : null;
  };
  for (let i = 0; i < logins.length; i += 1) {
    for (let j = i + 1; j < logins.length; j += 1) {
      const a = logins[i];
      const b = logins[j];
      if (a.org && b.org) {
        if (a.org === b.org) join(i, j);
        continue;
      }
      const named = label(a) && label(a) === label(b);
      const ra = weeklyReset(a);
      const rb = weeklyReset(b);
      if (a.fingerprint === b.fingerprint || named || (a.email && a.email === b.email) || (ra && rb && Math.abs(ra - rb) <= SAME_RESET_MS)) join(i, j);
    }
  }
  const groups = new Map();
  logins.forEach((l, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(l);
  });
  const accounts = [...groups.values()].map((members) => {
    const fingerprints = [...new Set(members.map((m) => m.fingerprint))].sort();
    const org = members.map((m) => m.org).find(Boolean) || null;
    const name = members.map(label).find(Boolean) || members.map((m) => m.email).find(Boolean) || null;
    // The newest windows any member saw stand for the account.
    const seen = members.filter((m) => m.windows && m.windowsAt).sort((x, y) => Date.parse(y.windowsAt) - Date.parse(x.windowsAt))[0] || null;
    const last24h = empty();
    const last7d = empty();
    for (const m of members) {
      addParts(last24h, m.use.last24h);
      addParts(last7d, m.use.last7d);
    }
    const limited = members.filter((m) => m.limit && Date.parse(m.limit.until) > t).map((m) => ({ install: m.install, until: m.limit.until }));
    const key = org || fingerprints[0];
    return {
      key,
      name,
      org,
      fingerprints,
      // Joined by a guess (same weekly reset), not by the account id or a name.
      inferred: !(org && members.every((m) => m.org === org)) && fingerprints.length > 1 && !(name && members.every((m) => label(m) === name)),
      windows: seen?.windows || null,
      windowsAt: seen?.windowsAt || null,
      limited,
      last24h,
      last7d,
      installs: members
        .map((m) => ({ install: m.install, owner: m.owner, accountId: m.accountId, fingerprint: m.fingerprint, last24h: m.use.last24h, last7d: m.use.last7d }))
        .sort((x, y) => fresh(y.last7d) - fresh(x.last7d)),
    };
  });
  accounts.sort((x, y) => fresh(y.last7d) - fresh(x.last7d));
  accounts.forEach((a, i) => {
    a.title = a.name || `اکانت ${i + 1} (${a.key.slice(0, 8)})`;
  });

  const totals = { last24h: empty(), last7d: empty() };
  for (const r of reports) {
    addParts(totals.last24h, r.usage.last24h);
    addParts(totals.last7d, r.usage.last7d);
  }
  const accountOf = new Map();
  for (const a of accounts) for (const m of a.installs) accountOf.set(`${m.install}|${m.accountId}`, a.title);
  const installs = reports
    .map((r) => {
      const age = t - Date.parse(r.at);
      return {
        install: r.install,
        owner: r.owner,
        assistant: r.assistant,
        product: r.product,
        commit: r.commit,
        reportAt: r.at,
        receivedAt: r.receivedAt || null,
        stale: age > STALE_MS,
        last24h: r.usage.last24h,
        last7d: r.usage.last7d,
        days: r.usage.days,
        share24h: fresh(totals.last24h) ? fresh(r.usage.last24h) / fresh(totals.last24h) : 0,
        share7d: fresh(totals.last7d) ? fresh(r.usage.last7d) / fresh(totals.last7d) : 0,
        accounts: Object.entries(r.usage.byAccount || {})
          .map(([id, v]) => ({ id, account: accountOf.get(`${r.install}|${id}`) || null, kind: (r.accounts || []).find((a) => a.id === id)?.kind || id.split("-")[0], last24h: v.last24h, last7d: v.last7d }))
          .filter((a) => a.last7d.total)
          .sort((x, y) => fresh(y.last7d) - fresh(x.last7d)),
        models: Object.entries(r.usage.byModel || {})
          .map(([model, v]) => ({ model, last24h: v.last24h, last7d: v.last7d }))
          .filter((m) => m.last7d.total)
          .sort((x, y) => fresh(y.last7d) - fresh(x.last7d))
          .slice(0, 6),
      };
    })
    .sort((x, y) => fresh(y.last7d) - fresh(x.last7d));
  return { at: now.toISOString(), totals, accounts, installs };
}

const fmt = (n) => {
  const v = num(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(Math.round(v));
};
export const tokens = fmt;
const pctOf = (x) => `${Math.round(x * 100)}٪`;
const whoOf = (i) => (i.owner ? `${i.owner} (${i.install})` : i.install);

/**
 * What the owner should hear about now: plan windows running out, a limit hit, an install spending
 * far more than its usual, one install eating a shared account, an install gone quiet.
 * Every alert has a stable key (one message per key per cooldown).
 */
export function fleetAlerts(fleet, { weeklyWarn = 80, weeklyCrit = 95, sessionWarn = 90, spikeFactor = 3, spikeFloor = 3e6, shareWarn = 0.5, shareFloor = 1e7, now = new Date() } = {}) {
  const t = now.getTime();
  const out = [];
  for (const a of fleet.accounts) {
    const live = a.windowsAt && t - Date.parse(a.windowsAt) < 6 * 3600_000;
    const week = live ? a.windows?.seven_day : null;
    if (week && (!week.resetsAt || Date.parse(week.resetsAt) > t) && week.percent >= weeklyWarn) {
      const level = week.percent >= weeklyCrit ? "critical" : "warning";
      out.push({ key: `weekly:${a.key}:${level}:${week.resetsAt || ""}`, level, account: a.title, text: `سقف هفتگی ${a.title} به ${week.percent}٪ رسید${week.resetsAt ? ` (ریست ${week.resetsAt})` : ""}. پرمصرف‌ترین در ۷ روز: ${a.installs.slice(0, 3).map((m) => `${m.owner || m.install} ${fmt(fresh(m.last7d))}`).join("، ")}` });
    }
    const session = live ? a.windows?.five_hour : null;
    if (session && (!session.resetsAt || Date.parse(session.resetsAt) > t) && session.percent >= sessionWarn) {
      out.push({ key: `session:${a.key}:${session.resetsAt || ""}`, level: "warning", account: a.title, text: `سقف ۵ ساعتهٔ ${a.title} به ${session.percent}٪ رسید${session.resetsAt ? ` (ریست ${session.resetsAt})` : ""}.` });
    }
    for (const l of a.limited) {
      out.push({ key: `limit:${a.key}:${l.install}:${l.until}`, level: "critical", account: a.title, text: `${a.title} روی ${l.install} به سقف خورد تا ${l.until}؛ کارهای آن نصب روی موتور دیگر می‌رود یا منتظر می‌ماند.` });
    }
    const shared24 = fresh(a.last24h);
    if (a.installs.length >= 2 && shared24 >= shareFloor) {
      for (const m of a.installs) {
        const share = fresh(m.last24h) / shared24;
        if (share >= shareWarn) out.push({ key: `share:${a.key}:${m.install}:${now.toISOString().slice(0, 10)}`, level: "warning", account: a.title, install: m.install, text: `${m.owner || m.install} در ۲۴ ساعت گذشته ${pctOf(share)} از مصرف ${a.title} را برده (${fmt(fresh(m.last24h))} از ${fmt(shared24)}، ${a.installs.length} نصب روی این اکانت).` });
      }
    }
  }
  for (const i of fleet.installs) {
    const today = fresh(i.last24h);
    // The usual day: the six days before the last 24 hours.
    const before = (i.days || []).slice(-8, -1);
    const usual = before.length ? before.reduce((s, d) => s + fresh(d), 0) / before.length : 0;
    if (today >= spikeFloor && today >= spikeFactor * Math.max(usual, 1)) {
      out.push({ key: `spike:${i.install}:${now.toISOString().slice(0, 10)}`, level: "warning", install: i.install, text: `مصرف ${whoOf(i)} در ۲۴ ساعت گذشته ${fmt(today)} توکن بود؛ ${usual ? `${(today / usual).toFixed(1)} برابر روز معمولش (${fmt(usual)})` : "روزهای قبل تقریباً صفر بود"}.` });
    }
    if (i.stale && t - Date.parse(i.reportAt) < 7 * DAY) {
      out.push({ key: `stale:${i.install}:${i.reportAt}`, level: "info", install: i.install, text: `از ${whoOf(i)} از ${i.reportAt} گزارش مصرفی نرسیده (نصب خاموش است یا به شبکه وصل نیست).` });
    }
  }
  return out;
}

/**
 * The accounting service. collect(): this install's report (built by index.mjs from its store);
 * network: createNetwork's { list, post }; isHub(): this is the maintainer's install;
 * notify(text): the owner's Telegram (hub only).
 */
export function createAccounting({ store, network = null, supportHost = () => "", selfHost = () => "", collect, notify = null, thresholds = () => ({}), log = console, now = () => new Date() }) {
  const isHub = () => {
    const hub = String(supportHost() || "").toLowerCase();
    return Boolean(hub) && hub === String(selfHost() || "").toLowerCase();
  };

  // kv values are JSON already (db.mjs); a value of the wrong shape counts as none.
  const kv = (key, fallback) => {
    const v = store.getKv(key);
    return v && typeof v === typeof fallback && Array.isArray(v) === Array.isArray(fallback) ? v : fallback;
  };
  function keep(report, from = null) {
    const r = { ...report, receivedAt: now().toISOString(), ...(from ? { from: str(from, 120) } : {}) };
    store.setKv(KV_REPORT(r.install), r);
    const list = kv(KV_INSTALLS, []);
    if (!list.includes(r.install)) store.setKv(KV_INSTALLS, [...list, r.install].slice(-200));
  }
  const reports = () => kv(KV_INSTALLS, []).map((host) => kv(KV_REPORT(host), null)).filter((r) => r?.install && r.usage);
  const labels = () => kv(KV_LABELS, {});
  const fleet = () => aggregateFleet(reports(), { labels: labels(), now: now() });

  async function pushOnce() {
    const report = await collect();
    if (!report?.install) return { ok: false, reason: "this install has no public address" };
    if (isHub()) {
      keep(report);
      await check();
      return { ok: true, hub: true };
    }
    const host = String(supportHost() || "").toLowerCase();
    const agent = host ? network?.list?.().find((a) => a.connected && hostOf(a.url) === host) : null;
    if (!agent) return { ok: false, reason: `not connected to ${host || "a hub"}` };
    const r = await network.post(agent.id, "/api/public/network/usage", { report });
    return { ok: Boolean(r?.ok) };
  }

  const history = () => kv(KV_HISTORY, []);
  // Each alert once per key, again after the cooldown if it still holds.
  async function check() {
    if (!isHub()) return [];
    const current = fleetAlerts(fleet(), { ...thresholds(), now: now() });
    const sent = kv(KV_ALERTED, {});
    const t = now().getTime();
    const due = current.filter((a) => a.level !== "info" && !(sent[a.key] && t - sent[a.key] < ALERT_COOLDOWN_MS));
    for (const a of due) sent[a.key] = t;
    for (const [k, at] of Object.entries(sent)) if (t - at > 7 * DAY) delete sent[k];
    store.setKv(KV_ALERTED, sent);
    if (due.length) {
      store.setKv(KV_HISTORY, [...due.map((a) => ({ ...a, at: now().toISOString() })), ...history()].slice(0, 200));
      if (notify) {
        const icon = (a) => (a.level === "critical" ? "🔴" : "🟠");
        try {
          await notify(`💳 مصرف اکانت‌ها\n${due.map((a) => `${icon(a)} ${a.text}`).join("\n")}`);
        } catch (error) {
          log.error?.(`[accounting] alert not sent: ${error.message}`);
        }
      }
    }
    return current;
  }

  function routes(app, peerAuth) {
    app.post("/api/public/network/usage", async (c) => {
      if (!isHub()) return c.json({ error: "not the accounting hub" }, 404);
      const who = peerAuth.authenticate(c.req.header("authorization"));
      if (who.error) return c.json({ error: who.error }, who.status);
      if (!String(who.userId).startsWith("net-")) return c.json({ error: "network members only" }, 403);
      if (Number(c.req.header("content-length") || 0) > 512 * 1024) return c.json({ error: "too large" }, 413);
      const body = await c.req.json().catch(() => ({}));
      const report = cleanReport(body?.report, now());
      if (!report) return c.json({ error: "bad report" }, 400);
      // A member reports for itself only: the token it holds was made for its own address.
      if (`net-${agentId(report.install)}`.slice(0, 41) !== who.userId) return c.json({ error: "report for another install" }, 403);
      keep(report, who.label);
      check().catch((e) => log.error?.(`[accounting] check: ${e.message}`));
      return c.json({ ok: true });
    });
  }
  // The owner's own API, on the hub only (404 elsewhere: the page is not there).
  function ownerRoutes(api) {
    const hubOnly = (handler) => (c) => (isHub() ? handler(c) : c.json({ error: "accounting is on the maintainer's install only" }, 404));
    api.get(
      "/api/accounting",
      hubOnly(async (c) => {
        const f = fleet();
        return c.json({ ...f, alerts: fleetAlerts(f, { ...thresholds(), now: now() }), history: history().slice(0, 50), labels: labels() });
      }),
    );
    api.post(
      "/api/accounting/refresh",
      hubOnly(async (c) => {
        await pushOnce().catch((e) => log.error?.(`[accounting] own report: ${e.message}`));
        return c.json({ ok: true });
      }),
    );
    api.put(
      "/api/accounting/labels",
      hubOnly(async (c) => {
        const body = await c.req.json().catch(() => ({}));
        // The account id when there is one (it holds for every token of that account), else the fingerprints.
        const asked = ORG.test(String(body.org || "")) ? [body.org] : Array.isArray(body.fingerprints) ? body.fingerprints : [body.fingerprint];
        const fps = asked.filter((f) => ORG.test(String(f || "")) || /^[0-9a-f]{12}$|^login$/.test(String(f || "")));
        if (!fps.length) return c.json({ error: "account id or fingerprint required" }, 400);
        const all = labels();
        const name = str(body.name, 40).trim();
        for (const f of fps) {
          if (name) all[f] = name;
          else delete all[f];
        }
        store.setKv(KV_LABELS, all);
        return c.json({ labels: all });
      }),
    );
  }

  function start() {
    const tick = () => pushOnce().catch((e) => log.error?.(`[accounting] report: ${e.message}`));
    setTimeout(tick, 90_000).unref?.();
    setInterval(tick, PUSH_MS).unref?.();
    // The hub also looks again between reports (a window crossing a line, an install going quiet).
    setInterval(() => check().catch(() => {}), PUSH_MS).unref?.();
  }

  return { isHub, pushOnce, check, fleet, reports, keep, routes, ownerRoutes, start };
}
