// Owner 2026-11-02: every chat runs on Sonnet with effort «medium» by default, in every mode. A
// stronger model (Opus, Fable …) or a higher effort (high, xhigh, max) is a manual choice that the
// owner confirms a second time; the confirmation is kept per chat (kv heavyok:<chatId>). Nothing else
// moves a chat there: not an agent profile's default, TEAM_/PEER_ routing, nor UPGRADE_MODEL.
export const DEFAULT_MODEL = "sonnet";
export const DEFAULT_EFFORT = "medium";

const ACCOUNT = /^(?:cursor|claude|openai)(?:-[a-z0-9]{1,24})?:/;
const bare = (id) => String(id || "").replace(ACCOUNT, "");

// Anything on the Claude side that is not Sonnet or Haiku costs more of the plan than the default.
export function isHeavyModel(id) {
  const name = bare(id).toLowerCase();
  if (!name || name === "auto") return false;
  if (/sonnet|haiku/.test(name)) return false;
  return /opus|fable|^claude/.test(name);
}

export const isHeavyEffort = (effort) => ["high", "xhigh", "max"].includes(effort);

export const heavyKey = (chatId) => `heavyok:${chatId}`;

// What a request asks for that needs the second confirmation: [] when nothing does.
export function needsConfirm({ model, effort }) {
  const what = [];
  if (isHeavyModel(model)) what.push("model");
  if (isHeavyEffort(effort)) what.push("effort");
  return what;
}

// One candidate of a plain Claude login ({ provider, model, effort }) held to the defaults unless the
// chat's own heavy choice was confirmed ({ model: bool, effort: bool }).
export function clampCandidate(candidate, ok = {}) {
  let { model, effort } = candidate;
  if (isHeavyModel(model) && !ok.model) model = DEFAULT_MODEL;
  if (!effort || (isHeavyEffort(effort) && !ok.effort)) effort = DEFAULT_EFFORT;
  return { ...candidate, model, effort };
}

// What a chat's picker shows: the same clamp the run goes through, so the two can never differ (a
// chat pinned on Opus before this policy said Opus while it ran Sonnet, 2026-11-02 to 11-04).
export function shownChoice({ model, effort }, ok = {}) {
  const run = clampCandidate({ model, effort }, ok);
  const account = run.model === model ? "" : String(model || "").match(ACCOUNT)?.[0] || "";
  return { model: run.model ? account + run.model : run.model, effort: run.effort };
}
