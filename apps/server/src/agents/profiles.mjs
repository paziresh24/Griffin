import { AGENTS, CALLER_LABELS, DEFAULT_AGENT, filterTools } from "./registry.mjs";

export const SELF_MGMT_TOOLS = [
  "list_agents",
  "agent_tools_list",
  "agent_tools_enable",
  "agent_tools_disable",
  "agent_settings_get",
  "agent_settings_set",
];

/** Tools the app itself provides (no broker, no credentials beyond what the owner connected). */
export const APP_TOOL_NAMES = [
  "ask_owner",
  "ask_requester",
  "ask_agent",
  "delegate",
  "subtasks",
  "peer_invite",
  "peer_connection",
  "visualize",
  "show_media",
  "knowledge_write",
  "knowledge_list",
  "jobs_list",
  "jobs_create",
  "jobs_update",
  "jobs_delete",
  "jobs_run",
  "telegram_dialogs",
  "telegram_read",
  "telegram_send",
  "end_agent",
  "incidents_list",
  "incident_update",
  "incident_ack",
  "incident_history",
  ...SELF_MGMT_TOOLS,
];

/** Built-in seed rows from the static registry (owner tools + self-mgmt). */
export function seedProfilesFromRegistry() {
  const rows = [];
  for (const [id, agent] of Object.entries(AGENTS)) {
    const callers = {};
    for (const [callerId, quota] of Object.entries(agent.callers || {})) {
      callers[callerId] = { tools: quota.tools };
    }
    const allTools = agent.tools == null;
    rows.push({
      id,
      label: agent.label,
      domain: agent.domain,
      blurb: "",
      instructions: "",
      provider: "cursor",
      model: null,
      tools: allTools ? [...SELF_MGMT_TOOLS] : unique([...(agent.tools || []), ...SELF_MGMT_TOOLS]),
      meta: { callers, ...(allTools ? { allTools: true } : {}) },
      builtIn: true,
    });
  }
  return rows;
}

export function unique(list) {
  const out = [];
  for (const item of list) {
    if (typeof item === "string" && item && !out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Resolve which tool names this profile may use for a given caller.
 * owner → profile.tools (or every catalog tool when the profile says allTools).
 * scheduler / team → meta.callers quota when present.
 */
export function resolveEnabledTools(profile, { caller = "owner", catalogNames = [] } = {}) {
  if (!profile) throw new Error("unknown agent profile");
  const catalog = Array.isArray(catalogNames) ? catalogNames : [];
  const meta = profile.meta || {};
  const callers = meta.callers || {};

  // Only the owner, driving the agent directly, gets the profile's full enabled set (plus the
  // self-management tools). Every other caller — a peer agent invoked through ask_agent, the
  // scheduler, or a /agent coverage session — is bounded by that caller's quota. A missing quota
  // row fails closed (no tools), so a peer can never reach beyond what it was explicitly granted,
  // and the self-management tools (which mutate the profile) stay out of reach for non-owners.
  if (caller === "owner") return expandProfileTools(profile, catalog);

  const quota = callers[caller];
  if (!quota) return [];
  // Self-management edits quotas and profiles: never reachable by a non-owner, whatever a row says.
  const noSelf = (n) => !SELF_MGMT_TOOLS.includes(n);
  if (quota.tools === "*") return expandProfileTools(profile, catalog).filter(noSelf);
  return unique(Array.isArray(quota.tools) ? quota.tools : []).filter(
    (n) => noSelf(n) && (catalog.includes(n) || APP_TOOL_NAMES.includes(n)),
  );
}

function expandProfileTools(profile, catalogNames) {
  const meta = profile.meta || {};
  const disabled = new Set(Array.isArray(meta.disabled) ? meta.disabled : []);
  // allTools: this agent gets whatever the install has, minus what the owner switched off.
  if (meta.allTools) {
    const base = catalogNames.filter((n) => !disabled.has(n));
    return unique([...base, ...(profile.tools || []), ...SELF_MGMT_TOOLS]).filter((n) => !disabled.has(n));
  }
  const enabled = new Set(profile.tools || []);
  return catalogNames.filter((n) => enabled.has(n) && !disabled.has(n));
}

export function publicProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    label: profile.label,
    domain: profile.domain,
    blurb: profile.blurb || "",
    instructions: profile.instructions || "",
    provider: profile.provider || "cursor",
    model: profile.model || null,
    tools: profile.tools || [],
    allTools: Boolean(profile.meta?.allTools),
    disabled: profile.meta?.disabled || [],
    builtIn: Boolean(profile.built_in ?? profile.builtIn),
    callers: Object.entries(profile.meta?.callers || {}).map(([callerId, quota]) => ({
      id: callerId,
      label: CALLER_LABELS[callerId] || callerId,
      tools: quota.tools,
    })),
    updatedAt: profile.updated_at || profile.updatedAt || null,
  };
}

export function filterToolsByProfile(toolMap, profile, { caller = "owner" } = {}) {
  const catalogNames = Object.keys(toolMap || {});
  const allowed = resolveEnabledTools(profile, { caller, catalogNames });
  return filterTools(toolMap, allowed);
}

// The caller at the top of an ask_agent / delegate chain (owner, a peer user, scheduler, ops,
// team). It decides who is asked for approval and whether anyone is watching at all — it no
// longer narrows the tools of the agent doing the work. A specialist called by Griffin runs with
// Griffin's quota on it, whoever started the chain: an agent that cannot reach its own tools is
// useless, and the real control on a chain the owner did not start is the approval gate in
// guard.mjs (every irreversible call asks the owner, wherever they are).
export function rootCallerOf(store, chat, maxDepth = 10) {
  let current = chat;
  for (let i = 0; i < maxDepth && current?.parent_chat_id; i += 1) {
    const parent = store.getChat(current.parent_chat_id);
    if (!parent) break;
    current = parent;
  }
  return current?.caller || "owner";
}

export { DEFAULT_AGENT, CALLER_LABELS, filterTools };
