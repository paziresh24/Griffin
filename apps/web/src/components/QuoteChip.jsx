import { useEffect, useRef, useState } from "react";
import { Pencil, Quote, X } from "lucide-react";
import { quotePreview, quoteStore } from "../quotes.js";
import { textDir } from "../dir.js";
import { useTouchPrimary } from "../touch.js";
import { isRtl, t } from "../i18n.js";

// One waiting quote above the input. A click opens it in place: the quoted text and
// the note are both editable, saved or cancelled before the message goes (Esc cancels; Enter in the
// note, or Ctrl+Enter anywhere, saves — on a phone the buttons do). Focus leaving the editor keeps
// the edit, so a send never carries the old quote.
export function QuoteChip({ chatId, quote, onDone }) {
  const touch = useTouchPrimary();
  const [draft, setDraft] = useState(null);
  const textBox = useRef(null);
  const closing = useRef(false);
  useEffect(() => {
    const box = textBox.current;
    if (!draft || !box || document.activeElement === box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(draft)]);
  const close = () => {
    // Save and cancel hand focus back to the message box: that blur is not «leaving with an edit».
    closing.current = true;
    setDraft(null);
    onDone?.();
    closing.current = false;
  };
  const save = () => {
    if (!draft.text.trim()) return;
    quoteStore.update(chatId, quote.id, draft);
    close();
  };
  const leave = (event) => {
    // Another tab or window took the focus: the box gets it back on return, nothing to save yet.
    if (!document.hasFocus()) return;
    if (closing.current || event.currentTarget.contains(event.relatedTarget)) return;
    if (draft.text.trim()) quoteStore.update(chatId, quote.id, draft);
    setDraft(null);
  };
  const onKeyDown = (event, enterSaves) => {
    if (event.nativeEvent?.isComposing) return;
    if (event.key === "Escape") {
      // The editor's, never the run's Stop.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey || (enterSaves && !touch && !event.shiftKey))) {
      event.preventDefault();
      save();
    }
  };
  const box = "scrollbar-thin w-full resize-none rounded-md border bg-background px-2 py-1 outline-none focus:border-primary/60";
  if (draft) {
    return (
      <div className="quote-edit flex flex-col gap-1.5 rounded-lg border-s-2 border-primary bg-muted/60 px-2 py-1.5 text-xs" dir={isRtl ? "rtl" : "ltr"} onBlur={leave}>
        <textarea
          ref={textBox}
          rows={3}
          value={draft.text}
          dir={textDir(draft.text)}
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          onKeyDown={(event) => onKeyDown(event, false)}
          aria-label={t("متن نقل‌قول")}
          className={`${box} max-h-40 text-muted-foreground`}
        />
        <textarea
          rows={2}
          value={draft.note}
          dir={draft.note ? textDir(draft.note) : isRtl ? "rtl" : "ltr"}
          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
          onKeyDown={(event) => onKeyDown(event, true)}
          aria-label={t("نظر دربارهٔ این بخش")}
          placeholder={t("نظرت دربارهٔ این بخش (اختیاری)")}
          className={`${box} max-h-32`}
        />
        <div className="flex justify-end gap-2" onMouseDown={(event) => event.preventDefault()}>
          <button type="button" className="rounded-md px-2.5 py-1 hover:bg-muted" onClick={close}>{t("انصراف")}</button>
          <button type="button" className="rounded-md bg-primary px-2.5 py-1 text-primary-foreground disabled:opacity-45" onClick={save} disabled={!draft.text.trim()} title={touch ? t("ذخیرهٔ تغییر") : t("ذخیرهٔ تغییر (Ctrl+Enter)")}>
            {t("ذخیره")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="group/quote flex items-start gap-1.5 rounded-lg bg-muted/60 px-2 py-1 text-xs">
      <button
        type="button"
        onClick={() => setDraft({ text: quote.text, note: quote.note || "" })}
        className="flex min-w-0 flex-1 items-start gap-1.5 text-start"
        aria-label={t("ویرایش این نقل‌قول: {text}", { text: quotePreview(quote.text) })}
        title={`${quote.note ? `${quote.text}\n\n${quote.note}` : quote.text}\n\n${t("(برای ویرایش کلیک کن)")}`}
      >
        <Quote className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1" dir="auto">
          <span className="line-clamp-1 text-muted-foreground">{quotePreview(quote.text)}</span>
          {quote.note ? <span className="line-clamp-1">{quote.note}</span> : null}
        </span>
        <Pencil className="mt-0.5 size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/quote:opacity-100 group-focus-within/quote:opacity-100 pointer-coarse:opacity-100" />
      </button>
      <button type="button" onClick={() => quoteStore.remove(chatId, quote.id)} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted" aria-label={t("برداشتن نقل‌قول")}>
        <X className="size-3" />
      </button>
    </div>
  );
}
