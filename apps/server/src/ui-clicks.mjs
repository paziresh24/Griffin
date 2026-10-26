// «نقشهٔ کلیک‌ها» (a colleague via the owner, 2026-10-24: «هیت‌مپ روی همهٔ نسخه‌های نصب‌شده نداریم که
// بفهمیم پراستفاده‌ترین بخش‌ها کجاست؛ دد کلیک‌ها را نمی‌فهمیم»).
//
// The page (apps/web/src/clicks.js) counts what was clicked — never what was written: a control's own
// label, the page and the part of the screen, a dead click (on something that does nothing), a click on
// a disabled control, three quick clicks on one control (rage), and where on the screen (a 10×10 grid).
// It posts the counts here; they are kept per day in kv for 30 days. Every install posts its last 14
// days every hour to the maintainer's install (SUPPORT_AGENT, as accounting.mjs) over the agents'
// network; there they are put together across installs. Settings → «نقشهٔ کلیک‌ها» reads GET
// /api/clicks: every install sees its own, the hub sees all of them. CLICK_MAP=off stops all of it.
import { agentId } from "./network.mjs";

export const KINDS = ["click", "dead", "disabled", "rage", "pos", "load"];
export const KEEP_DAYS = 30;
export const REPORT_DAYS = 14;
const DAY_KEYS = 3000;
const REPORT_KEYS = 4000;
const PUSH_MS = 60 * 60_000;
const KV_DAY = (day) => `clicks:day:${day}`;
const KV_DAYS = "clicks:days";
const KV_REPORT = (host) => `clicks:report:${host}`;
const KV_INSTALLS = "clicks:installs";
const SEP = "\u001f";

const str = (v, max) =>
  String(v ?? "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const dayOf = (date) => date.toISOString().slice(0, 10);

/** One counted row from the page, or null: route (page), area (part of the screen), kind, key. */
export function cleanRow(row) {
  const kind = KINDS.includes(row?.kind) ? row.kind : null;
  const route = str(row?.route, 40);
  const key = str(row?.key, 60);
  const n = Math.floor(Number(row?.n));
  if (!kind || !route || !key || !(n > 0)) return null;
  if (kind === "pos" && !/^\d,\d(?:,m)?$/.test(key)) return null;
  return { route, area: str(row?.area, 30) || "page", kind, key, n: Math.min(n, 500) };
}
export const rowKey = (r) => [r.route, r.area, r.kind, r.key].join(SEP);
export const splitKey = (k) => {
  const [route, area, kind, key] = String(k).split(SEP);
  return { route, area, kind, key };
};

/** Adds counts into one map; past `cap` keys, only keys already there grow. */
export function addCounts(into, counts, cap = Infinity) {
  let size = Object.keys(into).length;
  for (const [k, n] of Object.entries(counts || {})) {
    const v = Math.floor(Number(n));
    if (!(v > 0)) continue;
    if (!(k in into)) {
      if (size >= cap) continue;
      size += 1;
      into[k] = 0;
    }
    into[k] += v;
  }
  return into;
}

/** The biggest `max` counts. */
export function topCounts(counts, max) {
  return Object.fromEntries(Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).slice(0, max));
}

/** A report another install sent, cut again: someone else's data. */
export function cleanReport(r) {
  const install = str(r?.install, 120).toLowerCase();
  if (!install || !r?.counts || typeof r.counts !== "object") return null;
  const counts = {};
  for (const [k, n] of Object.entries(r.counts).slice(0, REPORT_KEYS)) {
    const row = cleanRow({ ...splitKey(k), n });
    if (row) counts[rowKey(row)] = (counts[rowKey(row)] || 0) + row.n;
  }
  return { install, owner: str(r.owner, 80), commit: str(r.commit, 40), days: Math.max(0, Math.min(REPORT_DAYS, Math.floor(Number(r.days)) || 0)), counts };
}

/**
 * Many installs' reports as one list, biggest first: each (route, area, kind, key) with its total and
 * how many installs clicked it. `install` keeps one install's own.
 */
export function fleetView(reports, { install = "" } = {}) {
  const chosen = install ? reports.filter((r) => r.install === install) : reports;
  const rows = new Map();
  for (const r of chosen) {
    for (const [k, n] of Object.entries(r.counts || {})) {
      const row = rows.get(k) || { ...splitKey(k), n: 0, installs: 0 };
      row.n += n;
      row.installs += 1;
      rows.set(k, row);
    }
  }
  const all = [...rows.values()].sort((a, b) => b.n - a.n);
  return {
    installs: reports.map((r) => ({ install: r.install, owner: r.owner || "", commit: r.commit || "", days: r.days || 0, receivedAt: r.receivedAt || null })),
    loads: all.filter((r) => r.kind === "load").reduce((sum, r) => sum + r.n, 0),
    rows: all.filter((r) => r.kind !== "pos" && r.kind !== "load").slice(0, 600),
    positions: all.filter((r) => r.kind === "pos"),
  };
}

/**
 * store: getKv / setKv / deleteKv. context(): { install, owner, commit }. enabled(): CLICK_MAP.
 * network: createNetwork's { list, post } (the hub is SUPPORT_AGENT, as feedback.mjs).
 */
export function createClicks({ store, network = null, supportHost = () => "", selfHost = () => "", context = () => ({}), enabled = () => true, log = console, now = () => new Date() }) {
  const isHub = () => {
    const hub = String(supportHost() || "").toLowerCase();
    return Boolean(hub) && hub === String(selfHost() || "").toLowerCase();
  };
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const list = (v) => (Array.isArray(v) ? v : []);

  /** POST /api/clicks: the page's counts, into today's. */
  function record(rows) {
    if (!enabled()) return { ok: false, off: true };
    const clean = list(rows).slice(0, 400).map(cleanRow).filter(Boolean);
    if (!clean.length) return { ok: true, kept: 0 };
    const day = dayOf(now());
    const counts = {};
    for (const r of clean) counts[rowKey(r)] = (counts[rowKey(r)] || 0) + r.n;
    store.setKv(KV_DAY(day), addCounts(obj(store.getKv(KV_DAY(day))), counts, DAY_KEYS));
    const days = list(store.getKv(KV_DAYS));
    if (!days.includes(day)) {
      const next = [...days, day].sort();
      const cut = dayOf(new Date(now().getTime() - KEEP_DAYS * 86_400_000));
      for (const old of next.filter((d) => d < cut)) store.deleteKv?.(KV_DAY(old));
      store.setKv(KV_DAYS, next.filter((d) => d >= cut));
    }
    return { ok: true, kept: clean.length };
  }

  /** This install's last REPORT_DAYS days, as one map. */
  function report() {
    const cut = dayOf(new Date(now().getTime() - (REPORT_DAYS - 1) * 86_400_000));
    const days = list(store.getKv(KV_DAYS)).filter((d) => d >= cut);
    const counts = {};
    for (const d of days) addCounts(counts, obj(store.getKv(KV_DAY(d))));
    const ctx = context() || {};
    return { install: str(ctx.install, 120).toLowerCase(), owner: str(ctx.owner, 80), commit: str(ctx.commit, 40), days: days.length, counts: topCounts(counts, REPORT_KEYS) };
  }

  function keep(r, from = null) {
    store.setKv(KV_REPORT(r.install), { ...r, receivedAt: now().toISOString(), ...(from ? { from: str(from, 120) } : {}) });
    const installs = list(store.getKv(KV_INSTALLS));
    if (!installs.includes(r.install)) store.setKv(KV_INSTALLS, [...installs, r.install].slice(-200));
  }
  const reports = () => list(store.getKv(KV_INSTALLS)).map((h) => store.getKv(KV_REPORT(h))).filter((r) => r?.install && r.counts);

  async function pushOnce() {
    if (!enabled()) return { ok: false, reason: "off" };
    const r = report();
    if (!r.install) return { ok: false, reason: "this install has no public address" };
    if (isHub()) {
      keep(r);
      return { ok: true, hub: true };
    }
    const host = String(supportHost() || "").toLowerCase();
    const agent = host ? network?.list?.().find((a) => a.connected && hostOf(a.url) === host) : null;
    if (!agent) return { ok: false, reason: `not connected to ${host || "a hub"}` };
    const res = await network.post(agent.id, "/api/public/network/clicks", { report: r });
    return { ok: Boolean(res?.ok) };
  }

  /** The page's routes (owner cookie) and the network's (a member's own token, hub only). */
  function routes(api, peerAuth) {
    api.post("/api/clicks", async (c) => {
      if (Number(c.req.header("content-length") || 0) > 256 * 1024) return c.json({ error: "too large" }, 413);
      const body = await c.req.json().catch(() => ({}));
      return c.json(record(body?.rows));
    });
    // Every install sees its own; the hub sees all of them (?install= one of them).
    api.get("/api/clicks", (c) => {
      const hub = isHub();
      if (hub) keep(report());
      const all = hub ? reports() : [{ ...report(), receivedAt: now().toISOString() }];
      return c.json({ hub, enabled: enabled(), ...fleetView(all, { install: hub ? String(c.req.query("install") || "").toLowerCase() : "" }) });
    });
    api.post("/api/public/network/clicks", async (c) => {
      if (!isHub()) return c.json({ error: "not the click-map hub" }, 404);
      const who = peerAuth.authenticate(c.req.header("authorization"));
      if (who.error) return c.json({ error: who.error }, who.status);
      if (!String(who.userId).startsWith("net-")) return c.json({ error: "network members only" }, 403);
      if (Number(c.req.header("content-length") || 0) > 1024 * 1024) return c.json({ error: "too large" }, 413);
      const body = await c.req.json().catch(() => ({}));
      const r = cleanReport(body?.report);
      if (!r) return c.json({ error: "bad report" }, 400);
      // A member reports for itself only: the token it holds was made for its own address.
      if (`net-${agentId(r.install)}`.slice(0, 41) !== who.userId) return c.json({ error: "report for another install" }, 403);
      keep(r, who.label);
      return c.json({ ok: true });
    });
  }

  function start() {
    const tick = () => pushOnce().catch((e) => log.error?.(`[clicks] report: ${e.message}`));
    setTimeout(tick, 120_000).unref?.();
    setInterval(tick, PUSH_MS).unref?.();
  }

  return { record, report, reports, keep, pushOnce, routes, start, isHub };
}

const hostOf = (url) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
};
