// Settings building blocks: a titled group of rows in one card, one row, and what every page shares —
// the switch, the «؟» that explains a setting where it stands, and the tabs of a page.
import { Popover, Switch } from "radix-ui";
import { motion } from "motion/react";
import { CircleHelp, Loader2 } from "lucide-react";
import { isRtl, t } from "../i18n.js";

// `joined`: the Karsara skin draws this group as one divided card (its status and live-check lists)
// instead of a card per row; the Griffin skin always draws one card.
export function Group({ title, action, children, joined = false }) {
  return (
    <section>
      {title || action ? (
        <div className="mb-2 flex min-h-7 items-center gap-2 px-1">
          {title ? <h3 className="text-xs font-medium text-muted-foreground">{title}</h3> : null}
          {action ? <div className="ms-auto">{action}</div> : null}
        </div>
      ) : null}
      <div className="g-group divide-y overflow-hidden rounded-2xl border bg-card" data-joined={joined || undefined}>{children}</div>
    </section>
  );
}

export function Item({ icon: Icon, tint = "bg-muted text-muted-foreground", title, subtitle, trailing, onClick, children }) {
  const Row = onClick ? "button" : "div";
  return (
    <div className="g-item">
      <Row
        {...(onClick ? { type: "button", onClick } : {})}
        className={`g-item-row flex w-full items-center gap-3 px-4 py-3 text-start ${onClick ? "hover:bg-muted/50" : ""}`}
      >
        {Icon ? (
          <span className={`g-item-icon flex size-8 shrink-0 items-center justify-center rounded-lg ${tint}`}>
            <Icon className="size-4" />
          </span>
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" dir="auto">{title}</span>
          {subtitle ? <span className="block truncate text-xs text-muted-foreground" dir="auto">{subtitle}</span> : null}
        </span>
        {trailing ? <span className="flex shrink-0 items-center gap-2">{trailing}</span> : null}
      </Row>
      {children}
    </div>
  );
}

export function SectionHeader({ title, description, action }) {
  return (
    <div className="g-section-head mb-6 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold">{title}</h2>
        {description ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Toggle({ on, label, disabled = false, busy = false, onChange }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      {busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
      <Switch.Root
        checked={on}
        disabled={disabled || busy}
        onCheckedChange={onChange}
        dir="ltr"
        className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors data-[state=checked]:bg-primary disabled:opacity-50"
        aria-label={label}
      >
        <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.375rem]" />
      </Switch.Root>
    </span>
  );
}

/** «؟»: what a setting does, opened with a tap (a phone has no hover). `children` may hold a picture. */
export function Help({ title, children }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="press inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-primary" aria-label={t("راهنمای {title}", { title })}>
          <CircleHelp className="size-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="center" sideOffset={6} collisionPadding={12} dir={isRtl ? "rtl" : "ltr"} className="pop z-50 w-[min(23rem,calc(100vw-1.5rem))] space-y-2 rounded-xl border bg-card p-3 text-xs leading-6 shadow-xl">
          <p className="text-sm font-medium">{title}</p>
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const BADGE = {
  fresh: "bg-primary/12 text-primary",
  warn: "bg-warn/12 text-warn",
  muted: "bg-muted text-muted-foreground",
};
export function Badge({ tone = "muted", children }) {
  return <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium leading-4 ${BADGE[tone]}`}>{children}</span>;
}

/**
 * One setting: its title, a «؟» beside it, and its control. `id` lets the search find it; `under` is a
 * full-width choice below; `depth` hangs it under the setting it depends on; `dim` greys what cannot act yet.
 */
export function SettingRow({ id, icon: Icon, title, badges, help, note, control, under, depth = 0, dim = false }) {
  return (
    <div id={id ? `set-${id}` : undefined} className="g-set-row" data-dim={dim || undefined} style={depth ? { "--depth": depth } : undefined}>
      <div className="flex min-h-13 items-center gap-2.5 px-4 py-2.5">
        {Icon ? <span className="g-item-icon flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary"><Icon className="size-4" /></span> : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
            <span className="text-sm font-medium" dir="auto">{title}</span>
            {help}
            {badges}
          </div>
          {note ? <p className="text-xs leading-5 text-muted-foreground" dir="auto">{note}</p> : null}
        </div>
        {control}
      </div>
      {under ? <div className="px-4 pb-3">{under}</div> : null}
    </div>
  );
}

/** A choice of a few words, as chips. */
export function Choice({ label, value, options, onChange, disabled = false }) {
  return (
    <span role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} disabled={disabled} onClick={() => value !== o.id && onChange(o.id)} className={`press rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-50 ${value === o.id ? "border-primary/40 bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** A page's tabs. They wrap instead of scrolling sideways: nothing is hidden past the edge of a phone. */
export function Tabs({ label, tabs, value, onChange }) {
  return (
    <div role="tablist" aria-label={label} className="g-settings-strip mb-6 flex flex-wrap gap-1.5">
      {tabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" aria-selected={value === tab.id} aria-current={value === tab.id ? "page" : undefined} onClick={() => onChange(tab.id)} className={`press relative rounded-full px-3.5 py-1.5 text-sm transition-colors ${value === tab.id ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          {value === tab.id ? <motion.span layoutId="settings-tab" className="g-nav-bar absolute inset-0 rounded-full bg-muted" transition={{ type: "spring", stiffness: 500, damping: 38 }} /> : null}
          <span className="relative">{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
