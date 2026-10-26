import { useEffect, useState } from "react";
import { Switch } from "radix-ui";
import { Check, Store } from "lucide-react";
import { api } from "../api.js";
import { Group, Item } from "./SettingsParts.jsx";
import { BrandPicker } from "./BrandPicker.jsx";
import { FLAGS, LOOKS, NAV_STYLES, applyPreset, installPreset, navStyleChoice, navStyleFlags, presetOf, resetUiPrefs, setUiPrefs, useUiPrefs } from "../ui-prefs.js";
import { ownedFlags } from "../modules.js";
import { t } from "../i18n.js";

// Preview colours are written out here: the skin tokens live on <html>, so a small card cannot
// borrow the other skin's palette from CSS. Keep them in step with styles.css. Griffin's colour is
// the install's own (--brand: stock orange, or what the owner picked under logo and colour).
const SKINS = [
  {
    id: "griffin",
    label: t("گریفین"),
    note: t("رنگ و لوگوی همین نصب، گوشه‌های گرد، وزیرمتن"),
    font: '"Vazirmatn Variable", sans-serif',
    radius: 16,
    light: { bg: "oklch(0.985 0.002 250)", card: "#fff", bubble: "color-mix(in oklch, var(--brand) 16%, white)", line: "oklch(0.9 0.008 250)", primary: "var(--brand)", text: "oklch(0.2 0.02 255)" },
    dark: { bg: "oklch(0.16 0.012 255)", card: "oklch(0.2 0.014 255)", bubble: "color-mix(in oklch, var(--brand) 25%, oklch(0.2 0.014 255))", line: "oklch(0.3 0.015 255)", primary: "var(--brand)", text: "oklch(0.93 0.008 250)" },
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

// Settings → Appearance (one UI, personalised per user): the look (appearance only), the install's
// logo and colour, then every structural choice as a switch. The two presets are
// starting points; whatever is changed here is saved for this user on every device (ui-prefs.js).
// Which sections sit in the menu, and a flag a module owns (the Telegram inbox row), are on that
// module's card in «بازارچه» (owner 2026-10-20: «تنظیماتش یکپارچه بشه»).
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function AppearanceSection({ onSection }) {
  const { look, flags } = useUiPrefs();
  const dark = useDark();
  const matching = LOOKS.find((l) => l.id === look && same(presetOf(l.id).flags, flags))?.id;
  const chip = (active) =>
    `press rounded-full border px-3 py-1 text-xs transition-colors ${active ? "border-primary/40 bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`;
  const [owned, setOwned] = useState(() => new Set());
  useEffect(() => {
    api("/api/modules/market").then((d) => setOwned(ownedFlags(d.modules)), () => {});
  }, []);
  // «بخش‌ها به‌صورت آیکون» is one of the choices of «جای بخش‌ها» below.
  const shownFlags = FLAGS.filter((f) => !owned.has(f.key) && f.key !== "navIcons");
  const navChoice = navStyleChoice(flags);
  const areas = [...new Set(shownFlags.map((f) => f.area))];
  return (
    <div className="space-y-6">
      <Group title={t("ظاهر")}>
        <div role="radiogroup" aria-label={t("ظاهر")} className="grid gap-3 p-3 sm:grid-cols-2">
          {SKINS.map((s) => {
            const active = look === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setUiPrefs({ look: s.id })}
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
      <Group title={t("لوگو و رنگ")}>
        <div className="p-3">
          <BrandPicker />
        </div>
      </Group>
      <Group title={t("همه با هم")}>
        <div className="flex flex-wrap items-center gap-1.5 p-3">
          {LOOKS.map((l) => (
            <button key={l.id} type="button" onClick={() => applyPreset(l.id)} className={chip(matching === l.id)}>
              {t("همه مثل {name}", { name: l.label })}
            </button>
          ))}
          <button type="button" onClick={() => resetUiPrefs()} className={chip(false)} title={t("پیش‌فرض این نصب: {name}", { name: LOOKS.find((l) => l.id === installPreset())?.label || "" })}>
            {t("برگرداندن به پیش‌فرض نصب")}
          </button>
        </div>
      </Group>
      {areas.map((area) => (
        <Group key={area} title={area}>
          {shownFlags.filter((f) => f.area === area).map((f) => (
            <Item key={f.key} title={f.label} subtitle={<span className="block whitespace-normal leading-5">{f.hint}</span>} trailing={<Toggle on={Boolean(flags[f.key])} label={f.label} onChange={(on) => setUiPrefs({ flags: { [f.key]: on } })} />} />
          ))}
          {area === t("فهرست گفتگوها") ? (
            <Item
              title={t("جای بخش‌ها")}
              subtitle={
                <span className="block whitespace-normal leading-5">
                  {t(NAV_STYLES.find((st) => st.id === navChoice)?.hint || "")}
                  <span role="radiogroup" aria-label={t("جای بخش‌ها")} className="mt-2 flex flex-wrap gap-1.5">
                    {NAV_STYLES.map((st) => (
                      <button key={st.id} type="button" role="radio" aria-checked={navChoice === st.id} onClick={() => setUiPrefs({ flags: navStyleFlags(st.id) })} className={chip(navChoice === st.id)}>
                        {t(st.label)}
                      </button>
                    ))}
                  </span>
                </span>
              }
            />
          ) : null}
          {area === t("فهرست گفتگوها") ? (
            <Item
              icon={Store}
              title={t("کدام بخش‌ها در منو باشند")}
              subtitle={<span className="block whitespace-normal leading-5">{t("روشن و خاموش کردن هر بخش، و آمدنش در منو، روی کارت همان بخش در بازارچه است.")}</span>}
              trailing={<button type="button" onClick={() => onSection?.("market")} className="press shrink-0 rounded-lg border px-2.5 py-1 text-xs hover:bg-muted">{t("بازارچه")}</button>}
            />
          ) : null}
        </Group>
      ))}
    </div>
  );
}

function Toggle({ on, label, onChange }) {
  return (
    <Switch.Root
      checked={on}
      onCheckedChange={onChange}
      dir="ltr"
      className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors data-[state=checked]:bg-primary"
      aria-label={label}
    >
      <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.375rem]" />
    </Switch.Root>
  );
}
