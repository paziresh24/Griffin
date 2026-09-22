import path from "node:path";

// Product env: every knob is GRIFFIN_<KEY>.
export function genv(key, fallback = undefined, env = process.env) {
  const v = env[`GRIFFIN_${key}`];
  return v === undefined || v === "" ? fallback : v;
}

/** The SQLite file, GRIFFIN_DB or <data>/griffin.sqlite. */
export function resolveDbPath(dataDir, env = process.env) {
  return genv("DB", undefined, env) || path.join(dataDir, "griffin.sqlite");
}
