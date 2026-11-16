// Mirror of apps/server/src/model-policy.mjs: Sonnet at «medium» is the default; a stronger model or a
// higher effort is chosen by hand and confirmed a second time.
// The install's MODEL_HOLD (brand info, brand.js): off = no second confirmation, the chosen model runs.
let held = false;
export const setModelHold = (value) => {
  held = Boolean(value);
};
export const modelHeld = () => held;
export const isHeavyModel = (id) => {
  if (!held) return false;
  const name = String(id || "").replace(/^(?:cursor|claude|openai)(?:-[a-z0-9]{1,24})?:/, "").toLowerCase();
  if (!name || name === "auto" || /sonnet|haiku/.test(name)) return false;
  return /opus|fable|^claude/.test(name);
};
export const isHeavyEffort = (effort) => held && ["high", "xhigh", "max"].includes(effort);
export const DEFAULT_EFFORT = "medium";
