import { useEffect, useState } from "react";
import { Switch } from "radix-ui";
import { Check } from "lucide-react";
import { Group, Item } from "./SettingsParts.jsx";
import { applySkin, readSkin } from "../skin.js";
import { t } from "../i18n.js";
import { NAV_ITEMS, NAV_PRESETS, NAV_STYLES, setNavPrefs, useNavPrefs } from "../sidebar-nav.js";

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
    <div className="space-y-6">
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
    <SidebarNavPrefs />
    </div>
  );
}

// The sidebar's top sections: as rows or one row of icons, and which show (the rest under «بیشتر»).
function SidebarNavPrefs() {
  const prefs = useNavPrefs();
  const shown = (id) => !prefs.hidden.includes(id);
  const preset = NAV_PRESETS.find((p) => p.hidden.length === prefs.hidden.length && p.hidden.every((id) => prefs.hidden.includes(id)))?.id;
  const chip = (active) =>
    `press rounded-full border px-3 py-1 text-xs transition-colors ${active ? "border-primary/40 bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`;
  return (
    <Group
      title={t("بخش‌های بالای منو")}
      action={
        <div className="flex gap-1.5">
          {NAV_PRESETS.map((p) => (
            <button key={p.id} type="button" onClick={() => setNavPrefs({ hidden: p.hidden })} className={chip(preset === p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      }
    >
      <div role="radiogroup" aria-label={t("شکل بخش‌ها")} className="grid grid-cols-2 gap-2 p-3">
        {NAV_STYLES.map((style) => {
          const active = prefs.style === style.id;
          return (
            <button
              key={style.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setNavPrefs({ style: style.id })}
              className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-start transition-shadow ${active ? "ring-2 ring-primary" : "hover:ring-1 hover:ring-primary/40"}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{style.label}</span>
                <span className="block text-xs leading-5 text-muted-foreground">{style.note}</span>
              </span>
              {active ? <Check className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>
      {NAV_ITEMS.map((item) => (
        <Item
          key={item.id}
          title={item.label}
          subtitle={shown(item.id) ? t("در منو") : t("زیر «بیشتر»")}
          trailing={
            <Switch.Root
              checked={shown(item.id)}
              onCheckedChange={(on) => setNavPrefs({ hidden: on ? prefs.hidden.filter((id) => id !== item.id) : [...prefs.hidden, item.id] })}
              dir="ltr"
              className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors data-[state=checked]:bg-primary"
              aria-label={t("{name} در منو", { name: item.label })}
            >
              <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.375rem]" />
            </Switch.Root>
          }
        />
      ))}
    </Group>
  );
}
