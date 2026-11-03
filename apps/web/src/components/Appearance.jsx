import { useEffect, useState } from "react";
import { Check, ChevronDown, LayoutDashboard, MessageSquare, MoreHorizontal, Moon, PanelRight, Palette, RotateCcw, Store, Sun, TextCursorInput } from "lucide-react";
import { api } from "../api.js";
import { readSetting, writeSetting } from "../brand.js";
import { Choice, Group, Help, Item, SettingRow, Toggle } from "./SettingsParts.jsx";
import { Compare, MiniApp, SceneChoice } from "./SettingsPreview.jsx";
import { BrandPicker } from "./BrandPicker.jsx";
import { FLAGS, LOOKS, NAV_STYLES, installPreset, navStyleChoice, navStyleFlags, presetOf, resetUiPrefs, setUiPrefs, useUiPrefs } from "../ui-prefs.js";
import { ownedFlags } from "../modules.js";
import { ZONES, homeChoice, homeFlags, updateChoice, updateFlags, workChoice, workFlags, zoneOfFlag } from "../settings-map.js";
import { t, num } from "../i18n.js";

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

function Preview({ skin, dark }) {
  const c = dark ? skin.dark : skin.light;
  const box = { border: `1px solid ${c.line}`, background: c.card };
  return (
    <div className="flex h-24 flex-col gap-1.5 p-2.5" style={{ background: c.bg, color: c.text, fontFamily: skin.font, borderRadius: skin.radius - 4 }} aria-hidden>
      <div className="self-start px-3 py-1 text-xs" style={{ background: c.bubble, borderRadius: skin.radius }}>{t("سلام، وضعیت کلاستر؟")}</div>
      <div className="truncate text-xs leading-5">{t("همه‌چیز سالم است؛ ۱۲ پاد در حال اجرا.")}</div>
      <div className="mt-auto flex items-center gap-2 px-2 py-1" style={{ ...box, borderRadius: skin.radius }}>
        <span className="h-1.5 flex-1 rounded-full" style={{ background: c.line }} />
        <span className="size-3.5 rounded-full" style={{ background: c.primary }} />
      </div>
    </div>
  );
}

const ZONE_ICONS = { look: Palette, sidebar: PanelRight, home: LayoutDashboard, chat: MessageSquare, composer: TextCursorInput, other: MoreHorizontal };
const ZONE_KEY = "griffin.settings.zone";

// Settings → «ظاهر», from the owner's complaint (2026-11-01: «گیج کننده ترین جا به نظرم بخش ظاهره»):
// thirty switches in one column became a small live drawing of the page. A tap on a part of it brings
// that part's options only, «سبک و رنگ» first; each option has a «؟» that draws it off and on. Switches
// that were parts of one question are one question now (settings-map.js MERGED_FLAGS). Everything
// stays per user on every device (ui-prefs.js).
// Which sections sit in the menu, and a flag a module owns, are on that module's card in «بازارچه».
export function AppearanceSection({ onSection, theme, onTheme, focus }) {
  const { look, flags } = useUiPrefs();
  const dark = theme ? theme === "dark" : document.documentElement.classList.contains("dark");
  const [zone, setZoneState] = useState(() => readSetting(ZONE_KEY, "look"));
  const setZone = (id) => {
    setZoneState(id);
    writeSetting(ZONE_KEY, id);
  };
  const [brand, setBrand] = useState(false);
  const [owned, setOwned] = useState(() => new Set());
  useEffect(() => {
    api("/api/modules/market").then((d) => setOwned(ownedFlags(d.modules)), () => {});
  }, []);
  // The search found an option in another part: open that part.
  useEffect(() => {
    const target = focus ? zoneOfFlag(focus) : null;
    if (target) setZone(target);
  }, [focus]);

  const set = (next) => setUiPrefs({ flags: next });
  const layout = LOOKS.find((l) => FLAGS.every((f) => Boolean(presetOf(l.id).flags[f.key]) === Boolean(flags[f.key])))?.id || "custom";
  const home = presetOf(installPreset()).flags;
  const changed = FLAGS.filter((f) => Boolean(home[f.key]) !== Boolean(flags[f.key])).length;
  const zoneOf = ZONES.find((z) => z.id === zone) || ZONES[0];
  const rows = zoneOf.flags.map((key) => FLAGS.find((f) => f.key === key)).filter((f) => f && !owned.has(f.key));
  const navPlace = navStyleChoice(flags);

  return (
    <div className="space-y-5">
      <div className="g-mini-sticky space-y-2">
        <MiniApp flags={flags} zone={zone} onZone={setZone} />
        <div role="tablist" aria-label={t("قسمت‌های صفحه")} className="flex flex-wrap gap-1.5">
          {ZONES.map((z) => {
            const Icon = ZONE_ICONS[z.id];
            return (
              <button key={z.id} type="button" role="tab" aria-selected={zone === z.id} onClick={() => setZone(z.id)} className={`press inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${zone === z.id ? "border-primary/40 bg-primary/10 font-medium text-foreground" : "bg-card text-muted-foreground hover:text-foreground"}`}>
                <Icon className="size-3.5" />{z.label}
              </button>
            );
          })}
        </div>
      </div>

      {zone === "look" ? <><Group>
        <div role="radiogroup" aria-label={t("ظاهر")} className="grid grid-cols-2 gap-3 p-3">
          {SKINS.map((s) => {
            const active = look === s.id;
            return (
              <button key={s.id} type="button" role="radio" aria-checked={active} onClick={() => setUiPrefs({ look: s.id })} className={`overflow-hidden rounded-xl border text-start transition-shadow ${active ? "ring-2 ring-primary" : "hover:ring-1 hover:ring-primary/40"}`}>
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
        {onTheme ? (
          <SettingRow
            id="theme"
            icon={dark ? Moon : Sun}
            title={t("حالت رنگ")}
            control={<Choice label={t("حالت رنگ")} value={theme} onChange={onTheme} options={[{ id: "light", label: t("روشن") }, { id: "dark", label: t("تیره") }]} />}
          />
        ) : null}
        <Item
          icon={Palette}
          tint="bg-primary/12 text-primary"
          title={t("لوگو و رنگ")}
          subtitle={t("برای همهٔ کاربران این نصب")}
          onClick={() => setBrand(!brand)}
          trailing={<><span className="size-4 rounded-full" style={{ background: "var(--brand)" }} aria-hidden /><ChevronDown className={`size-4 text-muted-foreground transition-transform ${brand ? "rotate-180" : ""}`} /></>}
        >
          {brand ? <div className="border-t p-3"><BrandPicker /></div> : null}
        </Item>
      </Group>

      <Group
        title={t("چیدمان صفحه")}
        action={<button type="button" onClick={() => resetUiPrefs()} title={t("پیش‌فرض این نصب: {v}", { v: LOOKS.find((l) => l.id === installPreset())?.label || "" })} className="press inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"><RotateCcw className="size-3" />{t("برگرداندن به پیش‌فرض نصب")}</button>}
      >
        <SettingRow
          id="layout"
          title={t("نقطهٔ شروع")}
          help={<Help title={t("نقطهٔ شروع")}><p>{t("همهٔ گزینه‌های چیدمان را یک‌جا مثل گریفین یا کارسرا می‌کند؛ رنگ و فونت از کارت‌های بالا جدا انتخاب می‌شوند. هر چیزی را بعدش جدا عوض کنید، «سفارشی» می‌شود.")}</p></Help>}
          note={layout === "custom" ? t("{n} گزینه با پیش‌فرض این نصب فرق دارد", { n: num(changed) }) : null}
          control={<Choice label={t("نقطهٔ شروع")} value={layout} onChange={(id) => id !== "custom" && set(presetOf(id).flags)} options={[...LOOKS.map((l) => ({ id: l.id, label: l.label })), ...(layout === "custom" ? [{ id: "custom", label: t("سفارشی") }] : [])]} />}
        />
      </Group></> : null}

      <div className="space-y-4">
        {zone === "sidebar" ? (
          <Group>
            <SettingRow
              id="navIcons"
              title={t("جای بخش‌ها")}
              help={<Help title={t("جای بخش‌ها")}><p>{t("تلگرام، جاب، حادثه‌ها و بقیهٔ بخش‌ها کجا باشند. ترتیب را با کشیدن عوض کنید؛ کدام بخش‌ها باشند روی کارت هر بخش در بازارچه است.")}</p></Help>}
              note={NAV_STYLES.find((st) => st.id === navPlace)?.hint}
              under={<SceneChoice label={t("جای بخش‌ها")} value={navPlace} scene="sidebar" flags={flags} onChange={(id) => set(navStyleFlags(id))} options={NAV_STYLES.map((st) => ({ id: st.id, label: st.label, flags: navStyleFlags(st.id) }))} />}
            />
            {navPlace === "list" || navPlace === "icons" ? <FlagRow flag={FLAGS.find((f) => f.key === "navMore")} flags={flags} onSet={set} depth={1} /> : null}
            <SettingRow
              id="market-link"
              icon={Store}
              title={t("کدام بخش‌ها در منو باشند")}
              help={<Help title={t("کدام بخش‌ها در منو باشند")}><p>{t("روشن و خاموش کردن هر بخش، و آمدنش در منو، روی کارت همان بخش در بازارچه است.")}</p></Help>}
              control={<button type="button" onClick={() => onSection?.("market")} className="press shrink-0 rounded-lg border px-2.5 py-1 text-xs hover:bg-muted">{t("بازارچه")}</button>}
            />
            <SettingRow
              id="updateTopButton"
              title={t("خبر نسخهٔ تازه کجا بیاید")}
              help={<Help title={t("خبر نسخهٔ تازه کجا بیاید")}><p>{t("پایین فهرست: یک ردیف باریک. بالای صفحه: آیکونی کنار عنوان گفتگو که با آمدن نسخه روشن می‌شود و زدنش ری‌استارت و اعمال را ثبت می‌کند. فقط در تنظیمات: یک نقطه روی تنظیمات و خود آپدیت در صفحهٔ وضعیت.")}</p></Help>}
              under={<Choice label={t("خبر نسخهٔ تازه کجا بیاید")} value={updateChoice(flags)} onChange={(id) => set(updateFlags(id))} options={[{ id: "list", label: t("پایین فهرست") }, { id: "top", label: t("بالای صفحه") }, { id: "settings", label: t("فقط در تنظیمات") }]} />}
            />
          </Group>
        ) : null}
        {zone === "home" ? (
          <Group>
            <SettingRow
              id="homeBoard"
              title={t("صفحهٔ گفتگوی جدید چه نشان بدهد")}
              help={<Help title={t("صفحهٔ گفتگوی جدید چه نشان بدهد")}><p>{t("ساده: یک خط معرفی و کادر وسط صفحه. کارها: «منتظر شما» و کارهای در جریان. هر چیز یک جا: تأییدها و سؤال‌ها فقط در خود گفتگو جواب داده می‌شوند و این‌جا یک خط با لینک دارند؛ پیشنهادها و کارهای در جریان فقط در فهرست کناری می‌آیند.")}</p></Help>}
              under={<SceneChoice wide label={t("صفحهٔ گفتگوی جدید چه نشان بدهد")} value={homeChoice(flags)} scene="home" flags={flags} onChange={(id) => set(homeFlags(id))} options={[{ id: "simple", label: t("ساده"), flags: homeFlags("simple") }, { id: "board", label: t("کارها"), flags: homeFlags("board") }, { id: "one", label: t("هر چیز فقط یک جا"), flags: homeFlags("one") }]} />}
            />
          </Group>
        ) : null}
        {zone === "chat" ? (
          <Group>
            <SettingRow
              id="workInline"
              title={t("مراحل کار ایجنت")}
              help={<Help title={t("مراحل کار ایجنت")}><p>{t("یک خط: بسته، با یک خط از کاری که همین الان انجام می‌شود. باز: هنگام اجرا همهٔ مراحل دیده می‌شود. روایت: حرف‌های ایجنت روی صفحه می‌مانند و فقط مرحله‌های بین دو حرف جمع می‌شوند، مثل کلاد دسکتاپ.")}</p></Help>}
              under={<SceneChoice wide label={t("مراحل کار ایجنت")} value={workChoice(flags)} scene="chat" flags={flags} onChange={(id) => set(workFlags(id))} options={[{ id: "fold", label: t("یک خط"), flags: workFlags("fold") }, { id: "open", label: t("باز"), flags: workFlags("open") }, { id: "inline", label: t("روایت"), flags: workFlags("inline") }]} />}
            />
          </Group>
        ) : null}
        {rows.length ? (
          <Group>
            {rows.map((f) => <FlagRow key={f.key} flag={f} flags={flags} onSet={set} />)}
          </Group>
        ) : null}
      </div>
    </div>
  );
}

function FlagRow({ flag, flags, onSet, depth = 0 }) {
  return (
    <SettingRow
      id={flag.key}
      title={flag.label}
      depth={depth}
      help={<Help title={flag.label}><p>{flag.hint}</p><Compare flags={flags} flagKey={flag.key} /></Help>}
      control={<Toggle on={Boolean(flags[flag.key])} label={flag.label} onChange={(on) => onSet({ [flag.key]: on })} />}
    />
  );
}
