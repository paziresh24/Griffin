import { modelMatches, modelName } from "../model-names.js";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Popover } from "radix-ui";
import { Command } from "cmdk";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, CircleHelp, FilePen, Hand, Infinity as InfinityIcon, ListTree, Moon, Sparkles, Sun, Bot } from "lucide-react";
import { api, usePolling } from "../api.js";
import { useFlag, useLook } from "../ui-prefs.js";
import { agentMeta, PROVIDER_META } from "../brand.js";
import { isRtl, num, t } from "../i18n.js";

// The chat's mode, as Claude Desktop's mode menu. The three asking modes apply to Claude with full
// Claude Code in the owner's chats; elsewhere they run like «بدون پرسیدن» (no asking).
export const MODES = [
  { value: "auto", label: t("خودکار"), icon: Sparkles, hint: t("Claude خودش دربارهٔ اجازه‌ها تصمیم می‌گیرد؛ هر جا مطمئن نبود از شما می‌پرسد") },
  { value: "ask", label: t("دستی"), icon: Hand, hint: t("قبل از هر تغییری از شما اجازه می‌گیرد") },
  { value: "edits", label: t("پذیرش ویرایش‌ها"), icon: FilePen, hint: t("ویرایش فایل‌ها بدون پرسیدن؛ بقیهٔ تغییرها با اجازهٔ شما") },
  { value: "plan", label: t("برنامه‌ریزی"), icon: ListTree, hint: t("اول نقشهٔ کار را می‌نویسد و بدون اجرای تغییر منتظر تأیید می‌ماند") },
  { value: "agent", label: t("بدون پرسیدن"), icon: InfinityIcon, hint: t("همه‌چیز را بدون گرفتن اجازه انجام می‌دهد (پیش‌فرض)") },
];

const PROVIDERS = [
  { value: "cursor", label: "Cursor", hint: t("ایجنت Cursor (مدل‌های حساب Cursor)") },
  { value: "claude", label: "Claude", hint: t("Claude Agent SDK مستقیم از Anthropic") },
];

// The doctor's report, shared by every composer and the new-chat card. It makes a real call per
// engine, so it is asked at most once per 15 minutes per page.
let doctorCache = { at: 0, promise: null };
export function loadDoctor() {
  if (!doctorCache.promise || Date.now() - doctorCache.at > 15 * 60_000) doctorCache = { at: Date.now(), promise: api("/api/doctor").catch(() => null) };
  return doctorCache.promise;
}
export function useDoctor() {
  const [report, setReport] = useState(null);
  useEffect(() => {
    let alive = true;
    loadDoctor().then((r) => alive && setReport(r));
    return () => {
      alive = false;
    };
  }, []);
  return report;
}
// Engine accounts whose key the provider refused (doctor cause bad_key): an amber dot in the model picker.
const badKeys = (report) => new Set((report?.engines || []).filter((e) => e.cause === "bad_key").map((e) => e.id));
const BadKeyDot = () => <span className="size-1.5 shrink-0 rounded-full bg-amber-500" role="img" aria-label={t("کلید این موتور رد شده است")} title={t("کلید این موتور رد شده است")} />;

export function AgentGlyph({ id, className = "size-8" }) {
  const meta = agentMeta(id);
  const karsara = useLook() === "karsara";
  if (meta.icon) {
    // Karsara draws its own logo as it is (a round mark), without Griffin's rounded tile.
    const tile = karsara ? "" : "rounded-[22%]";
    return <img src={meta.icon} alt="" className={`shrink-0 ${tile} ${className}`} />;
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-lg ${className}`}
      style={{ background: `${meta.color}22`, color: meta.color }}
    >
      <Bot className="size-[55%]" />
    </span>
  );
}

// The mode under the box: a small framed button with an arrow, so it reads as changeable.
// In a chat it is the mode's icon; on the new-chat page (`named`) its name too. The
// menu lists both modes with what each does.
export function ModeToggle({ mode, onChange, named = false }) {
  const [open, setOpen] = useState(false);
  // «حالت اجرا: فقط Bypass و Plan» (ui-prefs.js): Karsara's two modes, in its words.
  const simple = useFlag("modeSimple");
  if (simple) return <ModeMenu mode={mode} onChange={onChange} />;
  const current = MODES.find((m) => m.value === mode) || MODES.find((m) => m.value === "agent");
  const tone = (value) => (value === "plan" ? "text-amber-600 dark:text-amber-400" : "text-primary");
  const Icon = current.icon;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("حالت: {label}", { label: current.label })}
          title={`${current.label} — ${current.hint}`}
          className="group press flex h-7 shrink-0 items-center gap-1 rounded-lg border px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
        >
          <Icon className={`size-4 shrink-0 ${tone(current.value)}`} />
          {named ? <SwapText text={current.label} className="text-foreground" /> : null}
          <ChevronDown className="size-3 shrink-0 opacity-70 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" side="top" sideOffset={8} collisionPadding={16} className={`${MENU} p-1`}>
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => {
                onChange(m.value);
                setOpen(false);
              }}
              className="g-menu-row flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-start hover:bg-muted"
            >
              <m.icon className={`mt-0.5 size-4 shrink-0 ${tone(m.value)}`} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">{m.label}</span>
                <span className="block text-xs leading-5 text-muted-foreground">{m.hint}</span>
              </span>
              {mode === m.value ? <Check className="mt-0.5 size-3.5 shrink-0 text-primary" /> : null}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Karsara skin: the mode in English — «Bypass permissions ▾» («Bypass» on a phone) and «Plan»,
// each with a one-line description.
const KARSARA_MODES = [
  { value: "agent", label: "Bypass permissions", short: "Bypass", hint: t("اجرای مستقیم؛ ابزارها بدون پرسشِ اجازه کار می‌کنند") },
  { value: "plan", label: "Plan", short: "Plan", hint: t("اول نقشه را می‌نویسد و منتظر تأیید شما می‌ماند") },
];
function ModeMenu({ mode, onChange }) {
  const [open, setOpen] = useState(false);
  const current = KARSARA_MODES.find((m) => m.value === mode) || KARSARA_MODES[0];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="g-text-btn ltr inline-flex shrink-0 items-center gap-1 px-1 text-[13px] text-muted-foreground hover:text-foreground" aria-label={t("حالت اجرا: {label}", { label: current.label })} title={t("حالت اجرا — از منو انتخاب کنید")}>
          {current.short}<span className="max-[480px]:hidden">{current.label.slice(current.short.length)}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" side="top" sideOffset={8} collisionPadding={16} className="g-menu pop z-50 w-64 rounded-xl border bg-card p-1 shadow-xl" dir={isRtl ? "rtl" : "ltr"}>
          {KARSARA_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => {
                onChange(m.value);
                setOpen(false);
              }}
              className="g-menu-row flex w-full items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-start hover:bg-muted"
            >
              <span className="min-w-0">
                <span className="block text-[13px]">{m.label}</span>
                <span className="block text-xs text-muted-foreground">{m.hint}</span>
              </span>
              {mode === m.value ? <Check className="mt-0.5 size-3.5 shrink-0 text-primary" /> : null}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Wide rectangular agent switcher — shell chrome, not a tiny chat-header pill. */
export function AgentPicker({ agent, onChange, locked = false, className = "" }) {
  const karsara = useLook() === "karsara";
  const data = usePolling("/api/agents", 5 * 60_000);
  const agents = data?.agents || [];
  const [open, setOpen] = useState(false);
  const current = agents.find((a) => a.id === agent) || agents.find((a) => a.id === "griffin");
  const id = current?.id || agent || "griffin";
  const meta = agentMeta(id);
  const label = t(current?.label || meta.label);
  const main = agents.filter((a) => a.id === "griffin");
  const specialists = agents.filter((a) => a.id !== "griffin");

  const pick = (next) => {
    if (locked) return;
    onChange(next);
    setOpen(false);
  };

  const row = (a) => {
    const m = agentMeta(a.id);
    const selected = id === a.id;
    return (
      <Command.Item
        key={a.id}
        value={`${a.label} ${a.id}`}
        onSelect={() => pick(a.id)}
        className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-sm data-[selected=true]:bg-muted"
      >
        <AgentGlyph id={a.id} className="size-8" />
        <span className="min-w-0 flex-1 truncate text-start font-medium" dir="auto">{t(a.label)}</span>
        {selected ? <Check className="size-4 shrink-0" style={{ color: m.color }} /> : null}
      </Command.Item>
    );
  };

  return (
    <Popover.Root open={locked ? false : open} onOpenChange={locked ? undefined : setOpen}>
      <Popover.Trigger asChild>
        {karsara ? (
        <button
          type="button"
          disabled={locked}
          title={locked ? t("تا پایان کار فعلی نمی‌شود ایجنت را عوض کرد") : t("انتخاب ایجنت")}
          className={`kc-list-row min-h-11 min-w-0 flex-1 text-start data-[state=open]:bg-[var(--kc-chip)] disabled:cursor-default ${className}`}
          aria-label={t("ایجنت")}
        >
          <AgentGlyph id={id} className="size-5" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">{label}</span>
          {locked ? null : <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />}
        </button>
        ) : (
        <button
          type="button"
          disabled={locked}
          title={locked ? t("تا پایان کار فعلی نمی‌شود ایجنت را عوض کرد") : t("انتخاب ایجنت")}
          className={`g-agent-picker press flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl border bg-background px-3 text-start transition-colors hover:border-primary/50 data-[state=open]:border-primary/60 data-[state=open]:bg-accent/40 disabled:cursor-default disabled:opacity-80 ${className}`}
          aria-label={t("ایجنت")}
          style={{ boxShadow: open ? `0 0 0 1px ${meta.color}44` : undefined }}
        >
          <AgentGlyph id={id} className="size-7" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">{label}</span>
          {locked ? null : <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />}
        </button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={8} className="pop z-50 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border bg-card shadow-xl">
          <Command loop className="flex flex-col">
            <Command.Input autoFocus placeholder={t("جستجوی ایجنت…")} className="border-b bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground" />
            <Command.List className="scrollbar-thin max-h-80 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">{t("ایجنتی پیدا نشد")}</Command.Empty>
              {main.map(row)}
              {specialists.length ? (
                <>
                  <div className="my-1 border-t px-2 pb-1 pt-2 text-[11px] text-muted-foreground" dir="auto">{t("متخصص‌ها")}</div>
                  {specialists.map(row)}
                </>
              ) : null}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function ProviderPicker({ provider = "cursor", onChange, compact = false, icons = false }) {
  const [open, setOpen] = useState(false);
  const meta = PROVIDER_META[provider] || PROVIDER_META.cursor;
  const label = meta.label;
  const showLabel = !icons || open;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("موتور: {label}", { label })}
          title={label}
          className={`press flex h-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground ${
            icons
              ? showLabel
                ? "max-w-36 gap-1 px-2.5 text-[11px]"
                : "w-8"
              : compact
                ? "h-auto max-w-36 gap-1.5 px-2.5 py-1 text-[11px]"
                : "h-auto max-w-40 gap-1.5 px-3 py-1.5 text-xs"
          }`}
        >
          <Bot className="size-3.5 shrink-0 text-primary" />
          {showLabel ? (
            <>
              <span className="truncate ltr">{label}</span>
              <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
            </>
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" side="top" sideOffset={8} className="pop z-50 w-64 overflow-hidden rounded-xl border bg-card p-1 shadow-xl">
          {PROVIDERS.map((p) => {
            const selected = provider === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  onChange(p.value);
                  setOpen(false);
                }}
                className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-muted data-[selected=true]:bg-muted"
                data-selected={selected}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium ltr">{p.label}</span>
                  <span className="block text-xs text-muted-foreground">{p.hint}</span>
                </span>
                {selected ? <Check className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
              </button>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Engine accounts (label, on/off, key, limit) for the model menu. GET /api/providers probes every
// account, so it is read only when a menu opens, at most once a minute per page.
let accountsCache = { at: 0, promise: null };
function loadAccounts() {
  if (!accountsCache.promise || Date.now() - accountsCache.at > 60_000) {
    accountsCache = { at: Date.now(), promise: api("/api/providers").then((d) => d?.providers || []).catch(() => []) };
  }
  return accountsCache.promise;
}
const KIND_NAME = { cursor: "Cursor", claude: "Claude", openai: "OpenAI-compatible" };
const kindOfAccount = (id) => String(id || "").split("-")[0];
function accountName(id, accounts) {
  const account = accounts.find((a) => a.id === id);
  if (account?.label) return account.label;
  if (PROVIDER_META[id]) return PROVIDER_META[id].label;
  const kind = kindOfAccount(id);
  return `${KIND_NAME[kind] || kind} · ${String(id).slice(kind.length + 1)}`;
}
function accountTag(account) {
  if (!account) return null;
  if (!account.enabled) return t("خاموش");
  if (!account.hasKey) return t("بی‌کلید");
  if (account.limitedUntil) return t("سقف پر");
  return null;
}
const SHOWN_PER_ACCOUNT = 5;
// The engine an unpinned chat of this agent runs on: the server's route (the agent's own provider can
// be turned off and the run moves on), else the profile (an older server without `route`).
const runsOn = (profile) => (profile?.route?.provider ? profile.route : { provider: profile?.provider, model: profile?.model });

// The model menu: this account's models first — «خودکار» (the agent's priority list),
// the account's default tagged, keys 1–9 pick — and every other account behind «مدل‌های بیشتر».
// A pick is "<account>:<model>" and moves only this chat; "" = the agent's default.
// A menu's views slide sideways: forward (deeper) comes in from the reading end, back from the start.
const sideways = () => (typeof document !== "undefined" && document.documentElement.dir === "rtl" ? -1 : 1);
const SLIDE = {
  enter: (forward) => ({ opacity: 0, x: (forward ? 14 : -14) * sideways() }),
  center: { opacity: 1, x: 0 },
  exit: (forward) => ({ opacity: 0, x: (forward ? -14 : 14) * sideways() }),
};

// Model and effort menus share one width and frame, like Claude's.
export const MENU = "g-menu pop z-50 w-64 max-w-[calc(100vw-2rem)] rounded-xl border bg-card shadow-xl";

export function ModelPicker({ model, onChange, agent = "griffin", compact = false, icons = false, footer = null }) {
  const agentData = usePolling("/api/agents", 60_000);
  const profile = agentData?.agents?.find((a) => a.id === agent);
  const data = usePolling("/api/models?provider=all", 10 * 60_000);
  const models = (data?.models || []).filter((m) => m.id !== "default");
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ kind: "models", account: null });
  const [accounts, setAccounts] = useState([]);
  const [typed, setTyped] = useState("");
  const [filter, setFilter] = useState("");
  const karsara = useLook() === "karsara";
  const labels = useFlag("modelLabels"); // «نام نسخهٔ مدل‌ها» (ui-prefs.js)
  const bad = badKeys(useDoctor());

  const runs = runsOn(profile);
  const [pinnedAccount, pinnedId] = String(model || "").includes(":") ? model.split(/:(.*)/s) : [runs.provider || "cursor", model || ""];
  const current = pinnedAccount;
  const account = accounts.find((a) => a.id === current);
  // Karsara skin: «Opus 5.5», as Karsara's menu writes it (the server's version label).
  const nameOf = (accountId, id) => {
    const row = models.find((m) => m.provider === accountId && m.id === id);
    return (labels && row?.label) || row?.name || id;
  };
  // Karsara has no «خودکار» on the chip: it names the model that will run (the agent's own).
  const name = model ? nameOf(pinnedAccount, pinnedId) : labels && runs.model ? nameOf(runs.provider, runs.model) : t("خودکار");
  const browsing = view.account || current;
  const browsingInfo = accounts.find((a) => a.id === browsing);
  // The main view has this account's main and newest models; the older ones the engine marks `more`
  // (Claude Code's dated models) are behind «مدل‌های بیشتر», first there.
  const listed = models.filter((m) => m.provider === browsing && (view.account || !m.more));
  const needle = filter.trim().toLowerCase();
  const rows = needle ? listed.filter((m) => modelMatches(m, needle, labels)) : listed;
  const defaultId = browsingInfo?.defaultModel || (browsing === runs.provider ? runs.model : "") || "";
  const otherAccounts = [...new Set([...accounts.map((a) => a.id), ...models.map((m) => m.provider)])].filter((id) => id !== current);
  // «مدل‌های بیشتر»: the ready engines' models under a small heading each; the ones that are off or
  // have no key are one line pointing at Settings → engines.
  const ready = (id) => {
    const info = accounts.find((a) => a.id === id);
    return info ? Boolean(info.enabled && info.hasKey) : true;
  };
  const matches = (m) => modelMatches(m, needle, labels);
  const older = models.filter((m) => m.provider === current && m.more && matches(m));
  const groups = [
    ...(older.length ? [{ id: current, label: t("قدیمی‌تر"), own: older }] : []),
    ...otherAccounts
      .filter(ready)
      .map((id) => ({ id, label: accountTag(accounts.find((a) => a.id === id)), own: models.filter((m) => m.provider === id && matches(m)) }))
      .filter((g) => !needle || g.own.length),
  ];
  const readyCount = models.filter((m) => (m.provider !== current || m.more) && ready(m.provider)).length;
  const resting = otherAccounts.filter((id) => !ready(id));
  const openEngines = () => {
    try {
      localStorage.setItem("griffin.settings.section", "providers");
    } catch {
      // storage off: settings opens on its first section
    }
    setOpen(false);
    window.location.hash = "#/settings";
  };

  // Going into «مدل‌های بیشتر» or an account slides forward, coming back slides back.
  const depth = view.kind === "accounts" ? 1 : view.account ? 2 : 0;
  const lastDepth = useRef(depth);
  const forward = depth >= lastDepth.current;
  useEffect(() => {
    lastDepth.current = depth;
  }, [depth]);

  const onOpenChange = (next) => {
    setOpen(next);
    if (next) {
      setView({ kind: "models", account: null });
      setFilter("");
      setTyped("");
      loadAccounts().then(setAccounts);
    }
  };
  const pick = (id) => {
    onChange(id);
    setOpen(false);
  };
  const onKeyDown = (e) => {
    if (view.kind !== "models" || e.target.tagName === "INPUT") return;
    const n = Number(e.key);
    if (n >= 1 && n <= Math.min(9, rows.length)) {
      e.preventDefault();
      pick(`${browsing}:${rows[n - 1].id}`);
    }
  };

  const row = "g-menu-row flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none";
  const muted = "text-xs text-muted-foreground";
  const tag = "shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground";
  const divider = <div className="my-1 h-px bg-border" />;

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("مدل: {label}", { label: name })}
          title={`${name} · ${accountName(current, accounts)}${bad.has(current) ? ` — ${t("کلید این موتور رد شده است")}` : ""}`}
          className={karsara ? "g-pill press inline-flex min-w-0 shrink-0 items-center gap-1" : "g-text-btn press inline-flex min-w-0 shrink-0 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground data-[state=open]:text-foreground h-8 max-w-48 px-1.5 text-xs"}
        >
          {bad.has(current) ? <BadKeyDot /> : null}
          {/* Karsara's chip has no sliding text: a swap caught mid-way left both names drawn over each other. */}
          {karsara ? <span className="ltr min-w-0 truncate">{name}</span> : <SwapText text={name} className={model ? "ltr" : ""} />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" side="top" sideOffset={8} onKeyDown={onKeyDown} collisionPadding={16} className={`${MENU} max-h-[70vh] overflow-y-auto p-1`}>
          <AnimatePresence mode="wait" initial={false} custom={forward}>
          <motion.div key={`${view.kind}:${view.account || ""}`} custom={forward} variants={SLIDE} initial="enter" animate="center" exit="exit" transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}>
          {view.kind === "accounts" ? (
            <>
              <button type="button" className={`${row} font-medium`} onClick={() => setView({ kind: "models", account: null })}>
                <ChevronRight className="size-4 text-muted-foreground rtl:rotate-0 ltr:rotate-180" />
                <span className="flex-1">{t("مدل‌های بیشتر")}</span>
              </button>
              {readyCount > 10 ? (
                <input dir="ltr" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("جستجوی مدل…")} aria-label={t("جستجوی مدل")} className="g-input mx-1 my-1 w-[calc(100%-0.5rem)] rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none" />
              ) : null}
              {groups.map(({ id, label, own }) => (
                <div key={id} className="pt-1">
                  <p className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1 text-[11px] font-medium text-muted-foreground">
                    <span className="min-w-0 truncate">{accountName(id, accounts)}</span>
                    {bad.has(id) ? <BadKeyDot /> : null}
                    {label ? <span className={tag}>{label}</span> : null}
                  </p>
                  {(needle ? own : own.slice(0, SHOWN_PER_ACCOUNT)).map((m) => (
                    <button key={m.id} type="button" className={row} onClick={() => pick(`${id}:${m.id}`)}>
                      <span className="ltr min-w-0 flex-1 truncate text-start rtl:text-right">{modelName(m, labels)}</span>
                      {Boolean(model) && pinnedAccount === id && pinnedId === m.id ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                    </button>
                  ))}
                  {!own.length || (!needle && own.length > SHOWN_PER_ACCOUNT) ? (
                    <button type="button" className={`${row} ${muted}`} onClick={() => { setFilter(""); setView({ kind: "models", account: id }); }}>
                      <span className="flex-1">{own.length ? t("همهٔ {n} مدل", { n: num(own.length) }) : t("انتخاب مدل…")}</span>
                      <ChevronLeft className="size-3.5 rtl:rotate-0 ltr:rotate-180" />
                    </button>
                  ) : null}
                </div>
              ))}
              {needle && !groups.length ? <p className="px-2.5 py-2 text-xs text-muted-foreground">{t("مدلی با این نام نیست.")}</p> : null}
              {!needle && !groups.length && !resting.length ? <p className="px-2.5 py-2 text-xs text-muted-foreground">{t("موتور دیگری نیست؛ از تنظیمات ← موتورها اضافه کنید.")}</p> : null}
              {resting.length ? (
                <>
                  {divider}
                  <button type="button" className={`${row} ${muted}`} onClick={openEngines} title={t("تنظیمات ← موتورها")}>
                    <span className="min-w-0 flex-1 truncate">{t("{names} خاموش یا بی‌کلید", { names: resting.map((id) => accountName(id, accounts)).join(t("، ")) })}</span>
                    <span className="shrink-0 text-primary">{t("تنظیم")}</span>
                  </button>
                </>
              ) : null}
            </>
          ) : (
            <>
              {view.account ? (
                <>
                  <button type="button" className={`${row} ${muted}`} onClick={() => setView({ kind: "accounts", account: null })}>
                    <ChevronRight className="size-3.5 rtl:rotate-0 ltr:rotate-180" />
                    <span className="flex-1 truncate">{accountName(browsing, accounts)}</span>
                    {accountTag(browsingInfo) ? <span className={tag}>{accountTag(browsingInfo)}</span> : null}
                  </button>
                  {divider}
                </>
              ) : (
                <button type="button" className={row} onClick={() => pick("")} title={runs.provider ? t("به ترتیب اولویت ایجنت ({engine})", { engine: `${accountName(runs.provider, accounts)}${runs.model ? ` · ${runs.model}` : ""}` }) : t("به ترتیب اولویت ایجنت")}>
                  <span className="min-w-0 flex-1">{t("خودکار")}</span>
                  {!model ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                </button>
              )}
              {listed.length > 12 ? (
                <input dir="ltr" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("جستجوی مدل…")} aria-label={t("جستجوی مدل")} className="g-input mx-1 my-1 w-[calc(100%-0.5rem)] rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none" />
              ) : null}
              {rows.map((m, i) => {
                const selected = Boolean(model) && pinnedAccount === browsing && pinnedId === m.id;
                return (
                  <button key={m.id} type="button" className={row} onClick={() => pick(`${browsing}:${m.id}`)}>
                    <span className="ltr min-w-0 flex-1 truncate text-start rtl:text-right">{modelName(m, labels)}</span>
                    {m.id === defaultId ? <span className={tag}>{t("پیش‌فرض")}</span> : null}
                    {selected ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                    {i < 9 && !needle ? <kbd className="w-4 shrink-0 text-center font-sans text-[11px] text-muted-foreground">{num(i + 1)}</kbd> : null}
                  </button>
                );
              })}
              {listed.length && !rows.length ? <p className="px-2.5 py-2 text-xs text-muted-foreground">{t("مدلی با این نام نیست.")}</p> : null}
              {!listed.length ? <p className="px-2.5 py-2 text-xs text-muted-foreground">{accountTag(browsingInfo) ? t("این موتور {state} است.", { state: accountTag(browsingInfo) }) : t("فهرست مدل این موتور در دسترس نیست.")}</p> : null}
              {kindOfAccount(browsing) === "openai" ? (
                <form
                  className="px-1 py-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (typed.trim()) pick(`${browsing}:${typed.trim()}`);
                  }}
                >
                  <input dir="ltr" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t("شناسهٔ مدل، مثلاً {example}", { example: "z-ai/glm-4.6" })} aria-label={t("شناسهٔ مدل")} className="g-input w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none" />
                </form>
              ) : null}
              {divider}
              <button type="button" className={row} onClick={() => { setFilter(""); setView({ kind: "accounts", account: null }); }}>
                <span className="flex-1">{t("مدل‌های بیشتر")}</span>
                <ChevronLeft className="size-3.5 text-muted-foreground rtl:rotate-0 ltr:rotate-180" />
              </button>
              {footer}
            </>
          )}
          </motion.div>
          </AnimatePresence>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// How hard the model thinks, per chat: Claude's effort panel — «تلاش زیاد», then a slider from
// «سریع‌تر» to «باهوش‌تر». Only the word under the box is English, as Claude writes it.
// Claude takes all five levels; OpenAI-style endpoints (GLM) get low/medium/high; Cursor
// ignores it. The tick «پیشنهادی» is the model's default; picking what would run anyway stores no override.
const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const EFFORT_FA = { low: t("کم"), medium: t("متوسط"), high: t("زیاد"), xhigh: t("بسیار زیاد"), max: t("بیشینه") };
const SPRING = { type: "spring", stiffness: 520, damping: 40, mass: 0.9 };

// A label that slides to its new text (the choices under the box, the effort panel's title).
export function SwapText({ text, className = "" }) {
  const reduce = useReducedMotion();
  return (
    <span className={`relative inline-flex min-w-0 overflow-hidden ${className}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={text}
          className="block truncate"
          initial={reduce ? false : { y: "70%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { y: "-70%", opacity: 0 }}
          transition={SPRING}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** The engine account a chat runs on: its pinned «account:model», else the agent's route. */
export function useRunAccount(model = "", agent = "griffin") {
  const agentData = usePolling("/api/agents", 60_000);
  const profile = agentData?.agents?.find((a) => a.id === agent);
  return String(model || "").includes(":") ? model.split(":")[0] : runsOn(profile).provider;
}

export function EffortPicker({ effort = "", model = "", agent = "griffin", onChange }) {
  const agentData = usePolling("/api/agents", 60_000);
  const profile = agentData?.agents?.find((a) => a.id === agent);
  const runs = runsOn(profile);
  const account = String(model || "").includes(":") ? model.split(":")[0] : runs.provider;
  const kind = kindOfAccount(account);
  const karsara = useLook() === "karsara";
  const simple = useFlag("effortSimple"); // «تلاش: فهرست ساده، فقط برای Claude»
  // «پیشنهادی» is the model's own default (Claude Code's per-model catalog, via /api/models), not one
  // fixed level; with no pinned model, the one the agent or the engine would use.
  const models = usePolling("/api/models?provider=all", 10 * 60_000)?.models || [];
  const [accounts, setAccounts] = useState([]);
  useEffect(() => {
    loadAccounts().then(setAccounts);
  }, []);
  if (!account || kind === "cursor") return null;
  const levels = kind === "claude" ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"];
  const pinnedId = String(model || "").includes(":") ? model.split(/:(.*)/s)[1] : "";
  const modelId = pinnedId || (runs.provider === account ? runs.model : "") || accounts.find((a) => a.id === account)?.defaultModel || "";
  const modelDefault = models.find((m) => m.provider === account && m.id === modelId)?.defaultEffort;
  const recommended = levels.includes(modelDefault) ? modelDefault : kind === "claude" ? "high" : "medium";
  const applied = levels.includes(profile?.effort) ? profile.effort : recommended; // what runs with no choice here
  const current = levels.includes(effort) ? effort : applied;
  // Karsara offers effort only on its plain Claude login; a Claude-compatible endpoint (Z.ai, custom) has none.
  if (simple) return account === "claude" ? <KarsaraEffort levels={levels} effort={levels.includes(effort) ? effort : ""} onChange={onChange} /> : null;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("تلاش: {label}", { label: EFFORT_FA[current] })}
          title={t("میزان فکر کردن مدل")}
          className={`g-text-btn inline-flex shrink-0 items-center text-muted-foreground hover:text-foreground data-[state=open]:text-foreground ${karsara ? "px-1 text-[13px]" : "h-8 px-1.5 text-xs"}`}
        >
          <SwapText text={EFFORT_LABELS[current]} className="ltr" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" side="top" sideOffset={8} collisionPadding={16} className={`${MENU} p-1`}>
          <EffortPanel levels={levels} value={current} recommended={recommended} onPick={(level) => onChange(level === applied ? "" : level)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Karsara skin: the effort as a plain
// pill «تلاش پیش‌فرض ⇅» and a list — the default (no override stored), then each level.
function KarsaraEffort({ levels, effort, onChange }) {
  const [open, setOpen] = useState(false);
  const label = effort ? EFFORT_FA[effort] : t("تلاش پیش‌فرض");
  const pick = (value) => {
    onChange(value);
    setOpen(false);
  };
  const row = "g-menu-row flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-start text-[13px] hover:bg-muted";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={t("تلاش: {label}", { label })} title={label} className="g-text-btn inline-flex shrink-0 items-center gap-1 px-1 text-[13px] text-muted-foreground hover:text-foreground data-[state=open]:text-foreground">
          {label}
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" side="top" sideOffset={8} collisionPadding={16} className="g-menu pop z-50 w-56 rounded-xl border bg-card p-1 shadow-xl" dir={isRtl ? "rtl" : "ltr"}>
          <button type="button" onClick={() => pick("")} className={row}>
            {t("تلاش پیش‌فرض")}
            {!effort ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
          </button>
          {levels.map((level) => (
            <button key={level} type="button" onClick={() => pick(level)} className={row}>
              {EFFORT_FA[level]}
              {effort === level ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function EffortPanel({ levels, value, recommended, onPick }) {
  const last = levels.length - 1;
  const [picked, setPicked] = useState(null); // chosen, until the chat's new value comes back
  const [live, setLive] = useState(null); // the level under the finger while dragging
  const [help, setHelp] = useState(false);
  const shown = picked ?? Math.max(0, levels.indexOf(value));
  const title = EFFORT_FA[levels[live ?? shown]];
  const rail = useRef(null);
  const frac = useMotionValue(shown / last); // the thumb's place, 0–1, as --f for the CSS
  const reduce = useReducedMotion();
  const drag = useRef(false);

  useEffect(() => setPicked(null), [value]);
  useEffect(() => {
    if (drag.current) return;
    if (reduce) frac.jump(shown / last);
    else animate(frac, shown / last, SPRING);
  }, [shown, last, reduce, frac]);

  const fracAt = (clientX) => {
    const r = rail.current.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return getComputedStyle(rail.current).direction === "rtl" ? 1 - f : f;
  };
  const choose = (i) => {
    const next = Math.min(last, Math.max(0, i));
    setPicked(next);
    if (levels[next] !== value) onPick(levels[next]);
  };
  const release = (clientX) => {
    if (!drag.current) return;
    drag.current = false;
    setLive(null);
    const i = Math.round(fracAt(clientX) * last);
    if (i === shown) animate(frac, shown / last, SPRING);
    choose(i);
  };
  const onKeyDown = (e) => {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const step = { ArrowUp: 1, ArrowDown: -1, ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
    if (step) choose(shown + step);
    else if (e.key === "Home") choose(0);
    else if (e.key === "End") choose(last);
    else return;
    e.preventDefault();
  };

  return (
    <div className="effort-panel p-2.5">
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-muted-foreground">{t("تلاش")}</span>
        <SwapText text={title} className="font-medium" />
        <span className="flex-1" />
        <button
          type="button"
          aria-label={t("راهنمای تلاش")}
          aria-expanded={help}
          onClick={() => setHelp((v) => !v)}
          className={`-m-1 rounded-full p-1 transition-colors hover:text-foreground ${help ? "text-foreground" : "text-muted-foreground"}`}
        >
          <CircleHelp className="size-4" />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {help ? (
          <motion.p
            key="help"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden text-xs leading-5 text-muted-foreground"
          >
            <span className="block pt-1.5">{t("هرچه بیشتر، مدل عمیق‌تر فکر می‌کند ولی کندتر و پرمصرف‌تر است. فقط برای همین گفتگو؛ «پیشنهادی» پیش‌فرض ایجنت است.")}</span>
          </motion.p>
        ) : null}
      </AnimatePresence>
      <div className="mt-3 flex justify-between text-[13px] text-muted-foreground">
        <span>{t("سریع‌تر")}</span>
        <span>{t("باهوش‌تر")}</span>
      </div>
      <motion.div
        role="slider"
        tabIndex={0}
        aria-label={t("میزان تلاش")}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={shown}
        aria-valuetext={EFFORT_FA[levels[shown]]}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = true;
          const f = fracAt(e.clientX);
          setLive(Math.round(f * last));
          if (reduce) frac.jump(f);
          else animate(frac, f, { type: "spring", stiffness: 700, damping: 45 });
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const f = fracAt(e.clientX);
          frac.jump(f);
          setLive(Math.round(f * last));
        }}
        onPointerUp={(e) => release(e.clientX)}
        onPointerCancel={() => {
          drag.current = false;
          setLive(null);
          animate(frac, shown / last, SPRING);
        }}
        data-dragging={live != null ? "" : undefined}
        style={{ "--f": frac }}
        className="effort-track mt-1.5"
      >
        <span className="effort-fill" />
        <span ref={rail} className="effort-rail">
          {levels.map((level, i) => (
            <span key={level} className={level === recommended ? "effort-tick" : "effort-dot"} style={{ "--at": i / last }} />
          ))}
          <span className="effort-thumb" />
        </span>
      </motion.div>
      <div className="relative mt-1.5 h-4">
        <span className="effort-rail">
          <span className="effort-under" style={{ "--at": levels.indexOf(recommended) / last }}>
            <span>{t("پیشنهادی")}</span>
          </span>
        </span>
      </div>
    </div>
  );
}

// Light/dark switch: the new theme spreads as a circle from the button (View Transitions API),
// with a plain cross-fade where that API is missing or the owner prefers reduced motion.
export function ThemeToggle({ theme, onChange }) {
  const next = theme === "dark" ? "light" : "dark";
  const toggle = (event) => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!document.startViewTransition || reduce) {
      onChange(next);
      return;
    }
    const x = event.clientX || window.innerWidth / 2;
    const y = event.clientY || 0;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = document.startViewTransition(() => flushSync(() => onChange(next)));
    transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 520, easing: "cubic-bezier(0.2, 0, 0, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    });
  };
  return (
    <button type="button" onClick={toggle} className="press relative flex size-8 items-center justify-center overflow-hidden rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label={next === "dark" ? t("تم تیره") : t("تم روشن")}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={theme}
          initial={{ rotate: -90, scale: 0.4, opacity: 0 }}
          animate={{ rotate: 0, scale: 1, opacity: 1 }}
          exit={{ rotate: 90, scale: 0.4, opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="flex"
        >
          {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
