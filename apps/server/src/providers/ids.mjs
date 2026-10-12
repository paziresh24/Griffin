// Provider ids + normalization, free of SDK imports so db/app layers can use them
// without pulling @cursor/sdk or the Claude Agent SDK into scope.

export const PROVIDER_CURSOR = "cursor";
export const PROVIDER_CLAUDE = "claude";
export const PROVIDER_OPENAI = "openai";

export const PROVIDER_IDS = [PROVIDER_CURSOR, PROVIDER_CLAUDE, PROVIDER_OPENAI];

// A chat may pin a model of any provider as "<provider>:<model>" (UI model picker, 2026-10-08).
export function splitModel(id) {
  const m = String(id || "").match(/^(cursor|claude|openai):(.+)$/);
  return m ? { provider: m[1], model: m[2] } : null;
}

// Reasoning effort a chat or agent may ask for; providers map it to what they support.
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const effortOf = (value) => (EFFORTS.includes(value) ? value : null);

export function normalizeProvider(value) {
  return value === PROVIDER_CLAUDE || value === PROVIDER_OPENAI ? value : PROVIDER_CURSOR;
}
