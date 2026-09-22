// Product env: every knob is GRIFFIN_<KEY>.
export function genv(key, fallback = undefined, env = process.env) {
  const v = env[`GRIFFIN_${key}`];
  return v === undefined || v === "" ? fallback : v;
}
