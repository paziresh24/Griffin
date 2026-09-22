// Agent registry: authority is who is calling, not a property of the agent itself.
// Quota is enforced by filterTools (tools not in customTools cannot be called). Prompt text
// only informs; it is not the control.
//
// Each agent lists the tools it owns (`tools`). A caller quota of "*" means all of those —
// never every tool in the broker. A missing agent/caller row throws (no fall-open).
//
// griffin = default shell agent (orchestrator). It reaches specialists via ask_agent.
// platform / arvan-ban / nsin-ban are domain agents, also usable directly when the owner picks them.

export const DEFAULT_AGENT = "griffin";

// Griffin stands in for the owner: it owns their communication surface (messenger account,
// ask_owner, jobs, knowledge). Platform and CDN work go to specialists via ask_agent.
const GRIFFIN_TOOLS = [
  "ask_agent",
  "delegate",
  "subtasks",
  "peer_invite",
  "ask_owner",
  "ask_requester",
  "telegram_dialogs",
  "telegram_read",
  "telegram_send",
  "visualize",
  "show_media",
  "knowledge_write",
  "knowledge_list",
  "jobs_list",
  "jobs_create",
  "jobs_update",
  "jobs_delete",
  "jobs_run",
  "end_agent",
  "incidents_list",
  "incident_update",
  "incident_history",
  "incident_ack",
];

const ARVAN_TOOLS = [
  "arvan_domains",
  "arvan_dns_records",
  "arvan_dns_export",
  "arvan_dns_create",
  "arvan_dnssec",
  "arvan_cache_settings",
  "arvan_purge_tags",
  "arvan_cache_purge",
  "dns_lookup",
  "http_check",
  "tls_check",
  "ask_owner",
  "ask_requester",
  "ask_agent",
  "knowledge_write",
  "knowledge_list",
  "visualize",
  "show_media",
  "end_agent",
];

const NSIN_TOOLS = [
  "nsin_edge_ranges",
  "nsin_domains",
  "nsin_domain",
  "nsin_dns_records",
  "nsin_dns_create",
  "nsin_dns_update",
  "nsin_dns_delete",
  "nsin_ssl_status",
  "nsin_ssl_issue",
  "nsin_check_nameservers",
  "nsin_developer_mode",
  "nsin_cache_stats",
  "nsin_cache_keys",
  "nsin_cache_purge",
  "nsin_cache_purge_path",
  "nsin_rules",
  "nsin_rule_toggle",
  "nsin_analytics_summary",
  "nsin_top_uris",
  "nsin_request_logs",
  "nsin_waf_logs",
  "nsin_analytics_query",
  "nsin_uptime_live",
  "nsin_uptime_incidents",
  "nsin_recommendations",
  "dns_lookup",
  "http_check",
  "tls_check",
  "ask_owner",
  "ask_requester",
  "ask_agent",
  "knowledge_write",
  "knowledge_list",
  "visualize",
  "show_media",
  "end_agent",
];

/** Broad platform quota for Griffin (and similar owner-facing orchestrators) calling Platform-Ban. */
const GRIFFIN_ON_PLATFORM = [
  "kube_status",
  "kube_get",
  "kube_logs",
  "kube_df",
  "kube_secret",
  "kube_copy_secret",
  "cnpg_retry_bootstrap",
  "metrics_query",
  "grafana_search",
  "grafana_dashboard",
  "grafana_panel_query",
  "grafana_query",
  "gitlab_version",
  "gitlab_projects",
  "gitlab_search",
  "gitlab_file",
  "gitlab_mr",
  "gitlab_propose",
  "gitlab_pipeline",
  "gitlab_commits",
  "infisical_projects",
  "infisical_list",
  "infisical_get",
  "infisical_upsert",
  "infisical_create_project",
  "infisical_access",
  "pg_query",
  "s3_list",
  "s3_get",
  "mikrotik_print",
  "mikrotik_ping",
  "mikrotik_exec",
  "mikrotik_forward_add",
  "mikrotik_address_list_add",
  "mikrotik_set_enabled",
  "mikrotik_remove",
  "dns_lookup",
  "http_check",
  "tls_check",
  // Telegram stays on Griffin (owner's account) — do not give griffin→platform telegram_*.
  "debug_exec",
  "visualize",
  "show_media",
  "ask_owner",
  "ask_requester",
  "ask_agent",
  "knowledge_write",
  "knowledge_list",
  "jobs_list",
  "jobs_create",
  "jobs_update",
  "jobs_delete",
  "jobs_run",
];

const CDN_FOR_PEERS = [
  "arvan_domains",
  "arvan_dns_records",
  "arvan_dns_export",
  "arvan_dnssec",
  "arvan_cache_settings",
  "arvan_purge_tags",
  "arvan_cache_purge",
  "dns_lookup",
  "http_check",
  "tls_check",
];

/** Peer quota on nsin-ban: read + common ops (purge/path). DNS mutations stay owner-only. */
const NSIN_FOR_PEERS = [
  "nsin_edge_ranges",
  "nsin_domains",
  "nsin_domain",
  "nsin_dns_records",
  "nsin_ssl_status",
  "nsin_cache_stats",
  "nsin_cache_keys",
  "nsin_cache_purge",
  "nsin_cache_purge_path",
  "nsin_rules",
  "nsin_analytics_summary",
  "nsin_top_uris",
  "nsin_request_logs",
  "nsin_waf_logs",
  "nsin_uptime_live",
  "nsin_uptime_incidents",
  "nsin_recommendations",
  "dns_lookup",
  "http_check",
  "tls_check",
];

/** Tools owned by specialist agents — never included in platform's "null = everything" domain. */
export function isSpecialistTool(name) {
  const n = String(name);
  return n.startsWith("arvan_") || n.startsWith("nsin_");
}

export const AGENTS = {
  griffin: {
    label: "گریفین",
    domain: "ارکستریتور: مسئلهٔ بیزینسی یا فنی را می‌فهمد، پلن می‌چیند و متخصص درست را صدا می‌زند",
    tools: GRIFFIN_TOOLS,
    callers: {
      owner: { tools: "*" },
      // Jobs / unattended: orchestrate via ask_agent; no ask_owner (nobody is watching).
      scheduler: {
        tools: ["ask_agent", "visualize", "show_media", "knowledge_list", "knowledge_write", "telegram_dialogs", "telegram_read", "telegram_send"],
      },
      // Incident ops room (unattended, shadow mode): triage + delegate, no messaging, no ask_owner.
      ops: {
        tools: ["ask_agent", "knowledge_list", "knowledge_write", "incidents_list", "incident_update", "incident_history"],
      },
      // /agent coverage when the person profile picks Griffin.
      team: {
        tools: ["ask_agent", "ask_owner", "ask_requester", "visualize", "show_media", "knowledge_list", "end_agent", "telegram_dialogs", "telegram_read", "telegram_send"],
      },
    },
  },
  "platform": {
    label: "پلتفرم‌بان",
    domain: "پلتفرم: کلاستر، دیتابیس، گیت‌لب، گرافانا، S3، روتر، پیام‌رسان",
    // null = every available tool except specialist APIs (`arvan_*`, `nsin_*`). Those go through ask_agent.
    tools: null,
    callers: {
      owner: { tools: "*" },
      griffin: { tools: GRIFFIN_ON_PLATFORM },
      "arvan-ban": { tools: ["kube_get", "kube_status"] },
      // NSIN compares its published edge CIDRs with the router address list (read + ping only).
      "nsin-ban": { tools: ["mikrotik_print", "mikrotik_ping"] },
      // Griffin's ops room (shadow mode): read-only diagnosis only.
      ops: {
        tools: [
          "kube_status",
          "kube_get",
          "kube_logs",
          "kube_df",
          "metrics_query",
          "alerts_active",
          "grafana_search",
          "grafana_dashboard",
          "grafana_panel_query",
          "grafana_query",
          "gitlab_version",
          "gitlab_projects",
          "gitlab_search",
          "gitlab_file",
          "gitlab_commits",
          "dns_lookup",
          "http_check",
          "tls_check",
          "knowledge_list",
        ],
      },
      scheduler: {
        tools: [
          "kube_status",
          "kube_get",
          "kube_logs",
          "kube_df",
          "metrics_query",
          "grafana_search",
          "grafana_dashboard",
          "grafana_panel_query",
          "grafana_query",
          "gitlab_version",
          "gitlab_projects",
          "gitlab_search",
          "gitlab_file",
          "pg_query",
          "s3_list",
          "s3_get",
          "visualize",
          "show_media",
        ],
      },
      team: {
        tools: [
          "kube_status",
          "kube_get",
          "kube_logs",
          "kube_df",
          "metrics_query",
          "grafana_search",
          "grafana_dashboard",
          "grafana_panel_query",
          "grafana_query",
          "gitlab_version",
          "gitlab_projects",
          "gitlab_search",
          "gitlab_file",
          "gitlab_mr",
          "infisical_list",
          "infisical_get",
          "infisical_upsert",
          "infisical_create_project",
          "infisical_access",
          "pg_query",
          "s3_list",
          "s3_get",
          "mikrotik_print",
          "mikrotik_ping",
          "mikrotik_forward_add",
          "mikrotik_address_list_add",
          "mikrotik_set_enabled",
          "mikrotik_remove",
          "dns_lookup",
          "http_check",
          "tls_check",
          "telegram_dialogs",
          "telegram_read",
          "telegram_send",
          "debug_exec",
          "visualize",
          "show_media",
          "ask_owner",
          "ask_requester",
          "ask_agent",
          "gitlab_mr",
          "end_agent",
          "knowledge_list",
        ],
      },
    },
  },
  "arvan-ban": {
    label: "آروان‌بان",
    domain: "CDN آروان: دامنه، DNS، کش، purge",
    tools: ARVAN_TOOLS,
    callers: {
      owner: { tools: "*" },
      griffin: { tools: CDN_FOR_PEERS },
      "platform": { tools: CDN_FOR_PEERS },
      "nsin-ban": { tools: ["arvan_domains", "dns_lookup", "http_check", "tls_check"] },
      scheduler: {
        tools: [
          "arvan_domains",
          "arvan_dns_records",
          "arvan_dns_export",
          "arvan_dnssec",
          "arvan_cache_settings",
          "arvan_purge_tags",
          "arvan_cache_purge",
          "dns_lookup",
          "http_check",
          "tls_check",
          "visualize",
          "show_media",
          "ask_agent",
          "knowledge_list",
        ],
      },
      team: {
        tools: [
          "arvan_domains",
          "arvan_dns_records",
          "arvan_dns_export",
          "arvan_dnssec",
          "arvan_cache_settings",
          "arvan_purge_tags",
          "arvan_cache_purge",
          "dns_lookup",
          "http_check",
          "tls_check",
          "visualize",
          "show_media",
          "ask_owner",
          "ask_requester",
          "ask_agent",
          "end_agent",
          "knowledge_list",
        ],
      },
    },
  },
  "nsin-ban": {
    label: "انسین‌بان",
    domain: "NSIN CDN: دامنه، DNS، SSL، کش، قوانین لبه، آنالیتیکس، آپ‌تایم، رنج IP لبه",
    tools: NSIN_TOOLS,
    callers: {
      owner: { tools: "*" },
      griffin: { tools: NSIN_FOR_PEERS },
      "platform": { tools: NSIN_FOR_PEERS },
      "arvan-ban": { tools: ["nsin_edge_ranges", "nsin_uptime_live", "nsin_domains"] },
      scheduler: {
        tools: [
          ...NSIN_FOR_PEERS,
          "visualize",
          "show_media",
          "ask_agent",
          "knowledge_list",
        ],
      },
      team: {
        tools: [
          ...NSIN_FOR_PEERS,
          "visualize",
          "show_media",
          "ask_owner",
          "ask_requester",
          "ask_agent",
          "end_agent",
          "knowledge_list",
        ],
      },
    },
  },
};

export const CALLER_LABELS = {
  owner: "Owner",
  scheduler: "زمان‌بند",
  ops: "اتاق عملیات",
  team: "همکار (ایجنت تلگرام)",
  griffin: "گریفین",
  "arvan-ban": "آروان‌بان",
  "nsin-ban": "انسین‌بان",
  "platform": "پلتفرم‌بان",
};

export function callerQuota(agentId, callerId) {
  const agent = AGENTS[agentId];
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  const quota = agent.callers[callerId];
  if (!quota) throw new Error(`unknown caller ${callerId} for agent ${agentId}`);
  return quota;
}

export function allowedTools(agentId, callerId, availableNames) {
  const agent = AGENTS[agentId];
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  const quota = callerQuota(agentId, callerId);
  const names = Array.isArray(availableNames) ? availableNames : [];
  const owned =
    agent.tools == null ? names.filter((n) => !isSpecialistTool(n)) : names.filter((n) => agent.tools.includes(n));
  const keepAsk =
    callerId === "owner" ||
    callerId === "team" ||
    (Array.isArray(quota.tools) && quota.tools.includes("ask_owner"));
  if (quota.tools === "*") {
    return keepAsk ? owned : owned.filter((n) => n !== "ask_owner");
  }
  const allow = new Set(quota.tools);
  if (!keepAsk) allow.delete("ask_owner");
  return owned.filter((name) => allow.has(name));
}

export function filterTools(toolMap, allowed) {
  const allow = new Set(allowed);
  const out = {};
  for (const [name, tool] of Object.entries(toolMap || {})) {
    if (allow.has(name)) out[name] = tool;
  }
  return out;
}

export function listAgents() {
  return Object.entries(AGENTS).map(([id, agent]) => ({
    id,
    label: agent.label,
    domain: agent.domain,
    tools: agent.tools,
    callers: Object.entries(agent.callers).map(([callerId, quota]) => ({
      id: callerId,
      label: CALLER_LABELS[callerId] || callerId,
      tools: quota.tools,
    })),
  }));
}

export function resolveAgentId(agentId) {
  return agentId && AGENTS[agentId] ? agentId : DEFAULT_AGENT;
}
