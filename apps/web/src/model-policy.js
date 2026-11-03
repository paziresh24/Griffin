// Mirror of apps/server/src/model-policy.mjs: Sonnet at «medium» is the default; a stronger model or a
// higher effort is chosen by hand and confirmed a second time.
export const isHeavyModel = (id) => {
  const name = String(id || "").replace(/^(?:cursor|claude|openai)(?:-[a-z0-9]{1,24})?:/, "").toLowerCase();
  if (!name || name === "auto" || /sonnet|haiku/.test(name)) return false;
  return /opus|fable|^claude/.test(name);
};
export const isHeavyEffort = (effort) => ["high", "xhigh", "max"].includes(effort);
