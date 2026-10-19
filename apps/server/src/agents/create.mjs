import crypto from "node:crypto";
import { agentNameError } from "../identity.mjs";
import { agentIdError } from "./registry.mjs";
import { SELF_MGMT_TOOLS, unique } from "./profiles.mjs";

// Making an agent at run time (the agents page, POST /api/agents, and the agent_create tool of the
// mother agent). An agent is a row: name, line of work, instructions, engine/model, tools. It is
// never code, and it never gets the tools that edit agents.

export const MAX_INSTRUCTIONS = 6000;
// What a new agent can do when nothing else is asked: think with the owner, look things up, report.
const BASE_TOOLS = ["ask_owner", "ask_agent", "knowledge_list", "visualize", "show_media", "web_search", "web_fetch", "dns_lookup", "http_check"];

const fail = (message) => Object.assign(new Error(message), { code: "invalid" });

// Who may use which tools of a made agent. The owner and the mother agent use it with everything it
// has; a job or a colleague's thread gets it without the questions only a person at the desk can answer.
export function customCallers(tools) {
  const unattended = tools.filter((name) => !["ask_owner", "ask_requester", "end_agent"].includes(name));
  return { owner: { tools: "*" }, griffin: { tools: [...tools] }, scheduler: { tools: unattended }, team: { tools: [...tools] } };
}

/** A readable id from a Latin name; a random one when the name has no Latin letters. */
export function suggestAgentId(label, taken = () => false) {
  const slug = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  for (const candidate of [slug, `${slug}-agent`].filter((c) => c.length >= 3)) {
    if (!agentIdError(candidate) && !taken(candidate)) return candidate;
  }
  for (;;) {
    const candidate = `agent-${crypto.randomBytes(2).toString("hex")}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * Validate and save a new agent. `input`: { id?, label, domain, blurb?, instructions?, tools?,
 * provider?, model?, models? }. Throws an Error with code "invalid" and a message fit to show.
 */
export function createCustomAgent({ store, catalogNames = [], input = {}, isEngine = () => true, splitModel = () => null, defaultProvider = "cursor" }) {
  const label = String(input.label ?? "").trim();
  const labelError = agentNameError(label);
  if (labelError) throw fail(`name refused: ${labelError}`);
  const domain = String(input.domain ?? "").trim().slice(0, 500);
  if (!domain) throw fail("domain is required: one line saying what this agent is for");
  const instructions = String(input.instructions ?? "").trim();
  if (instructions.length > MAX_INSTRUCTIONS) throw fail(`instructions are at most ${MAX_INSTRUCTIONS} characters`);

  const taken = (id) => Boolean(store.getAgentProfile(id));
  const id = String(input.id ?? "").trim() || suggestAgentId(label, taken);
  const idError = agentIdError(id);
  if (idError) throw fail(idError);
  if (taken(id)) throw fail(`an agent with id «${id}» already exists`);

  const catalog = new Set(catalogNames);
  // Only tools that were named can be unknown; the defaults are whatever of them this install has.
  const asked = Array.isArray(input.tools) && input.tools.length ? unique(input.tools.map(String)) : BASE_TOOLS.filter((name) => catalog.has(name));
  const blocked = asked.filter((name) => SELF_MGMT_TOOLS.includes(name));
  if (blocked.length) throw fail(`an agent cannot be given the tools that edit agents: ${blocked.join(", ")}`);
  const unknown = asked.filter((name) => !catalog.has(name));
  if (unknown.length) throw fail(`unknown tools: ${unknown.join(", ")}`);
  const tools = asked.filter((name) => catalog.has(name));

  let models = [];
  if (Array.isArray(input.models)) {
    models = unique(input.models.map((m) => String(m).trim()).filter((m) => isEngine(m) || splitModel(m))).slice(0, 12);
  }
  let provider = String(input.provider ?? "").trim();
  let model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : null;
  if (models.length) {
    const first = splitModel(models[0]) || { provider: models[0], model: null };
    provider = first.provider;
    model = first.model;
  } else if (provider && !isEngine(provider)) {
    throw fail(`unknown engine account «${provider}»`);
  }
  if (!provider) provider = defaultProvider;

  // The mother agent and the owner use it with everything it has; a job or a colleague's thread gets
  // it without the questions only a person at the desk can answer.
  const meta = {
    instructions,
    callers: customCallers(tools),
    ...(models.length ? { models } : {}),
  };
  return store.upsertAgentProfile({ id, label, domain, blurb: String(input.blurb ?? "").trim().slice(0, 500), instructions, provider, model, tools, meta, builtIn: false });
}
