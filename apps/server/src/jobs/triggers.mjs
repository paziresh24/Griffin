import { randomBytes } from "node:crypto";
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

// An event from outside (a support system saying «a user wrote»). The URL token is the credential
// (like an incident webhook source). Only the listed `fields` of the body ever reach the agent — as
// short scalars — never the body itself, so a user's text inside an event cannot become an instruction.
//   token          generated once, kept on update
//   fields         dot paths copied from the body ("ticket.id"); at most 8
//   keyField       the field that names "the same thing" (a ticket): one run per key at a time,
//                  an event for a key that is running is coalesced and re-run once after it
//   actions        optional allow-list for body.action; other events are ignored
//   match          {path: value}: the event must carry all of these (e.g. the assignee), else it is ignored
//   maxConcurrent  runs of this job at once (1..10)
const PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,4}$/;
TRIGGERS.webhook = {
  label: "رویداد (وبهوک)",
  validate(config = {}) {
    const token = typeof config.token === "string" && /^[A-Za-z0-9_-]{24,64}$/.test(config.token) ? config.token : randomBytes(24).toString("base64url");
    const fields = (Array.isArray(config.fields) ? config.fields : []).map(String).filter((f) => PATH.test(f)).slice(0, 8);
    const keyField = typeof config.keyField === "string" && PATH.test(config.keyField) ? config.keyField : fields[0] || null;
    const actions = (Array.isArray(config.actions) ? config.actions : []).map(String).filter((a) => /^[A-Za-z0-9_]{1,60}$/.test(a)).slice(0, 20);
    const match = {};
    for (const [k, v] of Object.entries(config.match && typeof config.match === "object" ? config.match : {}).slice(0, 8)) {
      if (PATH.test(k) && ["string", "number"].includes(typeof v)) match[k] = String(v).slice(0, 60);
    }
    const n = Math.round(Number(config.maxConcurrent));
    return { token, fields, keyField, actions, match, maxConcurrent: Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 3 };
  },
  describe: (config) => `با هر رویداد وبهوک${config?.actions?.length ? ` (${config.actions.join("، ")})` : ""}`,
  nextAt: () => null,
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
