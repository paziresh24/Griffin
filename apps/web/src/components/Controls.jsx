import { useState } from "react";
import { flushSync } from "react-dom";
import { Popover, Tooltip } from "radix-ui";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "motion/react";
import { Brain, Check, ChevronsUpDown, Infinity as InfinityIcon, ListTree, Moon, Sparkles, Sun, Bot } from "lucide-react";
import { usePolling } from "../api.js";
import { agentMeta, PROVIDER_META } from "../brand.js";
import { t } from "../i18n.js";

const MODES = [
  { value: "agent", label: t("ایجنت"), icon: InfinityIcon, hint: t("خودش کار را انجام می‌دهد: ابزارها را صدا می‌زند و نتیجه می‌آورد") },
  { value: "plan", label: t("برنامه‌ریزی"), icon: ListTree, hint: t("اول نقشهٔ کار را می‌نویسد و بدون اجرای تغییر منتظر تأیید می‌ماند") },
];

const PROVIDERS = [
  { value: "cursor", label: "Cursor", hint: t("ایجنت Cursor (مدل‌های حساب Cursor)") },
  { value: "claude", label: "Claude", hint: t("Claude Agent SDK مستقیم از Anthropic") },
];

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
          className={`press flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl border bg-background px-3 text-start transition-colors hover:border-primary/50 data-[state=open]:border-primary/60 data-[state=open]:bg-accent/40 disabled:cursor-default disabled:opacity-80 ${className}`}
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

// One picker for every provider (2026-10-08): a pick is "<provider>:<model>" and moves only this
// chat; "auto" = the agent's default from the agents page.
export function ModelPicker({ model, onChange, agent = "griffin", compact = false, icons = false }) {
  const agentData = usePolling("/api/agents", 60_000);
  const profile = agentData?.agents?.find((a) => a.id === agent);
  const data = usePolling("/api/models?provider=all", 10 * 60_000);
  const models = (data?.models || []).filter((m) => m.id !== "default");
  const [open, setOpen] = useState(false);
  const [pinnedProvider, pinnedId] = String(model || "").includes(":") ? model.split(/:(.*)/s) : [profile?.provider || "cursor", model];
  const current = models.find((m) => m.provider === pinnedProvider && m.id === pinnedId);
  const short = PROVIDER_META[pinnedProvider]?.short || pinnedProvider;
  const label = model ? `${current?.name || pinnedId} · ${short}` : t("خودکار");
  const showLabel = !icons || open;
  const groups = Object.keys(PROVIDER_META).map((p) => [p, models.filter((m) => m.provider === p)]).filter(([, list]) => list.length);

  const pick = (id) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("مدل: {label}", { label })}
          title={label}
          className={`press flex h-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground ${
            icons
              ? showLabel
                ? "max-w-44 gap-1 px-2.5 text-[11px]"
                : "w-8"
              : compact
                ? "h-auto max-w-44 gap-1.5 px-2.5 py-1 text-[11px]"
                : "h-auto max-w-48 gap-1.5 px-3 py-1.5 text-xs"
          }`}
        >
          <Sparkles className="size-3.5 shrink-0 text-primary" />
          {showLabel ? (
            <>
              <span className={`truncate ${model ? "ltr" : ""}`}>{label}</span>
              <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
            </>
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" side="top" sideOffset={8} className="pop z-50 w-80 overflow-hidden rounded-xl border bg-card shadow-xl">
          <Command loop className="flex flex-col">
            <Command.Input autoFocus placeholder={t("جستجوی مدل…")} className="border-b bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground" />
            <Command.List className="scrollbar-thin max-h-96 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">{t("مدلی پیدا نشد")}</Command.Empty>
              <ModelItem
                id=""
                name={t("خودکار")}
                note={`${t("پیش‌فرض ایجنت")}${profile ? ` (${PROVIDER_META[profile.provider]?.short || profile.provider}${profile.model ? ` · ${profile.model}` : ""})` : ""}`}
                selected={!model}
                onSelect={pick}
              />
              {groups.map(([provider, list]) => (
                <Command.Group
                  key={provider}
                  heading={PROVIDER_META[provider]?.label || provider}
                  className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {list.map((m) => (
                    <ModelItem
                      key={`${provider}:${m.id}`}
                      id={`${provider}:${m.id}`}
                      name={m.name}
                      selected={pinnedProvider === provider && pinnedId === m.id && Boolean(model)}
                      onSelect={pick}
                    />
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// How hard the model thinks, per chat. Claude takes all five levels; OpenAI-style endpoints (GLM)
// get low/medium/high (the server maps xhigh/max to high); Cursor ignores it.
const EFFORTS = [
  { id: "", name: t("خودکار"), note: t("پیش‌فرض ایجنت یا موتور") },
  { id: "low", name: t("کم"), note: t("سریع و ارزان") },
  { id: "medium", name: t("متوسط") },
  { id: "high", name: t("زیاد") },
  { id: "xhigh", name: t("خیلی زیاد"), note: t("فقط Claude") },
  { id: "max", name: t("حداکثر"), note: t("فقط Claude؛ پرمصرف") },
];

export function EffortPicker({ effort = "", model = "", agent = "griffin", onChange }) {
  const agentData = usePolling("/api/agents", 60_000);
  const profile = agentData?.agents?.find((a) => a.id === agent);
  const provider = String(model || "").includes(":") ? model.split(":")[0] : profile?.provider;
  const [open, setOpen] = useState(false);
  if (provider === "cursor") return null;
  const current = EFFORTS.find((e) => e.id === (effort || "")) || EFFORTS[0];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("میزان فکر: {name}", { name: current.name })}
          title={t("میزان فکر: {name}", { name: current.name })}
          className="press flex h-8 shrink-0 items-center gap-1 rounded-full bg-muted px-2.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <Brain className="size-3.5 shrink-0 text-primary" />
          {effort ? <span>{current.name}</span> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" side="top" sideOffset={8} className="pop z-50 w-56 overflow-hidden rounded-xl border bg-card p-1 shadow-xl">
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] text-muted-foreground">{t("میزان فکر کردن مدل")}</p>
          {EFFORTS.filter((e) => provider === "claude" || !["xhigh", "max"].includes(e.id)).map((e) => (
            <button
              key={e.id || "auto"}
              type="button"
              onClick={() => {
                onChange(e.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-muted"
            >
              <span className="min-w-0 flex-1">
                <span className="block">{e.name}</span>
                {e.note ? <span className="block text-xs text-muted-foreground">{e.note}</span> : null}
              </span>
              {(effort || "") === e.id ? <Check className="size-4 shrink-0 text-primary" /> : null}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ModelItem({ id, name, note, selected, onSelect }) {
  return (
    <Command.Item
      value={`${name} ${id}`}
      onSelect={() => onSelect(id)}
      className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm data-[selected=true]:bg-muted"
    >
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-start ${id ? "ltr" : ""}`}>{name}</span>
        {note ? <span className="block truncate text-xs text-muted-foreground">{note}</span> : null}
      </span>
      {selected ? <Check className="size-4 shrink-0 text-primary" /> : null}
    </Command.Item>
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
