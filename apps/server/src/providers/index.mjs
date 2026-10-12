import { createClaudeProvider, PROVIDER_CLAUDE, CLAUDE_MODELS } from "./claude.mjs";
import { createCursorProvider, PROVIDER_CURSOR } from "./cursor.mjs";
import { createOpenAIProvider, PROVIDER_OPENAI } from "./openai.mjs";
import { PROVIDER_IDS, normalizeProvider, kindOf, KINDS, setAccounts } from "./ids.mjs";

export { PROVIDER_CLAUDE, PROVIDER_CURSOR, PROVIDER_OPENAI, CLAUDE_MODELS, normalizeProvider, PROVIDER_IDS, kindOf, KINDS, setAccounts };

// Every engine account id (live: setAccounts adds a second Claude account, an OpenRouter one, …).
export const PROVIDERS = PROVIDER_IDS;
export const DEFAULT_PROVIDER = PROVIDER_CURSOR;

const FACTORY = {
  [PROVIDER_CURSOR]: (a, builtinTools) => createCursorProvider({ apiKey: a.apiKey, defaultModel: a.model || "auto", builtinTools }),
  [PROVIDER_CLAUDE]: (a) => createClaudeProvider({ apiKey: a.apiKey, defaultModel: a.model || "sonnet" }),
  [PROVIDER_OPENAI]: (a) => createOpenAIProvider({ apiKey: a.apiKey, baseUrl: a.baseUrl, defaultModel: a.model || "gpt-4o-mini", reasoningEffort: a.reasoningEffort || "" }),
};

/** One provider object per engine account: accounts = [{ id, apiKey, baseUrl, model, reasoningEffort }]. */
export function createProviders({ accounts = [], builtinTools, demoSdk = null } = {}) {
  if (demoSdk) {
    return Object.fromEntries(PROVIDER_IDS.map((id) => [id, demoProvider(id, demoSdk)]));
  }
  return Object.fromEntries(
    accounts.filter((a) => kindOf(a.id)).map((a) => [a.id, { ...FACTORY[kindOf(a.id)](a, builtinTools), id: a.id, kind: kindOf(a.id) }]),
  );
}

function demoProvider(id, demoSdk) {
  const kind = kindOf(id);
  return {
    id,
    kind,
    defaultModel: kind === PROVIDER_CLAUDE ? "sonnet" : "auto",
    listModels: async () =>
      kind === PROVIDER_CLAUDE ? CLAUDE_MODELS.map((m) => ({ ...m, provider: id })) : [{ id: "demo", name: "Demo", provider: id }],
    health: async () => ({ ok: true, status: 200, ms: 1 }),
    create: (o) => demoSdk.create(toDemoOptions(o)),
    resume: (agentId, o) => demoSdk.resume(agentId, toDemoOptions(o)),
  };
}

function toDemoOptions(options) {
  return {
    apiKey: "demo",
    model: options.model || { id: "demo" },
    tools: [],
    local: {
      cwd: options.cwd || "/tmp",
      settingSources: [],
      customTools: options.customTools,
    },
  };
}
