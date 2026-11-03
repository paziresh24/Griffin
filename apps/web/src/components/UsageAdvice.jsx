import { useEffect, useState } from "react";
import { Gauge, Sparkles, X } from "lucide-react";
import { api } from "../api.js";
import { locale, t } from "../i18n.js";

// One short line on top of the message box, the way Claude shows its usage notice (owner 2026-11-02:
// «مثل کلاد بیارش بالای باکس پیام»). Server: usage-advice.mjs, GET /api/chats/:id/advice.
//  - this chat has run light turns on a heavy model: Sonnet would do (with a one-tap switch);
//  - otherwise, the last 24 hours cost far more than the usual day.
// One line at a time; × hides the chat's suggestion for good, the spend line for the day.
const fa = (n) => Number(n || 0).toLocaleString(locale);
const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key) => {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* a private window keeps nothing: the line comes back next time */
  }
};
const today = () => new Date().toISOString().slice(0, 10);

export function UsageAdvice({ chatId, running, onModelChange }) {
  const [advice, setAdvice] = useState(null);
  const [, setGone] = useState(0);
  useEffect(() => {
    setAdvice(null);
    if (!chatId || running) return undefined;
    let live = true;
    api(`/api/chats/${chatId}/advice`).then((a) => live && setAdvice(a), () => {});
    return () => {
      live = false;
    };
  }, [chatId, running]);
  const modelKey = `griffin.advice.model.${chatId}`;
  const spendKey = `griffin.advice.spend.${today()}`;
  const close = (key) => {
    write(key);
    setGone((n) => n + 1);
  };
  let line = null;
  if (advice?.model && !read(modelKey)) {
    line = {
      icon: Sparkles,
      text: t("این گفتگو با Sonnet هم پیش می‌رود و ارزان‌تر است."),
      title: t("{runs} نوبت آخر با مدل سنگین کار سبکی بود (میانگین {tools} ابزار در هر نوبت).", { runs: fa(advice.model.runs), tools: fa(advice.model.avgTools) }),
      action: onModelChange ? { label: t("تغییر به Sonnet"), run: () => { close(modelKey); onModelChange("sonnet"); } } : null,
      key: modelKey,
    };
  } else if (advice?.spend && !read(spendKey)) {
    line = {
      icon: Gauge,
      text: t("امروز {ratio} برابر همیشه مصرف کرده‌اید.", { ratio: fa(advice.spend.ratio) }),
      title: t("۲۴ ساعت اخیر حدود {today} دلار به قیمت API؛ روز معمول {baseline} دلار. {share}٪ آن Opus و مدل‌های سنگین بوده.", { today: fa(advice.spend.today), baseline: fa(advice.spend.baseline), share: fa(advice.spend.heavyShare) }),
      action: null,
      key: spendKey,
    };
  }
  if (!line) return null;
  const Icon = line.icon;
  return (
    <div className="mx-3 -mb-px flex items-center gap-2 rounded-t-xl border border-b-0 bg-muted/70 px-3 py-1.5 text-xs text-muted-foreground" title={line.title} data-testid="usage-advice">
      <Icon className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-foreground">{line.text}</span>
      {line.action ? (
        <button type="button" className="press shrink-0 font-medium text-primary hover:underline" onClick={line.action.run}>
          {line.action.label}
        </button>
      ) : null}
      <button type="button" className="press shrink-0 rounded-full p-0.5 hover:bg-background" aria-label={t("بستن")} onClick={() => close(line.key)}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}
