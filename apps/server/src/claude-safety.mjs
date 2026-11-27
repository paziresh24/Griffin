// Hardening switches for the subscription (OAuth) Claude accounts (owner 2026-11-25).
//
// Five Ultra accounts were banned and every one of them had been used through Griffin. The
// anti-fraud system there does not read the chats: it reads the *shape* of the traffic. What we
// found in this codebase was, in its own terms, a textbook pattern — an account polled every 15
// minutes for its usage, a raw HTTP call with a subscription bearer token every 6 hours, a test
// message with a one-word prompt, a "Persian" language knob on every send, one rotating exit IP
// shared by every account and every install, the full rulebook appended to the system prompt, and
// background jobs (titles, summaries, subagents, cron) burning the plan around the clock.
//
// Nothing here is deleted. Each behaviour keeps its code and gets a switch whose DEFAULT is the
// quiet one, so an install that wants the old behaviour back sets the key and gets it exactly as
// it was. `genv` is injected so this module stays pure and testable.
//
// Keys (all read through genv, so Settings → Configuration can change them without a redeploy):
//   CLAUDE_USAGE_POLL      on|off  default off — read every account's plan windows on a timer
//   CLAUDE_PROBE           on|off  default off — spend a real message to test an account's health
//   CLAUDE_TOKEN_KEEPER    on|off  default off — renew a folder login's token ahead of time (kept)
//   CLAUDE_ORG_LOOKUP      on|off  default off — one raw Anthropic call per key for the account id
//   CLAUDE_LANGUAGE_FLAG   on|off  default off — send settings.language on every run
//   CLAUDE_TELEMETRY       on|off  default off — let Claude Code report usage/errors to Anthropic
//   CLAUDE_PROMPT_APPEND   on|off  default on  — append Griffin's rulebook to the system prompt
//   CLAUDE_MAX_CONCURRENT  <n>     default 2    — runs allowed at once on one OAuth account
//   CLAUDE_BACKGROUND_OFF  on|off  default on   — keep background work off subscription accounts
//   CLAUDE_WARMUP          on|off  default on   — soft daily cap for a brand-new account

/** Whether a stored provider secret is a subscription (OAuth / login-dir) plan to pace, vs an API key. */
export const isSubscriptionKey = (key) => {
  const k = String(key || "");
  return k.startsWith("sk-ant-oat") || k === "claude-code-login" || k.startsWith("claude-login:");
};

/** Read a boolean switch the way every other setting is read: only "on" means on. */
export const on = (genv, key) => genv(key, "off") === "on";
/** Read a boolean switch whose default is the loud behaviour (opt-out). */
export const notOff = (genv, key) => genv(key, "on") !== "off";

/**
 * Every switch in one place, resolved against the install's settings. Call it where the decision
 * is made (not once at boot) so a change in Settings takes effect on the next send.
 */
export function claudeSafety(genv) {
  const backgroundOff = notOff(genv, "CLAUDE_BACKGROUND_OFF");
  return {
    // 4 — the 15-minute plan poll. Off: load comes only from what the account's own runs report,
    // and a person can still press «تازه‌سازی» (POST /api/providers/:id/usage) for one account.
    usagePoll: on(genv, "CLAUDE_USAGE_POLL"),
    // 5 — a probe that sends a real message just to see whether the account answers. Off: only a
    // person pressing «تست» on the Engines page probes, and a run's own failure is the signal.
    healthProbe: on(genv, "CLAUDE_PROBE"),
    // Token renwal ahead of time keeps its own switch (it was already opt-in).
    tokenKeeper: on(genv, "CLAUDE_TOKEN_KEEPER"),
    // A raw `/v1/models` call with a subscription token, every 6 hours, for the account id. Off:
    // the org shows only if the account's own run already reported it.
    orgLookup: on(genv, "CLAUDE_ORG_LOOKUP"),
    // `settings: { language: "Persian" }` on every send is not something the official client sets for a
    // normal session (opt-in via CLAUDE_LANGUAGE_FLAG=on, matching config.mjs). Persian replies stay
    // enforced by the prompt, UserPromptSubmit hook, silent-turn reminder, and Stop hook.
    languageFlag: on(genv, "CLAUDE_LANGUAGE_FLAG"),
    // Claude Code's own telemetry. Off: DISABLE_TELEMETRY and friends in the run's env.
    telemetry: on(genv, "CLAUDE_TELEMETRY"),
    // The rulebook is appended to the system prompt by default (it is how the agent knows its
    // job); a hardened install moves it into the workspace instead.
    promptAppend: notOff(genv, "CLAUDE_PROMPT_APPEND"),
    // Background work is what makes a plan look like a farm rather than a person.
    backgroundOff,
    // How many runs may sit on ONE subscription account at the same time.
    maxConcurrent: (() => {
      const n = Number(genv("CLAUDE_MAX_CONCURRENT", "2"));
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
    })(),
    // A brand-new account that immediately burns a full weekly window is the loudest pattern of
    // all; the first days stay under softCapPercent.
    warmup: notOff(genv, "CLAUDE_WARMUP"),
    warmupDailyPercent: Number(genv("CLAUDE_WARMUP_DAILY_PERCENT", "35")) || 35,
    warmupDays: Number(genv("CLAUDE_WARMUP_DAYS", "3")) || 3,
  };
}

/**
 * Environment for a Claude Code run: telemetry off unless asked for, and never a settings knob
 * that the official client would not set for itself.
 *
 * `ANTHROPIC_*` values here only ever *remove* reporting; none of them change what the model
 * answers, so an install can turn them off without losing a capability.
 */
export function hardenedEnv(base, flags) {
  const env = { ...base };
  if (!flags.telemetry) {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.DISABLE_TELEMETRY = "1";
    env.DISABLE_ERROR_REPORTING = "1";
    env.DISABLE_AUTOUPDATER = "1";
  }
  return env;
}

/** The `settings` block of a Claude Code send, with the language knob only if it was asked for. */
export function sendSettings(flags, rest = {}) {
  const { language, ...keep } = rest;
  return flags.languageFlag && language ? { language, ...keep } : keep;
}

/**
 * Is this account allowed one more run right now?
 *   concurrent -> how many runs it already has in flight
 *   load       -> its plan load 0-100 (null = unknown)
 *   ageDays    -> how long ago the account was added
 * Returns {ok:true} or {ok:false, reason}.
 */
export function admission(flags, { concurrent = 0, load = null, ageDays = null } = {}) {
  if (concurrent >= flags.maxConcurrent) return { ok: false, reason: "concurrent" };
  if (flags.warmup && ageDays != null && ageDays < flags.warmupDays && load != null && load >= flags.warmupDailyPercent) {
    return { ok: false, reason: "warmup" };
  }
  return { ok: true };
}

/**
 * The load above which an account takes no NEW work (never a run already on it). A plan pushed to its
 * last breath is the «burn the week to the end» pattern: a run that starts at 95% hits the wall halfway
 * through anyway, and a subscription that is always at 99% does not look like a person's.
 */
/**
 * The load above which an account takes no NEW work (never a run already on it): a plan pushed to its
 * last breath is the «burn the week to the end» pattern — a run starting at 95% hits the wall halfway
 * through anyway, and a subscription always at 99% does not look like a person's.
 */
export const SOFT_CAP = 92;
