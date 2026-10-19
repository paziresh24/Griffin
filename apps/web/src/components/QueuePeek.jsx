import { useEffect, useMemo, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, FileText, ImagePlus, ListTodo, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { textDir } from "../dir.js";
import { num, t } from "../i18n.js";
import { SENDING_LABEL, SENT_LABEL } from "../outbox.js";
import { QUEUE_WAITING_LABEL, editLossWarning, takeOutError, waitingQueued } from "../queue-peek.js";

const plainBtn = "press rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50";

/**
 * Above the composer, like ScheduledPeek (Notes.jsx): this chat's messages waiting behind the
 * running turn (queue-peek.js). A tap opens the list; "edit" takes one out of the queue back
 * into the box, "delete" takes it out. One still on its way (outbox.js) shows its send state and no
 * buttons until it lands. Under ScheduledPeek when both show (each tucks behind the next).
 */
export function QueuePeek({ chatId, onEdit }) {
  const messages = useAuiState((s) => s.thread.messages);
  // Taken out here: hidden at once, before the stream brings its user.queue event.
  const [gone, setGone] = useState(() => new Set());
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState(false);
  const items = useMemo(() => (chatId ? waitingQueued(messages).filter((item) => !gone.has(item.eventId)) : []), [chatId, messages, gone]);
  const first = items[0];
  useEffect(() => {
    if (!first) setOpen(false);
  }, [first]);

  const takeOut = async (item, edit) => {
    if (!edit && !window.confirm(t("این پیام از صف حذف شود؟"))) return;
    const loss = edit ? editLossWarning(item) : null;
    if (loss && !window.confirm(loss)) return;
    setBusy(item.eventId);
    try {
      await api(`/api/chats/${chatId}/queue/${item.eventId}`, { method: "DELETE" });
      setGone((prev) => new Set(prev).add(item.eventId));
      if (edit) onEdit?.(item.text);
    } catch (error) {
      toast.error(takeOutError(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AnimatePresence initial={false}>
      {first ? (
        <motion.div
          key="queue"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className="g-peek relative z-0 mx-3 -mb-3 rounded-t-xl border border-b-0 bg-muted px-3 pb-3.5 pt-1.5 text-xs"
        >
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full min-w-0 items-center gap-1.5 py-0.5 text-start text-muted-foreground hover:text-foreground">
            {items.some((item) => item.sendState === "sending") ? <Loader2 className="size-3.5 shrink-0 animate-spin text-signal" /> : <ListTodo className="size-3.5 shrink-0 text-primary" />}
            <span className="shrink-0 text-foreground">{QUEUE_WAITING_LABEL}</span>
            <span className="min-w-0 flex-1 truncate" dir={textDir(first.text)}>
              {first.text.split("\n").find((line) => line.trim()) || (first.files?.length ? first.files[0].name : first.images ? t("تصویر") : "")}
            </span>
            {items.length > 1 ? <span className="g-tag shrink-0 tabular-nums" dir="ltr">+{num(items.length - 1)}</span> : null}
            <ChevronDown className={`size-3.5 shrink-0 transition-transform duration-200 ${open ? "" : "rotate-180"}`} />
          </button>
          <AnimatePresence initial={false}>
            {open ? (
              <motion.ul
                key="list"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
                className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto pt-1.5"
              >
                {items.map((item) => (
                  <li key={item.key} className="g-note-item rounded-lg border px-2.5 py-1.5">
                    <p className="line-clamp-3 whitespace-pre-wrap break-words text-[13px]" dir={textDir(item.text)}>{item.text}</p>
                    {item.images ? (
                      <p className="mt-0.5 flex items-center gap-1 text-muted-foreground"><ImagePlus className="size-3" /> {t("{n} تصویر", { n: num(item.images) })}</p>
                    ) : null}
                    {item.files?.length ? (
                      <p className="mt-0.5 flex min-w-0 items-center gap-1 text-muted-foreground"><FileText className="size-3 shrink-0" /> <span className="truncate" dir="auto">{item.files.map((f) => f.name).join(t("، "))}</span></p>
                    ) : null}
                    {item.sendState ? (
                      <p className="mt-1 flex items-center gap-1 text-muted-foreground">
                        {item.sendState === "sending" ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} {item.sendState === "sending" ? SENDING_LABEL : SENT_LABEL}
                      </p>
                    ) : (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <button type="button" className={`g-btn ${plainBtn}`} disabled={busy != null} onClick={() => takeOut(item, true)}>{t("ویرایش")}</button>
                        <button type="button" className={`g-text-btn ${plainBtn}`} disabled={busy != null} onClick={() => takeOut(item, false)}>{t("حذف")}</button>
                      </div>
                    )}
                  </li>
                ))}
              </motion.ul>
            ) : null}
          </AnimatePresence>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
