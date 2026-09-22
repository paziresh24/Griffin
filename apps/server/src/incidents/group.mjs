// Deterministic grouping of Alertmanager alerts into incidents. No LLM: an alert storm (the same
// alert firing every few minutes, or 36 pods of one namespace) must become one incident, not many
// chats. The key says *what* is broken; members say *where* (pods, instances, certs).

// Not incidents: Watchdog is the pipeline's own heartbeat (checked separately), the log digest is a
// daily report, info/none severities are context.
const IGNORE = new Set(["Watchdog", "InfoInhibitor", "PodLoggedErrors24h"]);
const QUIET_SEVERITIES = new Set(["info", "none"]);

// Alerts where one incident per cluster is right, whatever the namespace/app.
const PER_CLUSTER = new Set([
  "TLSCertExpiringSoon",
  "CertManagerCertExpiringSoon",
  "PublicAppEndpointDown",
  "PublicAdminEndpointDown",
  "MassPublicAppEndpointDown",
  "KubeNodesNotReadyMass",
  "TargetDown",
  "NodeDiskIOSaturation",
  "KubeMemoryOvercommit",
  "KubeCPUOvercommit",
]);

const SEVERITY_RANK = { none: 0, info: 1, warning: 2, critical: 3 };
export const severityRank = (s) => SEVERITY_RANK[s] ?? 1;

export function isIncidentAlert(alert) {
  return !IGNORE.has(alert.alertname) && !QUIET_SEVERITIES.has(alert.severity);
}

export function scopeOf(alert) {
  if (PER_CLUSTER.has(alert.alertname)) return "";
  const l = alert.labels || {};
  return alert.owner || l.bucket || l.app_name || l.persistentvolumeclaim || l.namespace || "";
}

export function incidentKey(alert) {
  return `${alert.cluster}|${alert.alertname}|${scopeOf(alert)}`;
}

export function memberOf(alert) {
  const l = alert.labels || {};
  return l.instance || l.pod || l.persistentvolumeclaim || l.deployment || l.statefulset || l.service || l.bucket || l.namespace || alert.fingerprint || "-";
}

// alerts → Map(key → { key, cluster, alertname, severity, scope, owner, summary, members[], seenFrom[], startsAt })
export function groupAlerts(alerts) {
  const groups = new Map();
  for (const alert of alerts) {
    if (!isIncidentAlert(alert)) continue;
    const key = incidentKey(alert);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        cluster: alert.cluster,
        alertname: alert.alertname,
        severity: alert.severity,
        scope: scopeOf(alert),
        owner: alert.owner || null,
        summary: alert.summary || "",
        members: [],
        seenFrom: [],
        startsAt: alert.startsAt,
      };
      groups.set(key, g);
    }
    if (severityRank(alert.severity) > severityRank(g.severity)) g.severity = alert.severity;
    if (!g.owner && alert.owner) g.owner = alert.owner;
    if (alert.startsAt && (!g.startsAt || alert.startsAt < g.startsAt)) g.startsAt = alert.startsAt;
    const member = memberOf(alert);
    if (!g.members.includes(member)) g.members.push(member);
    if (!g.seenFrom.includes(alert.seenFrom)) g.seenFrom.push(alert.seenFrom);
  }
  return groups;
}
