// Provider ids + normalization, free of SDK imports so db/app layers can use them
// without pulling @cursor/sdk or the Claude Agent SDK into scope.

export const PROVIDER_CURSOR = "cursor";
export const PROVIDER_CLAUDE = "claude";
export const PROVIDER_OPENAI = "openai";

export const PROVIDER_IDS = [PROVIDER_CURSOR, PROVIDER_CLAUDE, PROVIDER_OPENAI];

export function normalizeProvider(value) {
  return value === PROVIDER_CLAUDE || value === PROVIDER_OPENAI ? value : PROVIDER_CURSOR;
}
