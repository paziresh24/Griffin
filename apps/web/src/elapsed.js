import { locale, num, t } from "./i18n.js";

// Elapsed time written in full, as shown when the pointer rests on a message: «۲ ساعت و ۳ دقیقه
// پیش» — two units at most, never abbreviated (the sidebar's short «۲ ساعت» is a different job).
export function fullAgo(stamp, now = new Date()) {
  const at = stamp ? new Date(stamp).getTime() : NaN;
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor(Math.max(0, now.getTime() - at) / 60_000);
  if (minutes < 1) return t("چند لحظه پیش");
  if (minutes < 60) return t("{n} دقیقه پیش", { n: num(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60
    ? t("{h} ساعت و {m} دقیقه پیش", { h: num(hours), m: num(minutes % 60) })
    : t("{n} ساعت پیش", { n: num(hours) });
  const days = Math.floor(hours / 24);
  if (days < 30 && hours % 24) return t("{d} روز و {h} ساعت پیش", { d: num(days), h: num(hours % 24) });
  return t("{n} روز پیش", { n: num(days) });
}

// The exact local date and time, for the same tooltip.
export function exactTime(stamp) {
  const at = stamp ? new Date(stamp) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}
