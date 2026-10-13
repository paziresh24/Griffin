import { useEffect, useState, useSyncExternalStore } from "react";
import { Popover } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { AlarmClock, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { textDir } from "../dir.js";
import { clockLabel, createNotesStore, fromLocalInput, LATER_CHOICES, noteError, noteTarget, noteTitle, noteWhen, toLocalInput, untilLabel } from "../notes.js";
import { isRtl, num, t } from "../i18n.js";

// One store for the whole app: the card above the composer and the sidebar list stay in step.
export const notesStore = createNotesStore(api);

const useNotes = () => useSyncExternalStore(notesStore.subscribe, notesStore.getState);

// Re-renders every 30 s, so «۱۵ دقیقه دیگر» counts down while the page is open.
function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

const menu = "g-menu pop z-50 w-72 max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-1.5 text-sm shadow-xl";
const row = "g-menu-row flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-start text-[13px] hover:bg-muted disabled:opacity-50";
const plainBtn = "press rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50";
const btn = `g-btn ${plainBtn}`;

/** The «when» list: no time, 15 min … tomorrow at this time (each with its clock time), or a chosen one. */
function WhenMenu({ onPick, busy = false, title = t("کِی اجرا شود؟") }) {
  const now = useNow();
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(() => toLocalInput(Date.now() + 60 * 60_000));
  return (
    <div className="flex flex-col gap-0.5" dir={isRtl ? "rtl" : "ltr"}>
      <p className="g-menu-title px-2 pb-1 text-[11px] font-medium text-muted-foreground">{title}</p>
      {LATER_CHOICES.map((choice) => {
        const at = choice.at(now);
        return (
          <button key={choice.key} type="button" disabled={busy} className={row} onClick={() => onPick(at)}>
            <span>{choice.label}</span>
            {at ? <span className="text-xs text-muted-foreground">{clockLabel(at, now)}</span> : null}
          </button>
        );
      })}
      {custom ? (
        <div className="mt-1 flex items-center gap-1 px-2">
          <input type="datetime-local" className="g-input min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-[13px]" dir="ltr" value={value} min={toLocalInput(now)} onChange={(event) => setValue(event.target.value)} />
          <button type="button" className="g-btn g-btn-primary press rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50" disabled={busy || !fromLocalInput(value)} onClick={() => onPick(fromLocalInput(value))}>
            {t("ذخیره")}
          </button>
        </div>
      ) : (
        <button type="button" className={row} onClick={() => setCustom(true)}>{t("زمان دلخواه…")}</button>
      )}
    </div>
  );
}

/**
 * Above the composer: what is scheduled for this chat (on the new-chat page, for a new chat), as a
 * card tucked behind the box with only its top edge showing. A tap opens it upward, each note with
 * its own actions (run now, another time, edit, delete).
 */
export function ScheduledPeek({ chatId = null }) {
  const { items, busy } = useNotes();
  const now = useNow();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    notesStore.refresh();
    const timer = setInterval(() => notesStore.refresh(), 60_000);
    return () => clearInterval(timer);
  }, [chatId]);
  const mine = items.filter((note) => (chatId ? note.chatId === chatId : !note.chatId) && (note.runAt || note.status === "failed"));
  const first = mine[0];
  useEffect(() => {
    if (!first) setOpen(false);
  }, [first]);
  return (
    <AnimatePresence initial={false}>
      {first ? (
        <motion.div
          key="peek"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className="g-peek relative z-0 mx-3 -mb-3 rounded-t-xl border border-b-0 bg-muted px-3 pb-3.5 pt-1.5 text-xs"
        >
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full min-w-0 items-center gap-1.5 py-0.5 text-start text-muted-foreground hover:text-foreground">
            <AlarmClock className="size-3.5 shrink-0 text-primary" />
            <span className={`shrink-0 ${first.status === "failed" ? "text-bad" : "text-foreground"}`}>{first.status === "failed" ? t("اجرا نشد") : untilLabel(Date.parse(first.runAt), now)}</span>
            <span className="min-w-0 flex-1 truncate" dir={textDir(first.text)}>
              {noteTitle(first)}
            </span>
            {mine.length > 1 ? <span className="g-tag shrink-0 tabular-nums" dir="ltr">+{num(mine.length - 1)}</span> : null}
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
                {mine.map((note) => (
                  <NoteItem key={note.id} note={note} now={now} working={Boolean(busy[note.id])} />
                ))}
              </motion.ul>
            ) : null}
          </AnimatePresence>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// Sidebar: «یادداشت‌ها». Hidden while there is none.
export function SidebarNotes({ refreshKey, onNavigate }) {
  const { items, busy } = useNotes();
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    notesStore.refresh();
  }, [refreshKey]);
  // A timed note may run while nothing else changes: look again every minute.
  useEffect(() => {
    const timer = setInterval(() => notesStore.refresh(), 60_000);
    return () => clearInterval(timer);
  }, []);
  const now = useNow();
  if (!items.length) return null;
  return (
    <section className="mb-2" aria-label={t("یادداشت‌ها")}>
      <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="g-list-row flex w-full items-center gap-1.5 rounded-md px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronDown className={`size-3 shrink-0 transition-transform ${expanded ? "" : "-rotate-90 rtl:rotate-90"}`} />
        <span className="flex-1 text-start">{t("یادداشت‌ها")}</span>
        <span className="g-tag tabular-nums">{num(items.length)}</span>
      </button>
      {expanded ? (
        <ul className="flex flex-col gap-1 px-1">
          {items.map((note) => (
            <NoteItem key={note.id} note={note} now={now} working={Boolean(busy[note.id])} onNavigate={onNavigate} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function NoteItem({ note, now, working, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const [timeOpen, setTimeOpen] = useState(false);
  const failed = note.status === "failed";
  const guard = (promise) => promise.catch((error) => toast.error(noteError(error)));
  const run = () =>
    guard(
      notesStore.run(note.id).then((chat) => {
        if (chat?.id) {
          navigate(chat.id);
          onNavigate?.();
        }
      }),
    );
  const saveText = () => guard(notesStore.update(note.id, { text: draft }).then(() => setEditing(false)));
  const setTime = (atMs) => guard(notesStore.update(note.id, { runAt: atMs ? new Date(atMs).toISOString() : null }).then(() => setTimeOpen(false)));
  const remove = () => {
    if (window.confirm(t("این یادداشت حذف شود؟"))) guard(notesStore.remove(note.id));
  };
  return (
    <li className={`g-note-item rounded-lg border px-2.5 py-1.5 ${open ? "bg-muted/50" : ""}`} data-open={open ? "true" : undefined}>
      <button type="button" className="block w-full min-w-0 text-start" onClick={() => setOpen(!open)} aria-expanded={open}>
        <p className={`text-[13px] font-medium ${open ? "whitespace-pre-wrap" : "line-clamp-2"}`} dir={textDir(note.text)}>
          {open ? note.text : noteTitle(note)}
        </p>
        <p className={`truncate text-xs ${note.runAt ? "g-note-when text-primary" : "text-muted-foreground"}`}>
          {note.runAt ? <AlarmClock className="inline size-3 align-[-1px]" /> : null} {noteWhen(note, now)} · {noteTarget(note)}
        </p>
        {failed ? <p className="text-xs text-bad" dir="auto">{t("اجرا نشد: {error}", { error: note.error })}</p> : null}
      </button>
      {open && editing ? (
        <div className="mt-1 flex flex-col gap-1">
          <textarea className="g-input rounded-md border bg-background px-2 py-1 text-[13px]" dir={textDir(draft)} value={draft} onChange={(event) => setDraft(event.target.value)} rows={4} autoFocus />
          <div className="flex gap-1">
            <button type="button" className={btn} disabled={working || !draft.trim()} onClick={saveText}>{t("ذخیره")}</button>
            <button type="button" className={`g-text-btn ${plainBtn}`} onClick={() => { setDraft(note.text); setEditing(false); }}>{t("انصراف")}</button>
          </div>
        </div>
      ) : null}
      {open && !editing ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <button type="button" className="g-btn g-btn-primary press rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50" disabled={working} onClick={run}>
            {failed ? t("دوباره اجرا") : t("اجرا الان")}
          </button>
          <Popover.Root open={timeOpen} onOpenChange={setTimeOpen}>
            <Popover.Trigger asChild>
              <button type="button" className={btn} disabled={working}>{t("تغییر زمان")}</button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="start" side="bottom" sideOffset={6} collisionPadding={16} className={menu}>
                <WhenMenu busy={working} onPick={setTime} title={t("زمانِ تازه")} />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <button type="button" className={btn} disabled={working} onClick={() => { setDraft(note.text); setEditing(true); }}>{t("ویرایش")}</button>
          <button type="button" className={`g-text-btn ${plainBtn}`} disabled={working} onClick={remove}>{t("حذف")}</button>
        </div>
      ) : null}
    </li>
  );
}
