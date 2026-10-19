// Settings building blocks: a titled group of rows in one card, and one row.

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
