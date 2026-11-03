// What this run can actually do, written from the tools it really has (2026-11-02).
//
// Claude Code shows every MCP tool but ~13 only as a bare name (deferred, ToolSearch loads the
// schema), and the hand-written tool list in the rules went stale (`incidents_*` for incident_*,
// 38 tools named nowhere). So the model did not know what it could do — e.g. that it has TWO
// browsers (a sandbox Chromium and the owner's own Chrome) — and subagents knew nothing at all
// (their prompt is Claude Code's 2.7k generic one). One line per family, only for families present,
// with when to pick which; anything not mapped still appears (its description's first sentence),
// so a new tool is never invisible.

import { PERSONA } from "./persona.mjs";

const FAMILIES = [
  // people & decisions
  { names: ["ask_owner"], line: "ask_owner — a decision or approval only the owner can give (once, with options)." },
  { names: ["ask_requester"], line: "ask_requester — ask whoever started this request what they meant; never for permission." },
  { names: ["owner_task"], line: "owner_task — ask the owner for an access nobody gave you (lands on his main page)." },
  { names: ["request_full_access"], line: "request_full_access — ask the owner to let this conversation act without asking each time." },
  { names: ["tell_owner", "notify_owner"], line: "tell_owner (a heads-up line in his Telegram, incidents) · notify_owner (ring his phone, urgent only)." },
  { names: ["inbox_list"], line: "inbox_list — what is waiting for the owner right now (check before asking him again)." },
  // other agents & chats
  { names: ["delegate", "subtasks", "ask_agent", "list_agents"], line: "delegate (hand work to a peer agent, returns at once; result comes back by itself) · subtasks (list/steer/cancel those) · ask_agent (blocking ≤3 min, quick reads only) · list_agents." },
  { names: ["network_agents", "network_ask", "network_reply", "network_connect"], line: "network_agents/ask/reply/connect — colleagues' own agents (other installs): ask them about their systems; never Telegram an agent." },
  { names: ["consult"], line: "consult — a second opinion from another model/account inside this call (≤13 min)." },
  { names: ["chat_list", "chat_read", "chat_send", "chat_suggest", "chat_archive", "chat_chapter", "chat_dismiss_suggestion", "related_chat_send"], line: "chat_* — the owner's other chats: list/read one, send it a note, suggest a new chat card, archive, mark a chapter in this one." },
  { names: ["peer_invite", "peer_connection"], line: "peer_invite (onboard a colleague's agent) · peer_connection (why a colleague's MCP connection dropped)." },
  { names: ["agent_create", "agent_delete", "agent_settings_get", "agent_settings_set", "agent_tools_list", "agent_tools_enable", "agent_tools_disable", "upgrade_model"], line: "agent_* — agent profiles of this install (tools, engine) · upgrade_model (move this chat to a stronger model)." },
  // browsers & web
  { names: ["browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_select", "browser_press", "browser_hover", "browser_wait", "browser_upload", "browser_eval", "browser_screenshot", "browser_console", "browser_tabs", "browser_close"], line: "browser_* — headless Chromium in the SANDBOX (not the owner's browser): test a site like a user, work in panels without an API; `profile` keeps a login." },
  { names: ["chrome_tabs", "chrome_snapshot", "chrome_act", "chrome_eval", "chrome_screenshot", "chrome_devtools", "chrome_cdp"], line: "chrome_* — the OWNER'S OWN Chrome, with his logins (needs his extension connected): when he says «مرورگرم» or a page needs his session; console/network for debugging. Your tabs go in the «گریفین» group." },
  { names: ["web_search", "web_fetch"], line: "web_search · web_fetch (readable text of a public page; JS-heavy or logged-in pages → browser_*/chrome_*)." },
  { names: ["show_media", "visualize"], line: "show_media (put an image/PDF/video in the chat) · visualize (a chart from Prometheus or rows)." },
  { names: ["preview_start", "preview_restart", "preview_logs", "preview_list", "preview_stop"], line: "preview_* — run an app/folder in the sandbox and show it live in the chat." },
  // time
  { names: ["later"], line: "later — wake THIS chat at a time (survives restarts): the way to keep a promise or check back; not ScheduleWakeup/sleep loops." },
  { names: ["jobs_create", "jobs_list", "jobs_update", "jobs_delete", "jobs_run"], line: "jobs_* — recurring scheduled jobs (every/cron) run by an agent." },
  // platform
  { names: ["kube_status", "kube_get", "kube_logs", "kube_exec", "kube_df", "kube_secret", "kube_create", "kube_delete", "kube_copy_secret"], line: "kube_* — the Platform clusters (east/west/north): status, get (incl. CNPG clusters and backups), logs, exec in a pod, df, secret keys, create/delete, copy a Secret across clusters." },
  { names: ["cnpg_retry_bootstrap"], line: "cnpg_retry_bootstrap — let CNPG retry a failed bootstrap (deletes only its failed Jobs)." },
  { names: ["metrics_query", "alerts_active"], line: "metrics_query (PromQL per cluster) · alerts_active (firing Alertmanager alerts)." },
  { names: ["grafana_search", "grafana_dashboard", "grafana_panel_query", "grafana_query"], line: "grafana_* — find a dashboard, read a panel's data, run a datasource query." },
  { names: ["pg_query"], line: "pg_query — read-only SQL on a platform PostgreSQL." },
  { names: ["s3_list", "s3_get"], line: "s3_list/s3_get — read the platform S3 (SeaweedFS)." },
  { names: ["infisical_projects", "infisical_list", "infisical_get", "infisical_upsert", "infisical_access", "infisical_create_project", "infisical_machine_identity"], line: "infisical_* — the secret manager: the ONLY way a secret moves (upsert into THEIR project, tell them the path); access audits, projects, machine identities." },
  { names: ["mikrotik_print", "mikrotik_exec", "mikrotik_ping", "mikrotik_address_list_add", "mikrotik_forward_add", "mikrotik_remove", "mikrotik_set_enabled"], line: "mikrotik_* — office/site routers: print, ping, exec, address lists, port forwards." },
  { names: ["vcenter_inventory", "vcenter_vms", "vcenter_vm_get", "vcenter_vm_create", "vcenter_customization_specs"], line: "vcenter_* — VMware vCenter: inventory, VMs, create a VM from a template." },
  { names: ["ssh_exec"], line: "ssh_exec — one read-only shell command on any capsule/Platform server or colleague install (user griffin)." },
  { names: ["debug_exec"], line: "debug_exec — a real root shell (sandbox; or debug/capsule/griffin hosts): drive any API/CLI with a credential read from Infisical when no tool covers it. A missing tool is never the answer while you have this." },
  { names: ["dns_lookup", "http_check", "tls_check"], line: "dns_lookup · http_check (the path users take) · tls_check." },
  // CDN
  { names: ["arvan_domains", "arvan_dns_records", "arvan_dns_create", "arvan_dns_delete", "arvan_dns_export", "arvan_dnssec", "arvan_cache_settings", "arvan_cache_purge", "arvan_purge_tags", "arvan_page_rules", "arvan_page_rule_create", "arvan_load_balancer_get", "arvan_reports", "arvan_security_rules"], line: "arvan_* — Arvan CDN: domains, DNS, cache/purge, page rules, load balancers, reports." },
  { prefix: "nsin_", line: "nsin_* — NSIN CDN: domains, DNS, SSL, cache/purge, edge rules, WAF/request logs, analytics, uptime, edge IP ranges." },
  // code
  { names: ["gitlab_projects", "gitlab_search", "gitlab_file", "gitlab_commits", "gitlab_mrs", "gitlab_mr", "gitlab_mr_changes", "gitlab_pipeline", "gitlab_version", "gitlab_propose", "gitlab_project_member"], line: "gitlab_* — read any project (search, file, commits, MRs and their diff, pipelines); gitlab_propose opens an MR (small edit = find/replace); gitlab_project_member grants a role (asks the owner)." },
  { names: ["repo_list", "repo_read", "repo_search", "repo_edit", "repo_write", "repo_git", "repo_push"], line: "repo_* — this chat's own worktree: read/search/edit, commit (repo_git), push its branch (repo_push)." },
  { names: ["git_clone", "git_fetch", "git_push"], line: "git_clone (bring a GitLab project into the repos folder) · git_fetch · git_push." },
  { names: ["build_tool"], line: "build_tool — get a missing READ-ONLY capability built (owner approves once; its report comes back here)." },
  { names: ["business_docs_search", "business_docs_read"], line: "business_docs_* — the company's business documents." },
  // incidents & ops
  { names: ["incidents_list", "incident_history", "incident_update", "incident_ack", "incident_assign", "incident_suggest", "incident_sources", "incident_source_set"], line: "incident_* — the incident layer: list, history, update/ack/assign, suggest a chat for one, manage its sources." },
  // knowledge & self
  { names: ["knowledge_list", "knowledge_write", "knowledge_edit", "knowledge_delete"], line: "knowledge_* — durable notes (never a secret): read a note in full, write/fix one." },
  { names: ["self_check", "self_fix"], line: "self_check (this app's real health: engines, stuck runs, messengers, disk) · self_fix (apply a fix it offered)." },
  { names: ["mcp_server_list", "mcp_server_add", "mcp_server_login", "mcp_server_remove"], line: "mcp_server_* — the owner's external MCP servers (add by Infisical reference, OAuth login)." },
  // Telegram
  { names: ["telegram_dialogs", "telegram_read", "telegram_media", "telegram_send", "telegram_edit", "telegram_delete", "telegram_ledger", "telegram_watch_list", "send_to_person"], line: "telegram_* — the owner's own Telegram (people, groups): read, see media, send as him, edit/delete your own message (fix in place, never a second one); ledger = which chat sent what." },
  { names: ["updateTodos"], line: "updateTodos — this task's step list." },
];

const matches = (f, name) => (f.prefix ? name.startsWith(f.prefix) : f.names.includes(name));

function compactNames(names) {
  // kube_get, kube_logs, kube_exec → kube_get/logs/exec
  const out = [];
  const byPrefix = new Map();
  for (const n of names) {
    const i = n.indexOf("_");
    const p = i > 0 ? n.slice(0, i) : n;
    if (!byPrefix.has(p)) byPrefix.set(p, []);
    byPrefix.get(p).push(i > 0 ? n.slice(i + 1) : "");
  }
  for (const [p, rest] of byPrefix) out.push(rest.length === 1 ? (rest[0] ? `${p}_${rest[0]}` : p) : `${p}_${rest.join("/")}`);
  return out.join(" ");
}

const firstSentence = (text) => {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.{20,}?[.;:!?])(\s|$)/);
  const one = m ? m[1] : s;
  return one.length > 110 ? `${one.slice(0, 107)}…` : one;
};

/**
 * The capability map for one run.
 * @param {string[]} tools names of the tools this run has
 * @param {{descriptions?: Record<string,string>, chrome?: "connected"|"paired"|"none"}} [opts]
 */
export function capabilityMap(tools, { descriptions = {}, chrome = null } = {}) {
  const have = [...new Set((tools || []).filter(Boolean))];
  if (!have.length) return "";
  const lines = [];
  const used = new Set();
  for (const f of FAMILIES) {
    const present = have.filter((n) => matches(f, n));
    if (!present.length) continue;
    present.forEach((n) => used.add(n));
    lines.push(`- ${f.line}`);
  }
  const rest = have.filter((n) => !used.has(n)).sort();
  for (const n of rest) lines.push(`- ${n} — ${firstSentence(descriptions[n]) || "see its schema (ToolSearch)"}`);
  const hasChrome = have.some((n) => n.startsWith("chrome_"));
  const hasBrowser = have.some((n) => n.startsWith("browser_"));
  let browsers = "";
  if (hasChrome && hasBrowser) browsers = `\nTwo browsers: browser_* is a sandbox Chromium on the server; chrome_* is the owner's real Chrome with his sessions${chrome === "paired" ? " (paired, not connected now — he only has to open Chrome)" : ""}. Pick chrome_* only for his browser or his logins.`;
  else if (hasBrowser && !hasChrome) browsers = "\nYour browser is browser_* (a sandbox Chromium on the server). The owner's own Chrome is not reachable from this conversation.";
  return `
Capability map — written from the tools THIS conversation really has (${have.length}): ${compactNames(have.slice().sort())}
That list is exactly what you have (a line below may name a sibling you lack). Most come by name only; ToolSearch "select:<name>" loads one's schema. What each is for:
${lines.join("\n")}${browsers}
`;
}

// The rules a subagent (Claude Code's Agent tool) never gets: its prompt is the generic 2.7k one.
// Kept short: it is added to every subagent's first turn.
export function subagentBrief(tools, { descriptions = {}, chrome = null, ownerName = "the owner" } = {}) {
  return `You are a subagent of ${PERSONA.latin} (${PERSONA.name}), ${ownerName}'s assistant. Rules that also bind you:
- Secrets move only through Infisical (infisical_upsert into the person's project, then name the path). Never print a token, password or key — not in your report either.
- Read-only unless your task says otherwise; anything irreversible (deleting data/PVCs/DNS, production writes, a push to a shared repo's main) is not yours to do — report it back.
- Times you write are Tehran time (UTC+03:30), not UTC. Your report is read by the parent agent: facts first, short, what you checked vs what you infer.
- Report ONCE at the end; no progress messages. To wait for something, run a waiter in the background instead of polling.
- Telegram, asking the owner and outside messages are the parent's: say in your report what should be sent or asked.
${capabilityMap(tools, { descriptions, chrome })}`;
}

export const CAPABILITY_FAMILIES = FAMILIES;
