import { t } from "./i18n.js";
// The server's resources read at a glance (GET /api/host) and the engines' state: what is worth a
// line at the bottom of the sidebar (owner 2026-10-18: «اگر منابع سرور خیلی درگیر بودن اعلام کنه»;
// later the same day: limits, spent credit, a filling disk there instead of the composer's gauge).
// Status colours only — never the install's palette: 74٪ CPU is orange whatever the brand is.

/** "ok" | "warn" | "danger" for a percentage (gauges, the context ring, the plan windows). */
export function loadLevel(percent) {
  const p = Number(percent);
  if (!Number.isFinite(p)) return "ok";
  return p >= 85 ? "danger" : p >= 60 ? "warn" : "ok";
}

// CPU jumps for a moment (a build, a test run): it is said only after this many readings in a row.
export const CPU_SUSTAIN = 3;
const fa = (n) => Math.round(Number(n) || 0).toLocaleString("fa-IR");

// Each alert: a plain headline that names nothing (owner 2026-10-18: a red line naming the account
// read as «my main account is finished») and its detail, shown only when the alert is opened.
// Orange (warn) for what waits or slows down; red (danger) only for what is broken now.
const LOAD = t("منابع سرور زیر فشار است");

/** What the sidebar says now: [{ key, sig, level: "warn"|"danger", text, detail }]. cpuStreak =
 *  readings in a row the CPU was at 90٪ or more, including this one. Memory and disk are said at once. */
export function hostAlerts(host, { cpuStreak = 0 } = {}) {
  if (!host) return [];
  if (host.available === false) return [{ key: "down", level: "warn", text: t("منابع سرور خوانده نمی‌شود"), detail: t("برنامه نتوانست مصرف پردازنده، حافظه و دیسک سرور را بخواند.") }];
  const out = [];
  const cpu = host.cpu?.percent;
  if (Number(cpu) >= 90 && cpuStreak >= CPU_SUSTAIN) out.push({ key: "cpu", sig: "cpu", level: "warn", text: LOAD, detail: t("پردازندهٔ سرور چند دقیقه است {fa}٪ درگیر است؛ پاسخ‌ها ممکن است کند شوند.", { fa: fa(cpu) }) });
  const mem = host.memory?.percent;
  if (Number(mem) >= 90) out.push({ key: "memory", sig: `memory:${mem >= 97 ? "danger" : "warn"}`, level: mem >= 97 ? "danger" : "warn", text: LOAD, detail: t("حافظهٔ سرور {fa}٪ پر است؛ اگر پر شود برنامه‌ها بسته می‌شوند.", { fa: fa(mem) }) });
  const disk = host.disk?.percent;
  // From 85٪: a disk fills up quietly, and a full one stops the database.
  if (Number(disk) >= 85) out.push({ key: "disk", sig: `disk:${disk >= 97 ? "danger" : "warn"}`, level: disk >= 97 ? "danger" : "warn", text: t("دیسک سرور در حال پر شدن است"), detail: t("دیسک سرور {fa}٪ پر است؛ وقتی پر شود گفتگوها و بکاپ‌ها ذخیره نمی‌شوند.", { fa: fa(disk) }) });
  return out;
}

const clock = (at, now) =>
  new Date(at).toLocaleString("fa-IR", { hour: "2-digit", minute: "2-digit", ...(at - now > 20 * 60 * 60_000 ? { weekday: "long" } : {}) });

/** The engines' lines (GET /api/engines/alerts; owner 2026-10-18): a plan limit with when it opens,
 *  a spent credit, and nothing usable at all. meanwhile = the engine that works in the meantime. */
export function engineAlerts(data, now = Date.now()) {
  if (!data) return [];
  const out = [];
  const meanwhile = data.meanwhile ? t("تا آن موقع کارها با {meanwhile} انجام می‌شود.", { meanwhile: data.meanwhile }) : t("فعلاً موتور آماده‌ای نیست و گفتگوها منتظر می‌مانند.");
  if (data.usable === false) out.push({ key: "engines:none", level: "danger", text: t("هیچ موتوری آماده نیست"), detail: t("همهٔ حساب‌ها به سقف خورده‌اند، اعتبارشان تمام شده یا وصل نیستند؛ گفتگوها تا آماده شدن یکی منتظر می‌مانند.") });
  for (const e of data.engines || []) {
    if (e.state === "limited") {
      // The plan says only when it opens: within five hours it is the 5-hour window, else the weekly one.
      const window = e.until && e.until - now <= 5 * 60 * 60_000 ? t("۵ ساعته") : t("هفتگی");
      out.push({ key: `engine:${e.id}`, sig: `engine:${e.id}:limited`, level: "warn", text: t("یکی از اکانت‌های شما به سقف مصرف رسیده است"), detail: t("حساب {name} به سقف مصرف {window} رسیده و {v} دوباره کار می‌کند. {meanwhile}", { name: e.name, window, v: e.until ? t("ساعت {clock}", { clock: clock(e.until, now) }) : t("بعد از باز شدن سقف"), meanwhile }) });
    } else if (e.state === "credit") {
      out.push({ key: `engine:${e.id}`, sig: `engine:${e.id}:credit`, level: "warn", text: t("اعتبار یکی از اکانت‌های شما تمام شده است"), detail: t("اعتبار (Credit) حساب {name} تمام شده؛ تا شارژ نشود آخر صف می‌ماند. {replace}", { name: e.name, replace: meanwhile.replace(t("تا آن موقع"), t("فعلاً")) }) });
    }
  }
  return out;
}

/** What «برام توضیحش بده» sends as the first message of a new chat on this install. */
export const explainPrompt = (a, product = "") =>
  t("در {v} این هشدار را دیدم: «{text}».\nجزئیات: {v2}\n\nبه زبان ساده توضیح بده یعنی چه و قدم‌به‌قدم کمکم کن حلش کنم (مثلاً موتور پیش‌فرض را عوض کنم، منتظر باز شدن سقف بمانم، حساب دیگری اضافه کنم یا دیسک را خالی کنم). اگر خودت می‌توانی بخشی را درست کنی، اول بگو چه می‌کنی.", { v: product || t("برنامه"), text: a.text, v2: a.detail || a.text });

// «متوجه شدم» on the sidebar's alerts (owner 2026-10-18): an alert seen once stays away for as long as
// the condition lasts. Its signature names the condition, never a moving number: the reset time of a
// limit is re-estimated (now + 1 h) every time an engine is tested or a run hits it, so a signature that
// carried it brought the alert back every five minutes (owner 2026-10-19: «هر ۵ دقیقه یه آلرتی که زدم
// چندین بار میاد»). A load that turns from orange to red is another condition; one that cleared and came
// back is a new occurrence (pruneDismissed forgets what is over).
// sig: what makes it the same alert (a CPU percent moving 91→92 is still the same one).
export const alertSig = (a) => a.sig || `${a.key}:${a.text}`;
/** The alerts not dismissed yet. */
export const unseenAlerts = (alerts, dismissed) => alerts.filter((a) => !dismissed.includes(alertSig(a)));
/** The dismissed list after «متوجه شدم» on these alerts (kept short: the newest 50). */
export const dismissAlerts = (alerts, dismissed) => [...new Set([...dismissed, ...alerts.map(alertSig)])].slice(-50);

// Below these a load counts as over (a little under the level that raises it, so a reading wobbling
// around the line does not raise the same alert again and again).
const CLEARED = { cpu: 70, memory: 85, disk: 80 };
// An engine's limit can lapse for a moment and come back (a passing test of a cheaper model clears the
// mark, the next run on the dear one sets it again): it is forgotten only after this long without it.
export const ENGINE_GRACE_MS = 30 * 60_000;
/** The dismissed list without what is over: an engine that has been usable for ENGINE_GRACE_MS, a load
 *  well below its level. Only a source that has been read counts (engines / host are null until their
 *  first answer). seen = when each dismissed engine alert was last active (sig -> ms), kept by the caller.
 *  Returns { dismissed, seen }. */
export function pruneDismissed(dismissed, { engines = null, host = null, seen = {}, now = Date.now(), grace = ENGINE_GRACE_MS } = {}) {
  const live = engines ? new Set(engineAlerts(engines, now).map(alertSig)) : null;
  const marks = { ...seen };
  const kept = dismissed.filter((sig) => {
    if (sig.startsWith("engine")) {
      if (!live) return true;
      if (live.has(sig)) {
        marks[sig] = now;
        return true;
      }
      // Never seen active here (dismissed before this was kept): the clock starts now.
      marks[sig] ??= now;
      if (now - marks[sig] < grace) return true;
      delete marks[sig];
      return false;
    }
    if (!host) return true;
    if (host.available === false) return true;
    if (sig.startsWith("down:")) return false;
    const family = sig.split(":")[0];
    if (!(family in CLEARED)) return true;
    const value = Number(host[family]?.percent);
    return !Number.isFinite(value) || value >= CLEARED[family];
  });
  for (const sig of Object.keys(marks)) if (!kept.includes(sig)) delete marks[sig];
  return { dismissed: kept, seen: marks };
}
