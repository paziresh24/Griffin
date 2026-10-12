import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, navigate } from "../api.js";
import { textDir } from "../dir.js";
import { dayBars, formatTokens, labelledDays, modelOrder } from "../tokens-format.js";
import { locale, num, t } from "../i18n.js";

// Settings → "Token usage": what every chat consumed over time (GET /api/usage/tokens) —
// a bar per day stacked by model, then the same window by model and by chat. Every recorded turn:
// fresh input, output, and the cache written and read.

const RANGES = [7, 30, 90];
const COLOURS = ["var(--primary)", "var(--agent-platform)", "var(--warn)", "var(--agent-nsin)", "var(--bad)", "var(--muted-foreground)"];
const colour = (index) => COLOURS[Math.min(Math.max(index, 0), COLOURS.length - 1)];
const dayLabel = (date, options) => new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, { timeZone: "UTC", ...options });
const fa = (n) => num(Number(n || 0));
const share = (part, whole) => `${whole ? Math.round((part / whole) * 100) : 0}%`;

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2" title={hint}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <bdi className="ltr text-sm font-semibold">{formatTokens(value)}</bdi>
    </div>
  );
}

function DailyChart({ days, order }) {
  const bars = useMemo(() => dayBars(days, order), [days, order]);
  const labelled = labelledDays(bars.length);
  return (
    <div className="flex h-44 items-end gap-px rounded-2xl border bg-card p-3" dir="ltr" role="img" aria-label={t("مصرف روزانهٔ توکن به تفکیک مدل")}>
      {bars.map((bar, i) => (
        <div
          key={bar.date}
          className="flex h-full min-w-0 flex-1 flex-col items-center"
          title={`${dayLabel(bar.date, { weekday: "long", month: "long", day: "numeric" })}\n${t("{n} توکن", { n: formatTokens(bar.total) })}${bar.segments.map((s) => `\n${s.model}: ${formatTokens(s.tokens)}`).join("")}`}
        >
          <div className="flex w-full flex-1 items-end justify-center">
            <div className="flex w-full max-w-4 flex-col-reverse overflow-hidden rounded-t-sm" style={{ height: `${bar.height * 100}%` }}>
              {bar.segments.map((s) => <span key={s.model} style={{ flexGrow: s.share, background: colour(s.index) }} />)}
            </div>
          </div>
          <span className="mt-1 h-3 whitespace-nowrap text-[9px] text-muted-foreground">{labelled(i) ? dayLabel(bar.date, { month: "numeric", day: "numeric" }) : ""}</span>
        </div>
      ))}
    </div>
  );
}

function Table({ head, children }) {
  return (
    <div className="scrollbar-thin overflow-x-auto rounded-2xl border bg-card">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>{head.map((h) => <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

export function TokensSection() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    const load = () => api(`/api/usage/tokens?days=${days}`).then((body) => alive && setData(body), () => alive && setFailed(true));
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [days]);

  const order = useMemo(() => (data ? modelOrder(data.days) : []), [data]);
  const cell = "px-3 py-2";

  return (
    <div className="space-y-5">
      <div className="flex gap-1.5" role="group" aria-label={t("بازهٔ زمانی")}>
        {RANGES.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setDays(n)}
            aria-pressed={days === n}
            className={`press rounded-full border px-3 py-1 text-xs ${days === n ? "border-primary/40 bg-primary/10 font-medium" : "text-muted-foreground hover:bg-muted"}`}
          >
            {t("{n} روز", { n: fa(n) })}
          </button>
        ))}
      </div>

      {failed && !data ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("خوانده نشد. کمی بعد دوباره امتحان کنید.")}</p>
      ) : !data ? (
        <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : !data.totals.total ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("در این بازه مصرفی ثبت نشده است.")}</p>
      ) : (
        <div className={`space-y-5 ${data.range !== days ? "opacity-60" : ""}`}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label={t("کل")} value={data.totals.total} hint={t("همهٔ توکن‌های ثبت‌شده در این بازه")} />
            <Stat label={t("ورودی تازه")} value={data.totals.input} hint={t("متن تازه‌ای که به مدل رفته")} />
            <Stat label={t("خروجی")} value={data.totals.output} hint={t("آنچه مدل نوشته، با فکرکردنش")} />
            <Stat label={t("نوشتن در کش")} value={data.totals.cacheWrite} hint={t("متنی که برای استفادهٔ دوباره ذخیره شده")} />
            <Stat label={t("خواندن از کش")} value={data.totals.cacheRead} hint={t("متن ذخیره‌شده‌ای که دوباره خوانده شده؛ معمولاً بیشترین سهم و ارزان‌ترین")} />
          </div>

          <DailyChart days={data.days} order={order} />
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {order.map((model, index) => (
              <li key={model} className="flex items-center gap-1.5">
                <i className="inline-block size-2.5 rounded-sm" style={{ background: colour(index) }} aria-hidden />
                <bdi className="ltr">{model}</bdi>
              </li>
            ))}
          </ul>

          <Table head={[t("مدل"), t("کل"), t("سهم"), t("ورودی"), t("خروجی"), t("نوبت")]}>
            {data.byModel.map((m) => (
              <tr key={m.model}>
                <td className={cell}><bdi className="ltr">{m.model}</bdi></td>
                <td className={`${cell} ltr`}>{formatTokens(m.total)}</td>
                <td className={`${cell} ltr`}>{share(m.total, data.totals.total)}</td>
                <td className={`${cell} ltr`}>{formatTokens(m.input + m.cacheWrite + m.cacheRead)}</td>
                <td className={`${cell} ltr`}>{formatTokens(m.output)}</td>
                <td className={cell}>{fa(m.turns)}</td>
              </tr>
            ))}
          </Table>

          <Table head={[t("گفتگو"), t("کل"), t("سهم"), t("مدل"), t("نوبت")]}>
            {data.byChat.map((c) => (
              <tr key={c.chatId}>
                <td className={`${cell} max-w-56`}>
                  <button type="button" className="block max-w-full truncate text-start hover:underline" dir={textDir(c.title || t("گفتگو"))} onClick={() => navigate(c.chatId)}>
                    {c.title || t("گفتگو")}
                  </button>
                </td>
                <td className={`${cell} ltr`}>{formatTokens(c.total)}</td>
                <td className={`${cell} ltr`}>{share(c.total, data.totals.total)}</td>
                <td className={cell}><bdi className="ltr">{c.models.join(" · ")}</bdi></td>
                <td className={cell}>{fa(c.turns)}</td>
              </tr>
            ))}
          </Table>
          <p className="text-xs leading-6 text-muted-foreground">
            {data.chatCount > data.byChat.length ? `${t("{shown} گفتگوی پرمصرف از {total}.", { shown: fa(data.byChat.length), total: fa(data.chatCount) })} ` : ""}
            {t("روزها به وقت")} <bdi className="ltr">{data.timeZone}</bdi> {t("است. «ورودی» در جدول مدل‌ها متن تازه و کش را با هم می‌شمارد.")}
          </p>
        </div>
      )}
    </div>
  );
}
