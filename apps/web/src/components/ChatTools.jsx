import { useEffect, useState, useSyncExternalStore } from "react";
import { Popover } from "radix-ui";
import { ChevronDown, ListTree, MessageSquarePlus } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { textDir } from "../dir.js";
import { ModelPicker } from "./Controls.jsx";
import { badgeText, canStartSuggestion, chatSuggestions, createSuggestionStore, openSuggestions, suggestionAnchor, suggestionView } from "../chat-tools.js";
import { num, t } from "../i18n.js";

// Suggested chats and chapters. One store for the whole app: the sidebar section,
// the in-thread list and the cards in the thread stay in step.
export const suggestionStore = createSuggestionStore(api);

export function useSuggestions() {
  const state = useSyncExternalStore(suggestionStore.subscribe, suggestionStore.getState);
  return { ...state, open: openSuggestions(state.items, state.overrides) };
}

// The server's start refusals, in the owner's words.
const START_ERRORS = {
  "invalid repo": t("ریپوی پیشنهادشده روی سرور نیست"),
  "the prompt changed since it was shown; reload and read it again": t("متن پیشنهاد عوض شده؛ صفحه را تازه کن و دوباره بخوان"),
  "already started": t("این پیشنهاد قبلاً شروع شده"),
};

async function startSuggestion(id, after) {
  try {
    const chat = await suggestionStore.start(id);
    if (chat?.id) {
      navigate(chat.id);
      after?.();
    }
  } catch (error) {
    // The card stays open: the owner sees why, can change the model and tap again.
    toast.error(t("چت شروع نشد: {reason}", { reason: START_ERRORS[error?.message] || error?.message || t("خطای نامعلوم") }));
  }
}

const dismissSuggestion = (id) => suggestionStore.dismiss(id).catch(() => {});

const btn = "press rounded-lg bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50";
const textBtn = "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50";
const tag = "rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground";

function CountBadge({ count, className = "" }) {
  const text = badgeText(count);
  return text ? <span className={`rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground ${className}`}>{text}</span> : null;
}

// Before «شروع چت»: the repo as a tag, the model (changeable), and an optional note before or after the prompt.
function SuggestionEdits({ id, view, disabled }) {
  const edits = useSuggestions().edits[id] || {};
  const [opened, setOpened] = useState(false);
  // A note typed where this suggestion shows elsewhere keeps the box open here too.
  const noteOpen = opened || Boolean(edits.note);
  const set = (patch) => suggestionStore.setEdits(id, { ...edits, ...patch });
  const position = edits.notePosition === "before" ? "before" : "after";
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5" disabled={disabled}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {view.repo ? <span className={tag} dir="ltr">{view.repo}</span> : null}
        <ModelPicker compact model={typeof edits.model === "string" ? edits.model : view.model} onChange={(model) => set({ model })} />
        {!noteOpen ? (
          <button type="button" className={textBtn} onClick={() => setOpened(true)}>
            {t("+ تذکر")}
          </button>
        ) : null}
      </div>
      {noteOpen ? (
        <div className="flex min-w-0 flex-col gap-1">
          <textarea
            className="min-h-14 w-full resize-y rounded-lg border bg-background px-2 py-1.5 text-sm outline-none"
            dir="auto"
            rows={2}
            maxLength={2000}
            value={edits.note || ""}
            placeholder={t("تذکری که همراه پرامپت فرستاده شود")}
            aria-label={t("تذکر")}
            onChange={(e) => set({ note: e.target.value })}
          />
          <div className="flex items-center gap-1" role="radiogroup" aria-label={t("جای تذکر")}>
            {[["before", t("اول پرامپت")], ["after", t("آخر پرامپت")]].map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={position === value}
                className={`${tag} border ${position === value ? "border-primary text-foreground" : "border-transparent"}`}
                onClick={() => set({ notePosition: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}

// «متن کامل»: the whole first message the new chat would run — never cut.
function PromptBlock({ view, open, onToggle }) {
  if (!view.prompt) return null;
  return (
    <div className="min-w-0">
      <button type="button" className={textBtn} aria-expanded={open} onClick={onToggle}>
        <span>{t("متن کامل")}</span>
        <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <pre className="scrollbar-thin mt-1 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border px-2.5 py-2 font-[inherit] text-[13px] leading-7" dir="auto">
          {view.prompt}
        </pre>
      ) : null}
    </div>
  );
}

/** A `suggestion` part in the thread: the agent proposes a separate chat for a side issue. A shared
 * (read-only) view shows the title and the line only: it has no access to the suggestions API. */
export function SuggestionCard({ part, readOnly = false }) {
  const { items, overrides, busy, loaded } = useSuggestions();
  // The owner's own toggle; untouched, a short prompt is open and a long one takes one tap.
  const [expanded, setExpanded] = useState(undefined);
  useEffect(() => {
    if (!loaded && !readOnly) suggestionStore.refresh();
  }, [loaded, readOnly]);
  const view = suggestionView(part, overrides[part.id], items.find((s) => s?.id === part.id) || null);
  const open = expanded === undefined ? view.promptOpen : expanded;
  const working = Boolean(busy[part.id]);
  const live = view.status === "open" && !readOnly;
  return (
    <div id={part.id ? suggestionAnchor(part.id) : undefined} className={`my-2 flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 ${live ? "bg-card" : "text-muted-foreground"}`} dir="rtl">
      <div className="flex min-w-0 items-center gap-2">
        <MessageSquarePlus className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" dir={textDir(view.title)}>{view.title}</span>
        {view.label ? <span className={`${tag} shrink-0`}>{view.label}</span> : null}
      </div>
      {view.tldr ? <p className="break-words text-[13px] leading-6 text-muted-foreground" dir="auto">{view.tldr}</p> : null}
      {live && view.prompt ? <SuggestionEdits id={part.id} view={view} disabled={working} /> : null}
      {live ? <PromptBlock view={view} open={open} onToggle={() => setExpanded(!open)} /> : null}
      {live && part.id ? (
        <div className="flex items-center gap-2">
          <button type="button" className={btn} disabled={working || !canStartSuggestion(view)} onClick={() => startSuggestion(part.id)}>
            {t("شروع چت")}
          </button>
          <button type="button" className={textBtn} disabled={working} onClick={() => dismissSuggestion(part.id)}>
            {t("رد")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Sidebar: «پیشنهادها», collapsed until opened, above the chat list. Hidden while nothing is open.
export function SidebarSuggestions({ refreshKey, onNavigate }) {
  const { open, busy } = useSuggestions();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    suggestionStore.refresh();
  }, [refreshKey]);
  if (!open.length) return null;
  return (
    <section className="mb-2" aria-label={t("پیشنهادها")}>
      <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted">
        <span>{t("پیشنهادها")}</span>
        <CountBadge count={open.length} />
        <span className="flex-1" />
        <ChevronDown className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded ? (
        <ul>
          {open.map((s) => (
            <SuggestionItem key={s.id} item={s} working={Boolean(busy[s.id])} onNavigate={onNavigate} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// One listed suggestion (sidebar, or this chat's list). The prompt is closed here: one tap opens it.
function SuggestionItem({ item, working, onNavigate, onGo = null, inThread = false }) {
  const [expanded, setExpanded] = useState(false);
  const view = suggestionView(item, undefined, item);
  return (
    <li className="rounded-lg py-1 hover:bg-muted/50">
      <div className="flex min-w-0 items-center gap-1.5 px-2.5">
        <div className="min-w-0 flex-1">
          {onGo ? (
            <button type="button" className="block w-full truncate text-start text-[13px] hover:underline" dir={textDir(view.title)} title={view.tldr || view.title} onClick={() => onGo(item.id)}>{view.title}</button>
          ) : (
            <p className="truncate text-[13px]" dir={textDir(view.title)} title={view.tldr || view.title}>{view.title}</p>
          )}
          {inThread && view.tldr ? <p className="line-clamp-2 text-xs text-muted-foreground" dir="auto">{view.tldr}</p> : null}
          {!inThread && item.fromChatTitle ? <p className="truncate text-xs text-muted-foreground" dir={textDir(item.fromChatTitle)}>{t("از: {title}", { title: item.fromChatTitle })}</p> : null}
        </div>
        <button type="button" className={`${btn} shrink-0`} disabled={working || !canStartSuggestion(view)} onClick={() => startSuggestion(item.id, onNavigate)}>
          {t("شروع چت")}
        </button>
        <button type="button" className={`${textBtn} shrink-0`} disabled={working} onClick={() => dismissSuggestion(item.id)}>
          {t("رد")}
        </button>
      </div>
      <div className="flex min-w-0 flex-col gap-1 px-2.5 pt-1">
        {view.prompt ? <SuggestionEdits id={item.id} view={view} disabled={working} /> : null}
        <PromptBlock view={view} open={expanded} onToggle={() => setExpanded(!expanded)} />
      </div>
    </li>
  );
}

const floatBtn = "relative flex size-8 items-center justify-center rounded-full border bg-card text-muted-foreground shadow hover:text-foreground";
const menu = "pop z-50 flex max-h-[var(--radix-popover-content-available-height)] flex-col rounded-xl border bg-card shadow-xl";

/**
 * Beside the chapter list: this chat's open suggestions in one list. A tap on a title scrolls to
 * its card; start and dismiss work from here too, so a card far up does not have to be hunted down.
 */
export function ChatSuggestions({ chatId }) {
  const { items, overrides, busy, loaded } = useSuggestions();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!loaded) suggestionStore.refresh();
  }, [loaded]);
  const mine = chatSuggestions(items, overrides, chatId);
  useEffect(() => {
    if (!mine.length && open) setOpen(false);
  }, [mine.length, open]);
  if (!mine.length) return null;
  const go = (id) => {
    setOpen(false);
    document.getElementById(suggestionAnchor(id))?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  // Only a card that is on the page can be scrolled to; otherwise the title is plain text.
  const canGo = (id) => typeof document !== "undefined" && Boolean(document.getElementById(suggestionAnchor(id)));
  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) suggestionStore.refresh(); }}>
      <Popover.Trigger asChild>
        <button type="button" className={floatBtn} aria-label={t("پیشنهادهای باز این چت")} title={t("پیشنهادهای باز این چت")}>
          <MessageSquarePlus className="size-4" />
          <CountBadge count={mine.length} className="absolute -end-1 -top-1" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={8} className={`${menu} w-[min(26rem,calc(100vw-1rem))]`} dir="rtl">
          <p className="px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">{t("پیشنهادهای باز این چت ({n})", { n: num(mine.length) })}</p>
          <ul className="scrollbar-thin max-h-[60vh] min-h-0 overflow-y-auto pb-1">
            {mine.map((s) => (
              <SuggestionItem key={s.id} item={s} working={Boolean(busy[s.id])} onNavigate={() => setOpen(false)} onGo={canGo(s.id) ? go : null} inThread />
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A `chapter` part: a thin divider with the chapter title. */
export function ChapterDivider({ id, part }) {
  return (
    <div id={id} className="my-4 flex min-w-0 scroll-mt-3 items-center gap-2.5 text-xs text-muted-foreground before:h-px before:min-w-3 before:flex-1 before:bg-border after:h-px after:min-w-3 after:flex-1 after:bg-border" role="separator" title={part.summary || undefined}>
      <span className="min-w-0 truncate" dir={textDir(part.title || "")}>{part.title}</span>
    </div>
  );
}

/** Floating table of contents: lists the chapters and scrolls to the tapped one. */
export function ChapterToc({ chapters = [] }) {
  const [open, setOpen] = useState(false);
  if (!chapters.length) return null;
  const go = (id) => {
    setOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={floatBtn} aria-label={t("فهرست فصل‌ها")} title={t("فهرست فصل‌ها")}>
          <ListTree className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={8} className={`${menu} w-64 p-1`} dir="rtl">
          <p className="px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">{t("فصل‌ها")}</p>
          {chapters.map((chapter) => (
            <button key={chapter.id} type="button" className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted" onClick={() => go(chapter.id)} title={chapter.summary || undefined}>
              <span className="min-w-0 flex-1 truncate text-start" dir={textDir(chapter.title)}>{chapter.title}</span>
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
