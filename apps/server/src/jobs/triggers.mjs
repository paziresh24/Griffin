import { DEFAULT_TZ, formatDuration, nextCron, nextInterval, parseCron, parseDuration } from "./cron.mjs";

// What can start a job. Today: a schedule, or the owner pressing "run now". A new kind only has to
// provide validate/describe/nextAt here (plus, if it is event-driven, call jobs.run() from its own
// source) — the store, the runner, delivery and the UI stay the same.
//
//   nextAt(config, from) -> Date | null   null means "never on its own"

export class TriggerError extends Error {}

export const TRIGGERS = {
  schedule: {
    label: "زمان‌بندی",
    validate(config = {}) {
      const tz = typeof config.tz === "string" && config.tz ? config.tz : DEFAULT_TZ;
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        throw new TriggerError(`منطقهٔ زمانی «${tz}» معتبر نیست`);
      }
      if (config.cron) {
        try {
          parseCron(config.cron);
        } catch (error) {
          throw new TriggerError(error.message);
        }
        return { cron: String(config.cron).trim().replace(/\s+/g, " "), tz };
      }
      try {
        parseDuration(config.every ?? "30m");
      } catch (error) {
        throw new TriggerError(error.message);
      }
      return { every: String(config.every ?? "30m").trim(), tz };
    },
    describe(config) {
      if (config.cron) return `cron ${config.cron}`;
      return `هر ${formatDuration(parseDuration(config.every))}`;
    },
    nextAt(config, from) {
      return config.cron ? nextCron(config.cron, from, config.tz) : nextInterval(parseDuration(config.every), from, config.tz);
    },
  },

  manual: {
    label: "فقط دستی",
    validate: () => ({}),
    describe: () => "فقط وقتی خودت اجرا کنی",
    nextAt: () => null,
  },
};

export function validateTrigger(type, config) {
  const trigger = TRIGGERS[type];
  if (!trigger) throw new TriggerError(`تریگر «${type}» را نمی‌شناسم`);
  return trigger.validate(config || {});
}

export function describeTrigger(type, config) {
  try {
    return TRIGGERS[type]?.describe(config) ?? type;
  } catch {
    return type;
  }
}

export function nextTriggerAt(type, config, from = new Date()) {
  const trigger = TRIGGERS[type];
  if (!trigger) return null;
  try {
    return trigger.nextAt(config, from) || null;
  } catch {
    return null;
  }
}

export function triggerKinds() {
  return Object.entries(TRIGGERS).map(([type, t]) => ({ type, label: t.label }));
}
