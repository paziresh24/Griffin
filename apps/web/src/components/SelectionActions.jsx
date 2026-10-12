import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquarePlus, PanelRight } from "lucide-react";
import { SELECTION_QUOTE_MAX, quoteForChat } from "../side.js";
import { quoteStore } from "../quotes.js";
import { useRuntimeChat } from "../runtime.jsx";
import { textDir } from "../dir.js";
import { useTouchPrimary } from "../touch.js";
import { isRtl, t } from "../i18n.js";

// Reply to part of an answer: select text in an answer and a small toolbar offers
// «به گفتگو» — a popup shows the selection, the owner writes what they think of it, and it waits
// folded above the composer until the message is sent — and «به چت کناری», which starts a side chat
// with the quote. Only selections inside an answer (.sd-block) count, never tool cards or the box.

// The main thread and the side chat each mount this; a selection belongs to the one it is in.
const inSide = (el) => Boolean(el?.closest?.(".side-panel"));

function selectionTarget(anchor) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = String(sel).trim();
  if (!text) return null;
  const node = sel.anchorNode;
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  if (!el?.closest?.(".sd-block") || inSide(el) !== inSide(anchor)) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;
  return { text, rect };
}

export function SelectionActions() {
  const { boxId } = useRuntimeChat();
  const [target, setTarget] = useState(null); // { text, rect } while a quotable selection is open
  const [quoting, setQuoting] = useState(null); // { text, x, y } while the note popup is open
  const anchor = useRef(null);
  const sync = useCallback(() => setTarget(selectionTarget(anchor.current)), []);

  useEffect(() => {
    document.addEventListener("selectionchange", sync);
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      document.removeEventListener("selectionchange", sync);
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
    };
  }, [sync]);

  const drop = () => {
    setTarget(null);
    window.getSelection()?.removeAllRanges();
  };

  const addToChat = () => {
    if (!target) return;
    const text = target.text.length > SELECTION_QUOTE_MAX ? `${target.text.slice(0, SELECTION_QUOTE_MAX).trimEnd()}…` : target.text;
    const width = Math.min(384, window.innerWidth - 24);
    const x = Math.max(12, Math.min(window.innerWidth - width - 12, target.rect.left + target.rect.width / 2 - width / 2));
    const y = Math.max(12, Math.min(window.innerHeight - 260, target.rect.bottom + 8));
    setQuoting({ text, x, y, width });
    drop();
  };

  const submitQuote = (note) => {
    quoteStore.add(boxId, { text: quoting.text, note });
    setQuoting(null);
    const side = inSide(anchor.current);
    [...document.querySelectorAll(".composer-box textarea")].find((box) => inSide(box) === side)?.focus();
  };

  const addToSide = () => {
    if (!target) return;
    window.dispatchEvent(new CustomEvent("griffin:side-insert", { detail: { text: `${quoteForChat(target.text)}\n\n` } }));
    drop();
  };

  if (quoting) {
    return (
      <>
        <span ref={anchor} hidden />
        <QuotePopup quote={quoting} onSubmit={submitQuote} onCancel={() => setQuoting(null)} />
      </>
    );
  }
  if (!target) return <span ref={anchor} hidden />;
  // Above the selection; flips below near the viewport top, clamped to both edges.
  const x = Math.max(12, Math.min(window.innerWidth - 12, target.rect.left + target.rect.width / 2));
  const below = target.rect.top < 52;
  const y = below ? target.rect.bottom + 8 : target.rect.top - 44;
  const button = "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 hover:bg-muted";
  return (
    <>
      <span ref={anchor} hidden />
      <div
        className="fixed z-50 flex items-center rounded-lg border bg-card p-0.5 text-xs shadow-lg"
        style={{ left: x, top: y, transform: `translateX(-50%)${below ? " translateY(100%)" : ""}` }}
        dir={isRtl ? "rtl" : "ltr"}
        onMouseDown={(e) => e.preventDefault()}
      >
        <button type="button" className={button} onClick={addToChat} title={t("این بخش را نقل کن و نظرت را دربارهٔ آن بنویس")}>
          <MessageSquarePlus className="size-3.5" /> {t("به گفتگو")}
        </button>
        {inSide(anchor.current) ? null : (
          <>
            <span className="h-4 w-px bg-border" aria-hidden />
            <button type="button" className={button} onClick={addToSide} title={t("با این نقل، چت کناری را شروع کن")}>
              <PanelRight className="size-3.5" /> {t("به چت کناری")}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function QuotePopup({ quote, onSubmit, onCancel }) {
  const [note, setNote] = useState("");
  const box = useRef(null);
  const touch = useTouchPrimary(); // on a phone Enter is a new line, as in the composer
  // A click outside closes it without adding (the selection can be picked again).
  useEffect(() => {
    const onDown = (event) => {
      if (!box.current?.contains(event.target)) onCancel();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onCancel]);
  return (
    <div
      ref={box}
      className="fixed z-50 flex flex-col gap-2 rounded-xl border bg-card p-2.5 text-sm shadow-xl"
      style={{ left: quote.x, top: quote.y, width: quote.width }}
      dir={isRtl ? "rtl" : "ltr"}
      role="dialog"
      aria-label={t("نقل به گفتگو")}
    >
      <div className="scrollbar-thin max-h-28 overflow-y-auto border-s-2 ps-2 text-xs text-muted-foreground" dir={textDir(quote.text)}>
        {quote.text}
      </div>
      <textarea
        autoFocus
        rows={2}
        value={note}
        dir={note ? textDir(note) : "rtl"}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (!touch && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSubmit(note);
          }
        }}
        aria-label={t("نظر دربارهٔ این بخش")}
        placeholder={t("نظرت دربارهٔ این بخش (اختیاری)")}
        className="scrollbar-thin max-h-40 resize-none rounded-lg border bg-background px-2 py-1.5 outline-none focus:border-primary/60"
      />
      <div className="flex justify-end gap-2 text-xs">
        <button type="button" className="rounded-md px-2.5 py-1 hover:bg-muted" onClick={onCancel}>{t("انصراف")}</button>
        <button type="button" className="rounded-md bg-primary px-2.5 py-1 text-primary-foreground" onClick={() => onSubmit(note)} title={touch ? t("افزودن به پیام") : t("افزودن به پیام (Enter)")}>
          {t("افزودن")}
        </button>
      </div>
    </div>
  );
}
