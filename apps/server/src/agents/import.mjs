import { AGENT_ID, CORE_TOOLS } from "./registry.mjs";
import { SELF_MGMT_TOOLS, unique } from "./profiles.mjs";

// One shape for "here is an agent": the UI form, POST /api/agents, and the ready-made profiles in
// examples/agents/*.json all go through this. An agent is data — id, what it is, what it may use,
// and who may call it — so adding one never means editing code.

export class AgentInputError extends Error {}

const str = (value, max) => String(value ?? "").slice(0, max);

/** Normalize a profile description into the row the store stores. Throws on a bad id. */
export function agentPayload(raw = {}, { builtIn = false } = {}) {
  const id = str(raw.id, 64).trim().toLowerCase();
  if (!AGENT_ID.test(id)) {
    throw new AgentInputError("id must be lowercase letters, digits and dashes (max 40 characters)");
  }
  const callers = normalizeCallers(raw.callers);
  const allTools = Boolean(raw.allTools);
  const tools = Array.isArray(raw.tools) && raw.tools.length ? raw.tools.map(String) : allTools ? [] : [...CORE_TOOLS];
  return {
    id,
    label: str(raw.label, 120).trim() || id,
    domain: str(raw.domain, 500),
    blurb: str(raw.blurb, 500),
    instructions: str(raw.instructions, 20_000),
    provider: raw.provider === "claude" ? "claude" : "cursor",
    model: raw.model ? str(raw.model, 120) : null,
    tools: unique([...tools, ...SELF_MGMT_TOOLS]),
    meta: { callers, ...(allTools ? { allTools: true } : {}) },
    builtIn,
  };
}

/** Who may call this agent, and with which tools. Owner always may. */
function normalizeCallers(raw) {
  const out = {};
  if (raw && typeof raw === "object") {
    for (const [caller, quota] of Object.entries(raw)) {
      if (!caller || typeof caller !== "string") continue;
      const tools = quota?.tools;
      if (tools === "*") out[caller] = { tools: "*" };
      else if (Array.isArray(tools)) out[caller] = { tools: unique(tools.map(String)) };
    }
  }
  if (!out.owner) out.owner = { tools: "*" };
  return out;
}

export function importAgent(store, raw, options) {
  return store.upsertAgentProfile(agentPayload(raw, options));
}
