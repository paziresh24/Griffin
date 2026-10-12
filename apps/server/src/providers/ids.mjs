// Provider ids + normalization, free of SDK imports so db/app layers can use them
// without pulling @cursor/sdk or the Claude Agent SDK into scope.
//
// An engine is an ACCOUNT of one KIND (cursor | claude | openai). The three base accounts keep the
// kind as their id, so old rows ("claude", "openai") stay valid; more accounts of a kind get ids
// like "claude-2" or "openai-openrouter" (owner 2026-10-12: a second Claude account, engines on/off).

export const PROVIDER_CURSOR = "cursor";
export const PROVIDER_CLAUDE = "claude";
export const PROVIDER_OPENAI = "openai";

export const KINDS = [PROVIDER_CURSOR, PROVIDER_CLAUDE, PROVIDER_OPENAI];
// Live list of account ids; mutated in place by setAccounts so every importer sees the change.
export const PROVIDER_IDS = [...KINDS];
const KIND_OF = new Map(KINDS.map((k) => [k, k]));

export const ACCOUNT_ID = /^(cursor|claude|openai)(-[a-z0-9]{1,24})?$/;

export function setAccounts(accounts) {
  KIND_OF.clear();
  PROVIDER_IDS.length = 0;
  for (const kind of KINDS) {
    KIND_OF.set(kind, kind);
    PROVIDER_IDS.push(kind);
  }
  for (const a of accounts || []) {
    if (!ACCOUNT_ID.test(a?.id || "") || KIND_OF.has(a.id)) continue;
    KIND_OF.set(a.id, a.id.split("-")[0]);
    PROVIDER_IDS.push(a.id);
  }
}

/** The kind (cursor | claude | openai) of an account id, or null. */
export const kindOf = (id) => KIND_OF.get(id) || null;

// A chat may pin a model of any account as "<account>:<model>" (UI model picker, 2026-10-08).
export function splitModel(id) {
  const m = String(id || "").match(/^((?:cursor|claude|openai)(?:-[a-z0-9]{1,24})?):(.+)$/);
  return m && KIND_OF.has(m[1]) ? { provider: m[1], model: m[2] } : null;
}

// Reasoning effort a chat or agent may ask for; providers map it to what they support.
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const effortOf = (value) => (EFFORTS.includes(value) ? value : null);

export function normalizeProvider(value) {
  return KIND_OF.has(value) ? value : PROVIDER_CURSOR;
}
