import { useEffect, useRef, useState } from "react";
import { ListChecks, Minus, X } from "lucide-react";
import { t } from "../i18n.js";

// The chat's work in progress — its running plan, the engine's steps, its sub-agents — floats in the
// empty margin at the end side of the thread (owner 2026-11-07: «در حین اجرا رو ببر گوشه. دقیقا تو جای
// خالی ای که الان وجود داره نه اینکه خود این فلوته باعث بشه چت جاش عوض بشه»); what waits for him stays
// above the chat box. Open only where the margin holds it and the pane is closed (styles.css
// .g-work-host); otherwise, or minimized, a pill that opens it over the chat.
export function WorkFloat({ compact, pill, short, onMinimize, onRestore, children }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (!box.current?.contains(event.target) && !event.target.closest?.("[data-radix-popper-content-wrapper]")) setOpen(false); };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  // The header copy of the pill (WorkPill) opens the same card.
  useEffect(() => {
    const onOpen = () => { onRestore(); setOpen(true); };
    window.addEventListener("griffin:work-open", onOpen);
    return () => window.removeEventListener("griffin:work-open", onOpen);
  }, [onRestore]);
  return (
    <div ref={box} className={`g-work-float ${compact ? "is-compact" : ""} ${open ? "is-open" : ""}`}>
      <button type="button" className="g-work-pill press items-center gap-1.5 rounded-full border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-muted" onClick={() => { onRestore(); setOpen(true); }} aria-expanded={open} title={pill} aria-label={pill}>
        <ListChecks className="size-3.5 shrink-0 text-primary" />
        {/* Small enough for the margin beside the messages; the whole line is its title. */}
        <bdi className="ltr tabular-nums">{short}</bdi>
      </button>
      <section className="g-work-card" aria-label={t("کار این گفتگو")}>
        <div className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
          <span className="flex-1">{t("کار این گفتگو")}</span>
          {open && compact ? (
            <button type="button" className="g-icon-btn rounded-md p-1 hover:bg-muted hover:text-foreground" onClick={() => setOpen(false)} title={t("بستن")} aria-label={t("بستن")}><X className="size-3.5" /></button>
          ) : (
            <button type="button" className="g-icon-btn rounded-md p-1 hover:bg-muted hover:text-foreground" onClick={() => { setOpen(false); onMinimize(); }} title={t("کوچک کردن")} aria-label={t("کوچک کردن")}><Minus className="size-3.5" /></button>
          )}
        </div>
        {children}
      </section>
    </div>
  );
}

/** The pill in the chat header, for a chat with no margin beside its messages (styles.css). */
export function WorkPill({ pill, short }) {
  return (
    <button type="button" className="g-work-pill-head press shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium hover:bg-muted" onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new Event("griffin:work-open")); }} title={pill} aria-label={pill}>
      <ListChecks className="size-3.5 shrink-0 text-primary" />
      <bdi className="ltr tabular-nums">{short}</bdi>
    </button>
  );
}
