import { useCallback, useEffect, useState } from "react";
import { Bot, Check, HardDrive, Loader2, RotateCw, ShieldCheck, Store, Wrench } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { BRAND } from "../brand.js";
import { readSetting, writeSetting } from "../brand.js";
import { FEATURES, FEATURE_GROUPS, blockedBy, featureDepth, featureOf, featureOn, featureValue, isFresh, isSwitch } from "../settings-features.js";
import { Badge, Choice, Group, Help, SettingRow, Toggle } from "./SettingsParts.jsx";
import { num, t } from "../i18n.js";
import { askConfirm } from "../dialog.jsx";

// Settings → «قابلیت‌ها» and «پیکربندی»: everything that used to need an env edit and a redeploy. A
// value set here wins over the env; «بعد از ری‌استارت» ones apply once Griffin restarts (button below).
// How a setting reads (title, «؟», group, what it hangs on) is in settings-features.js. A setting that
// belongs to a module (the server says which: `modules`) is not here: it is on that module's card in
// «بازارچه» (owner 2026-10-20: «تنظیماتش هم یکپارچه بشه»). Both draw ConfigFields.

/** /api/config and the engine accounts (for the «حساب موتور» fields), with a reload. */
export function useConfigData() {
  const [data, setData] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const load = useCallback(() => api("/api/config").then(setData).catch((e) => toast.error(e.message)), []);
  useEffect(() => {
    load();
    api("/api/providers").then((d) => setAccounts(d.providers || [])).catch(() => {});
  }, [load]);
  return { data, accounts, reload: load };
}

export async function restartGriffin(force = false) {
  try {
    await api("/api/admin/restart", { method: "POST", body: { force } });
    toast.message(t("در حال ری‌استارت… صفحه چند ثانیه بعد دوباره وصل می‌شود."));
    setTimeout(() => window.location.reload(), 8000);
  } catch (e) {
    if (/runs are in progress/.test(e.message) && (await askConfirm(t("ران‌هایی در جریان‌اند و قطع می‌شوند. باز هم ری‌استارت شود؟")))) restartGriffin(true);
    else toast.error(e.message);
  }
}

/** /api/config for switches that save on the spot: the rows, the key being saved, and `set`. */
export function useFeatureRows() {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = useCallback(() => api("/api/config").then((d) => setRows(d.settings || []), (e) => toast.error(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const set = async (key, value) => {
    setBusy(key);
    try {
      const r = await api("/api/config", { method: "PATCH", body: { [key]: value } });
      await load();
      if (r?.restart) toast.message(t("بعد از ری‌استارت اعمال می‌شود"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };
  return { rows, busy, set };
}

/** The little labels beside a setting's title: new, and what applying it takes. */
export function featureBadges(feature) {
  return (
    <>
      {isFresh(feature) ? <Badge tone="fresh">{t("تازه")}</Badge> : null}
      {feature.restart ? <Badge>{t("بعد از ری‌استارت")}</Badge> : null}
    </>
  );
}

/** «؟»: what a setting does, its default and what it depends on. `children` adds a picture. */
export function FeatureHelp({ feature, children }) {
  const parent = featureOf(feature.requires);
  const dflt = feature.choices?.[feature.def] || (feature.def === "on" ? t("روشن") : feature.def === "off" ? t("خاموش") : "");
  return (
    <Help title={feature.title}>
      <p>{feature.help}</p>
      {children}
      {dflt || parent || feature.when === "new" ? (
        <ul className="space-y-0.5 border-t pt-2 text-[11px] leading-5 text-muted-foreground">
          {dflt ? <li>{t("پیش‌فرض: {v}", { v: dflt })}</li> : null}
          {parent ? <li>{t("وابسته به: {v}", { v: parent.title })}</li> : null}
          {feature.when === "new" ? <li>{t("برای گفتگوی تازه یا بعد از ری‌استارت اعمال می‌شود")}</li> : null}
        </ul>
      ) : null}
    </Help>
  );
}

/** One feature that saves on the spot: a switch, or chips for a choice of several; nested under what it needs. */
export function FeatureRow({ feature, rows, busy, set }) {
  const row = rows.find((r) => r.key === feature.key);
  const blocked = blockedBy(feature, rows);
  const options = feature.choices ? Object.entries(feature.choices).map(([id, label]) => ({ id, label })) : null;
  return (
    <SettingRow
      id={feature.key}
      title={feature.title}
      depth={featureDepth(feature)}
      dim={Boolean(blocked)}
      note={blocked ? t("با روشن کردن «{v}» فعال می‌شود", { v: blocked.title }) : null}
      help={<FeatureHelp feature={feature} />}
      badges={featureBadges(feature)}
      control={options ? null : <Toggle on={featureOn(feature, row)} label={feature.title} disabled={Boolean(blocked)} busy={busy === feature.key} onChange={(on) => set(feature.key, on ? "on" : "off")} />}
      under={options ? <Choice label={feature.title} value={featureValue(feature, row)} disabled={Boolean(blocked) || busy === feature.key} onChange={(value) => set(feature.key, value)} options={options} /> : null}
    />
  );
}

const SHOW = [
  { id: "all", label: t("همه") },
  { id: "on", label: t("روشن") },
  { id: "off", label: t("خاموش") },
  { id: "fresh", label: t("تازه") },
];
const SHOW_KEY = "griffin.settings.featuresShow";
const GROUP_ICONS = { tools: Wrench, claude: Bot, guard: ShieldCheck, upkeep: HardDrive };

// «قابلیت‌ها» (owner 2026-11-01: «بخش‌های جدید تنظیمات هم همینطور (قابلیت جدید دیفالت خاموش و ....)»): every
// on/off of /api/config on a row that says in a few words what it is, by topic, each topic with how much
// of it is on. What depends on another hangs under it. A module's own settings are on its card.
export function FeaturesSection() {
  const { rows, busy, set } = useFeatureRows();
  const [show, setShowState] = useState(() => readSetting(SHOW_KEY, "all"));
  const setShow = (id) => {
    setShowState(id);
    writeSetting(SHOW_KEY, id);
  };
  if (!rows) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  const here = (feature) => {
    const row = rows.find((r) => r.key === feature.key);
    return Boolean(row) && !row.modules?.length && FEATURE_GROUPS.find((g) => g.id === feature.group)?.section === "features";
  };
  const all = FEATURES.filter(here);
  const lit = (f) => (isSwitch(f) ? featureOn(f, rows.find((r) => r.key === f.key)) : false);
  const counts = { all: all.length, on: all.filter(lit).length, off: all.filter((f) => isSwitch(f) && !lit(f)).length, fresh: all.filter((f) => isFresh(f)).length };
  const fits = (f) => show === "all" || (show === "fresh" ? isFresh(f) : isSwitch(f) && lit(f) === (show === "on"));
  const groups = FEATURE_GROUPS.filter((g) => g.section === "features").map((g) => ({ ...g, all: all.filter((f) => f.group === g.id) })).filter((g) => g.all.some(fits));
  return (
    <div className="space-y-6">
      <div role="tablist" aria-label={t("نمایش")} className="inline-flex rounded-lg border bg-card p-0.5">
        {SHOW.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={show === s.id} onClick={() => setShow(s.id)} className={`rounded-md px-3 py-1 text-sm ${show === s.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {s.label} <span className="tabular-nums opacity-75">{num(counts[s.id])}</span>
          </button>
        ))}
      </div>
      {!groups.length ? <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("قابلیتی در این دسته نیست.")}</p> : null}
      {groups.map((g) => {
        const Icon = GROUP_ICONS[g.id];
        const switches = g.all.filter(isSwitch);
        const onCount = switches.filter(lit).length;
        return (
          <section key={g.id}>
            <div className="mb-2 flex items-center gap-2 px-1">
              <Icon className="size-3.5 text-muted-foreground" />
              <h3 className="text-xs font-medium text-muted-foreground">{g.label}</h3>
              <span className="ms-auto text-[11px] tabular-nums text-muted-foreground">{t("{a} از {b} روشن", { a: num(onCount), b: num(switches.length) })}</span>
              <span className="g-set-meter" aria-hidden><span style={{ width: `${switches.length ? (onCount / switches.length) * 100 : 0}%` }} /></span>
            </div>
            <div className="g-group divide-y overflow-hidden rounded-2xl border bg-card">
              {g.all.filter(fits).map((f) => <FeatureRow key={f.key} feature={f} rows={rows} busy={busy} set={set} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * A list of settings to edit and one «ذخیره». `settings` are rows of /api/config (or a module's own,
 * with `save`). A row that is a plain on/off is a switch that saves on the spot. `grouped` draws them
 * under the headings of settings-features.js.
 */
export function ConfigFields({ settings, accounts = [], onSaved, save: saveWith, activeRuns = 0, restartButton = false, grouped = false }) {
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const dirty = Object.keys(draft).length > 0;
  const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm";

  const send = async (body) => {
    setSaving(true);
    try {
      const r = saveWith ? await saveWith(body) : await api("/api/config", { method: "PATCH", body });
      if (r?.restart) setNeedsRestart(true);
      toast.success(r?.restart ? t("ذخیره شد؛ بعد از ری‌استارت اعمال می‌شود") : t("ذخیره شد"));
      await onSaved?.();
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const save = async () => {
    if (await send(draft)) setDraft({});
  };

  const fieldOf = (s) => {
    const meta = featureOf(s.key);
    const value = s.key in draft ? draft[s.key] : s.value;
    const set = (v) => setDraft((d) => ({ ...d, [s.key]: v }));
    const fallback = s.default || s.effective || "";
    const name = meta?.title || s.label || s.description || s.key;
    const inputId = `field-${s.key}`;
    if (isSwitch(meta)) {
      return (
        <div key={s.key} id={`set-${s.key}`} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-sm">{name}</span>
          <FeatureHelp feature={meta} />
          <Toggle on={featureOn(meta, s)} label={name} busy={saving} onChange={(on) => send({ [s.key]: on ? "on" : "off" })} />
        </div>
      );
    }
    return (
      <div key={s.key} id={`set-${s.key}`}>
        <div className="mb-1 flex min-h-6 items-center gap-1.5 text-xs leading-5 text-muted-foreground">
          <label htmlFor={inputId}>{name}</label>
          {meta ? <FeatureHelp feature={meta} /> : null}
          {s.live === false ? <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px]">{t("بعد از ری‌استارت")}</span> : null}
        </div>
        {s.options ? (
          <select id={inputId} className={field} value={value} onChange={(e) => set(e.target.value)}>
            <option value="">{s.effective && !s.value ? t("پیش‌فرض ({effective})", { effective: meta?.choices?.[s.effective] || s.effective }) : t("پیش‌فرض")}</option>
            {s.options.filter(Boolean).map((o) => <option key={o} value={o}>{meta?.choices?.[o] || o}</option>)}
          </select>
        ) : s.kind === "account" ? (
          <select id={inputId} className={field} value={value} onChange={(e) => set(e.target.value)}>
            <option value="">{s.effective && !s.value ? t("پیش‌فرض ({effective})", { effective: s.effective }) : t("— مثل ایجنت —")}</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.label || a.id}</option>)}
          </select>
        ) : s.multiline ? (
          <textarea id={inputId} className={`${field} min-h-20`} dir="auto" value={value} onChange={(e) => set(e.target.value)} placeholder={fallback} />
        ) : (
          <input id={inputId} className={field} dir="auto" value={value} onChange={(e) => set(e.target.value)} placeholder={fallback} />
        )}
      </div>
    );
  };
  const typed = settings.filter((s) => !isSwitch(featureOf(s.key)));
  const groups = grouped
    ? FEATURE_GROUPS.map((g) => ({ ...g, rows: settings.filter((s) => featureOf(s.key)?.group === g.id) })).filter((g) => g.rows.length)
    : [];
  const loose = grouped ? settings.filter((s) => !featureOf(s.key)) : settings;

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <Group key={g.id} title={g.label}><div className="space-y-4 p-4">{g.rows.map(fieldOf)}</div></Group>
      ))}
      {loose.length ? (grouped ? <Group><div className="space-y-4 p-4">{loose.map(fieldOf)}</div></Group> : loose.map(fieldOf)) : null}
      {typed.length || restartButton ? (
        <div className={`flex flex-wrap gap-2 ${grouped && dirty ? "g-set-savebar" : ""}`}>
          {typed.length ? (
            <button type="button" onClick={save} disabled={!dirty || saving} className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {t("ذخیره")}
            </button>
          ) : null}
          {restartButton || needsRestart ? (
            <button type="button" onClick={() => restartGriffin()} className={`press inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-2 text-sm ${needsRestart ? "border-primary text-primary" : ""}`}>
              <RotateCw className="size-4" /> {t("ری‌استارت گریفین{v}", { v: activeRuns ? t(" ({activeRuns} ران در جریان)", { activeRuns }) : "" })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ConfigSection({ onSection }) {
  const { data, accounts, reload } = useConfigData();
  if (!data) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  // Here: the values. A switch is under «قابلیت‌ها», speech to text under «گفتگو و اعلان», a module's on its card.
  const sectionOf = (s) => FEATURE_GROUPS.find((g) => g.id === featureOf(s.key)?.group)?.section;
  const own = data.settings.filter((s) => !s.modules?.length && (sectionOf(s) || "config") === "config");
  const moved = data.settings.some((s) => s.modules?.length);
  return (
    <div className="space-y-4">
      {moved ? (
        <button type="button" onClick={() => onSection?.("market")} className="flex w-full items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-start text-xs leading-5 text-muted-foreground hover:bg-muted/60">
          <Store className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">{t("تنظیمات تلگرام، حادثه‌ها، ایجنت‌های همکاران و بقیهٔ بخش‌ها روی کارت همان بخش در «بازارچه» است.")}</span>
          <span className="shrink-0 text-primary">{t("بازارچه")}</span>
        </button>
      ) : null}
      <ConfigFields grouped settings={own} accounts={accounts} onSaved={reload} activeRuns={data.activeRuns} restartButton />
      <p className="text-xs leading-6 text-muted-foreground">{t("خالی = مقدار متغیر محیطی یا پیش‌فرض. مسیرها، پورت‌ها و سوکت کارگزار عمداً فقط هنگام نصب تعیین می‌شوند.")}</p>
    </div>
  );
}
