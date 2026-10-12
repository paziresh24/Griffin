import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Group } from "./SettingsParts.jsx";
import { applySkin, readSkin } from "../skin.js";
import { t } from "../i18n.js";

// Preview colours are written out here: the skin tokens live on <html>, so a small card cannot
// borrow the other skin's palette from CSS. Keep them in step with styles.css.
const SKINS = [
  {
    id: "griffin",
    label: t("گریفین"),
    note: t("نارنجی، گوشه‌های گرد، وزیرمتن"),
    font: '"Vazirmatn Variable", sans-serif',
    radius: 16,
    light: { bg: "oklch(0.985 0.002 250)", card: "#fff", bubble: "oklch(0.95 0.04 55)", line: "oklch(0.9 0.008 250)", primary: "oklch(0.7 0.15 55)", text: "oklch(0.2 0.02 255)" },
    dark: { bg: "oklch(0.16 0.012 255)", card: "oklch(0.2 0.014 255)", bubble: "oklch(0.28 0.05 50)", line: "oklch(0.3 0.015 255)", primary: "oklch(0.78 0.14 55)", text: "oklch(0.93 0.008 250)" },
  },
  {
    id: "karsara",
    label: t("کارسرا"),
    note: t("پوستهٔ دوم: تخت و ساده، آبی"),
    font: '"iran-sans-x", "Vazirmatn Variable", sans-serif',
    radius: 12,
    light: { bg: "#f2f3f5", card: "#fff", bubble: "#e2e8f0", line: "#cbd5e1", primary: "#2b4dcc", text: "#2b2f33" },
    dark: { bg: "#121218", card: "#1a1a2a", bubble: "#2a2a3c", line: "#3a3a50", primary: "#7b92f0", text: "#f1f5f9" },
  },
];

function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function Preview({ skin, dark }) {
  const c = dark ? skin.dark : skin.light;
  const box = { border: `1px solid ${c.line}`, background: c.card };
  return (
    <div className="flex h-28 flex-col gap-2 p-3" style={{ background: c.bg, color: c.text, fontFamily: skin.font, borderRadius: skin.radius - 4 }} aria-hidden>
      <div className="self-start px-3 py-1 text-xs" style={{ background: c.bubble, borderRadius: skin.radius }}>{t("سلام، وضعیت کلاستر؟")}</div>
      <div className="text-xs leading-5">{t("همه‌چیز سالم است؛ ۱۲ پاد در حال اجرا.")}</div>
      <div className="mt-auto flex items-center gap-2 px-2 py-1.5" style={{ ...box, borderRadius: skin.radius }}>
        <span className="h-1.5 flex-1 rounded-full" style={{ background: c.line }} />
        <span className="size-4 rounded-full" style={{ background: c.primary }} />
      </div>
    </div>
  );
}

export function AppearanceSection() {
  const [skin, setSkin] = useState(readSkin);
  const dark = useDark();
  return (
    <Group title={t("پوسته")}>
      <div role="radiogroup" aria-label={t("پوسته")} className="grid gap-3 p-3 sm:grid-cols-2">
        {SKINS.map((s) => {
          const active = skin === s.id;
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSkin(applySkin(s.id))}
              className={`overflow-hidden rounded-xl border text-start transition-shadow ${active ? "ring-2 ring-primary" : "hover:ring-1 hover:ring-primary/40"}`}
            >
              <Preview skin={s} dark={dark} />
              <span className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{s.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{s.note}</span>
                </span>
                {active ? <Check className="size-4 shrink-0 text-primary" /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </Group>
  );
}
