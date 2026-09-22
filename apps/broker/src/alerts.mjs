import { ToolInputError } from "./kube.mjs";

// Active Alertmanager alerts of each cluster, read through the kube API service proxy (same
// public-API-then-emergency-SSH fallback as metrics). Read-only. Griffin's incident intake polls
// this without an LLM; the agent can call it too.
export const ALERTMANAGER_PATH = "/api/v1/namespaces/monitoring/services/kube-prometheus-stack-alertmanager:9093/proxy/api/v2/alerts";
// Clusters whose Alertmanager we poll: every site-config cluster unless it sets "alerts": false.

// Labels that identify *what* is broken; everything else (pod hash, instance ip, …) stays in labels.
const KEEP = ["alertname", "severity", "namespace", "service", "job", "bucket", "persistentvolumeclaim", "app_name", "app_namespace", "owner", "target_cluster", "source_cluster", "instance", "pod", "deployment", "statefulset", "cluster", "node"];

export function normalizeAlert(raw, cluster) {
  const labels = raw.labels || {};
  const kept = {};
  for (const key of KEEP) if (labels[key]) kept[key] = labels[key];
  return {
    fingerprint: raw.fingerprint || null,
    cluster: labels.target_cluster || labels.source_cluster || cluster,
    seenFrom: cluster,
    alertname: labels.alertname || "unknown",
    severity: labels.severity || "none",
    owner: labels.owner || null,
    labels: kept,
    summary: String(raw.annotations?.summary || "").slice(0, 300),
    description: String(raw.annotations?.description || "").slice(0, 600),
    startsAt: raw.startsAt || null,
    state: raw.status?.state || "active",
  };
}

export function createAlertTools({ kube, clusters = [] }) {
  const ALERT_CLUSTERS = clusters;

  async function active(cluster, { silenced = false } = {}) {
    if (!ALERT_CLUSTERS.length) throw new ToolInputError("no clusters configured for alerts");
    if (!ALERT_CLUSTERS.includes(cluster)) throw new ToolInputError(`cluster must be one of ${ALERT_CLUSTERS.join(", ")}`);
    const query = `?active=true&silenced=${silenced}&inhibited=false`;
    const apiPath = `${ALERTMANAGER_PATH}${query}`;
    const result = await kube.withFallback(cluster, {
      viaApi: async () => (await kube.publicRequest(cluster, apiPath)).body,
      viaSsh: async () => JSON.parse(await kube.emergency(cluster, ["get", "--raw", apiPath])),
    });
    const list = Array.isArray(result.value) ? result.value : [];
    return { cluster, source: result.source, alerts: list.map((a) => normalizeAlert(a, cluster)) };
  }

  return {
    alerts_active: {
      description:
        "Active (firing, not silenced/inhibited) Alertmanager alerts of one or all clusters, normalized: alertname, severity, cluster, owner, key labels, summary, startsAt. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          cluster: { type: "string", enum: ALERT_CLUSTERS, description: "omit for all clusters" },
          silenced: { type: "boolean", description: "also include silenced alerts" },
        },
        additionalProperties: false,
      },
      async execute(args = {}) {
        const clusters = args.cluster ? [args.cluster] : ALERT_CLUSTERS;
        const out = { clusters: {}, alerts: [] };
        await Promise.all(
          clusters.map(async (c) => {
            try {
              const r = await active(c, { silenced: Boolean(args.silenced) });
              out.clusters[c] = { ok: true, source: r.source, count: r.alerts.length };
              out.alerts.push(...r.alerts);
            } catch (error) {
              out.clusters[c] = { ok: false, error: String(error.message).slice(0, 300), attempts: error.attempts };
            }
          }),
        );
        return out;
      },
    },
  };
}
