import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, Switch } from "radix-ui";
import { AlertTriangle, ArrowLeftRight, Check, ChevronDown, Loader2, Power, PowerOff, Search, SlidersHorizontal, Wrench, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { marketView, moduleSettings, moduleTags, planLines, settingsCount } from "../modules.js";
import { reloadModules } from "../module-hooks.js";
import { readSetting, writeSetting } from "../brand.js";
import { FLAGS, NAV_ITEMS, setUiPrefs, useUiPrefs } from "../ui-prefs.js";
import { MODULE_ICONS } from "./ModulePage.jsx";
import { ConfigFields, useConfigData } from "./Config.jsx";
import { t } from "../i18n.js";

// Settings → «بازارچه» (owner 2026-10-20: «طراحی و دسته‌بندی خوبی نداره» → «اسمش بشه بازارچه؛
// تنظیماتش یکپارچه بشه»): the modules on shelves by what they are for, a card each, and modules that
// fill one slot (two ways of answering Telegram) as one question with options. Each card also holds
// the module's settings — its core config keys, its own, its UI flags and whether its pages are in
// the menu — which Settings → پیکربندی and ظاهر no longer show. A switch never acts on the spot: the
// server first says what it would do (modules it needs or replaces, chats it moves into a folder, the
// setting it changes) and only the owner's «انجام بده» in the dialog applies it.
const NAV_IDS = NAV_ITEMS.map((i) => i.id);

const PLAN_ICON = { off: PowerOff, on: Power, fix: Wrench, note: ArrowLeftRight };
const PLAN_TONE = { off: "text-bad", on: "text-ok", fix: "text-warn", note: "text-muted-foreground" };
const SHOW = [
  { key: "all", label: t("همه") },
  { key: "on", label: t("روشن") },
  { key: "off", label: t("خاموش") },
];
const SHOW_KEY = "griffin.modules.show";

export function ModulesSection() {
  const [modules, setModules] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // { mod, enable, plan }
  const [busy, setBusy] = useState(null);
  const [show, setShowState] = useState(() => readSetting(SHOW_KEY, "all"));
  const [search, setSearch] = useState("");
  const setShow = (key) => {
    setShowState(key);
    writeSetting(SHOW_KEY, key);
  };

  const load = useCallback(async () => {
    try {
      setModules((await api("/api/modules/market")).modules);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const config = useConfigData();
  const view = useMemo(() => marketView(modules, { show, search }), [modules, show, search]);
  const settingsOf = (mod) => moduleSettings(mod, { config: config.data?.settings || [], flags: FLAGS, navIds: NAV_IDS });
  const settingsProps = { settingsOf, config, onOwnSaved: load };
  const title = (id) => modules?.find((m) => m.id === id)?.title || id;

  async function ask(mod, enable) {
    setBusy(mod.id);
    try {
      const { plan } = await api(`/api/modules/${mod.id}/plan`, { method: "POST", body: { enable } });
      if (plan.blocked) toast.error(plan.blocked);
      else if (plan.empty) toast("چیزی عوض نمی‌شود");
      else setPending({ mod, enable, plan });
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    const { mod, enable, plan } = pending;
    setBusy(mod.id);
    try {
      const out = await api(`/api/modules/${mod.id}/switch`, { method: "POST", body: { enable, confirm: plan.risky } });
      const failed = Object.entries(out.failed || {});
      if (failed.length) toast.error(`روشن نشد: ${failed.map(([id, why]) => `${title(id)} (${why})`).join(t("؛ "))}`);
      else toast.success(t("انجام شد"));
      setPending(null);
      await load();
      await reloadModules();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <div className="rounded-xl border border-bad/40 bg-bad/5 p-4 text-sm">
        <p className="text-bad">{error}</p>
        <button type="button" onClick={load} className="mt-2 rounded-lg border px-3 py-1 text-xs hover:bg-muted">{t("دوباره")}</button>
      </div>
    );
  }
  if (!modules) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("در حال خواندن…")}</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border bg-card p-0.5" role="tablist" aria-label={t("نمایش")}>
          {SHOW.map((s) => (
            <button key={s.key} type="button" role="tab" aria-selected={show === s.key} onClick={() => setShow(s.key)} className={`rounded-md px-3 py-1 text-sm ${show === s.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {s.label} <span className="tabular-nums opacity-75">{view.counts[s.key].toLocaleString("fa-IR")}</span>
            </button>
          ))}
        </div>
        <label className="relative ms-auto min-w-0 flex-1 sm:max-w-56">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("جستجوی ماژول")} aria-label={t("جستجوی ماژول")} className="w-full rounded-lg border bg-background py-1.5 pe-2 ps-8 text-sm" />
        </label>
      </div>

      {!view.shelves.length ? <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{search ? t("ماژولی با این نام نیست.") : show === "on" ? t("هیچ ماژولی روشن نیست.") : t("همهٔ ماژول‌ها روشن‌اند.")}</p> : null}

      {view.shelves.map((shelf) => (
        <section key={shelf.key} className="space-y-2.5">
          <h3 className="flex items-baseline gap-2 text-sm font-medium">
            {shelf.label}
            {shelf.hint ? <span className="text-xs font-normal text-muted-foreground">{shelf.hint}</span> : null}
          </h3>
          <div className="space-y-2.5">
            {shelf.entries.map((e) =>
              e.kind === "choice" ? (
                <ChoiceCard key={e.key} entry={e} busy={busy} onPick={(mod) => ask(mod, true)} onOff={(mod) => ask(mod, false)} {...settingsProps} />
              ) : (
                <ModuleCard key={e.key} mod={e.mod} busy={busy === e.mod.id} title={title} onSwitch={(on) => ask(e.mod, on)} onFix={() => ask(e.mod, true)} {...settingsProps} />
              ),
            )}
          </div>
        </section>
      ))}

      <PlanDialog pending={pending} busy={pending && busy === pending.mod.id} onCancel={() => setPending(null)} onConfirm={confirm} />
    </div>
  );
}

function ModuleIcon({ name, on }) {
  const Icon = MODULE_ICONS[name] || MODULE_ICONS.puzzle;
  return (
    <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${on ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
      <Icon className="size-4.5" />
    </span>
  );
}

function StatusPill({ mod }) {
  if (mod.error) return <span className="rounded-full bg-bad/10 px-2 py-0.5 text-[11px] text-bad">{mod.enabled ? t("بالا نیامد") : t("خطا")}</span>;
  if (mod.drift) return <span className="rounded-full bg-warn/10 px-2 py-0.5 text-[11px] text-warn">{t("ناهمخوان")}</span>;
  return mod.enabled ? <span className="rounded-full bg-ok/10 px-2 py-0.5 text-[11px] text-ok">{t("روشن")}</span> : <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t("خاموش")}</span>;
}

function Problems({ mod, onFix }) {
  return (
    <>
      {mod.error ? <p className="flex items-start gap-1.5 text-xs text-bad"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{mod.error}</p> : null}
      {mod.drift ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-warn">
          <AlertTriangle className="size-3.5" />تنظیم با این ماژول نمی‌خواند: {mod.drift}
          <button type="button" onClick={onFix} className="rounded-md border px-2 py-0.5 text-foreground hover:bg-muted">{t("درست کن")}</button>
        </div>
      ) : null}
    </>
  );
}

function ModuleCard({ mod, busy, title, onSwitch, onFix, settingsOf, config, onOwnSaved }) {
  const [open, setOpen] = useState(false);
  const settings = settingsOf(mod);
  const tags = moduleTags(mod);
  const details = [
    mod.requires.length ? `نیاز دارد به: ${mod.requires.map(title).join(t("، "))}` : "",
    mod.requiredBy?.length ? `این‌ها به آن نیاز دارند: ${mod.requiredBy.map(title).join(t("، "))}` : "",
    mod.conflicts.length ? `با این‌ها جور نیست: ${mod.conflicts.map(title).join(t("، "))}` : "",
    mod.preset ? t("در این نصب پیش‌فرض روشن است") : "",
    mod.version ? `نسخهٔ ${mod.version}` : "",
  ].filter(Boolean);
  return (
    <div className={`rounded-xl border bg-card p-3.5 ${mod.error ? "border-bad/40" : mod.drift ? "border-warn/40" : ""}`}>
      <div className="flex items-start gap-3">
        <ModuleIcon name={mod.icon} on={mod.enabled} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{mod.title}</span>
            <StatusPill mod={mod} />
            {!mod.builtin ? <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">{t("افزونه")}</span> : null}
          </div>
          {mod.description ? <p className="text-xs leading-5 text-muted-foreground">{mod.description}</p> : null}
          {mod.maintainer ? <p className="text-[11px] leading-5 text-muted-foreground">ساخته و پشتیبانی: {mod.maintainer}</p> : null}
        </div>
        <Toggle checked={mod.enabled} disabled={busy || (!mod.version && Boolean(mod.error))} busy={busy} label={mod.title} onChange={onSwitch} />
      </div>
      <div className="mt-2 space-y-1.5 ps-12">
        {tags.length ? <div className="flex flex-wrap gap-1.5">{tags.map((t) => <span key={t} className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t}</span>)}</div> : null}
        <Problems mod={mod} onFix={onFix} />
        <ModuleSettings
          mod={mod}
          settings={settings}
          config={config}
          onOwnSaved={onOwnSaved}
          head={details.length ? (
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              جزئیات<ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
          ) : null}
          under={open ? <ul className="space-y-0.5 text-[11px] text-muted-foreground">{details.map((d) => <li key={d}>{d}</li>)}</ul> : null}
        />
      </div>
    </div>
  );
}

// A card's «تنظیمات»: everything of this module in one place, folded until opened (kept open per
// module across visits). Saving a core setting is the same PATCH /api/config as Settings → پیکربندی.
function ModuleSettings({ mod, settings, config, onOwnSaved, head = null, under = null }) {
  const key = `griffin.modules.settings.${mod.id}`;
  const [open, setOpenState] = useState(() => readSetting(key, "") === "1");
  const setOpen = (v) => {
    setOpenState(v);
    writeSetting(key, v ? "1" : "");
  };
  const { flags } = useUiPrefs();
  const n = settingsCount(settings);
  if (!n && !head) return null;
  const hidden = flags.navHidden || [];
  const toggleNav = (id, show) => setUiPrefs({ flags: { navHidden: show ? hidden.filter((x) => x !== id) : [...hidden, id] } });
  const saveOwn = async (draft) => {
    await api(`/api/modules/${mod.id}/config`, { method: "PATCH", body: draft });
    await onOwnSaved();
    return {};
  };
  return (
    <div className="space-y-1.5 pt-0.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {n ? (
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <SlidersHorizontal className="size-3.5" />{t("تنظیمات")}<span className="tabular-nums opacity-70">{n.toLocaleString("fa-IR")}</span>
            <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        ) : null}
        {head}
      </div>
      {under}
      {open && n ? (
        <div className="mt-2 space-y-4 rounded-lg border bg-background/60 p-3">
          {!mod.enabled ? <p className="text-[11px] text-muted-foreground">{t("این بخش خاموش است؛ تنظیماتش وقتی روشن شود اثر می‌کند.")}</p> : null}
          {settings.nav.length || settings.flags.length ? (
            <div className="space-y-2">
              {settings.nav.map((p) => (
                <SettingSwitch key={p.id} label={`«${p.title}» در منوی کناری`} hint={hidden.includes(p.id) ? (flags.navMore ? t("زیر «بیشتر»") : t("پنهان")) : t("در منو")} on={!hidden.includes(p.id)} onChange={(v) => toggleNav(p.id, v)} />
              ))}
              {settings.flags.map((f) => (
                <SettingSwitch key={f.key} label={f.label} hint={f.hint} on={Boolean(flags[f.key])} onChange={(v) => setUiPrefs({ flags: { [f.key]: v } })} />
              ))}
            </div>
          ) : null}
          {settings.config.length ? <ConfigFields settings={settings.config} accounts={config.accounts} onSaved={config.reload} activeRuns={config.data?.activeRuns || 0} /> : !config.data && mod.settings?.config?.length ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
          {settings.own.length ? <ConfigFields settings={settings.own} save={saveOwn} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function SettingSwitch({ label, hint, on, onChange }) {
  return (
    <div className="flex items-start gap-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        {hint ? <span className="block text-[11px] leading-5 text-muted-foreground">{hint}</span> : null}
      </span>
      <Toggle checked={on} label={label} onChange={onChange} />
    </div>
  );
}

// Modules of one slot: a question and its answers. Picking another answer switches the current one
// off and the picked one on (the plan dialog says so first); «خاموش کن» leaves none.
function ChoiceCard({ entry, busy, onPick, onOff, settingsOf, config, onOwnSaved }) {
  const on = entry.enabled;
  // The settings are the picked option's (each way of doing it has its own); none picked, the first's.
  const shownMod = on || entry.options[0];
  return (
    <div className={`rounded-xl border bg-card p-3.5 ${entry.attention ? "border-warn/40" : ""}`}>
      <div className="flex items-start gap-3">
        <ModuleIcon name={entry.options[0].icon} on={Boolean(on)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{entry.title}</span>
            {on ? <span className="rounded-full bg-ok/10 px-2 py-0.5 text-[11px] text-ok">{t("روشن")}</span> : <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t("خاموش")}</span>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{entry.question}</p>
        </div>
        {on ? (
          <button type="button" disabled={Boolean(busy)} onClick={() => onOff(on)} className="shrink-0 rounded-lg border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">{t("خاموش کن")}</button>
        ) : null}
      </div>
      <div role="radiogroup" aria-label={entry.question} className="mt-3 space-y-2 ps-12">
        {entry.options.map((o) => {
          const picked = o.enabled;
          const isBusy = busy === o.id;
          return (
            <div key={o.id}>
              <button
                type="button"
                role="radio"
                aria-checked={picked}
                disabled={Boolean(busy) || (!o.version && Boolean(o.error))}
                onClick={() => !picked && onPick(o)}
                className={`flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-start transition disabled:opacity-60 ${picked ? "border-primary bg-primary/5" : "hover:bg-muted/60"}`}
              >
                <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${picked ? "border-primary bg-primary text-primary-foreground" : ""}`}>
                  {isBusy ? <Loader2 className="size-3 animate-spin" /> : picked ? <Check className="size-3" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{o.label}</span>
                  {o.description ? <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{o.description}</span> : null}
                </span>
              </button>
              <div className="ps-7 pt-1"><Problems mod={o} onFix={() => onPick(o)} /></div>
            </div>
          );
        })}
        <ModuleSettings mod={shownMod} settings={settingsOf(shownMod)} config={config} onOwnSaved={onOwnSaved} />
      </div>
    </div>
  );
}

function Toggle({ checked, disabled, busy, label, onChange }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      {busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
      <Switch.Root
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        dir="ltr"
        aria-label={label}
        className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors data-[state=checked]:bg-primary disabled:opacity-50"
      >
        <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.375rem]" />
      </Switch.Root>
    </span>
  );
}

// What a switch will do, in a dialog in the middle of the screen (a card at the top of a long list
// was missed: the switch looked dead).
function PlanDialog({ pending, busy, onCancel, onConfirm }) {
  const lines = planLines(pending?.plan);
  return (
    <Dialog.Root open={Boolean(pending)} onOpenChange={(open) => !open && !busy && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] overlay" />
        <Dialog.Content dir="rtl" className="pop fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-card p-5 shadow-2xl">
          {pending ? (
            <>
              <div className="mb-3 flex items-start gap-2">
                <Dialog.Title className="font-semibold">{pending.enable ? t("روشن کردن") : t("خاموش کردن")} «{pending.mod.title}»</Dialog.Title>
                <Dialog.Close disabled={busy} className="press ms-auto rounded-full p-1.5 hover:bg-muted" aria-label={t("بستن")}><X className="size-4" /></Dialog.Close>
              </div>
              <Dialog.Description className="mb-2 text-xs text-muted-foreground">{t("این کارها انجام می‌شود:")}</Dialog.Description>
              <ul className="space-y-2 text-sm">
                {lines.map((line, i) => {
                  const Icon = PLAN_ICON[line.tone] || ArrowLeftRight;
                  return (
                    <li key={i} className="flex items-start gap-2">
                      <Icon className={`mt-0.5 size-4 shrink-0 ${PLAN_TONE[line.tone]}`} />
                      <span className={line.tone === "note" ? "text-muted-foreground" : ""}>{line.text}</span>
                    </li>
                  );
                })}
              </ul>
              {pending.plan.risky ? <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-warn/10 p-2 text-xs text-warn"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{t("این تغییر به چیزی زنده دست می‌زند؛ با «انجام بده» تأیید می‌کنید.")}</p> : null}
              <div className="mt-4 flex gap-2">
                <button type="button" disabled={busy} onClick={onConfirm} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-60">
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}انجام بده
                </button>
                <button type="button" disabled={busy} onClick={onCancel} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-muted">{t("بیخیال")}</button>
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
