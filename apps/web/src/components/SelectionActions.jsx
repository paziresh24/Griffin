import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquarePlus, PanelLeft, PanelRight, SquarePen } from "lucide-react";
import { SELECTION_QUOTE_MAX, quoteForChat } from "../side.js";
import { quoteStore } from "../quotes.js";
import { useRuntimeChat } from "../runtime.jsx";
import { textDir } from "../dir.js";
import { useTouchPrimary } from "../touch.js";
import { isRtl, t } from "../i18n.js";

// The side panel sits on the reading end's far side: left in RTL, right in LTR.
const SideIcon = isRtl ? PanelLeft : PanelRight;

// Reply to part of an answer: select text in an answer and a small toolbar offers
// «به گفتگو» — a popup shows the selection, the owner writes what they think of it, and it waits
// folded above the composer until the message is sent — and «به چت کناری», which starts a side chat
// with the quote — and «به چت جدید»: the same popup, but the note is a required request and the new
// chat starts with quote + request (App handles griffin:new-chat-insert). Only selections inside an
// answer (.sd-block) count, never tool cards or the box.

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
  const { boxId, chatId } = useRuntimeChat();
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

  // The popup under the selection: «به گفتگو» (kind "chat") or «به چت جدید» (kind "new").
  const openPopup = (kind) => {
    if (!target) return;
    const text = target.text.length > SELECTION_QUOTE_MAX ? `${target.text.slice(0, SELECTION_QUOTE_MAX).trimEnd()}…` : target.text;
    const width = Math.min(384, window.innerWidth - 24);
    const x = Math.max(12, Math.min(window.innerWidth - width - 12, target.rect.left + target.rect.width / 2 - width / 2));
    const y = Math.max(12, Math.min(window.innerHeight - 260, target.rect.bottom + 8));
    setQuoting({ text, x, y, width, kind });
    drop();
  };
  const addToChat = () => openPopup("chat");
  const addToNewChat = () => openPopup("new");

  const submitQuote = (note) => {
    if (quoting.kind === "new") {
      window.dispatchEvent(new CustomEvent("griffin:new-chat-insert", { detail: { text: quoting.text, chatId, request: note.trim() } }));
      setQuoting(null);
      return;
    }
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
        className="g-sel-actions fixed z-50 flex items-center rounded-lg border bg-card p-0.5 text-xs shadow-lg"
        style={{ left: x, top: y, transform: `translateX(-50%)${below ? " translateY(100%)" : ""}` }}
        dir={isRtl ? "rtl" : "ltr"}
        onMouseDown={(e) => e.preventDefault()}
      >
        <button type="button" className={button} onClick={addToChat} title={t("این بخش را نقل کن و نظرت را دربارهٔ آن بنویس")}>
          <MessageSquarePlus className="size-3.5" /> {t("به گفتگو")}
        </button>
        <span className="h-4 w-px bg-border" aria-hidden />
        <button type="button" className={button} onClick={addToNewChat} title={t("با این نقل و خواسته‌ات، گفتگوی تازه‌ای شروع کن")}>
          <SquarePen className="size-3.5" /> {t("به چت جدید")}
        </button>
        {inSide(anchor.current) ? null : (
          <>
            <span className="h-4 w-px bg-border" aria-hidden />
            <button type="button" className={button} onClick={addToSide} title={t("با این نقل، چت کناری را شروع کن")}>
              <SideIcon className="size-3.5" /> {t("به چت کناری")}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function QuotePopup({ quote, onSubmit, onCancel }) {
  const [note, setNote] = useState("");
  const fresh = quote.kind === "new"; // «به چت جدید»: the note is the request the new chat starts with
  const ready = !fresh || Boolean(note.trim()); // required there; optional for «به گفتگو»
  const box = useRef(null);
  const touch = useTouchPrimary(); // on a phone Enter is a new line, as in the composer
  // On touch the popup docks at the top, where the on-screen keyboard does not cover it.
  const place = touch
    ? { left: 12, top: "max(12px, env(safe-area-inset-top))", width: "calc(100vw - 24px)" }
    : { left: quote.x, top: quote.y, width: quote.width };
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
      className="g-quote-pop fixed z-50 flex flex-col gap-2 rounded-xl border bg-card p-2.5 text-sm shadow-xl"
      style={place}
      dir={isRtl ? "rtl" : "ltr"}
      role="dialog"
      aria-label={fresh ? t("شروع چت جدید با این نقل") : t("نقل به گفتگو")}
    >
      <div className="scrollbar-thin max-h-28 overflow-y-auto border-s-2 ps-2 text-xs text-muted-foreground" dir={textDir(quote.text)}>
        {quote.text}
      </div>
      <textarea
        autoFocus
        rows={2}
        value={note}
        dir={note ? textDir(note) : isRtl ? "rtl" : "ltr"}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (!touch && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (ready) onSubmit(note);
          }
        }}
        aria-label={fresh ? t("خواسته‌ات از چت جدید") : t("نظر دربارهٔ این بخش")}
        placeholder={fresh ? t("در چت جدید چه می‌خواهی؟") : t("نظرت دربارهٔ این بخش (اختیاری)")}
        className="scrollbar-thin max-h-40 resize-none rounded-lg border bg-background px-2 py-1.5 outline-none focus:border-primary/60"
      />
      <div className="flex justify-end gap-2 text-xs">
        <button type="button" className="rounded-md px-2.5 py-1 hover:bg-muted" onClick={onCancel}>{t("انصراف")}</button>
        <button type="button" className="g-btn-primary rounded-md bg-primary px-2.5 py-1 text-primary-foreground disabled:opacity-50" disabled={!ready} onClick={() => onSubmit(note)} title={fresh ? (touch ? t("شروع چت جدید") : t("شروع چت جدید (Enter)")) : touch ? t("افزودن به پیام") : t("افزودن به پیام (Enter)")}>
          {fresh ? t("شروع چت جدید") : t("افزودن")}
        </button>
      </div>
    </div>
  );
}
