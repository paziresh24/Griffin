import { createClaudeProvider, PROVIDER_CLAUDE, CLAUDE_MODELS } from "./claude.mjs";
import { createCursorProvider, PROVIDER_CURSOR } from "./cursor.mjs";
import { createOpenAIProvider, PROVIDER_OPENAI } from "./openai.mjs";
import { PROVIDER_IDS, normalizeProvider } from "./ids.mjs";

export { PROVIDER_CLAUDE, PROVIDER_CURSOR, PROVIDER_OPENAI, CLAUDE_MODELS, normalizeProvider, PROVIDER_IDS };

export const PROVIDERS = [PROVIDER_CURSOR, PROVIDER_CLAUDE, PROVIDER_OPENAI];
export const DEFAULT_PROVIDER = PROVIDER_CURSOR;

export function createProviders({
  cursorApiKey,
  anthropicApiKey,
  openaiApiKey,
  openaiBaseUrl,
  openaiModel,
  openaiReasoningEffort,
  cursorModel,
  claudeModel,
  builtinTools,
  demoSdk = null,
} = {}) {
  if (demoSdk) {
    const wrap = (id) => ({
      id,
      defaultModel: id === PROVIDER_CLAUDE ? "sonnet" : "auto",
      listModels: async () =>
        id === PROVIDER_CLAUDE
          ? CLAUDE_MODELS.map((m) => ({ ...m, provider: id }))
          : [{ id: "demo", name: "Demo", provider: id }],
      health: async () => ({ ok: true, status: 200, ms: 1 }),
      create: (o) => demoSdk.create(toDemoOptions(o)),
      resume: (agentId, o) => demoSdk.resume(agentId, toDemoOptions(o)),
    });
    return {
      [PROVIDER_CURSOR]: wrap(PROVIDER_CURSOR),
      [PROVIDER_CLAUDE]: wrap(PROVIDER_CLAUDE),
      [PROVIDER_OPENAI]: wrap(PROVIDER_OPENAI),
    };
  }

  return {
    [PROVIDER_CURSOR]: createCursorProvider({
      apiKey: cursorApiKey,
      defaultModel: cursorModel || "auto",
      builtinTools,
    }),
    [PROVIDER_CLAUDE]: createClaudeProvider({
      apiKey: anthropicApiKey,
      defaultModel: claudeModel || "sonnet",
    }),
    [PROVIDER_OPENAI]: createOpenAIProvider({
      apiKey: openaiApiKey,
      baseUrl: openaiBaseUrl,
      defaultModel: openaiModel || "gpt-4o-mini",
      reasoningEffort: openaiReasoningEffort || "",
    }),
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
