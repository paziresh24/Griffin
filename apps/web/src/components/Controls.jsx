import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Popover, Tooltip } from "radix-ui";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, Infinity as InfinityIcon, ListTree, Moon, Sparkles, Sun, Bot } from "lucide-react";
import { api, usePolling } from "../api.js";
import { useSkin } from "../skin.js";
import { agentMeta, PROVIDER_META } from "../brand.js";
import { isRtl, num, t } from "../i18n.js";

const MODES = [
  { value: "agent", label: t("ایجنت"), icon: InfinityIcon, hint: t("خودش کار را انجام می‌دهد: ابزارها را صدا می‌زند و نتیجه می‌آورد") },
  { value: "plan", label: t("برنامه‌ریزی"), icon: ListTree, hint: t("اول نقشهٔ کار را می‌نویسد و بدون اجرای تغییر منتظر تأیید می‌ماند") },
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
  if (meta.icon) {
    return <img src={meta.icon} alt="" className={`shrink-0 rounded-[22%] ${className}`} />;
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

export function ModeToggle({ mode, onChange, compact = false, icons = false }) {
  const [expanded, setExpanded] = useState(false);
  const karsara = useSkin() === "karsara";
  if (karsara) return <ModeMenu mode={mode} onChange={onChange} />;
  const visible = icons && !expanded ? MODES.filter((m) => m.value === mode) : MODES;

  return (
    <Tooltip.Provider delayDuration={400}>
      <div
        role="radiogroup"
        aria-label={t("حالت")}
        className={`relative flex shrink-0 rounded-full bg-muted p-0.5 ${compact || icons ? "text-[11px]" : "text-xs"}`}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setExpanded(false);
        }}
      >
        {visible.map(({ value, label, icon: Icon, hint }) => {
          const active = mode === value;
          const plan = value === "plan";
          const showLabel = !icons || expanded;
          return (
            <Tooltip.Root key={value}>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={label}
                  title={label}
                  onClick={() => {
                    if (icons && !expanded) {
                      setExpanded(true);
                      return;
                    }
                    onChange(value);
                    if (icons) setExpanded(false);
                  }}
                  className={`press relative z-10 flex h-8 items-center justify-center rounded-full transition-colors ${
                    icons
                      ? showLabel
                        ? "gap-1 px-2.5"
                        : "w-8"
                      : compact
                        ? "h-auto gap-1.5 px-2.5 py-1"
                        : "h-auto gap-1.5 px-3 py-1.5"
                  } ${
                    active
                      ? plan
                        ? "text-amber-700 dark:text-amber-300"
                        : "text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {active ? (
                    <motion.span
                      layoutId="mode-pill"
                      className={`absolute inset-0 -z-10 rounded-full shadow-sm ring-1 ${
                        plan
                          ? "bg-amber-500/15 ring-amber-500/35"
                          : "bg-primary/15 ring-primary/35"
                      }`}
                      transition={{ type: "spring", stiffness: 500, damping: 38 }}
                    />
                  ) : null}
                  <Icon className={`size-3.5 shrink-0 ${active ? (plan ? "text-amber-600 dark:text-amber-400" : "text-primary") : ""}`} />
                  {showLabel ? <span className={icons ? "" : compact ? "" : "hidden sm:inline"}>{label}</span> : null}
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content side="top" sideOffset={6} className="pop z-50 max-w-60 rounded-lg bg-foreground px-2.5 py-1.5 text-xs leading-5 text-background shadow-lg">
                  <b>{label}</b> — {hint}
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          );
        })}
      </div>
    </Tooltip.Provider>
  );
}

// Karsara skin: the mode as a text menu «ایجنت ▾», each option with its description.
function ModeMenu({ mode, onChange }) {
  const [open, setOpen] = useState(false);
  const current = MODES.find((m) => m.value === mode) || MODES[0];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="g-text-btn inline-flex shrink-0 items-center gap-1 px-1 text-[13px] text-muted-foreground hover:text-foreground" aria-label={t("حالت: {label}", { label: current.label })} title={t("حالت اجرا — از منو انتخاب کنید")}>
          {current.label}
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" side="top" sideOffset={8} collisionPadding={16} className="g-menu pop z-50 w-64 rounded-xl border bg-card p-1 shadow-xl" dir={isRtl ? "rtl" : "ltr"}>
          {MODES.map((m) => (
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
const SHOWN_PER_ACCOUNT = 8;

// The model menu: this account's models first — «خودکار» (the agent's priority list),
// the account's default tagged, keys 1–9 pick — and every other account behind «مدل‌های بیشتر».
// A pick is "<account>:<model>" and moves only this chat; "" = the agent's default.
export function ModelPicker({ model, onChange, agent = "griffin", compact = false, icons = false }) {
  const agentData = usePolling("/api/agents", 60_000);
  const profile = agentData?.agents?.find((a) => a.id === agent);
  const data = usePolling("/api/models?provider=all", 10 * 60_000);
  const models = (data?.models || []).filter((m) => m.id !== "default");
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ kind: "models", account: null });
  const [accounts, setAccounts] = useState([]);
  const [typed, setTyped] = useState("");
  const [filter, setFilter] = useState("");
  const karsara = useSkin() === "karsara";
  const bad = badKeys(useDoctor());

  const [pinnedAccount, pinnedId] = String(model || "").includes(":") ? model.split(/:(.*)/s) : [profile?.provider || "cursor", model || ""];
  const current = pinnedAccount;
  const account = accounts.find((a) => a.id === current);
  const nameOf = (accountId, id) => models.find((m) => m.provider === accountId && m.id === id)?.name || id;
  const name = model ? nameOf(pinnedAccount, pinnedId) : t("خودکار");
  const browsing = view.account || current;
  const browsingInfo = accounts.find((a) => a.id === browsing);
  const listed = models.filter((m) => m.provider === browsing);
  const needle = filter.trim().toLowerCase();
  const rows = needle ? listed.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(needle)) : listed;
  const defaultId = browsingInfo?.defaultModel || (browsing === profile?.provider ? profile?.model : "") || "";
  const otherAccounts = [...new Set([...accounts.map((a) => a.id), ...models.map((m) => m.provider)])].filter((id) => id !== current);

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
          className={`g-pill press flex shrink-0 items-center justify-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground data-[state=open]:text-foreground ${
            karsara ? "" : `rounded-full bg-muted data-[state=open]:bg-accent ${icons ? "h-8 max-w-40 px-2.5 text-[11px]" : compact ? "max-w-44 px-2.5 py-1 text-[11px]" : "max-w-48 px-3 py-1.5 text-xs"}`
          }`}
        >
          {bad.has(current) ? <BadKeyDot /> : null}
          {karsara ? null : <Sparkles className="size-3.5 shrink-0 text-primary" />}
          <span className={`truncate ${model ? "ltr" : ""}`}>{name}</span>
          {karsara ? null : <ChevronsUpDown className="size-3 shrink-0 opacity-60" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" side="top" sideOffset={8} onKeyDown={onKeyDown} className="g-menu pop z-50 max-h-[70vh] w-72 overflow-y-auto rounded-xl border bg-card p-1 shadow-xl">
          {view.kind === "accounts" ? (
            <>
              <button type="button" className={`${row} ${muted}`} onClick={() => setView({ kind: "models", account: null })}>
                <ChevronRight className="size-3.5 rtl:rotate-0 ltr:rotate-180" />
                <span className="flex-1">{t("مدل‌های {name}", { name: accountName(current, accounts) })}</span>
              </button>
              {divider}
              {otherAccounts.map((id) => {
                const info = accounts.find((a) => a.id === id);
                const own = models.filter((m) => m.provider === id);
                const label = accountTag(info);
                return (
                  <div key={id}>
                    <button type="button" className={`${row} ${muted}`} onClick={() => { setFilter(""); setView({ kind: "models", account: id }); }} title={label ? `${accountName(id, accounts)} — ${label}` : accountName(id, accounts)}>
                      <span className="min-w-0 flex-1 truncate">{accountName(id, accounts)}</span>
                      {bad.has(id) ? <BadKeyDot /> : null}
                      {label ? <span className={tag}>{label}</span> : null}
                      <ChevronLeft className="size-3.5 rtl:rotate-0 ltr:rotate-180" />
                    </button>
                    {own.slice(0, SHOWN_PER_ACCOUNT).map((m) => (
                      <button key={m.id} type="button" className={row} onClick={() => pick(`${id}:${m.id}`)}>
                        <span className="ltr min-w-0 flex-1 truncate text-start">{m.name}</span>
                      </button>
                    ))}
                    {own.length > SHOWN_PER_ACCOUNT ? (
                      <button type="button" className={`${row} ${muted}`} onClick={() => { setFilter(""); setView({ kind: "models", account: id }); }}>
                        <span className="flex-1">{t("همه ({n})", { n: num(own.length) })}</span>
                        <ChevronLeft className="size-3.5 rtl:rotate-0 ltr:rotate-180" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
              {otherAccounts.length ? null : <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">{t("موتور دیگری نیست؛ از تنظیمات ← موتورها اضافه کن.")}</p>}
            </>
          ) : (
            <>
              {browsing !== current ? (
                <>
                  <button type="button" className={`${row} ${muted}`} onClick={() => setView({ kind: "accounts", account: null })}>
                    <ChevronRight className="size-3.5 rtl:rotate-0 ltr:rotate-180" />
                    <span className="flex-1 truncate">{accountName(browsing, accounts)}</span>
                    {accountTag(browsingInfo) ? <span className={tag}>{accountTag(browsingInfo)}</span> : null}
                  </button>
                  {divider}
                </>
              ) : (
                <button type="button" className={row} onClick={() => pick("")}>
                  <span className="min-w-0 flex-1">
                    <span className="block">{t("خودکار")}</span>
                    <span className={`block truncate ${muted}`}>{profile ? t("به ترتیب اولویت ایجنت ({engine})", { engine: `${accountName(profile.provider, accounts)}${profile.model ? ` · ${profile.model}` : ""}` }) : t("به ترتیب اولویت ایجنت")}</span>
                  </span>
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
                    <span className="ltr min-w-0 flex-1 truncate text-start">{m.name}</span>
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
              <button type="button" className={row} onClick={() => setView({ kind: "accounts", account: null })}>
                <span className="flex-1">{t("مدل‌های بیشتر")}</span>
                <ChevronLeft className="size-3.5 text-muted-foreground rtl:rotate-0 ltr:rotate-180" />
              </button>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// How hard the model thinks, per chat (a text button and a plain list). Claude takes
// all five levels; OpenAI-style endpoints (GLM) get low/medium/high; Cursor ignores it.
const EFFORT_LABELS = { low: t("کم"), medium: t("متوسط"), high: t("زیاد"), xhigh: t("بسیار زیاد"), max: t("بیشینه") };

export function EffortPicker({ effort = "", model = "", agent = "griffin", onChange }) {
  const agentData = usePolling("/api/agents", 60_000);
  const profile = agentData?.agents?.find((a) => a.id === agent);
  const account = String(model || "").includes(":") ? model.split(":")[0] : profile?.provider;
  const kind = kindOfAccount(account);
  const [open, setOpen] = useState(false);
  const karsara = useSkin() === "karsara";
  if (!account || kind === "cursor") return null;
  const levels = kind === "claude" ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"];
  const label = effort ? EFFORT_LABELS[effort] || effort : t("تلاش پیش‌فرض");
  const pick = (value) => {
    onChange(value);
    setOpen(false);
  };
  const row = "g-menu-row flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-muted";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("تلاش: {label}", { label })}
          title={t("میزان فکر کردن مدل")}
          className={`g-text-btn inline-flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground data-[state=open]:text-foreground ${karsara ? "px-1 text-[13px]" : "h-8 rounded-full bg-muted px-2.5 text-[11px] data-[state=open]:bg-accent"}`}
        >
          {label}
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" side="top" sideOffset={8} className="g-menu pop z-50 w-56 overflow-hidden rounded-xl border bg-card p-1 shadow-xl">
          <button type="button" onClick={() => pick("")} className={row}>
            {t("تلاش پیش‌فرض")}
            {!effort ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
          </button>
          {levels.map((level) => (
            <button key={level} type="button" onClick={() => pick(level)} className={row}>
              {EFFORT_LABELS[level]}
              {effort === level ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
