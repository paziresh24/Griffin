import { num, t } from "./i18n.js";

// What a running turn is doing right now, in the owner's words (run.phase + its detail).
// Engine-agnostic: the openai engine and Claude Code both report retries and closed limits.
const PHASES = { connecting: t("در حال اتصال"), working: t("در حال کار"), summarizing: t("خلاصه‌سازی") };
const LIMITS = {
  five_hour: t("سقف مصرف پنج‌ساعته"),
  seven_day: t("سقف مصرف هفتگی"),
  seven_day_opus: t("سقف مصرف هفتگی Opus"),
  seven_day_sonnet: t("سقف مصرف هفتگی Sonnet"),
};

function retryReason(status) {
  if (status == null) return t("اتصال برقرار نشد");
  if (status === 529 || status === 503) return t("سرور مدل شلوغ است");
  if (status === 429) return t("محدودیت نرخ درخواست");
  return t("خطای {n}", { n: num(status, { useGrouping: false }) });
}

const two = (n) => num(n, { minimumIntegerDigits: 2 });
const clock = (ms) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};

// How long after its announced wait a retry label still stands: then the request is through and
// simply being answered (nothing in the stream says "the retry worked").
const RETRY_GRACE_MS = 5_000;

/** phaseLabel(run.phase, run.phaseDetail, { at: run.phaseAt, now: Date.now() }) */
export function phaseLabel(phase, detail = null, { at = null, now = null } = {}) {
  if (phase === "retrying") {
    const since = at ? new Date(at).getTime() : NaN;
    if (now != null && Number.isFinite(since) && now > since + (Number(detail?.delayMs) || 0) + RETRY_GRACE_MS) return PHASES.working;
    if (!detail?.attempt) return t("تلاش دوباره");
    const reason = retryReason(detail.status ?? null);
    return detail.max
      ? t("تلاش دوباره ({n} از {max})؛ {reason}", { n: num(detail.attempt), max: num(detail.max), reason })
      : t("تلاش دوباره ({n})؛ {reason}", { n: num(detail.attempt), reason });
  }
  if (phase === "limited") {
    const which = LIMITS[detail?.limitType] || t("سقف مصرف");
    return detail?.resetsAt
      ? t("{which} پر شد؛ ساعت {time} باز می‌شود", { which, time: clock(detail.resetsAt) })
      : t("{which} پر شد", { which });
  }
  return PHASES[phase] || PHASES.working;
}
