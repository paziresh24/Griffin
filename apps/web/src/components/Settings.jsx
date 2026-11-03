import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Dialog, Switch } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { Activity, BarChart3, Bell, Palette, ArrowRight, Bot, Check, ChevronDown, ChevronLeft, Copy, ExternalLink, KeyRound, Languages, Loader2, LogOut, MessageSquare, Plug, Plus, RefreshCw, Search, Send, ShieldOff, Sparkles, Store, Trash2, UserRound, X, Pencil, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { StatusSection, Pill } from "./Health.jsx";
import { Choice, Group, Item, SectionHeader, SettingRow, Tabs, Toggle } from "./SettingsParts.jsx";
import { BRAND, agentMeta, readSetting, writeSetting } from "../brand.js";
import { lang, num, setLang, t } from "../i18n.js";
import { ProvidersSection } from "./Providers.jsx";
import { FeedbackInbox } from "./Feedback.jsx";
import { ClickMapSection } from "./ClickMap.jsx";
import { AccountingSection } from "./Accounting.jsx";
import { DoctorSection } from "./Doctor.jsx";
import { SecretsSection } from "./Secrets.jsx";
import { McpServersSection } from "./McpServers.jsx";
import { PhoneSection } from "./Phone.jsx";
import { MyBrowserSection } from "./MyBrowser.jsx";
import { ServerBrowserSection } from "./ServerBrowser.jsx";
import { ConfigSection, FeatureHelp, FeaturesSection, featureBadges, useFeatureRows } from "./Config.jsx";
import { profileChanged } from "../profile.js";
import { TokensSection } from "./Tokens.jsx";
import { UsageBadge } from "./Usage.jsx";
import { SttSection } from "./PlanLimits.jsx";
import { AgentsPage } from "./Agents.jsx";
import { AppearanceSection } from "./Appearance.jsx";
import { ModulesSection } from "./Modules.jsx";
import { pushSupportIssue, subscriptionToJSON, urlBase64ToUint8Array } from "../push.js";
import { setUiPrefs, useFlag, useLook, useUiPrefs } from "../ui-prefs.js";
import { FIRST_SECTION, linkedSection, pageOf, pagesFor, searchSettings, sectionId, settingsIndex } from "../settings-map.js";
import { blockedBy, featureDepth, featureOf, featureOn, featureValue } from "../settings-features.js";
import { Compare } from "./SettingsPreview.jsx";
import { agoPhrase, connectionRows } from "../karsara-shell.js";
import { exactTime } from "../elapsed.js";
import { ProxyStep } from "./Setup.jsx";
import { UpdateNotice } from "./UpdateNotice.jsx";
import { TwoStepSection } from "./TwoStep.jsx";

import { askConfirm } from "../dialog.jsx";

const KIND_META = {
  telegram_bot: { label: t("ربات تلگرام"), icon: Send, tint: "text-sky-500 bg-sky-500/12", link: (u, code) => `https://t.me/${u}?start=${code}`, help: t("در تلگرام از @BotFather یک ربات بساز و توکنش را اینجا بگذار.") },
  bale_bot: { label: t("ربات بله"), icon: Bot, tint: "text-emerald-500 bg-emerald-500/12", link: (u, code) => `https://ble.ir/${u}?start=${code}`, help: t("در بله از @botfather یک ربات بساز و توکنش را اینجا بگذار.") },
  telegram_account: { label: t("اکانت تلگرام"), icon: UserRound, tint: "text-sky-500 bg-sky-500/12" },
};

const PAGE_ICONS = { activity: Activity, user: UserRound, palette: Palette, message: MessageSquare, bot: Bot, plug: Plug, store: Store, chart: BarChart3 };
const LAST_SECTION = "griffin.settings.section";

const subscribeHash = (callback) => {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
};
const useHash = () => useSyncExternalStore(subscribeHash, () => window.location.hash);

/** With no section in the address: the one picked last, or «وضعیت» when the flag asks to start there. */
const restingSection = (fromStatus) => (fromStatus ? FIRST_SECTION : sectionId(readSetting(LAST_SECTION, "")) || FIRST_SECTION);

// The address says which section is open (#/settings/providers), so a link, the back button and a
// phone all agree. A phone at #/settings shows the list of pages instead of a section; a computer has
// that list beside it (owner 2026-11-01: «توی گوشی هم مضخرفه، نوار بغل اسکرول هم نمیشه»: the column had
// no scroll of its own, so on a short screen the rows past its end could not be reached).
export function SettingsPage({ onBack, onSection, theme, onTheme }) {
  const fromStatus = useFlag("settingsList"); // «تنظیمات همیشه از «وضعیت» باز شود» (ui-prefs.js)
  const flat = useLook() === "karsara";
  const hash = useHash();
  const linked = linkedSection(hash);
  const section = linked || restingSection(fromStatus);
  // "Usage accounting" is there only where the server has it.
  const [hub, setHub] = useState(false);
  useEffect(() => {
    let alive = true;
    api("/api/accounting").then(() => alive && setHub(true), () => {});
    return () => {
      alive = false;
    };
  }, []);
  const pages = useMemo(() => pagesFor(hub), [hub]);
  const page = pageOf(section, pages) || pages[0];
  const current = page.sections.find((s) => s.id === section) || page.sections[0];
  // The open section names the browser tab (tab-title.js).
  useEffect(() => {
    onSection?.(current.label);
    return () => onSection?.("");
  }, [current.label, onSection]);
  useEffect(() => {
    if (linked && !fromStatus) writeSetting(LAST_SECTION, linked);
  }, [linked, fromStatus]);
  const setSection = useCallback((id) => {
    window.location.hash = `/settings/${id}`;
  }, []);

  // A search result opens its section and shows the row it found.
  const [focus, setFocus] = useState(null);
  const open = (entry) => {
    setSection(entry.section);
    setFocus(entry.focus || null);
  };
  useEffect(() => {
    if (!focus) return undefined;
    let tries = 0;
    const timer = setInterval(() => {
      const row = document.getElementById(`set-${focus}`);
      tries += 1;
      if (!row && tries < 30) return;
      clearInterval(timer);
      setFocus(null);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.dataset.flash = "";
      setTimeout(() => delete row.dataset.flash, 1800);
    }, 100);
    return () => clearInterval(timer);
  }, [focus]);

  const backArrow = (label, onClick) => (
    <button type="button" onClick={onClick} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={label}>
      <ArrowRight className="rtl-mirror size-4" />
    </button>
  );
  const title = <h1 className="font-semibold">{t("تنظیمات")}</h1>;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <aside className="g-settings-rail hidden min-h-0 w-60 shrink-0 flex-col border-e bg-card/50 sm:flex">
        <div className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-[max(env(safe-area-inset-top),1rem)]">
          {backArrow(t("بازگشت"), onBack)}
          {title}
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <SettingsSearch pages={pages} onOpen={open}>
            <nav className="space-y-0.5">
              {pages.map((p) => {
                const Icon = PAGE_ICONS[p.icon];
                const active = page.id === p.id;
                return (
                  <button key={p.id} type="button" onClick={() => setSection(p.sections[0].id)} aria-current={active ? "page" : undefined} className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}>
                    {active ? <motion.span layoutId="settings-nav" className="g-nav-bar absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-primary" /> : null}
                    <Icon className={`size-4 shrink-0 ${active ? "text-primary" : ""}`} />
                    <span className="min-w-0 truncate">{p.label}</span>
                  </button>
                );
              })}
            </nav>
          </SettingsSearch>
        </div>
      </aside>

      <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto">
        {linked ? null : (
          <div className="px-4 pb-16 pt-[max(env(safe-area-inset-top),1rem)] sm:hidden">
            <div className="mb-4 flex items-center gap-2">
              {backArrow(t("بازگشت"), onBack)}
              {title}
            </div>
            <SettingsSearch pages={pages} onOpen={open}>
              <nav className="divide-y overflow-hidden rounded-2xl border bg-card">
                {pages.map((p) => {
                  const Icon = PAGE_ICONS[p.icon];
                  return (
                    <button key={p.id} type="button" onClick={() => setSection(p.sections[0].id)} className="press flex w-full items-center gap-3 px-4 py-3 text-start">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary"><Icon className="size-[18px]" /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{p.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">{p.blurb}</span>
                      </span>
                      <ChevronLeft className="rtl-mirror size-4 shrink-0 text-muted-foreground" />
                    </button>
                  );
                })}
              </nav>
            </SettingsSearch>
          </div>
        )}
        <div className={`g-settings-content mx-auto w-full max-w-2xl px-4 pb-16 pt-[max(env(safe-area-inset-top),1rem)] sm:px-8 sm:pt-10 ${linked ? "" : "hidden sm:block"}`}>
          <div className="mb-4 flex items-center gap-2 sm:hidden">
            {backArrow(t("همهٔ تنظیمات"), () => { window.location.hash = "/settings"; })}
            <h1 className="font-semibold">{t("تنظیمات")}</h1>
          </div>
          {current.id === "connections" ? null : <SectionHeader title={page.label} description={current.description} />}
          {page.sections.length > 1 && current.id !== "connections" ? <Tabs label={page.label} tabs={page.sections} value={current.id} onChange={setSection} /> : null}
          <motion.div key={current.id} initial={flat ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
            {current.id === "connections" ? (
              <ConnectionsSection page={page} meta={current} onTab={setSection} />
            ) : current.id === "health" ? (
              <div className="space-y-6">
                <UpdateNotice place="settings" />
                <ConnectionsCheck onSection={setSection} />
                <DoctorSection />
              </div>
            ) : current.id === "server" ? (
              <StatusSection />
            ) : current.id === "secrets" ? (
              <SecretsSection />
            ) : current.id === "feedback" ? (
              <FeedbackInbox />
            ) : current.id === "clicks" ? (
              <ClickMapSection />
            ) : current.id === "accounting" ? (
              <AccountingSection />
            ) : current.id === "proxy" ? (
              <ProxyStep heading={false} />
            ) : current.id === "mcp" ? (
              <McpServersSection />
            ) : current.id === "phone" ? (
              <PhoneSection />
            ) : current.id === "browser" ? (
              <div className="space-y-8">
                <section className="space-y-3"><h3 className="text-sm font-semibold">{t("مرورگر سرور")}</h3><ServerBrowserSection /></section>
                <section className="space-y-3"><h3 className="text-sm font-semibold">{t("مرورگر من")}</h3><MyBrowserSection /></section>
              </div>
            ) : current.id === "features" ? (
              <FeaturesSection />
            ) : current.id === "config" ? (
              <ConfigSection onSection={setSection} />
            ) : current.id === "tokens" ? (
              <div className="space-y-6">
                <div className="rounded-xl border p-1"><UsageBadge open /></div>
                <TokensSection />
              </div>
            ) : current.id === "agents" ? (
              <AgentsPage embedded />
            ) : current.id === "providers" ? (
              <ProvidersSection />
            ) : current.id === "knowledge" ? (
              <KnowledgeSection />
            ) : current.id === "chat" ? (
              <div className="space-y-6">
                <ChatPrefsSection />
                <SttSection />
                <PushSection />
              </div>
            ) : current.id === "appearance" ? (
              <AppearanceSection onSection={setSection} theme={theme} onTheme={onTheme} focus={focus} />
            ) : current.id === "market" ? (
              <ModulesSection />
            ) : (
              <div className="space-y-6">
                <ProfileSection />
                <TwoStepSection />
                <AccountSection />
              </div>
            )}
          </motion.div>
        </div>
      </div>
    </div>
  );
}

// The box above the pages. While something is typed its results stand in for the list below it.
function SettingsSearch({ pages, onOpen, children }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState(null);
  const asked = useRef(false);
  const load = () => {
    if (asked.current) return;
    asked.current = true;
    api("/api/config").then((d) => setRows(d.settings || []), () => setRows([]));
  };
  const entries = useMemo(() => settingsIndex(rows || [], pages), [rows, pages]);
  const found = query.trim() ? searchSettings(query, entries) : null;
  return (
    <>
      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input type="search" value={query} onFocus={load} onChange={(e) => setQuery(e.target.value)} placeholder={t("جستجو در تنظیمات")} aria-label={t("جستجو در تنظیمات")} className="w-full rounded-lg border bg-background py-1.5 pe-2 ps-8 text-sm outline-none focus:border-primary" />
      </label>
      {!found ? children : found.length ? (
        <ul className="space-y-0.5">
          {found.map((entry) => (
            <li key={entry.id}>
              <button type="button" onClick={() => { setQuery(""); onOpen(entry); }} className="w-full rounded-lg px-3 py-1.5 text-start hover:bg-muted/60">
                <span className="block text-sm" dir="auto">{entry.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{entry.path}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="px-3 py-4 text-center text-xs text-muted-foreground">{t("چیزی پیدا نشد")}</p>}
    </>
  );
}

// «وضعیت»: the connection checklist (karsara-shell.js connectionRows) from fast reads, above the live check.
const STATUS_ICON = { ok: Check, warn: KeyRound, off: X };
const STATUS_TINT = { ok: "bg-ok/12 text-ok", warn: "bg-warn/12 text-warn", off: "bg-muted text-muted-foreground" };
function ConnectionsCheck({ onSection }) {
  const [reads, setReads] = useState({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const get = (path) => api(path).catch(() => null);
    Promise.all([get("/api/setup"), get("/api/integrations"), get("/api/telegram-inbox/status"), get("/api/mcp-servers"), get("/api/setup/status")]).then(([setup, integrations, inbox, mcp, checks]) => {
      if (!alive) return;
      setReads({ setup, integrations: integrations?.integrations || [], inbox, mcp, checks });
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  const rows = connectionRows(reads);
  return (
    <Group joined title={t("وضعیت اتصال‌ها")}>
      {!loaded ? (
        <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
      ) : !rows.length ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t("وضعیت اتصال‌ها خوانده نشد.")}</p>
      ) : (
        rows.map((row) => (
          <Item
            key={row.id}
            icon={STATUS_ICON[row.level]}
            tint={STATUS_TINT[row.level]}
            title={row.title}
            subtitle={row.subtitle}
            trailing={row.action ? (
              <button
                type="button"
                onClick={() => (row.action.href ? (window.location.hash = row.action.href.slice(1)) : onSection(sectionId(row.action.section) || row.action.section))}
                className="g-pill press rounded-lg border px-2.5 py-1 text-xs hover:bg-muted"
              >
                {row.action.label}
              </button>
            ) : null}
          />
        ))
      )}
    </Group>
  );
}

// Web Push on this device. The permission prompt fires only from this tap, never on
// page load. The lock screen shows the chat title and one short, redacted line.
function PushSection() {
  const [status, setStatus] = useState("checking"); // checking | unsupported | off | on | busy
  const [issue, setIssue] = useState(null);

  const refresh = useCallback(async () => {
    const problem = pushSupportIssue();
    if (problem) {
      setIssue(problem);
      setStatus("unsupported");
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      setStatus((await registration.pushManager.getSubscription()) ? "on" : "off");
    } catch {
      setStatus("off");
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const enable = async () => {
    setStatus("busy");
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        toast.error(t("اجازهٔ اعلان داده نشد"));
        setStatus("off");
        return;
      }
      const { publicKey } = await api("/api/push/key");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await api("/api/push/subscribe", { method: "POST", body: subscriptionToJSON(subscription) });
      toast.success(t("اعلان‌ها روشن شد"));
      setStatus("on");
    } catch (error) {
      toast.error(error.message || t("روشن کردن اعلان نشد"));
      setStatus("off");
    }
  };

  const disable = async () => {
    setStatus("busy");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api("/api/push/subscribe", { method: "DELETE", body: { endpoint: subscription.endpoint } }).catch(() => {});
        await subscription.unsubscribe();
      }
      setStatus("off");
    } catch (error) {
      toast.error(error.message || t("خاموش کردن اعلان نشد"));
      setStatus("on");
    }
  };

  return (
    <Group title={t("اعلان")}>
      <Item
        icon={Bell}
        tint="bg-primary/12 text-primary"
        title={t("اعلان روی این دستگاه")}
        subtitle={status === "unsupported" ? issue : status === "on" ? t("روشن") : status === "checking" || status === "busy" ? "…" : t("خاموش")}
        trailing={
          <Switch.Root
            checked={status === "on"}
            disabled={status === "checking" || status === "busy" || status === "unsupported"}
            onCheckedChange={(checked) => (checked ? enable() : disable())}
            dir="ltr"
            className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors data-[state=checked]:bg-primary"
            aria-label={t("اعلان‌ها")}
          >
            <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.375rem]" />
          </Switch.Root>
        }
      />
    </Group>
  );
}

function ConnectionsSection({ page, meta, onTab }) {
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api("/api/integrations").then(setData, (e) => toast.error(e.message)), []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <>
      <SectionHeader
        title={page.label}
        description={meta.description}
        action={
          <button type="button" onClick={() => setAdding(true)} className="press flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm">
            <Plus className="size-4" /> {t("اتصال جدید")}
          </button>
        }
      />
      <Tabs label={page.label} tabs={page.sections} value={meta.id} onChange={onTab} />
      {!data ? (
        <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : data.integrations.length === 0 ? (
        <button type="button" onClick={() => setAdding(true)} className="press flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed py-12 text-sm text-muted-foreground hover:border-primary/60 hover:text-foreground">
          <Send className="size-6" />
          {t("هنوز اتصالی نیست — ربات تلگرام/بله یا اکانت تلگرام اضافه کن")}
        </button>
      ) : (
        <Group>
          {data.integrations.map((integration) => (
            <IntegrationRow key={integration.id} integration={integration} onChange={load} />
          ))}
        </Group>
      )}
      <AddDialog open={adding} onOpenChange={setAdding} onAdded={load} />
    </>
  );
}

const STATUS = {
  polling: ["ok", t("وصل")],
  starting: ["warn", t("در حال اتصال")],
  error: ["bad", t("خطا")],
  unavailable: ["warn", t("اختلال دریافت")],
  stopped: ["none", t("متوقف")],
  disabled: ["none", t("غیرفعال")],
};

function IntegrationRow({ integration, onChange }) {
  const meta = KIND_META[integration.kind] || { label: integration.kind, icon: Bot, tint: "bg-muted" };
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const patch = async (body) => {
    setBusy(true);
    try {
      await api(`/api/integrations/${integration.id}`, { method: "PATCH", body });
      await onChange();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await askConfirm(t("«{name}» حذف شود؟ گفتگوهای ساخته‌شده در گریفین می‌مانند.", { name: integration.name })))) return;
    await api(`/api/integrations/${integration.id}`, { method: "DELETE" }).catch((e) => toast.error(e.message));
    onChange();
  };
  const [tone, statusLabel] = STATUS[!integration.enabled ? "disabled" : integration.status?.state] || STATUS.stopped;
  const problem = integration.status?.userMessage || (integration.status?.state === "error" ? integration.status.lastError : null);
  const isBot = integration.kind !== "telegram_account";
  const link = integration.username && integration.pairingCode && meta.link ? meta.link(integration.username, integration.pairingCode) : null;
  const subtitle = (
    <>
      {meta.label}
      {integration.username ? <> · <bdi dir="ltr">@{integration.username}</bdi></> : null}
      {isBot ? ` · ${t("{n} گفتگو", { n: num(integration.paired.length) })}` : null}
    </>
  );

  return (
    <Item
      icon={meta.icon}
      tint={meta.tint}
      title={integration.name}
      subtitle={subtitle}
      trailing={
        <>
          <Pill state={problem && integration.enabled ? "warn" : tone} title={problem || ""}>{statusLabel}</Pill>
          <Switch.Root
            checked={integration.enabled}
            disabled={busy}
            onCheckedChange={(enabled) => patch({ enabled })}
            onClick={(e) => e.stopPropagation()}
            dir="ltr"
            className="relative h-5 w-9 shrink-0 rounded-full bg-muted-foreground/25 transition-colors data-[state=checked]:bg-primary"
            aria-label={t("فعال")}
          >
            <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.125rem]" />
          </Switch.Root>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={t("جزئیات")} className="press flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted">
            <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </>
      }
    >
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="space-y-3 border-t bg-muted/30 px-4 py-3 text-sm">
              {problem ? <p className="rounded-lg bg-warn/10 px-3 py-2 text-xs" dir="auto">{problem}</p> : null}
              {isBot ? (
                <>
                  {integration.paired.length ? (
                    <ul className="space-y-1">
                      {integration.paired.map((p) => (
                        <li key={p.id} className="flex items-center gap-2">
                          <Check className="size-3.5 text-ok" />
                          <span dir="auto">{p.name}</span>
                          <button type="button" onClick={() => patch({ unpair: p.id })} className="press ms-auto rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-bad">{t("قطع")}</button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("هنوز گفتگویی وصل نشده.")}</p>
                  )}
                  {integration.pairingCode ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-background p-2.5">
                      <span className="text-xs text-muted-foreground">{t("در ربات بفرست:")}</span>
                      <code className="ltr rounded-md bg-muted px-2 py-1 font-mono text-sm tracking-wider">/start {integration.pairingCode}</code>
                      <CopyButton text={`/start ${integration.pairingCode}`} />
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer" className="press ms-auto flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
                          {t("باز کردن ربات")} <ExternalLink className="size-3" />
                        </a>
                      ) : null}
                    </div>
                  ) : (
                    <button type="button" onClick={() => patch({ newPairingCode: true })} className="press flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                      <RefreshCw className="size-3.5" /> {t("کد اتصال برای گفتگوی دیگر")}
                    </button>
                  )}
                </>
              ) : (
                <p className="text-xs leading-5 text-muted-foreground">{t("{name} با این اکانت در Saved Messages با تو حرف می‌زند، رشته‌های گفتگو با هم‌تیمی‌ها را جواب می‌دهد و ابزارهای تلگرام را دارد.", { name: BRAND.name })}</p>
              )}
              <div className="flex justify-end">
                <button type="button" onClick={remove} className="press flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-bad/10 hover:text-bad">
                  <Trash2 className="size-3.5" /> {t("حذف اتصال")}
                </button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Item>
  );
}

// «گفتگو»: the chat switches of /api/config (settings-features.js, group chat), all live. The next-message
// suggestion is one question made of an install setting and a per-user flag: off, in a row above the
// box, or as ghost text in it.
const CHAT_KEYS = ["ENTER_KEY", "AUTO_CONTINUE", "PLAN_FALLBACK", "PLAN_APPROVAL", "SIDE_CHAT", "CHAT_SEARCH_MESSAGES"];
const CHAT_ICONS = { AUTO_CONTINUE: RefreshCw, SIDE_CHAT: MessageSquare };

function ChatPrefsSection() {
  const { rows, busy, set } = useFeatureRows();
  const { flags } = useUiPrefs();
  if (!rows) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  const row = (key) => rows.find((r) => r.key === key);
  const suggest = featureOf("PROMPT_SUGGESTIONS");
  const next = featureOf("NEXT_STEP_RETURNS");
  const suggestOn = featureOn(suggest, row(suggest.key));
  const where = !suggestOn ? "off" : flags.nextGhost ? "ghost" : "row";
  const pick = (id) => {
    if ((id === "off") === suggestOn) set(suggest.key, id === "off" ? "off" : "on");
    if (id !== "off") setUiPrefs({ flags: { nextGhost: id === "ghost" } });
  };
  const nextBlocked = blockedBy(next, rows);
  return (
    <Group title={t("گفتگو")}>
      <SettingRow
        id="PROMPT_SUGGESTIONS"
        icon={Sparkles}
        title={suggest.title}
        help={<FeatureHelp feature={suggest}><Compare flags={flags} flagKey="nextGhost" /></FeatureHelp>}
        under={<Choice label={suggest.title} value={where} onChange={pick} disabled={busy === suggest.key} options={[{ id: "off", label: t("خاموش") }, { id: "row", label: t("ردیف بالای کادر") }, { id: "ghost", label: t("کم‌رنگ داخل کادر") }]} />}
      />
      <div id="set-nextGhost" />
      <SettingRow
        id={next.key}
        title={next.title}
        depth={featureDepth(next) || 1}
        dim={Boolean(nextBlocked)}
        help={<FeatureHelp feature={next} />}
        badges={featureBadges(next)}
        control={<Toggle on={featureOn(next, row(next.key))} label={next.title} disabled={Boolean(nextBlocked)} busy={busy === next.key} onChange={(on) => set(next.key, on ? "on" : "off")} />}
      />
      {CHAT_KEYS.map((key) => {
        const feature = featureOf(key);
        const current = row(key);
        return (
          <SettingRow
            key={key}
            id={key}
            icon={CHAT_ICONS[key]}
            title={feature.title}
            help={<FeatureHelp feature={feature} />}
            badges={featureBadges(feature)}
            control={feature.choices ? null : <Toggle on={featureOn(feature, current)} label={feature.title} busy={busy === key} onChange={(on) => set(key, on ? "on" : "off")} />}
            under={feature.choices ? <Choice label={feature.title} value={featureValue(feature, current)} disabled={busy === key} onChange={(value) => set(key, value)} options={Object.entries(feature.choices).map(([id, label]) => ({ id, label }))} /> : null}
          />
        );
      })}
    </Group>
  );
}

// The owner's name at the foot of the sidebar (GET/PUT /api/profile). Telegram's name and photo come
// by themselves once the account is connected; a name typed here wins, and an empty one goes back to it.
function ProfileSection() {
  const [profile, setProfile] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/api/profile").then((p) => (setProfile(p), setName(p.typedName || "")), (e) => toast.error(e.message));
  }, []);
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const next = await api("/api/profile", { method: "PUT", body: { name } });
      setProfile(next);
      setName(next.typedName || "");
      profileChanged(next);
      toast.success(t("ذخیره شد"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const changed = profile && name.trim() !== (profile.typedName || "");
  return (
    <section>
    <h3 className="mb-2 px-1 text-xs font-medium text-muted-foreground">{t("نام شما در منو")}</h3>
    <form onSubmit={save} className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-4 shadow-sm">
      {profile?.photo ? (
        <img src={profile.photo} alt="" className="size-10 shrink-0 rounded-full object-cover" onError={() => setProfile({ ...profile, photo: null })} />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary"><UserRound className="size-5" /></span>
      )}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={60}
        dir="auto"
        disabled={!profile || busy}
        placeholder={profile?.telegramName || t("نام شما")}
        aria-label={t("نام شما")}
        className="min-w-0 flex-1 rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
      />
      <button type="submit" disabled={!changed || busy} className="press rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm disabled:opacity-50">
        {busy ? <Loader2 className="size-4 animate-spin" /> : t("ذخیره")}
      </button>
    </form>
    <p className="mt-2 px-1 text-xs leading-5 text-muted-foreground">{t("خالی بگذارید تا نام و عکس اکانت تلگرامِ وصل‌شده بیاید.")}</p>
    </section>
  );
}

function AccountSection() {
  const logout = () => api("/api/auth/logout", { method: "POST" }).finally(() => window.location.reload());
  const revokeAll = async () => {
    if (!(await askConfirm(t("از همهٔ دستگاه‌ها (از جمله همین) خارج شوی؟")))) return;
    await api("/api/auth/revoke-all", { method: "POST" }).catch((e) => toast.error(e.message));
    window.location.reload();
  };
  // The new token is shown here once (never stored by the page); this device stays signed in.
  const [newToken, setNewToken] = useState("");
  const rotate = async () => {
    if (!(await askConfirm(t("توکن ورود عوض شود؟ توکن فعلی (ورود، اسکریپت‌ها و CLI) از کار می‌افتد و بقیهٔ دستگاه‌ها خارج می‌شوند.")))) return;
    try {
      setNewToken((await api("/api/auth/rotate-token", { method: "POST" })).token);
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <div className="space-y-6">
      <Group>
        <Item
          icon={Languages}
          title={t("زبان")}
          trailing={
            <div className="flex gap-1 rounded-xl bg-muted p-1">
              {[["fa", "فارسی"], ["en", "English"]].map(([id, label]) => ( // i18n-ignore
                <button
                  key={id}
                  type="button"
                  onClick={() => id !== lang && setLang(id)}
                  aria-pressed={lang === id}
                  className={`rounded-lg px-3 py-1 text-sm ${lang === id ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        />
      </Group>
      <Group title={t("نشست‌ها")}>
        <Item icon={LogOut} title={t("خروج از این دستگاه")} subtitle={t("کوکی همین مرورگر پاک می‌شود")} onClick={logout} />
        <Item icon={ShieldOff} tint="bg-bad/10 text-bad" title={t("خروج از همهٔ دستگاه‌ها")} subtitle={t("همهٔ نشست‌ها باطل می‌شوند؛ برای ورود دوباره توکن لازم است")} onClick={revokeAll} />
      <Item icon={KeyRound} tint="bg-bad/10 text-bad" title={t("ریست توکن ورود")} subtitle={t("توکن تازه ساخته می‌شود؛ قبلی و بقیهٔ نشست‌ها باطل می‌شوند")} onClick={newToken ? undefined : rotate}>
        {newToken ? (
          <div className="mx-4 mb-3 rounded-xl border bg-muted/40 p-3">
            <p className="mb-2 text-xs leading-5 text-muted-foreground">{t("توکن تازه فقط همین یک بار نشان داده می‌شود؛ جای امن (مثلاً Infisical) نگهش دارید.")}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs" dir="ltr">{newToken}</code>
              <CopyButton text={newToken} />
            </div>
          </div>
        ) : null}
      </Item>
      </Group>
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})}
      className="press flex size-7 items-center justify-center rounded-md hover:bg-background"
      aria-label={t("کپی")}
    >
      {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

// Owner's own Telegram account: the phone (plus api credentials from my.telegram.org when this server
// has no default app), then the code Telegram sends, then the two-step password if the account has one. Values go straight to the server and Telegram.
export function AccountLogin({ onDone }) {
  const [step, setStep] = useState("phone");
  const [form, setForm] = useState({ apiId: "", apiHash: "", phone: "", code: "", password: "" });
  // null = still asking the server; then true/false.
  const [preset, setPreset] = useState(null);
  const checkPreset = useCallback(() => api("/api/integrations/telegram-account/app").then((r) => setPreset(Boolean(r.preset)), () => setPreset(false)), []);
  useEffect(() => {
    checkPreset();
  }, [checkPreset]);
  const [loginId, setLoginId] = useState(null);
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (step === "phone") {
        const r = await api("/api/integrations/telegram-account/login", { method: "POST", body: preset ? { phone: form.phone.trim() } : { apiId: form.apiId.trim(), apiHash: form.apiHash.trim(), phone: form.phone.trim() } });
        setLoginId(r.loginId);
        setStep("code");
        toast(r.viaApp ? t("کد به اپ تلگرامت فرستاده شد") : t("کد با پیامک فرستاده شد"));
      } else {
        const body = step === "code" ? { code: form.code.trim() } : { password: form.password };
        const r = await api(`/api/integrations/telegram-account/login/${loginId}`, { method: "POST", body });
        if (r.needPassword) {
          setHint(r.hint || "");
          setStep("password");
        } else {
          setForm({ apiId: "", apiHash: "", phone: "", code: "", password: "" });
          toast.success(t("اکانت تلگرام وصل شد"));
          onDone();
        }
      }
    } catch (error) {
      toast.error(error.message);
      // The server's default app may have gone away since the form opened: ask again, so the id
      // fields come back instead of the same refusal.
      if (step === "phone" && preset) checkPreset();
    } finally {
      setBusy(false);
    }
  };

  const [linkBefore, linkAfter] = t("در {link} یک app بساز و api_id و api_hash را اینجا بگذار.").split("{link}");
  const input = "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary";
  return (
    <form onSubmit={submit} className="space-y-3">
      <ol className="flex items-center gap-2 text-xs text-muted-foreground">
        {[["phone", t("شماره")], ["code", t("کد")], ["password", t("رمز دوم")]].map(([key, label], i) => (
          <li key={key} className={`flex items-center gap-1 ${step === key ? "font-medium text-foreground" : ""}`}>
            <span className={`flex size-5 items-center justify-center rounded-full text-[10px] ${step === key ? "bg-primary text-primary-foreground" : "bg-muted"}`}>{i + 1}</span>{label}
          </li>
        ))}
      </ol>
      {step === "phone" ? (
        <>
          {preset === false ? (
            <>
              <p className="text-xs leading-5 text-muted-foreground">
                {linkBefore}<a className="text-primary underline" href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">my.telegram.org/apps</a>{linkAfter}
              </p>
              <div className="grid grid-cols-3 gap-2">
                <input value={form.apiId} onChange={set("apiId")} required inputMode="numeric" placeholder="api_id" className={`ltr col-span-1 font-mono ${input}`} />
                <input value={form.apiHash} onChange={set("apiHash")} required autoComplete="off" spellCheck={false} placeholder="api_hash" className={`ltr col-span-2 font-mono ${input}`} />
              </div>
            </>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">{t("شمارهٔ تلگرامت را با کد کشور بنویس؛ کد ورود به اپ تلگرامت می‌آید.")}</p>
          )}
          <input value={form.phone} onChange={set("phone")} required inputMode="tel" placeholder="+98912…" className={`ltr font-mono ${input}`} />
        </>
      ) : step === "code" ? (
        <input value={form.code} onChange={set("code")} required autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder={t("کد ورود")} className={`ltr text-center font-mono text-lg tracking-[0.4em] ${input}`} />
      ) : (
        <>
          <p className="text-xs leading-5 text-muted-foreground">{t("این اکانت رمز دوم (تأیید دومرحله‌ای) دارد؛ همان رمزی که در تلگرام گذاشته‌ای.")}{hint ? <> {t("راهنمایی که خودت گذاشته‌ای:")} <span className="font-medium text-foreground">{hint}</span></> : null}</p>
          <input value={form.password} onChange={set("password")} required autoFocus type="password" autoComplete="current-password" placeholder={t("رمز تأیید دومرحله‌ای")} className={`ltr ${input}`} />
        </>
      )}
      <button type="submit" disabled={busy} className="press flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 font-medium text-primary-foreground disabled:opacity-50">
        {busy ? <Loader2 className="size-4 animate-spin" /> : null} {step === "phone" ? t("ارسال کد") : t("ورود")}
      </button>
      <p className="text-center text-xs leading-5 text-muted-foreground">
        {t("{name} با این اکانت گروه‌ها و کانال‌ها را می‌خواند، در Saved Messages با تو گفتگو می‌کند و فقط بعد از تأیید تو از طرفت پیام می‌فرستد.", { name: BRAND.name })}
      </p>
    </form>
  );
}

function AddDialog({ open, onOpenChange, onAdded }) {
  const [kind, setKind] = useState("telegram_bot");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/api/integrations", { method: "POST", body: { kind, token: token.trim(), name: name.trim() } });
      toast.success(t("ربات اضافه شد؛ حالا با کد اتصال وصلش کن"));
      setToken("");
      setName("");
      onOpenChange(false);
      onAdded();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] overlay" />
        <Dialog.Content className="pop fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-card p-5 shadow-2xl">
          <div className="mb-4 flex items-center">
            <Dialog.Title className="font-semibold">{t("اتصال جدید")}</Dialog.Title>
            <Dialog.Close className="press ms-auto rounded-full p-1.5 hover:bg-muted" aria-label={t("بستن")}><X className="size-4" /></Dialog.Close>
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {["telegram_bot", "bale_bot", "telegram_account"].map((k) => {
                const meta = KIND_META[k];
                const Icon = meta.icon;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`press flex flex-col items-center gap-1.5 rounded-xl border p-3 text-xs ${kind === k ? "border-primary bg-primary/8 ring-1 ring-primary" : "hover:bg-muted"}`}
                  >
                    <span className={`flex size-8 items-center justify-center rounded-lg ${meta.tint}`}><Icon className="size-4" /></span>
                    {meta.label}
                  </button>
                );
              })}
            </div>
            {kind === "telegram_account" ? <AccountLogin onDone={() => { onOpenChange(false); onAdded(); }} /> : <form onSubmit={submit} className="space-y-4">
            <p className="text-xs leading-5 text-muted-foreground">{KIND_META[kind].help}</p>
            <label className="block">
              <span className="mb-1 flex items-center gap-1 text-xs text-muted-foreground"><KeyRound className="size-3.5" /> {t("توکن ربات")}</span>
              <input value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" spellCheck={false} placeholder="123456789:AA…" className="ltr w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">{t("نام (اختیاری)")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("گریفین من")} className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary" />
            </label>
            <button type="submit" disabled={busy || !token.trim()} className="press flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 font-medium text-primary-foreground disabled:opacity-50">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("افزودن")}
            </button>
            <p className="text-center text-xs text-muted-foreground">{t("توکن فقط روی سرور گریفین می‌ماند و دیگر نمایش داده نمی‌شود.")}</p>
            </form>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Knowledge review gate: notes agents write (knowledge_write) land here unreviewed; only
// reviewed:true notes are injected into that agent's rules. Flipping is owner-only (API).
// Edit keeps the review state when the owner does it (an agent's edit sends the note back to
// «در انتظار تأیید»); delete asks twice and moves the note to «حذف‌شده», from where it is restorable.
const KNOWLEDGE_FILTERS = [
  ["pending", t("در انتظار تأیید")],
  ["reviewed", t("تأییدشده")],
  ["all", t("همه")],
  ["trash", t("حذف‌شده")],
];
// Knowledge on auto-approve (owner 2026-11-01, KNOWLEDGE_AUTO_APPROVE=on): every note is approved
// when it is written, so the page is a list with delete only — no review toggle, no edit.
const KNOWLEDGE_AUTO_FILTERS = [
  ["all", t("همه")],
  ["trash", t("حذف‌شده")],
];

function KnowledgeSection() {
  const karsara = useFlag("timeAgo"); // «زمان به‌صورت «… پیش»»
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("pending");
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);
  const [trash, setTrash] = useState([]);
  const [editing, setEditing] = useState(null); // { key, agent, file, title, body }
  const [confirmDel, setConfirmDel] = useState(null); // key waiting for the second «حذف»

  const load = useCallback(
    () => Promise.all([api("/api/knowledge"), api("/api/knowledge/trash")]).then(([notes, bin]) => { setData(notes); setTrash(bin.trash || []); }, (e) => toast.error(e.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  const act = async (key, run, done) => {
    setBusy(key);
    try {
      await run();
      await load();
      if (done) toast.success(done);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    act(editing.key, () => api(`/api/knowledge/${editing.agent}/note`, { method: "PUT", body: { file: editing.file, title: editing.title, body: editing.body } }), t("ذخیره شد")).then(() => setEditing(null));
  const remove = (agent, file, key) => {
    setConfirmDel(null);
    act(key, () => api(`/api/knowledge/${agent}/note`, { method: "DELETE", body: { file } }), t("به «حذف‌شده» رفت؛ بازیابی‌شدنی است"));
  };
  const purge = async (item) => {
    if (!(await askConfirm(t("این دانش برای همیشه حذف می‌شود و قابل بازیابی نیست. ادامه؟")))) return;
    act(`trash/${item.id}`, () => api(`/api/knowledge/${item.agent}/trash`, { method: "DELETE", body: { id: item.id } }), t("برای همیشه حذف شد"));
  };
  const restore = (item) => act(`trash/${item.id}`, () => api(`/api/knowledge/${item.agent}/restore`, { method: "POST", body: { id: item.id } }), t("بازیابی شد"));

  const flip = async (agent, file, reviewed) => {
    setBusy(`${agent}/${file}`);
    try {
      await api(`/api/knowledge/${agent}/review`, { method: "POST", body: { file, reviewed } });
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  const auto = Boolean(data.autoApprove);
  const filters = auto ? KNOWLEDGE_AUTO_FILTERS : KNOWLEDGE_FILTERS;
  const view = auto && filter !== "trash" ? "all" : filter;
  const all = Object.entries(data.agents || {});
  const counts = {
    pending: all.reduce((n, [, notes]) => n + notes.filter((x) => !x.reviewed).length, 0),
    reviewed: all.reduce((n, [, notes]) => n + notes.filter((x) => x.reviewed).length, 0),
  };
  counts.all = counts.pending + counts.reviewed;
  counts.trash = trash.length;
  const shown = view === "trash"
    ? []
    : all
        .map(([agent, notes]) => [agent, notes.filter((x) => view === "all" || (view === "reviewed") === Boolean(x.reviewed))])
        .filter(([, notes]) => notes.length);

  return (
    <div className="space-y-6">
      {auto ? <p className="text-xs text-muted-foreground">{t("دانش خودکار است: هر یادداشتی که ایجنت می‌نویسد خودش تأیید می‌شود و به گفتگوهای بعدی می‌رسد. هر کدام غلط بود، حذفش کنید.")}</p> : null}
      <div className="flex gap-1 rounded-xl bg-muted p-1">
        {filters.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${view === id ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
          >
            {label}
            <span className="rounded-full bg-muted-foreground/15 px-1.5 text-[11px] tabular-nums">{num(counts[id])}</span>
          </button>
        ))}
      </div>

      {view === "trash" ? (
        trash.length ? (
          <Group title={t("حذف‌شده · {toLocaleString}", { toLocaleString: trash.length.toLocaleString("fa") })}>
            {trash.map((item) => (
              <Item
                key={item.id}
                title={item.title}
                subtitle={<>{agentMeta(item.agent).label} · <bdi dir="ltr">{item.deletedAt}</bdi></>}
                trailing={
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy === `trash/${item.id}`}
                      onClick={() => restore(item)}
                      className="press inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground"
                    >
                      {busy === `trash/${item.id}` ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
                      {t("بازیابی")}
                    </button>
                    <button
                      type="button"
                      disabled={busy === `trash/${item.id}`}
                      onClick={() => purge(item)}
                      className="press inline-flex items-center gap-1 rounded-full bg-destructive px-2.5 py-1 text-[11px] font-medium text-white"
                    >
                      <Trash2 className="size-3" />
                      {t("حذف دائمی")}
                    </button>
                  </div>
                }
              />
            ))}
          </Group>
        ) : (
          <p className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">{t("چیزی حذف نشده.")}</p>
        )
      ) : !shown.length ? (
        <p className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {counts.all ? t("در این دسته یادداشتی نیست.") : auto ? t("هنوز یادداشتی نیست. ایجنت‌ها خودشان می‌نویسند و اینجا می‌بینید.") : t("هنوز یادداشتی نیست. ایجنت‌ها با knowledge_write می‌نویسند و اینجا تأییدش می‌کنی.")}
        </p>
      ) : (
        shown.map(([agent, notes]) => (
          <Group key={agent} title={`${agentMeta(agent).label} · ${num(notes.length)}`}>
            {notes.map((note) => {
              const key = `${agent}/${note.file}`;
              const expanded = open === key;
              return (
                <Item
                  key={key}
                  title={note.title}
                  subtitle={
                    <>
                      {karsara && note.at ? <span title={exactTime(note.at)}>{agoPhrase(note.at)}</span> : <bdi dir="ltr">{note.at || note.file}</bdi>}
                      {note.expires ? <> · {t("انقضا")} <bdi dir="ltr">{note.expires}</bdi></> : null}
                      {note.autoTrusted ? <span title={t("از چتِ خودتان بدون محتوای شخص ثالث؛ بدون تأیید به چت‌های بعدی می‌رسد")}> · {t("خودکار")}</span> : null}
                    </>
                  }
                  onClick={() => setOpen(expanded ? null : key)}
                  trailing={
                    <>
                      {auto ? null : <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); if (busy !== key) flip(agent, note.file, !note.reviewed); }}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); flip(agent, note.file, !note.reviewed); } }}
                        className={`press inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${
                          note.reviewed ? "bg-ok/12 text-ok" : "bg-primary text-primary-foreground"
                        }`}
                      >
                        {busy === key ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                        {note.reviewed ? t("تأییدشده") : t("تأیید")}
                      </span>}
                      <ChevronDown className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
                    </>
                  }
                >
                  {expanded ? (
                    <div className="border-t bg-muted/30 px-4 py-3">
                      <p className="ltr mb-2 text-[11px] text-muted-foreground">{note.file}</p>
                      {editing?.key === key ? (
                        <div className="space-y-2">
                          <input
                            value={editing.title}
                            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                            maxLength={120}
                            className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                            dir="auto"
                          />
                          <textarea
                            value={editing.body}
                            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                            rows={12}
                            className="scrollbar-thin w-full rounded-lg border bg-background p-3 text-xs leading-5 outline-none focus:border-primary"
                            dir="auto"
                          />
                          <p className="text-[11px] text-muted-foreground">{t("ویرایش شما وضعیت تأیید را عوض نمی‌کند. رمز و توکن ننویسید.")}</p>
                          <div className="flex gap-2">
                            <button type="button" disabled={busy === key || !editing.title.trim() || !editing.body.trim()} onClick={save} className="press inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50">
                              {busy === key ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                              {t("ذخیره")}
                            </button>
                            <button type="button" onClick={() => setEditing(null)} className="press rounded-full bg-muted px-3 py-1.5 text-xs">{t("انصراف")}</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <pre className="scrollbar-thin max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-background p-3 text-xs leading-5" dir="auto">{note.body}</pre>
                          <div className="mt-3 flex items-center gap-2">
                            {auto ? null : (
                              <button type="button" onClick={() => { setConfirmDel(null); setEditing({ key, agent, file: note.file, title: note.title, body: note.body }); }} className="press inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1.5 text-xs">
                                <Pencil className="size-3" />
                                {t("ویرایش")}
                              </button>
                            )}
                            {confirmDel === key ? (
                              <>
                                <span className="text-xs text-muted-foreground">{t("مطمئنی؟ بازیابی‌شدنی است.")}</span>
                                <button type="button" disabled={busy === key} onClick={() => remove(agent, note.file, key)} className="press inline-flex items-center gap-1 rounded-full bg-bad px-3 py-1.5 text-xs font-medium text-white">
                                  {busy === key ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                                  {t("بله، حذف")}
                                </button>
                                <button type="button" onClick={() => setConfirmDel(null)} className="press rounded-full bg-muted px-3 py-1.5 text-xs">{t("انصراف")}</button>
                              </>
                            ) : (
                              <button type="button" onClick={() => setConfirmDel(key)} className="press inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1.5 text-xs text-bad">
                                <Trash2 className="size-3" />
                                {t("حذف")}
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                </Item>
              );
            })}
          </Group>
        ))
      )}
    </div>
  );
}
