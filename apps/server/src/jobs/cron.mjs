// Wall-clock helpers for schedules. Everything is computed in a named time zone (the owner thinks in
// Tehran time), without pulling in a date library: the zone offset is read once from Intl and the
// arithmetic then happens on a shifted timestamp.

export const DEFAULT_TZ = "Asia/Tehran";
const MINUTE = 60_000;
const DAY = 86_400_000;

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dom", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dow", min: 0, max: 7 },
];

export function tzOffsetMs(date, timeZone = DEFAULT_TZ) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// "30m", "2h", "90s", "1d" -> milliseconds
export function parseDuration(value) {
  const match = /^(\d{1,5})\s*(s|m|h|d)$/.exec(String(value || "").trim());
  if (!match) throw new Error("فاصله باید مثل 30m یا 2h یا 1d باشد");
  const ms = Number(match[1]) * { s: 1000, m: MINUTE, h: 3_600_000, d: DAY }[match[2]];
  if (ms < MINUTE) throw new Error("کمترین فاصله یک دقیقه است");
  return ms;
}

export function formatDuration(ms) {
  if (ms % DAY === 0) return `${ms / DAY} روز`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} ساعت`;
  return `${Math.round(ms / MINUTE)} دقیقه`;
}

// Next tick of a fixed interval, aligned to the local day so "every 30m" lands on :00 and :30.
export function nextInterval(ms, from, timeZone = DEFAULT_TZ) {
  if (ms >= DAY) return new Date(from.getTime() + ms);
  const offset = tzOffsetMs(from, timeZone);
  const local = from.getTime() + offset;
  const dayStart = Math.floor(local / DAY) * DAY;
  const next = dayStart + (Math.floor((local - dayStart) / ms) + 1) * ms;
  return new Date(next - offset);
}

export function parseCron(expression) {
  const parts = String(expression || "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron باید ۵ بخش باشد: دقیقه ساعت روز ماه روزهفته");
  return FIELDS.map((field, i) => ({ ...field, values: parseField(parts[i], field), wildcard: parts[i] === "*" }));
}

function parseField(text, field) {
  const values = new Set();
  for (const piece of String(text).split(",")) {
    const [range, stepText] = piece.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`گام نامعتبر در «${piece}»`);
    let start;
    let end;
    if (range === "*") {
      start = field.min;
      end = field.max;
    } else if (range.includes("-")) {
      [start, end] = range.split("-").map(Number);
    } else {
      start = Number(range);
      end = stepText === undefined ? start : field.max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < field.min || end > field.max || start > end) {
      throw new Error(`مقدار نامعتبر «${piece}» برای ${field.name}`);
    }
    for (let v = start; v <= end; v += step) values.add(field.name === "dow" && v === 7 ? 0 : v);
  }
  if (!values.size) throw new Error(`مقدار خالی برای ${field.name}`);
  return values;
}

function matches(fields, localDate) {
  const [minute, hour, dom, month, dow] = fields;
  if (!minute.values.has(localDate.getUTCMinutes())) return false;
  if (!hour.values.has(localDate.getUTCHours())) return false;
  if (!month.values.has(localDate.getUTCMonth() + 1)) return false;
  const domOk = dom.values.has(localDate.getUTCDate());
  const dowOk = dow.values.has(localDate.getUTCDay());
  // Standard cron: when both day fields are restricted, either one matching is enough.
  if (dom.wildcard && dow.wildcard) return true;
  if (dom.wildcard) return dowOk;
  if (dow.wildcard) return domOk;
  return domOk || dowOk;
}

function dayMatches(fields, localDate) {
  const [, , dom, month, dow] = fields;
  if (!month.values.has(localDate.getUTCMonth() + 1)) return false;
  if (dom.wildcard && dow.wildcard) return true;
  const domOk = dom.values.has(localDate.getUTCDate());
  const dowOk = dow.values.has(localDate.getUTCDay());
  if (dom.wildcard) return dowOk;
  if (dow.wildcard) return domOk;
  return domOk || dowOk;
}

export function nextCron(expression, from, timeZone = DEFAULT_TZ) {
  const fields = parseCron(expression);
  const offset = tzOffsetMs(from, timeZone);
  // Work in "local time pretending to be UTC", then shift back at the end.
  let local = new Date(Math.floor((from.getTime() + offset) / MINUTE) * MINUTE + MINUTE);
  for (let guard = 0; guard < 4 * 366; guard += 1) {
    if (!dayMatches(fields, local)) {
      local = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1));
      continue;
    }
    const endOfDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
    for (; local.getTime() < endOfDay; local = new Date(local.getTime() + MINUTE)) {
      if (!matches(fields, local)) continue;
      const utc = local.getTime() - offset;
      // A zone change between now and then (DST elsewhere) shifts the wall-clock target.
      const realOffset = tzOffsetMs(new Date(utc), timeZone);
      return new Date(local.getTime() - realOffset);
    }
  }
  return null;
}

export function formatLocal(date, timeZone = DEFAULT_TZ) {
  return new Intl.DateTimeFormat("fa-IR", { timeZone, dateStyle: "short", timeStyle: "short" }).format(date);
}
