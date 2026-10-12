import path from "node:path";

// Settings the owner changed in the UI (Settings → Configuration, config.mjs) win over the env.
let overrides = null;
export function setConfigOverrides(read) {
  overrides = read;
}

// Product env: every knob is GRIFFIN_<KEY>.
export function genv(key, fallback = undefined, env = process.env) {
  const set = env === process.env ? overrides?.()?.[key] : undefined;
  if (set !== undefined && set !== "") return set;
  const v = env[`GRIFFIN_${key}`];
  return v === undefined || v === "" ? fallback : v;
}

/** The SQLite file, GRIFFIN_DB or <data>/griffin.sqlite. */
export function resolveDbPath(dataDir, env = process.env) {
  return genv("DB", undefined, env) || path.join(dataDir, "griffin.sqlite");
}
