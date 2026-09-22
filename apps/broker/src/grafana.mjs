import { ToolInputError } from "./kube.mjs";

// Grafana on each cluster (kube-prometheus-stack). The broker uses the Grafana service-account
// token that grafana-mcp already has (monitoring/grafana-mcp-credentials, key "token") and talks to the
// public Grafana host. If that host is unreachable, the same HTTP call runs inside the Grafana pod over
// the emergency SSH path. Dashboard panel queries are sent back to Grafana (/api/ds/query), so Grafana
// expands its own macros ($__timeFrom, $__timeFilter, …) exactly as the dashboard does.

export const DEFAULT_GRAFANA = {
  // Filled from the site config: { "<cluster>": { "url": "https://grafana.example.com" } }.
  // A cluster entry's "grafana" key in the site config becomes one of these.
};

const SECRET = { namespace: "monitoring", name: "grafana-mcp-credentials", key: "token" };
const UID = /^[A-Za-z0-9_-]{1,64}$/;
const TIME = /^(now([+-]\d+[smhdwMy])?(\/[smhdwMy])?|\d{10,13}|\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?)$/;
const MAX_ROWS = 500;

export function createGrafanaTools({ kube, grafanas = DEFAULT_GRAFANA, fetchImpl = fetch }) {
  const tokens = new Map(); // cluster -> { at, token }

  function clusterOf(args) {
    const known = Object.keys(grafanas);
    if (!known.length) throw new ToolInputError("no Grafana configured — give a cluster a \"grafana\" url in the site config");
    const cluster = String(args?.cluster || known[0]);
    if (!grafanas[cluster]) throw new ToolInputError(`cluster must be one of ${known.join(", ")}`);
    return cluster;
  }

  async function token(cluster) {
    const hit = tokens.get(cluster);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.token;
    const { namespace, name, key } = SECRET;
    const result = await kube.withFallback(cluster, {
      viaApi: async () => (await kube.publicRequest(cluster, `/api/v1/namespaces/${namespace}/secrets/${name}`)).body,
      viaSsh: async () => JSON.parse(await kube.emergency(cluster, ["get", "secret", name, "-n", namespace, "-o", "json"])),
    });
    const value = result.value?.data?.[key];
    if (!value) throw new Error(`no Grafana service-account token in ${cluster} ${namespace}/${name}`);
    const t = Buffer.from(value, "base64").toString().trim();
    tokens.set(cluster, { at: Date.now(), token: t });
    return t;
  }

  // One Grafana API call; public host first, then curl inside the Grafana pod over emergency SSH.
  async function call(cluster, method, path, body) {
    const t = await token(cluster);
    const attempts = [];
    const url = grafanas[cluster].url + path;
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${t}`, Accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      if (response.status >= 300 && response.status < 400) throw new Error(`redirect http_${response.status} (auth gateway)`);
      const json = parseJson(text);
      if (!response.ok) {
        // A Grafana answer (bad query, unknown uid) is final; do not retry it on another path.
        const error = new Error(`Grafana http_${response.status}: ${json?.message || json?.results ? JSON.stringify(json).slice(0, 600) : text.slice(0, 300)}`);
        error.final = true;
        error.grafana = json;
        throw error;
      }
      return { json, source: `grafana ${new URL(url).host}`, attempts: [...attempts, { path: "public", ok: true }] };
    } catch (error) {
      if (error.final) throw error;
      attempts.push({ path: "public", ok: false, error: error.cause?.code || error.message });
    }
    try {
      const pods = JSON.parse(await kube.emergency(cluster, ["get", "pods", "-n", "monitoring", "-l", "app.kubernetes.io/name=grafana", "-o", "json"]));
      const pod = pods.items?.find((p) => p.status?.phase === "Running")?.metadata?.name;
      if (!pod) throw new Error("no running Grafana pod");
      const payload = Buffer.from(body ? JSON.stringify(body) : "").toString("base64");
      const script = [
        `printf %s '${payload}' | base64 -d |`,
        `curl -sS -X ${method} -H 'Authorization: Bearer ${t}' -H 'Accept: application/json'`,
        body ? "-H 'content-type: application/json' --data-binary @-" : "",
        `'http://127.0.0.1:3000${path.replace(/'/g, "%27")}'`,
      ].join(" ");
      const text = await kube.emergency(cluster, ["exec", "-n", "monitoring", pod, "-c", "grafana", "--", "sh", "-c", script], { timeoutMs: 90_000 });
      const json = parseJson(text);
      if (json === null) throw new Error(`Grafana pod answer was not JSON: ${text.slice(0, 200)}`);
      return { json, source: `emergency-ssh grafana pod ${pod}`, attempts: [...attempts, { path: "emergency-ssh", ok: true }] };
    } catch (error) {
      attempts.push({ path: "emergency-ssh", ok: false, error: error.message });
      const failure = new Error(`Grafana on ${cluster} unreachable`);
      failure.attempts = attempts;
      throw failure;
    }
  }

  function requireUid(value, label = "uid") {
    const uid = String(value || "");
    if (!UID.test(uid)) throw new ToolInputError(`invalid ${label}`);
    return uid;
  }

  function timeArg(value, fallback) {
    const t = String(value ?? fallback);
    if (!TIME.test(t)) throw new ToolInputError(`invalid time "${t}" (use now-24h, now/d, epoch ms, or ISO date)`);
    return t;
  }

  async function dashboard(cluster, uid) {
    const { json, source, attempts } = await call(cluster, "GET", `/api/dashboards/uid/${uid}`);
    return { dashboard: json.dashboard, meta: json.meta, source, attempts };
  }

  async function runQueries(cluster, queries, from, to) {
    const { json, source, attempts } = await call(cluster, "POST", "/api/ds/query", { from, to, queries });
    return { results: summarizeResults(json), source, attempts };
  }

  const cluster = { type: "string", enum: Object.keys(grafanas), description: "which cluster's Grafana (defaults to the first configured one)" };
  const timeProps = {
    from: { type: "string", description: "Grafana time: now-24h, now/d (start of today), epoch ms, ISO date. Default: the dashboard's own range" },
    to: { type: "string", description: "default now" },
  };

  return {
    grafana_search: {
      description:
        "Search Grafana dashboards by title/tag/folder. Returns uid, title, folder.",
      inputSchema: {
        type: "object",
        properties: { cluster, query: { type: "string", maxLength: 200 }, tag: { type: "string", maxLength: 100 }, limit: { type: "integer", minimum: 1, maximum: 500 } },
        additionalProperties: false,
      },
      async execute(args) {
        const c = clusterOf(args);
        const params = new URLSearchParams({ type: "dash-db", limit: String(Math.min(Number(args.limit) || 100, 500)) });
        if (args.query) params.set("query", String(args.query));
        if (args.tag) params.set("tag", String(args.tag));
        const { json, source, attempts } = await call(c, "GET", `/api/search?${params}`);
        return {
          cluster: c,
          dashboards: (json || []).map((d) => ({ uid: d.uid, title: d.title, folder: d.folderTitle || null, tags: d.tags || [], url: grafanas[c].url + d.url })),
          source,
          attempts,
        };
      },
    },

    grafana_dashboard: {
      description:
        "Read a Grafana dashboard: its panels (id, title, type, datasource) with the full query of each target (SQL/PromQL/LogQL), variables and default time range. Use before grafana_panel_query.",
      inputSchema: {
        type: "object",
        properties: { cluster, uid: { type: "string" } },
        required: ["uid"],
        additionalProperties: false,
      },
      async execute(args) {
        const c = clusterOf(args);
        const { dashboard: d, meta, source, attempts } = await dashboard(c, requireUid(args.uid));
        return {
          cluster: c,
          uid: d.uid,
          title: d.title,
          folder: meta?.folderTitle || null,
          url: meta?.url ? grafanas[c].url + meta.url : null,
          timezone: d.timezone || null,
          time: d.time || null,
          variables: (d.templating?.list || []).map((v) => ({ name: v.name, type: v.type, current: v.current?.value ?? null, query: typeof v.query === "string" ? v.query : v.query?.query || null })),
          panels: flattenPanels(d.panels).map((p) => ({
            id: p.id,
            title: p.title || "",
            type: p.type,
            datasource: p.datasource || null,
            unit: p.fieldConfig?.defaults?.unit || null,
            description: p.description || null,
            targets: (p.targets || []).map((t) => ({ refId: t.refId, datasource: t.datasource || null, format: t.format || null, query: t.rawSql || t.expr || t.query || null, hide: t.hide || false })),
          })),
          source,
          attempts,
        };
      },
    },

    grafana_panel_query: {
      description:
        "Run a dashboard panel's own queries through Grafana (same result the panel shows) and return the data: columns and rows (last rows kept for long series) plus the last row. Variables default to the dashboard's current values.",
      inputSchema: {
        type: "object",
        properties: {
          cluster,
          uid: { type: "string" },
          panelId: { type: "integer" },
          ...timeProps,
          variables: { type: "object", additionalProperties: { type: "string" }, description: "override dashboard variables, e.g. {\"center\": \"5532\"}" },
          maxRows: { type: "integer", minimum: 1, maximum: MAX_ROWS },
        },
        required: ["uid", "panelId"],
        additionalProperties: false,
      },
      async execute(args) {
        const c = clusterOf(args);
        const { dashboard: d, source: dashSource } = await dashboard(c, requireUid(args.uid));
        const panel = flattenPanels(d.panels).find((p) => p.id === Number(args.panelId));
        if (!panel) throw new ToolInputError(`panel ${args.panelId} not found in ${d.title}`);
        const vars = Object.fromEntries((d.templating?.list || []).map((v) => [v.name, String(v.current?.value ?? "")]));
        Object.assign(vars, args.variables || {});
        const queries = (panel.targets || []).filter((t) => !t.hide).map((t) => ({
          ...substitute(t, vars),
          datasource: t.datasource?.uid ? t.datasource : panel.datasource,
          maxDataPoints: 2000,
          intervalMs: 60_000,
        }));
        if (!queries.length) throw new ToolInputError(`panel ${panel.id} (${panel.title}) has no queries`);
        const from = timeArg(args.from, d.time?.from || "now-6h");
        const to = timeArg(args.to, d.time?.to || "now");
        const { results, source, attempts } = await runQueries(c, queries, from, to);
        return {
          cluster: c,
          dashboard: d.title,
          panel: { id: panel.id, title: panel.title, type: panel.type, unit: panel.fieldConfig?.defaults?.unit || null },
          range: { from, to },
          results: limitRows(results, args.maxRows),
          source,
          attempts,
          dashboardSource: dashSource,
        };
      },
    },

    grafana_query: {
      description:
        "Run any query on a Grafana datasource by uid (SQL for Postgres/MySQL datasources, PromQL for Prometheus, LogQL for Loki) with Grafana macros available ($__timeFilter(col), $__timeFrom(), $__unixEpochFilter(col), …). List datasources with an empty query and datasourceUid \"list\".",
      inputSchema: {
        type: "object",
        properties: {
          cluster,
          datasourceUid: { type: "string", description: "datasource uid; \"list\" to list the datasources" },
          query: { type: "string", maxLength: 20_000 },
          format: { type: "string", enum: ["table", "time_series"], description: "SQL datasources only (default table)" },
          ...timeProps,
          maxRows: { type: "integer", minimum: 1, maximum: MAX_ROWS },
        },
        required: ["datasourceUid"],
        additionalProperties: false,
      },
      async execute(args) {
        const c = clusterOf(args);
        if (args.datasourceUid === "list") {
          const { json, source, attempts } = await call(c, "GET", "/api/datasources");
          return { cluster: c, datasources: (json || []).map((ds) => ({ uid: ds.uid, name: ds.name, type: ds.type, database: ds.jsonData?.database || ds.database || null, default: Boolean(ds.isDefault) })), source, attempts };
        }
        const uid = requireUid(args.datasourceUid, "datasourceUid");
        const text = String(args.query || "").trim();
        if (!text) throw new ToolInputError("query is required");
        const { json: ds } = await call(c, "GET", `/api/datasources/uid/${uid}`);
        const q = { refId: "A", datasource: { uid, type: ds.type }, maxDataPoints: 2000, intervalMs: 60_000 };
        if (/sql/i.test(ds.type)) Object.assign(q, { rawSql: text, format: args.format || "table", rawQuery: true, editorMode: "code" });
        else Object.assign(q, { expr: text, query: text });
        const from = timeArg(args.from, "now-24h");
        const to = timeArg(args.to, "now");
        const { results, source, attempts } = await runQueries(c, [q], from, to);
        return { cluster: c, datasource: { uid, name: ds.name, type: ds.type }, range: { from, to }, results: limitRows(results, args.maxRows), source, attempts };
      },
    },
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function flattenPanels(panels = []) {
  return panels.flatMap((p) => (Array.isArray(p.panels) && p.panels.length ? [p, ...flattenPanels(p.panels)] : [p]));
}

// $var, ${var}, ${var:csv}, [[var]] in string fields of a target.
export function substitute(target, vars) {
  const replace = (s) =>
    s.replace(/\$\{(\w+)(?::\w+)?\}|\[\[(\w+)\]\]|\$(\w+)/g, (match, a, b, c) => {
      const name = a || b || c;
      if (name.startsWith("__")) return match; // Grafana macros and globals stay for Grafana
      return Object.hasOwn(vars, name) ? vars[name] : match;
    });
  const out = {};
  for (const [key, value] of Object.entries(target)) out[key] = typeof value === "string" ? replace(value) : value;
  return out;
}

// Grafana data frames are columnar; turn them into rows with readable times.
export function summarizeResults(json) {
  const out = [];
  for (const [refId, result] of Object.entries(json?.results || {})) {
    if (result.error) {
      out.push({ refId, error: result.error });
      continue;
    }
    for (const frame of result.frames || []) {
      const fields = frame.schema?.fields || [];
      const values = frame.data?.values || [];
      const length = Math.max(0, ...values.map((v) => v?.length || 0));
      const rows = [];
      for (let i = 0; i < length; i += 1) {
        const row = {};
        fields.forEach((field, j) => {
          const label = field.config?.displayNameFromDS || field.name + (field.labels ? ` ${JSON.stringify(field.labels)}` : "");
          let value = values[j]?.[i] ?? null;
          if (field.type === "time" && typeof value === "number") value = tehran(value);
          row[label] = value;
        });
        rows.push(row);
      }
      out.push({ refId, name: frame.schema?.name || null, columns: fields.map((f) => ({ name: f.name, type: f.type })), rowCount: length, rows, notices: frame.schema?.meta?.notices?.map((n) => n.text) || undefined });
    }
  }
  return out;
}

function limitRows(results, maxRows) {
  const limit = Math.min(Math.max(Number(maxRows) || 200, 1), MAX_ROWS);
  return results.map((r) => (r.rows && r.rows.length > limit
    ? { ...r, rows: r.rows.slice(-limit), truncated: `showing last ${limit} of ${r.rowCount} rows`, lastRow: r.rows.at(-1) }
    : { ...r, lastRow: r.rows?.at(-1) }));
}

function tehran(ms) {
  const date = new Date(ms);
  const local = date.toLocaleString("sv-SE", { timeZone: "Asia/Tehran" }).replace(" ", "T");
  return `${local}+03:30`;
}
