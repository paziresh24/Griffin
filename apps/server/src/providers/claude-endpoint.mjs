// A Claude-kind engine account that runs Claude Code against another vendor's Anthropic-compatible
// endpoint: the chat keeps the whole
// Claude Code harness — Bash, skills, hooks, MCP, sessions and resume — and only the env of its
// query() changes: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, plus every model slot Claude Code reads
// (main, opus/sonnet/haiku/fable aliases, small/fast, subagent), so nothing silently falls back to
// Anthropic. Switched on per account: kv "provider:<id>" { "endpoint": "<preset id>" } on a claude-*
// account. An account without it is a plain Claude account, exactly as before.

export const CLAUDE_ENDPOINTS = [
  {
    id: "zai",
    label: "GLM (Z.ai)",
    baseUrl: "https://api.z.ai/api/anthropic",
    // The key the Z.ai preset of the OpenAI-compatible engine already reads (index.mjs OPENAI_PRESETS).
    keyFile: "zai.api-key",
    // The vendor's own ids and case.
    defaultModel: "GLM-5.3-Flash",
    smallModel: "GLM-5.3-Flash",
    models: [
      { id: "GLM-5.3-Flash", name: "GLM-5.3-Flash", contextWindow: 200_000 },
      { id: "GLM-5.3", name: "GLM-5.3", contextWindow: 200_000 },
    ],
  },
  // Other Anthropic-compatible vendors.
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    // The same key the OpenRouter preset of the OpenAI-compatible engine reads.
    keyFile: "openrouter.api-key",
    defaultModel: "z-ai/glm-4.6",
    models: [
      { id: "z-ai/glm-4.6", name: "z-ai/glm-4.6", contextWindow: 200_000 },
      { id: "anthropic/claude-sonnet-4.5", name: "anthropic/claude-sonnet-4.5", contextWindow: 200_000 },
      { id: "deepseek/deepseek-chat", name: "deepseek/deepseek-chat", contextWindow: 128_000 },
    ],
  },
  // Any Anthropic-compatible endpoint: base URL, model, small model and window come from the
  // account's own settings (kv "provider:<id>" baseUrl/model/smallModel/contextWindow).
  { id: "custom", label: "Custom endpoint", baseUrl: "", defaultModel: "", models: [] },
];

/** The endpoint preset an account's settings name, or null (a plain Claude account). */
export function endpointOf(config) {
  const id = config?.endpoint;
  const preset = (id && CLAUDE_ENDPOINTS.find((e) => e.id === id)) || null;
  if (preset?.id !== "custom") return preset;
  const model = String(config.model || "");
  const window = Number(config.contextWindow) > 0 ? Number(config.contextWindow) : null;
  return {
    ...preset,
    baseUrl: String(config.baseUrl || ""),
    defaultModel: model,
    ...(config.smallModel ? { smallModel: String(config.smallModel) } : {}),
    models: model ? [{ id: model, name: model, contextWindow: window }] : [],
  };
}

// Claude's own aliases and ids mean "this endpoint's default" (an agent profile's "opus" left over).
const CLAUDE_ID = /^(opus|sonnet|haiku|fable|claude-.*)$/i;
export function endpointModel(endpoint, requested) {
  const id = String(requested || "").trim();
  return !id || id === "auto" || CLAUDE_ID.test(id.replace(/\[1m\]$/i, "")) ? endpoint.defaultModel : id;
}

// Env names Claude Code reads for an endpoint, model slots and the compaction window. A host env may
// carry any of them (a Z.ai shell); they are all replaced, never inherited.
export const ENDPOINT_ENV_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  // Routes and headers that would send the run elsewhere or add someone else's credentials.
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

// Claude Code does not know a non-Claude model's window, assumes its default, and may compact only
// after the real limit ("Prompt is too long"): CLAUDE_CODE_AUTO_COMPACT_WINDOW says it.
const windowOf = (endpoint, model) => endpoint.models.find((m) => m.id === model)?.contextWindow || null;

/** The env of one run on the endpoint: the host env without any Anthropic login or override. */
export function endpointEnv(endpoint, key, model, base = process.env) {
  // A custom account with no base URL must never fall through to Anthropic with the vendor's key.
  if (!endpoint.baseUrl) throw new Error(`${endpoint.label}: no base URL set for this account`);
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  for (const name of Object.keys(env)) if (ENDPOINT_ENV_VARS.includes(name) || /^ANTHROPIC_DEFAULT_[A-Z0-9_]*_MODEL$/.test(name)) delete env[name];
  const small = endpoint.smallModel || model;
  const window = windowOf(endpoint, model);
  return {
    ...env,
    ...(window ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) } : {}),
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    ANTHROPIC_SMALL_FAST_MODEL: small,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

// Z.ai's spent plan, as Claude Code passes the API error on: «Usage limit reached for 5 hour. Your
// limit will reset at …» (1308), «Weekly/Monthly Limit Exhausted» (1310), or the body code itself.
// A plain rate limit (1302, «Rate limit reached for requests») is not a spent plan.
const ZAI_PLAN_LIMIT = /usage limit reached|limit exhausted|"code"\s*:\s*"?13(08|10)\b/i;
export const isEndpointPlanLimit = (message) => ZAI_PLAN_LIMIT.test(String(message || ""));

/**
 * PATCH /api/providers/:id { endpoint }: the account's next settings, or { error }. The base claude
 * account stays on Claude. A key stored for this account belongs to its current vendor, so the
 * endpoint is not switched under it (an Anthropic token would go to Z.ai, or the reverse): remove
 * the account or its key first. Only the preset's own key file goes with the endpoint.
 */
export function endpointSettings(current, value, { base = false, hasSecret = false } = {}) {
  const preset = value ? CLAUDE_ENDPOINTS.find((e) => e.id === value) : null;
  if (value && !preset) return { error: "unknown endpoint" };
  const was = endpointOf(current);
  if ((was?.id || null) === (preset?.id || null)) return { next: { ...current } };
  if (base) return { error: "the base Claude account stays on Claude; add a claude-* account for an endpoint" };
  if (hasSecret) return { error: "this account holds a key for its current vendor; remove it (or the account) before changing the endpoint" };
  const next = { ...current };
  if (was && next.keyFile === was.keyFile) delete next.keyFile;
  if (preset) Object.assign(next, { endpoint: preset.id, keyFile: preset.keyFile });
  else delete next.endpoint;
  return { next };
}

/** Z.ai plan windows (5-hour + weekly) from the account host, for the usage panel. */
export async function zaiQuota(baseUrl, key, fetchImpl = fetch) {
  const origin = String(baseUrl).replace(/\/api\/.*$/, "");
  const response = await fetchImpl(`${origin}/api/monitor/usage/quota/limit`, {
    method: "GET",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return { ok: false, status: response.status, windows: [] };
  const limits = (await response.json())?.data?.limits || [];
  // Observed (pro plan): unit 3 + number 5 = the 5-hour window, unit 6 + number 1 = weekly.
  const label = (l) => (l.unit === 3 ? `${l.number} ساعته` : l.unit === 6 ? (l.number === 1 ? "هفتگی" : `${l.number} هفته`) : l.unit === 5 ? "روزانه" : `${l.number}×${l.unit}`);
  return {
    ok: true,
    status: response.status,
    windows: limits.map((l) => ({
      label: label(l),
      used: l.currentValue ?? 0,
      limit: l.usage ?? null,
      remaining: l.remaining ?? null,
      percentage: l.percentage ?? null,
      resetAt: l.nextResetTime || null,
    })),
  };
}
