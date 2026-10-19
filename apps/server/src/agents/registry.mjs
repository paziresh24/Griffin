import { PERSONA } from "../persona.mjs";
import { genv } from "../env.mjs";

// Agent registry: authority is who is calling, not a property of the agent itself.
// Quota is enforced by filterTools (tools not in customTools cannot be called). Prompt text
// only informs; it is not the control.
//
// This file holds the ONE built-in agent a fresh install starts with. Everything else — more
// agents, their instructions, their tools, who may call them — is data in `agent_profiles`,
// created from the UI (#/agents) or the API. `examples/agents/` has ready-made profiles to
// import; nothing about anyone's infrastructure belongs here.

export const DEFAULT_AGENT = "griffin";

/** Tools that exist in every install, with no broker and no credentials. */
export const CORE_TOOLS = [
  "ask_owner",
  "ask_requester",
  "ask_agent",
  "delegate",
  "subtasks",
  "visualize",
  "show_media",
  "web_search",
  "web_fetch",
  "knowledge_write",
  "knowledge_list",
  "jobs_list",
  "jobs_create",
  "jobs_update",
  "jobs_delete",
  "jobs_run",
  "telegram_dialogs",
  "telegram_read",
  "telegram_media",
  "telegram_send",
  "end_agent",
  "chat_suggest",
  "chat_dismiss_suggestion",
  "chat_chapter",
  "consult",
];

/** What an unattended caller (a scheduled job) may use: work, but never ask a human. */
const SCHEDULER_TOOLS = ["ask_agent", "delegate", "subtasks", "visualize", "show_media", "knowledge_list", "knowledge_write"];

/** What a person talking through a messenger bridge may use. */
const TEAM_TOOLS = ["ask_agent", "delegate", "subtasks", "ask_owner", "ask_requester", "visualize", "show_media", "web_search", "web_fetch", "knowledge_list", "end_agent", "peer_connection"];

export const AGENTS = {
  griffin: {
    label: PERSONA.name,
    domain: "دستیار عمومی: مسئله را می‌فهمد، پلن می‌چیند و اگر ایجنت متخصصی هست کار را به او می‌سپارد",
    tools: CORE_TOOLS,
    callers: {
      owner: { tools: "*" },
      scheduler: { tools: SCHEDULER_TOOLS },
      // Unattended triage; its own ask_owner reaches the owner with a timeout (asks.mjs), approvals
      // for irreversible calls stay refused there.
      ops: { tools: ["ask_agent", "knowledge_list", "knowledge_write", "incidents_list", "incident_update", "incident_history", "ask_owner", "tell_owner"] },
      team: { tools: TEAM_TOOLS },
    },
  },
};

export const CALLER_LABELS = {
  owner: "Owner",
  scheduler: "زمان‌بند",
  ops: "اتاق عملیات",
  team: "همکار (پیام‌رسان)",
  get griffin() {
    return PERSONA.name;
  },
};

// Built-in specialists an install may seed besides the mother agent. A fresh public install has
// none; GRIFFIN_SPECIALISTS=off drops any that were seeded (db.mjs removes their rows too).
export const SPECIALIST_AGENTS = [];
export const specialistsOff = (env = process.env) => genv("SPECIALISTS", "", env) === "off";
if (specialistsOff()) for (const id of SPECIALIST_AGENTS) delete AGENTS[id];

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
  const owned = agent.tools == null ? names : names.filter((n) => agent.tools.includes(n));
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

/** A usable agent id, or the default. Custom agents live in the database, so this only
 *  checks the shape — callers that need to know an agent exists ask the store. */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

// --- agents the owner (or the mother agent, with his yes) makes at run time -------------------------
// They live in agent_profiles (db.mjs) and are mirrored here so everything keyed on AGENTS (the
// working folder, the rules, the caller names, the knowledge folder) knows them too.

// Caller ids share a namespace with agent ids (a quota row is keyed by the caller), so none of these
// can be an agent's id.
export const RESERVED_AGENT_IDS = new Set(["owner", "scheduler", "ops", "team", "peer", "system", "all", "new", "auto", "default", ...Object.keys(AGENTS), ...SPECIALIST_AGENTS]);
const NEW_AGENT_ID = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

/** Why `id` cannot name a new agent, or null. */
export function agentIdError(id) {
  const value = String(id ?? "");
  if (!NEW_AGENT_ID.test(value)) return "agent id: 3–32 characters, lowercase letters, digits and dashes, starting with a letter";
  if (RESERVED_AGENT_IDS.has(value) || value.startsWith("peer")) return `agent id «${value}» is reserved`;
  return null;
}

export function registerAgent(profile) {
  if (!profile?.id || profile.built_in || profile.builtIn) return;
  if (AGENTS[profile.id] && !AGENTS[profile.id].custom) return;
  AGENTS[profile.id] = {
    custom: true,
    label: profile.label,
    domain: profile.domain || "",
    tools: Array.isArray(profile.tools) ? profile.tools : [],
    callers: profile.meta?.callers && typeof profile.meta.callers === "object" ? profile.meta.callers : {},
  };
}

export function unregisterAgent(id) {
  if (AGENTS[id]?.custom) delete AGENTS[id];
}

export function resolveAgentId(agentId) {
  const id = String(agentId || "");
  return AGENT_ID.test(id) ? id : DEFAULT_AGENT;
}
