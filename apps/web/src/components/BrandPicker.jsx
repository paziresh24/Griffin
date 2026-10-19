import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, RotateCcw, Upload } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { BRAND, applyAgentColor, setIconVersion } from "../brand.js";
import { LOGOS, PALETTES, findLogo, findPalette, paletteFromColor, renderLogo, svgDataUrl } from "../brand-presets.js";

// The install's logo and colours (setup wizard "Appearance" and Settings → Appearance). Presets are drawn here
// with the chosen palette; the server keeps the final SVG + colours under <data>/brand/.

// Neutral page colours from styles.css, so the preview shows light and dark side by side.
const PAGE = {
  light: { bg: "oklch(0.985 0.002 250)", card: "#fff", line: "oklch(0.9 0.008 250)", text: "oklch(0.2 0.02 255)", muted: "oklch(0.52 0.02 255)" },
  dark: { bg: "oklch(0.16 0.012 255)", card: "oklch(0.2 0.014 255)", line: "oklch(0.3 0.015 255)", text: "oklch(0.93 0.008 250)", muted: "oklch(0.68 0.015 255)" },
};

/** Re-fetches brand.css and the logo everywhere on the page after a change (no reload). */
export function reloadBrandAssets() {
  const v = Date.now();
  // Also the URL of every logo drawn later (the sidebar is not on the page while the wizard is).
  setIconVersion(v);
  const bust = (url) => `${url.split("?")[0]}?v=${v}`;
  for (const link of document.querySelectorAll('link[href^="/brand.css"], link[rel="icon"]')) link.href = bust(link.getAttribute("href"));
  for (const img of document.querySelectorAll('img[src^="/icon.svg"], img[src^="/agents/griffin.svg"]')) img.src = bust(img.getAttribute("src"));
}

// A palette picked but not saved yet: the page itself shows it at once (otherwise picking one
// changed only the logo). Same selectors as the server's brand.css, put after it; removed on
// save (brand.css then has it) and when the picker closes unsaved.
const LIVE_ID = "brand-live";
const LIGHT = ":root,:root[data-look]:not([data-agent])";
const DARK = ".dark,:root.dark[data-look]:not([data-agent])";
const VARS = { brand: "--brand", primary: "--primary", primaryForeground: "--primary-foreground", accent: "--accent" };
const block = (selector, set) => `${selector}{${Object.entries(VARS).filter(([k]) => set?.[k]).map(([k, v]) => `${v}:${set[k]}`).join(";")}}`;
function showLive(palette) {
  let el = document.getElementById(LIVE_ID);
  if (!palette) return el?.remove();
  if (!el) {
    el = document.createElement("style");
    el.id = LIVE_ID;
  }
  el.textContent = `${block(LIGHT, palette.light)}\n${block(DARK, palette.dark)}`;
  document.body.appendChild(el); // last: after /brand.css
}

function Preview({ mode, palette, logoSrc, name }) {
  const page = PAGE[mode];
  const c = palette[mode];
  return (
    <div className="flex-1 space-y-2.5 rounded-xl p-3" style={{ background: page.bg, color: page.text, border: `1px solid ${page.line}` }} aria-hidden>
      <div className="flex items-center gap-2">
        <img src={logoSrc} alt="" className="size-8 rounded-lg" />
        <span className="text-sm font-semibold">{name}</span>
        <span className="ms-auto text-[10px]" style={{ color: page.muted }}>{mode === "light" ? t("روشن") : t("تیره")}</span>
      </div>
      <div className="w-fit max-w-[90%] rounded-2xl px-3 py-1.5 text-xs" style={{ background: c.accent }}>{t("سلام، امروز چه خبر؟")}</div>
      <div className="text-xs leading-5" style={{ color: page.muted }}>{t("همه‌چیز آماده است.")}</div>
      <div className="flex items-center gap-2">
        <span className="rounded-lg px-3 py-1 text-xs font-medium" style={{ background: c.primary, color: c.primaryForeground }}>{t("ارسال")}</span>
        <span className="size-3 rounded-full" style={{ background: c.brand }} />
      </div>
    </div>
  );
}

export function BrandPicker({ onSaved, saveLabel = t("ذخیره") }) {
  const [paletteId, setPaletteId] = useState("griffin");
  const [custom, setCustom] = useState(null); // palette from a picked colour
  const [logoId, setLogoId] = useState("hub");
  const [upload, setUpload] = useState(null); // uploaded SVG text
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const name = BRAND.name || t("گریفین");

  useEffect(() => {
    api("/api/setup/brand")
      .then((r) => {
        setSaved(r);
        if (r.palette?.preset && findPalette(r.palette.preset)) setPaletteId(r.palette.preset);
        else if (r.palette?.light) setCustom({ ...paletteFromColor("#888888"), light: r.palette.light, dark: r.palette.dark });
        if (r.logo?.preset && findLogo(r.logo.preset)) setLogoId(r.logo.preset);
        else if (r.custom && r.logo) fetch("/icon.svg", { cache: "no-store" }).then((res) => res.text()).then(setUpload).catch(() => {});
      })
      .catch(() => {});
  }, []);

  const palette = custom || findPalette(paletteId) || PALETTES[0];
  // Shown on the page only once the owner picks (not the saved look being read back on open).
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (picked) showLive(palette);
  }, [picked, palette]);
  useEffect(() => () => showLive(null), []);
  const svg = upload || renderLogo(logoId, palette, name);
  const logoSrc = useMemo(() => svgDataUrl(svg), [svg]);

  const readFile = (file) => {
    if (!file) return;
    if (file.size > 100 * 1024) return toast.error(t("فایل لوگو باید زیر ۱۰۰ کیلوبایت باشد."));
    file.text().then((text) => {
      if (!/<svg[\s>]/i.test(text)) return toast.error(t("فقط فایل SVG."));
      setUpload(text);
    });
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await api("/api/setup/brand", {
        method: "PUT",
        body: {
          logo: { preset: upload ? null : logoId, svg },
          palette: { preset: custom ? null : palette.id, light: palette.light, dark: palette.dark },
        },
      });
      setSaved(r);
      applyAgentColor(r);
      reloadBrandAssets();
      // brand.css has it now; the live copy goes once the new file is in (no flash back meanwhile).
      setPicked(false);
      setTimeout(() => showLive(null), 1500);
      toast.success(t("ظاهر ذخیره شد"));
      onSaved?.();
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
  };

  const reset = async () => {
    setBusy(true);
    try {
      setSaved(await api("/api/setup/brand", { method: "DELETE" }));
      setPaletteId("griffin");
      setCustom(null);
      setLogoId("hub");
      setUpload(null);
      setPicked(false);
      showLive(null);
      applyAgentColor(null);
      reloadBrandAssets();
      toast.success(t("ظاهر به گریفین برگشت"));
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
  };

  const tile = (active) => `press relative rounded-xl border p-1.5 transition-shadow ${active ? "ring-2 ring-primary" : "hover:ring-1 hover:ring-primary/40"}`;
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("رنگ‌ها")}</h3>
        <p className="text-xs leading-6 text-muted-foreground">{t("رنگ دکمه‌ها، حباب پیام‌ها و لوگو. هر پالت نسخهٔ روشن و تیره دارد.")}</p>
        <div role="radiogroup" aria-label={t("پالت رنگ")} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PALETTES.map((p) => {
            const active = !custom && paletteId === p.id;
            return (
              <button key={p.id} type="button" role="radio" aria-checked={active} onClick={() => { setCustom(null); setPaletteId(p.id); setPicked(true); }} className={`${tile(active)} flex items-center gap-2 px-2.5 py-2 text-start`}>
                <span className="flex -space-x-1.5 rtl:space-x-reverse">
                  {[p.ink.bg, p.light.primary, p.dark.primary, p.light.accent].map((color, i) => <span key={i} className="size-4 rounded-full ring-2 ring-background" style={{ background: color }} />)}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">{p.label}</span>
                {active ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
              </button>
            );
          })}
        </div>
        <label className={`${tile(Boolean(custom))} flex w-fit cursor-pointer items-center gap-2 px-2.5 py-2 text-xs`}>
          <input type="color" value={custom?.light.brand?.startsWith("#") ? custom.light.brand : palette.light.brand.startsWith("#") ? palette.light.brand : "#888888"} onChange={(e) => { setCustom(paletteFromColor(e.target.value)); setPicked(true); }} className="size-6 cursor-pointer rounded border-0 bg-transparent p-0" />
          {t("رنگ دلخواه (روشن و تیره خودش ساخته می‌شود)")}
        </label>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("لوگو")}</h3>
        <p className="text-xs leading-6 text-muted-foreground">{t("آیکون تب مرورگر، صفحهٔ ورود و بالای منو. لوگوها با پالت انتخابی رنگ می‌گیرند؛ «حرف اول نام» از نام دستیار ساخته می‌شود.")}</p>
        <div role="radiogroup" aria-label={t("لوگو")} className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {LOGOS.map((l) => {
            const active = !upload && logoId === l.id;
            return (
              <button key={l.id} type="button" role="radio" aria-checked={active} onClick={() => { setUpload(null); setLogoId(l.id); }} className={`${tile(active)} flex flex-col items-center gap-1`} title={l.label}>
                <img src={svgDataUrl(l.render(palette.ink, name))} alt="" className="size-12 rounded-lg" />
                <span className="text-[11px] text-muted-foreground">{l.label}</span>
              </button>
            );
          })}
          <label className={`${tile(Boolean(upload))} flex cursor-pointer flex-col items-center justify-center gap-1`} title={t("بارگذاری SVG")}>
            {upload ? <img src={logoSrc} alt="" className="size-12 rounded-lg" /> : <Upload className="size-6 text-muted-foreground" />}
            <span className="text-[11px] text-muted-foreground">{t("فایل SVG خودت")}</span>
            <input type="file" accept=".svg,image/svg+xml" className="sr-only" onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground">{t("SVG مربعی، زیر ۱۰۰ کیلوبایت. اسکریپت و لینک بیرونی داخلش پاک می‌شود.")}</p>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("پیش‌نمایش")}</h3>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Preview mode="light" palette={palette} logoSrc={logoSrc} name={name} />
          <Preview mode="dark" palette={palette} logoSrc={logoSrc} name={name} />
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={busy} className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {saveLabel}
        </button>
        {saved?.custom ? (
          <button type="button" onClick={reset} disabled={busy} className="press inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm">
            <RotateCcw className="size-4" /> {t("برگشت به ظاهر گریفین")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
