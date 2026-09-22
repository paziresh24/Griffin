import { K8S_NAME, ToolInputError } from "./kube.mjs";
import { createMetrics, niceDomain, stats, summarizeQuery } from "./metrics.mjs";
import { createMikrotikTools } from "./mikrotik.mjs";
import { createS3Tools } from "./s3.mjs";
import { createGrafanaTools } from "./grafana.mjs";
import { createInfisicalTools } from "./infisical.mjs";
import { createGitlabTools } from "./gitlab.mjs";
import { createPgTools } from "./pg.mjs";
import { createArvanTools } from "./arvan.mjs";
import { createNetTools } from "./netcheck.mjs";
import { createNsinTools } from "./nsin.mjs";
import { createAlertTools } from "./alerts.mjs";
import { EMPTY_SITE } from "./site.mjs";

// Read-only kinds the agent may list. No secrets, no configmaps.
const KINDS = {
  pods: { group: "api/v1", namespaced: true },
  nodes: { group: "api/v1", namespaced: false },
  events: { group: "api/v1", namespaced: true },
  persistentvolumeclaims: { group: "api/v1", namespaced: true },
  persistentvolumes: { group: "api/v1", namespaced: false },
  services: { group: "api/v1", namespaced: true },
  deployments: { group: "apis/apps/v1", namespaced: true },
  statefulsets: { group: "apis/apps/v1", namespaced: true },
  daemonsets: { group: "apis/apps/v1", namespaced: true },
  jobs: { group: "apis/batch/v1", namespaced: true },
  cronjobs: { group: "apis/batch/v1", namespaced: true },
  ingresses: { group: "apis/networking.k8s.io/v1", namespaced: true },
  "clusters.postgresql.cnpg.io": { group: "apis/postgresql.cnpg.io/v1", plural: "clusters", namespaced: true },
};

const DF_PATH = /^\/[A-Za-z0-9_./-]{0,200}$/;
// Shell hosts for debug_exec, from the site config: { "<name>": { host, port, user } }.
const DEBUG_HOSTS = {};

const k8sName = (description) => ({ type: "string", pattern: K8S_NAME.source, description });

export function createTools({
  kube,
  vault,
  sshRun,
  site = EMPTY_SITE,
  fetchImpl = fetch,
  debugHosts = site.debugHosts || DEBUG_HOSTS,
  metrics = createMetrics({ kube }),
  mikrotik = null,
  s3 = createS3Tools({ kube, config: site.s3 || null, fetchImpl }),
  pg = createPgTools({ kube }),
  grafana = createGrafanaTools({ kube, grafanas: grafanasOf(site), fetchImpl }),
  infisical = createInfisicalTools({ vault, fetchImpl }),
  gitlab = createGitlabTools({ vault, fetchImpl, host: site.gitlab?.url || "" }),
  arvan = createArvanTools({ vault, fetchImpl }),
  net = createNetTools({}),
  nsin = createNsinTools({ vault, fetchImpl }),
  alerts = createAlertTools({ kube, clusters: alertClustersOf(site) }),
}) {
  // Cluster names are whatever the site config declares; nothing is baked into the code.
  const clusterNames = Object.keys(site.clusters || {});
  const cluster = { type: "string", ...(clusterNames.length ? { enum: clusterNames } : {}), description: "cluster name from the site config" };
  const requireCluster = (args) => {
    const name = String(args?.cluster || "");
    if (!clusterNames.includes(name)) throw new ToolInputError(`cluster must be one of ${clusterNames.join(", ") || "(none configured)"}`);
    return name;
  };

  const tools = {
    metrics_query: {
      description:
        "PromQL against the cluster's own Prometheus (range or instant). Returns statistics only: overall min/max/avg, a suggested y-axis domain, and the top series by peak (min/max/avg/last each). Use it to understand data before answering or before calling visualize. Memory/CPU per workload: container_memory_working_set_bytes / container_cpu_usage_seconds_total with namespace, pod=~\"<deployment>-.*\", container!=\"\", container!=\"POD\"; sum over pods for a workload total.",
      inputSchema: {
        type: "object",
        properties: {
          cluster,
          promql: { type: "string", minLength: 1, maxLength: 4000 },
          range: { type: "string", pattern: "^\\d{1,5}(s|m|h|d)$", description: "look-back window, e.g. 1h, 24h, 7d (max 30d; default 1h)" },
          step: { type: "string", pattern: "^\\d{1,5}(s|m|h|d)$", description: "resolution; omit for ~300 points" },
          instant: { type: "boolean", description: "single current value per series instead of a range" },
          maxSeries: { type: "integer", minimum: 1, maximum: 50, description: "series listed in the answer (default 20)" },
        },
        required: ["cluster", "promql"],
        additionalProperties: false,
      },
      async execute(args) {
        const cluster = requireCluster(args);
        const result = await metrics.query({ cluster, promql: args.promql, range: args.range, step: args.step, instant: Boolean(args.instant) });
        return { cluster, promql: args.promql, ...summarizeQuery(result, { maxSeries: Number(args.maxSeries) || 20 }) };
      },
    },

    gitlab_version: {
      description: "Current version of the configured GitLab (live).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const host = String(site.gitlab?.url || "").replace(/\/+$/, "");
        if (!host) throw new ToolInputError("no GitLab configured — set gitlab.url in the site config");
        const response = await fetchImpl(`${host}/api/v4/version`, {
          headers: { "PRIVATE-TOKEN": await vault.item("gitlab__token"), Accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`GitLab http_${response.status}`);
        const body = await response.json();
        return { version: String(body.version || ""), revision: String(body.revision || ""), source: `${host} api/v4/version` };
      },
    },

    kube_status: {
      description:
        "Pod counts by phase/namespace for a cluster; with namespace (and optional name prefix) also per-pod details and CNPG clusters. Falls back to the emergency SSH path when the public API is down.",
      inputSchema: {
        type: "object",
        properties: { cluster, namespace: k8sName("namespace (omit for cluster-wide)"), prefix: k8sName("pod name prefix") },
        required: ["cluster"],
        additionalProperties: false,
      },
      async execute(args) {
        const name = requireCluster(args);
        const namespace = optionalName(args.namespace, "namespace");
        const prefix = optionalName(args.prefix, "prefix");
        const podPath = namespace ? `/api/v1/namespaces/${namespace}/pods` : "/api/v1/pods";
        const cnpgPath = `/apis/postgresql.cnpg.io/v1/namespaces/${namespace}/clusters`;
        const result = await kube.withFallback(name, {
          viaApi: async () => {
            const pods = (await kube.publicRequest(name, podPath)).body;
            const cnpg = namespace ? (await kube.publicRequest(name, cnpgPath)).body || { items: [] } : { items: [] };
            return { pods, cnpg };
          },
          viaSsh: async () => {
            const pods = JSON.parse(await kube.emergency(name, ["get", "pods", ...(namespace ? ["-n", namespace] : ["-A"]), "-o", "json"]));
            let cnpg = { items: [] };
            if (namespace) {
              cnpg = JSON.parse(
                await kube.emergency(name, ["get", "clusters.postgresql.cnpg.io", "-n", namespace, "-o", "json"]).catch(() => '{"items":[]}'),
              );
            }
            return { pods, cnpg };
          },
        });
        const match = (item) => !prefix || String(item.metadata?.name || "").startsWith(prefix);
        const pods = (result.value.pods?.items || []).filter(match);
        return {
          cluster: name,
          scope: namespace ? "namespace" : "cluster",
          namespace: namespace || null,
          prefix: prefix || null,
          counts: countPods(pods),
          pods: namespace || prefix ? pods.map(summarizePod) : unhealthyPods(pods),
          cnpg: (result.value.cnpg?.items || []).filter(match).map(summarizeCnpg),
          source: result.source,
          attempts: result.attempts,
        };
      },
    },

    kube_get: {
      description:
        "Read-only list/get of one Kubernetes kind (pods, nodes, events, pvc, pv, services, deployments, statefulsets, daemonsets, jobs, cronjobs, ingresses, CNPG clusters), summarized. Falls back to emergency SSH.",
      inputSchema: {
        type: "object",
        properties: {
          cluster,
          kind: { type: "string", enum: Object.keys(KINDS) },
          namespace: k8sName("namespace (omit for all namespaces)"),
          name: k8sName("object name"),
          limit: { type: "integer", minimum: 1, maximum: 300, description: "max items (default 100)" },
        },
        required: ["cluster", "kind"],
        additionalProperties: false,
      },
      async execute(args) {
        const name = requireCluster(args);
        const spec = KINDS[args.kind];
        if (!spec) throw new ToolInputError(`kind must be one of ${Object.keys(KINDS).join(", ")}`);
        const namespace = spec.namespaced ? optionalName(args.namespace, "namespace") : "";
        const objectName = optionalName(args.name, "name");
        const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 300);
        const plural = spec.plural || args.kind;
        const apiPath = `/${spec.group}${namespace ? `/namespaces/${namespace}` : ""}/${plural}${objectName ? `/${objectName}` : ""}`;
        const kubectlArgs = ["get", args.kind, ...(objectName ? [objectName] : []), ...(namespace ? ["-n", namespace] : spec.namespaced ? ["-A"] : []), "-o", "json"];
        const result = await kube.withFallback(name, {
          viaApi: async () => {
            const response = await kube.publicRequest(name, apiPath);
            if (response.notFound) return { notFound: true };
            return response.body;
          },
          viaSsh: async () => JSON.parse(await kube.emergency(name, kubectlArgs)),
        });
        if (result.value?.notFound) return { cluster: name, kind: args.kind, found: false, source: result.source };
        let items = result.value.items ? result.value.items : [result.value];
        if (args.kind === "events") items = items.sort((a, b) => eventTime(b).localeCompare(eventTime(a)));
        return {
          cluster: name,
          kind: args.kind,
          namespace: namespace || null,
          total: items.length,
          items: items.slice(0, limit).map((item) => summarize(args.kind, item)),
          truncated: items.length > limit,
          source: result.source,
          attempts: result.attempts,
        };
      },
    },

    kube_logs: {
      description: "Tail of a pod's logs (max 500 lines). Falls back to emergency SSH.",
      inputSchema: {
        type: "object",
        properties: {
          cluster,
          namespace: k8sName("namespace"),
          pod: k8sName("pod"),
          container: k8sName("container"),
          tailLines: { type: "integer", minimum: 1, maximum: 500 },
          previous: { type: "boolean", description: "logs of the previous (crashed) container" },
        },
        required: ["cluster", "namespace", "pod"],
        additionalProperties: false,
      },
      async execute(args) {
        const name = requireCluster(args);
        const namespace = requiredName(args.namespace, "namespace");
        const pod = requiredName(args.pod, "pod");
        const container = optionalName(args.container, "container");
        const tail = Math.min(Math.max(Number(args.tailLines) || 200, 1), 500);
        const previous = args.previous === true;
        const query = new URLSearchParams({ tailLines: String(tail), ...(container ? { container } : {}), ...(previous ? { previous: "true" } : {}) });
        const result = await kube.withFallback(name, {
          viaApi: async () => {
            const response = await kube.publicRequest(name, `/api/v1/namespaces/${namespace}/pods/${pod}/log?${query}`, { accept: "*/*" }); // "text/plain" gets 406 from the apiserver
            if (response.notFound) throw new Error("pod not found");
            return response.body;
          },
          viaSsh: () =>
            kube.emergency(name, ["logs", "-n", namespace, pod, `--tail=${tail}`, ...(container ? ["-c", container] : []), ...(previous ? ["--previous"] : [])]),
        });
        return { cluster: name, namespace, pod, container: container || null, previous, logs: result.value, source: result.source, attempts: result.attempts };
      },
    },

    kube_df: {
      description:
        "Filesystem usage (df -h) inside a pod via emergency SSH (kubectl exec). There is no public-api path for this tool — do not report API failure. Give the pod and, when the pod has several volumes, the mount path.",
      inputSchema: {
        type: "object",
        properties: { cluster, namespace: k8sName("namespace"), pod: k8sName("pod"), container: k8sName("container"), path: { type: "string", pattern: DF_PATH.source } },
        required: ["cluster", "namespace", "pod"],
        additionalProperties: false,
      },
      async execute(args) {
        const name = requireCluster(args);
        const namespace = requiredName(args.namespace, "namespace");
        const pod = requiredName(args.pod, "pod");
        const container = optionalName(args.container, "container");
        if (args.path !== undefined && !DF_PATH.test(String(args.path))) throw new ToolInputError("invalid path");
        const result = await kube.withFallback(name, {
          viaSsh: () =>
            kube.emergency(name, ["exec", "-n", namespace, pod, ...(container ? ["-c", container] : []), "--", "df", "-h", ...(args.path ? [args.path] : [])]),
        });
        return { cluster: name, namespace, pod, path: args.path || null, df: parseDf(result.value), raw: result.value, source: result.source, attempts: result.attempts };
      },
    },

    kube_secret: {
      description:
        "Read a Kubernetes Secret's keys (values base64-decoded) from a namespace. Use it to check or fetch a credential instead of poking at the debug host. Prefer copying the value into Infisical (infisical_upsert) over sending it in chat.",
      inputSchema: {
        type: "object",
        properties: {
          cluster,
          namespace: k8sName("namespace"),
          name: k8sName("secret name"),
          key: { type: "string", description: "one key to return; omit to list all keys with values" },
        },
        required: ["cluster", "namespace", "name"],
        additionalProperties: false,
      },
      async execute(args) {
        const cluster = requireCluster(args);
        const namespace = requiredName(args.namespace, "namespace");
        const name = requiredName(args.name, "secret name");
        const key = args.key === undefined ? null : String(args.key);
        if (key !== null && !/^[A-Za-z0-9_.-]{1,253}$/.test(key)) throw new ToolInputError("invalid key");
        const result = await kube.withFallback(cluster, {
          viaApi: async () => (await kube.publicRequest(cluster, `/api/v1/namespaces/${namespace}/secrets/${name}`)).body,
          viaSsh: async () => JSON.parse(await kube.emergency(cluster, ["get", "secret", name, "-n", namespace, "-o", "json"])),
        });
        const raw = result.value?.data || {};
        const decode = (value) => Buffer.from(String(value), "base64").toString("utf8");
        const data = key !== null
          ? (key in raw ? { [key]: decode(raw[key]) } : (() => { throw new ToolInputError(`secret ${namespace}/${name} has no key "${key}" (keys: ${Object.keys(raw).join(", ")})`); })())
          : Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decode(v)]));
        return { cluster, namespace, name, type: result.value?.type || null, data, source: result.source, attempts: result.attempts };
      },
    },

    kube_copy_secret: {
      description:
        "Copy a Secret between clusters (or to another name) without exposing its values — e.g. a DR replica that needs the primary cluster's <db>-ca, <db>-replication and <db>-app. Same namespace on both sides; refuses to overwrite an existing target unless replace=true. Returns only key names.",
      inputSchema: {
        type: "object",
        properties: {
          fromCluster: cluster,
          toCluster: cluster,
          namespace: k8sName("namespace (same on both clusters)"),
          name: k8sName("source secret name"),
          targetName: k8sName("target secret name (default: same)"),
          replace: { type: "boolean", description: "overwrite an existing target secret" },
          rewriteHost: {
            type: "object",
            description: "replace one hostname token in every value (e.g. a DR app secret: baft-db-rw → baft-db-primary-rw)",
            properties: { from: { type: "string", pattern: K8S_NAME.source }, to: { type: "string", pattern: K8S_NAME.source } },
            required: ["from", "to"],
            additionalProperties: false,
          },
        },
        required: ["fromCluster", "toCluster", "namespace", "name"],
        additionalProperties: false,
      },
      async execute(args) {
        const from = requireCluster({ cluster: args.fromCluster });
        const to = requireCluster({ cluster: args.toCluster });
        const namespace = requiredName(args.namespace, "namespace");
        const name = requiredName(args.name, "secret name");
        const targetName = args.targetName ? requiredName(args.targetName, "target secret name") : name;
        if (from === to && targetName === name) throw new ToolInputError("source and target are the same secret");
        const source = (await kube.publicRequest(from, `/api/v1/namespaces/${namespace}/secrets/${name}`)).body;
        if (!source || source.notFound || !source.data) throw new ToolInputError(`secret ${namespace}/${name} not found on ${from}`);
        let data = source.data;
        let rewritten = [];
        if (args.rewriteHost) {
          const from = String(args.rewriteHost.from);
          const toHost = String(args.rewriteHost.to);
          const token = new RegExp(`(^|[^A-Za-z0-9-])${from.replace(/[.]/g, "\\.")}(?=$|[^A-Za-z0-9-])`, "g");
          data = Object.fromEntries(
            Object.entries(source.data).map(([k, v]) => {
              const text = Buffer.from(String(v), "base64").toString("utf8");
              const next = text.replace(token, (m, pre) => `${pre}${toHost}`);
              if (next !== text) rewritten.push(k);
              return [k, Buffer.from(next, "utf8").toString("base64")];
            }),
          );
          if (!rewritten.length) throw new ToolInputError(`host "${from}" does not appear in ${namespace}/${name}`);
        }
        const existing = await kube.publicRequest(to, `/api/v1/namespaces/${namespace}/secrets/${targetName}`);
        const manifest = {
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name: targetName,
            namespace,
            labels: { "app.kubernetes.io/managed-by": "griffin-copy-secret" },
            annotations: { "griffin/copied-from": `${from}/${namespace}/${name}`, "griffin/copied-at": new Date().toISOString() },
          },
          type: source.type || "Opaque",
          data,
        };
        if (rewritten.length) manifest.metadata.annotations["griffin/rewrite-host"] = `${args.rewriteHost.from}->${args.rewriteHost.to}`;
        let action;
        if (existing.notFound) {
          await kube.publicWrite(to, `/api/v1/namespaces/${namespace}/secrets`, { method: "POST", body: manifest });
          action = "created";
        } else {
          if (!args.replace) throw new ToolInputError(`secret ${namespace}/${targetName} already exists on ${to} (pass replace=true to overwrite)`);
          manifest.metadata.resourceVersion = existing.body?.metadata?.resourceVersion;
          await kube.publicWrite(to, `/api/v1/namespaces/${namespace}/secrets/${targetName}`, { method: "PUT", body: manifest });
          action = "replaced";
        }
        return { action, from: `${from}/${namespace}/${name}`, to: `${to}/${namespace}/${targetName}`, type: manifest.type, keys: Object.keys(source.data), rewritten, source: "public-api" };
      },
    },

    cnpg_retry_bootstrap: {
      description:
        "Let CloudNativePG retry a failed bootstrap (initdb / pg_basebackup / recovery) of one Cluster by deleting its FAILED bootstrap Jobs (label cnpg.io/cluster=<name>). Never touches pods of running instances, PVCs or the Cluster itself. Use after fixing the cause (e.g. a missing replication secret).",
      inputSchema: {
        type: "object",
        properties: { cluster, namespace: k8sName("namespace"), name: k8sName("CNPG Cluster name") },
        required: ["cluster", "namespace", "name"],
        additionalProperties: false,
      },
      async execute(args) {
        const clusterName = requireCluster(args);
        const namespace = requiredName(args.namespace, "namespace");
        const name = requiredName(args.name, "CNPG Cluster name");
        const selector = encodeURIComponent(`cnpg.io/cluster=${name}`);
        const list = (await kube.publicRequest(clusterName, `/apis/batch/v1/namespaces/${namespace}/jobs?labelSelector=${selector}`)).body;
        const jobs = (list?.items || []).filter((j) => (j.status?.failed || 0) > 0 && !(j.status?.succeeded > 0) && !(j.status?.active > 0));
        const deleted = [];
        for (const job of jobs) {
          await kube.publicWrite(clusterName, `/apis/batch/v1/namespaces/${namespace}/jobs/${job.metadata.name}`, {
            method: "DELETE",
            body: { kind: "DeleteOptions", apiVersion: "v1", propagationPolicy: "Background" },
          });
          deleted.push(job.metadata.name);
        }
        return { cluster: clusterName, namespace, name, deletedJobs: deleted, note: deleted.length ? "operator will recreate the bootstrap job" : "no failed bootstrap job found", source: "public-api" };
      },
    },

    debug_exec: {
      description: "Run one shell command on a configured shell host as root. Read-only diagnostics unless the owner approved a change.",
      inputSchema: {
        type: "object",
        properties: {
          host: { type: "string", enum: Object.keys(debugHosts) },
          command: { type: "string", minLength: 1, maxLength: 4000 },
        },
        required: ["command"],
        additionalProperties: false,
      },
      async execute(args) {
        const name = args.host || Object.keys(debugHosts)[0];
        const target = debugHosts[name];
        if (!target) throw new ToolInputError(`unknown host (configured: ${Object.keys(debugHosts).join(", ") || "none"})`);
        const command = String(args.command || "").trim();
        if (!command || command.length > 4000 || /[\0\r\n]/.test(command)) throw new ToolInputError("invalid command");
        const { stdout, stderr } = await sshRun(target, command, { timeoutMs: 120_000 });
        return { host: name, stdout, stderr, source: `ssh ${target.host}` };
      },
    },
  };
  Object.defineProperty(tools, "metricsData", {
    enumerable: false,
    // scale converts to display units (e.g. 1/1073741824 for GiB) before the axis is chosen.
    value: async (args) => {
      const result = await metrics.query({ ...args, cluster: requireCluster(args) });
      const scale = Number.isFinite(Number(args.scale)) && Number(args.scale) !== 0 ? Number(args.scale) : 1;
      const series = result.series.map((item) => ({ ...item, points: item.points.map(([t, v]) => [t, v * scale]) }));
      const overall = stats(series.flatMap((item) => item.points.map(([, v]) => v)));
      return { ...result, series, scale, overall, domain: niceDomain(overall.min, overall.max) };
    },
  });
  // Router credentials come from the vault or the secret manager, per the site config.
  const mikrotikTools =
    mikrotik ||
    createMikrotikTools({
      vault,
      routers: site.routers || {},
      readSecret: async (args) => (await infisical.infisical_get.execute(args)).value,
    });
  Object.assign(tools, mikrotikTools, s3, pg, grafana, infisical, gitlab, arvan, net, nsin, alerts);
  return keepConfigured(tools, site);
}

// A tool nobody configured is worse than a missing one: the agent sees it, calls it, and gets an
// error it cannot fix. So each pack is published only when this site has what it needs. Override
// with "tools": { "<pack>": true|false } in the site config.
export const TOOL_PACKS = {
  kubernetes: { prefixes: ["kube_", "metrics_", "cnpg_"], needs: (site) => hasAny(site.clusters) },
  alerts: { prefixes: ["alerts_"], needs: (site) => hasAny(site.clusters) },
  grafana: { prefixes: ["grafana_"], needs: (site) => Object.values(site.clusters || {}).some((c) => c?.grafana) },
  postgres: { prefixes: ["pg_"], needs: (site) => hasAny(site.clusters) },
  s3: { prefixes: ["s3_"], needs: (site) => Boolean(site.s3?.endpoint) },
  gitlab: { prefixes: ["gitlab_"], needs: (site) => Boolean(site.gitlab?.url) },
  mikrotik: { prefixes: ["mikrotik_"], needs: (site) => hasAny(site.routers) },
  shell: { prefixes: ["debug_exec"], needs: (site) => hasAny(site.debugHosts) },
  // These only need a credential in the vault, which the broker cannot see from here: opt in.
  infisical: { prefixes: ["infisical_"], needs: () => false },
  arvan: { prefixes: ["arvan_"], needs: () => false },
  nsin: { prefixes: ["nsin_"], needs: () => false },
  // No credentials at all — always available.
  net: { prefixes: ["dns_lookup", "http_check", "tls_check"], needs: () => true },
};

const hasAny = (obj) => Boolean(obj && Object.keys(obj).length);

export function enabledPacks(site = {}) {
  const wanted = site.tools && typeof site.tools === "object" ? site.tools : {};
  const out = {};
  for (const [name, pack] of Object.entries(TOOL_PACKS)) {
    out[name] = wanted[name] === undefined ? pack.needs(site) : Boolean(wanted[name]);
  }
  return out;
}

function keepConfigured(tools, site) {
  const packs = enabledPacks(site);
  const off = Object.entries(packs)
    .filter(([, on]) => !on)
    .flatMap(([name]) => TOOL_PACKS[name].prefixes);
  const kept = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!off.some((prefix) => name.startsWith(prefix))) kept[name] = tool;
  }
  // metricsData is not an agent tool; carry it across the filter.
  const raw = Object.getOwnPropertyDescriptor(tools, "metricsData");
  if (raw) Object.defineProperty(kept, "metricsData", raw);
  return kept;
}

// Grafana urls and alert-capable clusters are both derived from the cluster entries.
function grafanasOf(site) {
  const out = {};
  for (const [name, config] of Object.entries(site.clusters || {})) if (config?.grafana) out[name] = { url: config.grafana };
  return out;
}

function alertClustersOf(site) {
  return Object.entries(site.clusters || {}).filter(([, config]) => config?.alerts !== false).map(([name]) => name);
}

function optionalName(value, label) {
  if (value === undefined || value === null || value === "") return "";
  if (!K8S_NAME.test(String(value)) || String(value).length > 253) throw new ToolInputError(`invalid ${label}`);
  return String(value);
}

function requiredName(value, label) {
  const name = optionalName(value, label);
  if (!name) throw new ToolInputError(`${label} required`);
  return name;
}

function countPods(pods) {
  const byPhase = {};
  const byNamespace = {};
  for (const pod of pods) {
    const phase = String(pod.status?.phase || "Unknown");
    byPhase[phase] = (byPhase[phase] || 0) + 1;
    const ns = pod.metadata?.namespace;
    if (ns) byNamespace[ns] = (byNamespace[ns] || 0) + 1;
  }
  return { total: pods.length, by_phase: byPhase, by_namespace: byNamespace };
}

function summarizePod(pod) {
  const statuses = pod.status?.containerStatuses || [];
  const waiting = statuses.map((s) => s.state?.waiting?.reason).filter(Boolean);
  return {
    name: pod.metadata?.name || "",
    namespace: pod.metadata?.namespace || "",
    phase: pod.status?.phase || "",
    reason: waiting[0] || pod.status?.reason || null,
    node: pod.spec?.nodeName || "",
    ready: `${statuses.filter((s) => s.ready).length}/${statuses.length}`,
    restarts: statuses.reduce((sum, s) => sum + Number(s.restartCount || 0), 0),
    created_at: pod.metadata?.creationTimestamp || "",
  };
}

// Cluster-wide view lists only pods that need attention, so the answer stays small.
function unhealthyPods(pods) {
  return pods
    .map(summarizePod)
    .filter((pod) => {
      const [ready, total] = pod.ready.split("/");
      const notReady = pod.phase === "Running" && ready !== total;
      return !["Running", "Succeeded"].includes(pod.phase) || Boolean(pod.reason) || notReady;
    })
    .slice(0, 100);
}

function summarizeCnpg(item) {
  return {
    name: item.metadata?.name || "",
    instances: item.status?.instances ?? null,
    ready_instances: item.status?.readyInstances ?? null,
    phase: item.status?.phase || "",
    current_primary: item.status?.currentPrimary || "",
  };
}

function eventTime(event) {
  return String(event.lastTimestamp || event.eventTime || event.metadata?.creationTimestamp || "");
}

function condition(item, type) {
  return (item.status?.conditions || []).find((c) => c.type === type)?.status || null;
}

export function summarize(kind, item) {
  const meta = { name: item.metadata?.name || "", ...(item.metadata?.namespace ? { namespace: item.metadata.namespace } : {}) };
  const s = item.status || {};
  const spec = item.spec || {};
  switch (kind) {
    case "pods":
      return summarizePod(item);
    case "nodes":
      return {
        ...meta,
        ready: condition(item, "Ready"),
        pressure: ["MemoryPressure", "DiskPressure", "PIDPressure"].filter((type) => condition(item, type) === "True"),
        unschedulable: Boolean(spec.unschedulable),
        roles: Object.keys(item.metadata?.labels || {}).filter((l) => l.startsWith("node-role.kubernetes.io/")).map((l) => l.split("/")[1]),
        kubelet: s.nodeInfo?.kubeletVersion || null,
        capacity: s.capacity ? { cpu: s.capacity.cpu, memory: s.capacity.memory, pods: s.capacity.pods } : null,
        allocatable: s.allocatable ? { cpu: s.allocatable.cpu, memory: s.allocatable.memory } : null,
      };
    case "events":
      return {
        type: item.type,
        reason: item.reason,
        object: `${item.involvedObject?.kind || ""}/${item.involvedObject?.name || ""}`,
        namespace: item.metadata?.namespace,
        message: String(item.message || "").slice(0, 500),
        count: item.count ?? null,
        last: eventTime(item),
      };
    case "persistentvolumeclaims":
      return { ...meta, phase: s.phase, capacity: s.capacity?.storage || null, requested: spec.resources?.requests?.storage || null, storageClass: spec.storageClassName || null, volume: spec.volumeName || null };
    case "persistentvolumes":
      return { ...meta, phase: s.phase, capacity: spec.capacity?.storage || null, claim: spec.claimRef ? `${spec.claimRef.namespace}/${spec.claimRef.name}` : null, storageClass: spec.storageClassName || null, reclaim: spec.persistentVolumeReclaimPolicy };
    case "services":
      return { ...meta, type: spec.type, clusterIP: spec.clusterIP, ports: (spec.ports || []).map((p) => `${p.port}/${p.protocol}`), externalIPs: (s.loadBalancer?.ingress || []).map((i) => i.ip || i.hostname) };
    case "deployments":
    case "statefulsets":
      return { ...meta, replicas: spec.replicas ?? null, ready: s.readyReplicas ?? 0, updated: s.updatedReplicas ?? 0, images: (spec.template?.spec?.containers || []).map((c) => c.image) };
    case "daemonsets":
      return { ...meta, desired: s.desiredNumberScheduled, ready: s.numberReady, unavailable: s.numberUnavailable ?? 0 };
    case "jobs":
      return { ...meta, active: s.active ?? 0, succeeded: s.succeeded ?? 0, failed: s.failed ?? 0, completed: s.completionTime || null };
    case "cronjobs":
      return { ...meta, schedule: spec.schedule, suspend: Boolean(spec.suspend), lastSchedule: s.lastScheduleTime || null, lastSuccess: s.lastSuccessfulTime || null };
    case "ingresses":
      return { ...meta, hosts: (spec.rules || []).map((r) => r.host).filter(Boolean), className: spec.ingressClassName || null };
    case "clusters.postgresql.cnpg.io":
      return summarizeCnpg(item);
    default:
      return meta;
  }
}

export function parseDf(text) {
  const lines = [];
  // df (busybox too) wraps a long filesystem name onto its own line; join it with the next.
  for (const line of String(text || "").trim().split("\n").slice(1)) {
    const previous = lines.at(-1);
    if (previous !== undefined && previous.trim().split(/\s+/).length === 1) lines[lines.length - 1] = `${previous} ${line.trim()}`;
    else lines.push(line);
  }
  return lines.map((line) => {
    const [filesystem, size, used, available, usePercent, ...mount] = line.trim().split(/\s+/);
    return { filesystem, size, used, available, usePercent, mount: mount.join(" ") };
  }).filter((row) => row.mount);
}
