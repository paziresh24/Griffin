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

// The exact local date and time (weekday, date, seconds), for the tooltip on every time label.
export function exactTime(stamp) {
  const at = stamp ? new Date(stamp) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(locale, { dateStyle: "full", timeStyle: "medium" });
}

// When, as a clock — the time itself, the exact one on hover — rather than «۳ دقیقه پیش»:
// today «۱۴:۰۳», yesterday «دیروز ۱۴:۰۳», this year «۲۱ مهر ۱۴:۰۳», else «۲۱ مهر ۱۴۰۴».
export function clockLabel(stamp, now = new Date()) {
  const at = stamp ? new Date(stamp) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  const clock = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (at.toDateString() === now.toDateString()) return clock;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return t("دیروز {clock}", { clock });
  const year = (d) => d.toLocaleDateString(`${locale}-u-nu-latn`, { year: "numeric" });
  const day = at.toLocaleDateString(locale, { day: "numeric", month: "long" });
  return year(at) === year(now) ? `${day} ${clock}` : at.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
}
