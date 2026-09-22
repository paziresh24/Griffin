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
];

/** What an unattended caller (a scheduled job) may use: work, but never ask a human. */
const SCHEDULER_TOOLS = ["ask_agent", "delegate", "subtasks", "visualize", "show_media", "knowledge_list", "knowledge_write"];

/** What a person talking through a messenger bridge may use. */
const TEAM_TOOLS = ["ask_agent", "ask_owner", "ask_requester", "visualize", "show_media", "knowledge_list", "end_agent"];

export const AGENTS = {
  griffin: {
    label: "گریفین",
    domain: "دستیار عمومی: مسئله را می‌فهمد، پلن می‌چیند و اگر ایجنت متخصصی هست کار را به او می‌سپارد",
    tools: CORE_TOOLS,
    callers: {
      owner: { tools: "*" },
      scheduler: { tools: SCHEDULER_TOOLS },
      ops: { tools: ["ask_agent", "knowledge_list", "knowledge_write"] },
      team: { tools: TEAM_TOOLS },
    },
  },
};

export const CALLER_LABELS = {
  owner: "Owner",
  scheduler: "زمان‌بند",
  ops: "اتاق عملیات",
  team: "همکار (پیام‌رسان)",
  griffin: "گریفین",
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

export function resolveAgentId(agentId) {
  const id = String(agentId || "");
  return AGENT_ID.test(id) ? id : DEFAULT_AGENT;
}
