// The sidebar's «ورود دومرحله‌ای را روشن کنید» line (TwoStepNotice.jsx): offered to everyone who has
// not set it up, instead of forcing it (owner 2026-10-25: «برای همه پیشنهادش رو بده، پایین سایدبار بیاد»).
// «بعداً» puts it away for a week; it comes back until two-step sign-in is on.
export const NUDGE_LATER_KEY = "griffin.twoStep.later";
export const NUDGE_LATER_MS = 7 * 86_400_000;
// TwoStep.jsx raises it after every load, so the line goes the moment it is turned on.
export const TWO_STEP_EVENT = "griffin:2fa-state";

/** Whether the line shows: the state is known, two-step is off, and «بعداً» is not still running. */
export function showNudge(state, laterAt, now = Date.now()) {
  if (!state || state.failed || state.enabled) return false;
  const at = Number(laterAt);
  return !(at > 0 && now - at < NUDGE_LATER_MS);
}
