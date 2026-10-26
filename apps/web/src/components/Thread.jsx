import { fallbackLabel } from "../fallback.js";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActionBarPrimitive, AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, unstable_useComposerInput, useAui, useAuiEvent, useAuiState,
} from "@assistant-ui/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { motion } from "motion/react";
import {
  AlertCircle, Archive, ArrowDown, ArrowUp, Brain, Check, ChevronDown, Clock, Copy, CornerDownLeft, FileText, ImagePlus, ListTodo, Loader2, Mic, MicOff, Pencil, Plus, Quote, RotateCcw, Send, Sparkles, Square, StickyNote, X, Zap,
} from "lucide-react";
import { ToolCard } from "./Tool.jsx";
import { formatAnsweredAt, formatDuration, splitRun, toolProps, WorkLog } from "./Work.jsx";
import { textDir } from "../dir.js";
import { DirBlock } from "./DirBlock.jsx";
import { Dialog } from "radix-ui";
import { filesLine, rewindChoices, textBackToBox } from "../rewind.js";
import { AgentGlyph, EffortPicker, ModeToggle, ModelPicker, loadDoctor, useRunAccount } from "./Controls.jsx";
import { agentMeta, writeSetting } from "../brand.js";
import { pickSuggestions } from "../suggestions.js";
import { locale, num, t, isRtl } from "../i18n.js";
import { toast } from "sonner";
import { countProblem, dragHasFiles, formatBytes, isImageAttachment, overLimit } from "../attachments.js";
import { api, navigate, reloadTimeline } from "../api.js";
import { RESTORE_EVENT, editSend, retrySend, returnToBox, useRuntimeChat } from "../runtime.jsx";
import { FAILED_LABEL, SENDING_LABEL, SENT_LABEL } from "../outbox.js";
import { parseQuoted, quoteStore } from "../quotes.js";
import { SelectionActions } from "./SelectionActions.jsx";
import { QuoteChip, QuotedText } from "./QuoteChip.jsx";
import { ChatRecord, ComposerAssist, FastSwitch, MentionBackdrop, FastToggle, ForkButton, useNextStep } from "./ComposerAssist.jsx";
import { NoteRow, PersonAvatar, PersonName } from "./Telegram.jsx";
import { isNoReply, motherName, peerFrame, reminderFrame, stripOwnerFrame, stripSender, userSide } from "../telegram.js";
import { submitMode, useTouchPrimary } from "../touch.js";
import { loadDraft, saveDraft } from "../draft.js";
import { MAX_RECORD_MS, joinDictation, pickAudioMime, recordClock, toWav } from "../dictation.js";
import { holdReload } from "../new-version.js";
import { HomeNotes, ScheduledPeek, SendLater } from "./Notes.jsx";
import { QueuePeek } from "./QueuePeek.jsx";
import { TasksPeek } from "./TasksPeek.jsx";
import { inPeek, queueDropped, queueLabel, queueRemoved } from "../queue-peek.js";
import { UsageRing } from "./ComposerStats.jsx";
import { WhyButton, WhyFlag, WhyPanel } from "./Why.jsx";
import { phaseLabel } from "../run-phase.js";
import { answerItems, chapterAnchor } from "../chat-tools.js";
import { ChapterDivider, ChapterToc, ChatSuggestions, SuggestionCard } from "./ChatTools.jsx";
import { tr } from "./Setup.jsx";
import { useFlag, useLook, useUiPrefs } from "../ui-prefs.js";
import { MessageBoundary } from "../boundary.js";
import { escCancels } from "../keys.js";
import { clockLabel, exactTime, fullAgo } from "../elapsed.js";
import { answerTokens } from "../tokens-format.js";
import { MentionPart } from "./Mention.jsx";

const ChatContext = createContext({ chatId: null, readOnly: false });

const plugins = { code };
// Code blocks stay compact: copy only. Tables keep download (CSV) and fullscreen — a wide table is
// unreadable inside the chat column.
const controls = { code: { copy: true, download: false }, table: { copy: true, download: true, fullscreen: true } };

export function Thread({
  header,
  runInfo,
  readOnly = false,
  canSide = false, // "to side chat" in the selection toolbar (App: an owner's chat, SIDE_CHAT on)
  agentLabel = t("ایجنت"),
  agent = "griffin",
  fresh = false,
  recentTitles = [],
  onSuggestion,
  mode = "agent",
  model = "",
  chatId = null,
  onModeChange,
  onModelChange,
  effort = "",
  onEffortChange,
  composerTop = null,
  compact = false,
  placeholder = "",
  board = null,
  loading = false, // the chat's events have not arrived yet (App: useTimeline connection "loading")
  earlier = 0, // messages before the first one held (a long chat opens with its last page only)
  onLoadEarlier = null,
}) {
  return (
    <ChatContext.Provider value={{ chatId, readOnly }}>
    <ThreadPrimitive.Root data-griffin-chat="" className="flex h-full min-h-0 flex-col">
      {header}
      {readOnly ? null : <SelectionActions canSide={canSide} />}
      <ThreadBody
        runInfo={runInfo}
        readOnly={readOnly}
        agentLabel={agentLabel}
        agent={agent}
        fresh={fresh}
        recentTitles={recentTitles}
        onSuggestion={onSuggestion}
        mode={mode}
        model={model}
        onModeChange={onModeChange}
        onModelChange={onModelChange}
        effort={effort}
        onEffortChange={onEffortChange}
        composerTop={composerTop}
        compact={compact}
        placeholder={placeholder}
        board={board}
        loading={loading}
        earlier={earlier}
        onLoadEarlier={onLoadEarlier}
      />
    </ThreadPrimitive.Root>
    </ChatContext.Provider>
  );
}

// Where the messages go while a chat's events are still coming: a few quiet placeholder bubbles, so
// a switch to another chat shows something at once instead of an empty page.
function ThreadSkeleton() {
  return (
    <div className="space-y-5 py-4" role="status" aria-label={t("در حال بارگذاری گفتگو")}>
      {[["w-2/5", "ms-auto"], ["w-4/5", ""], ["w-3/5", ""], ["w-1/3", "ms-auto"], ["w-3/4", ""]].map(([width, side], i) => (
        <div key={i} className={`${width} ${side} animate-pulse space-y-2 rounded-2xl bg-muted/60 p-4`} style={{ animationDelay: `${i * 110}ms` }} aria-hidden>
          <div className="h-3 w-full rounded bg-muted" />
          <div className="h-3 w-4/5 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

// The top of a long chat: older messages come a page at a time, by themselves as this scrolls into
// view (and by a tap, which also retries a failed page).
function LoadEarlier({ earlier, onLoad }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onLoad();
    } finally {
      setBusy(false);
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  // Once per page: a new `earlier` makes a fresh observer, which looks again at what is in view.
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return undefined;
    const watcher = new IntersectionObserver((hits) => hits.some((hit) => hit.isIntersecting) && loadRef.current(), { rootMargin: "200px 0px 0px 0px" });
    watcher.observe(node);
    return () => watcher.disconnect();
  }, [earlier]);
  return (
    <div className="flex justify-center py-3">
      <button ref={ref} type="button" onClick={load} disabled={busy} className="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-60">
        {busy ? t("در حال بارگذاری…") : `پیام‌های قبلی (${earlier.toLocaleString("fa-IR")})`}
      </button>
    </div>
  );
}

function ThreadBody({ runInfo, readOnly, agentLabel, agent, fresh, recentTitles, onSuggestion, mode, model, onModeChange, onModelChange, effort, onEffortChange, composerTop, compact, placeholder, board, loading = false, earlier = 0, onLoadEarlier = null }) {
  // New chat page: the box is docked at the bottom like in a chat; the owner's
  // board — or, with nothing on it, the welcome and suggestions — fills the page above it. The
  // side chat (compact) keeps its composer in the middle.
  const showHero = fresh && !readOnly;
  // «کارهای منتظر شما و در جریان» off (ui-prefs.js): Karsara's centred home page — the blurb, the
  // setup card and the composer in the middle, no board.
  const karsara = useLook() === "karsara";
  const homeBoard = useFlag("homeBoard");
  const docked = showHero && !compact && homeBoard;
  const composerProps = { agentLabel, mode, model, agent, onModeChange, onModelChange, effort, onEffortChange, top: composerTop, compact, placeholder };

  return (
    // The hero has no messages to follow; a tall home-page board would be pulled to its bottom.
    <ThreadPrimitive.Viewport data-griffin-thread="" autoScroll={!showHero} className="scrollbar-thin relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className={`${showHero ? "" : "thread-in"} mx-auto flex w-full ${karsara ? "max-w-3xl" : "max-w-5xl"} flex-1 flex-col px-3 pt-4 sm:px-6 ${showHero && (!homeBoard || !board) ? "justify-center" : ""}`}>
        {showHero ? (
          <WelcomeHero
            agent={agent}
            recentTitles={recentTitles}
            onSuggestion={onSuggestion}
            board={board}
            docked={docked}
            {...composerProps}
          />
        ) : (
          <>
            {loading ? <ThreadSkeleton /> : null}
            {earlier > 0 && onLoadEarlier ? <LoadEarlier earlier={earlier} onLoad={onLoadEarlier} /> : null}
            <MessageBoundary>
              <ThreadPrimitive.Messages components={{ UserMessage: SafeUserMessage, AssistantMessage: SafeAssistantMessage, SystemMessage: SafeSystemMessage }} />
            </MessageBoundary>
            <div className="min-h-6 flex-1" />
          </>
        )}
      </div>
      {readOnly || (showHero && !docked) ? null : (
        <ThreadPrimitive.ViewportFooter className={`g-thread-footer sticky bottom-0 mx-auto w-full ${karsara ? "max-w-3xl" : "max-w-5xl"} bg-gradient-to-t from-background via-background to-transparent px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2 sm:px-6`}>
          {showHero ? null : (
            <>
              <ThreadPrimitive.ScrollToBottom className="absolute -top-10 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border bg-card shadow disabled:invisible">
                <ArrowDown className="size-4" />
              </ThreadPrimitive.ScrollToBottom>
              <ThreadTools />
              {runInfo}
            </>
          )}
          {/* The new chat page keeps its own composer (mode names, effort under the box), docked. */}
          <Composer {...composerProps} variant={showHero ? "hero" : "dock"} />
        </ThreadPrimitive.ViewportFooter>
      )}
    </ThreadPrimitive.Viewport>
  );
}

// docked: the composer is in the page's footer (ThreadBody), so the hero leaves its slot empty.
function WelcomeHero({ agent, agentLabel, recentTitles, onSuggestion, mode, model, onModeChange, onModelChange, effort, onEffortChange, top, compact, board, docked = false }) {
  const meta = agentMeta(agent);
  const homeBoard = useFlag("homeBoard");
  const suggestions = useMemo(
    () => pickSuggestions(agent, { count: 4, recentTitles, salt: String(recentTitles[0] || "") }),
    [agent, recentTitles],
  );
  const composer = docked ? null : (
    <Composer
      agentLabel={agentLabel}
      variant="hero"
      mode={mode}
      model={model}
      agent={agent}
      onModeChange={onModeChange}
      onModelChange={onModelChange}
      effort={effort}
      onEffortChange={onEffortChange}
      top={top}
      compact={compact}
    />
  );

  // The board takes the blurb's place: «منتظر شما», then the task lists (above the docked box).
  const bottom = board && !compact ? board.bottom : null;

  // Board off: one quiet line, what is not connected yet, the composer. No glyph, no pills, no motion.
  if (!homeBoard) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-6">
        <h2 className="text-center text-lg font-medium text-foreground/90" dir="auto">{meta.blurb || meta.label}</h2>
        {compact ? null : <SetupCard />}
        {composer}
        {compact ? null : <HomeNotes />}
      </div>
    );
  }

  // One tree whether or not the board shows: the glyph, the blurb, the board's parts and the pills
  // are fixed slots, so the composer never moves and is never remounted (a dictation in progress
  // would be thrown away, and focus would jump) when the first item arrives.
  return (
    <motion.div
      className={`mx-auto flex w-full ${board && docked ? "max-w-3xl" : "max-w-xl"} flex-col items-center gap-5 py-6`}
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
      }}
    >
      {board ? null : (
        <motion.div variants={fadeUp} className="welcome-glow">
          <AgentGlyph id={agent} className="size-14" />
        </motion.div>
      )}
      {board ? null : (
        <motion.div variants={fadeUp} className="text-center">
          <h2 className="text-xl font-semibold" dir="auto">{meta.label}</h2>
          <p className="mt-1 text-sm text-muted-foreground" dir="auto">{meta.blurb}</p>
        </motion.div>
      )}
      <motion.div variants={fadeUp} className="w-full">
        <SetupCard />
      </motion.div>
      {/* empty:hidden — a part with nothing to show (NeedsYou/TaskLists render null) leaves no gap. */}
      {board ? <motion.div variants={fadeUp} className="w-full empty:hidden">{board.top}</motion.div> : null}
      {board && docked ? <motion.div variants={fadeUp} className="w-full empty:hidden">{bottom}</motion.div> : null}
      {composer ? (
        <motion.div variants={fadeUp} className="w-full">
          {composer}
        </motion.div>
      ) : null}
      {board && !docked ? <motion.div variants={fadeUp} className="w-full empty:hidden">{bottom}</motion.div> : null}
      {board ? null : (
        <motion.div variants={fadeUp} className="flex w-full flex-wrap justify-center gap-2">
          {suggestions.map((item, i) => (
            <motion.button
              key={item.title}
              type="button"
              custom={i}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.28 + i * 0.05, type: "spring", stiffness: 380, damping: 28 }}
              onClick={() => onSuggestion?.(item.prompt)}
              className="press rounded-full border bg-card px-3.5 py-2 text-sm text-foreground/90 transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-sm"
              dir="auto"
            >
              {item.title}
            </motion.button>
          ))}
        </motion.div>
      )}
      {/* «یادآورها»: last on the home page, folded (owner 10-24: not in the sidebar). */}
      {compact ? null : (
        <motion.div variants={fadeUp} className="w-full empty:hidden">
          <HomeNotes />
        </motion.div>
      )}
    </motion.div>
  );
}

const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 380, damping: 28 } },
};

// «هنوز وصل نیستند» on a new chat: an engine with no working key, a messenger that
// is down — each with its wizard and a «بعداً» that hides that one item on this browser.
const SETUP_LATER = "griffin.setup-later";
const readLater = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(SETUP_LATER) || "[]"));
  } catch {
    return new Set();
  }
};

export function setupItems(setup, report) {
  const items = [];
  const engines = (report?.checks || []).filter((c) => c.level !== "ok" && (c.id === "engines" || c.id.startsWith("engine:")));
  if (engines.length) for (const c of engines) items.push({ id: c.id, text: tr(c.title, c.vars), flow: "engine" });
  else if (setup?.needsEngine) items.push({ id: "engines", text: t("هیچ موتور هوش مصنوعی وصل نیست"), flow: "engine" });
  for (const c of report?.checks || []) {
    if (c.level !== "ok" && c.id.startsWith("integration:")) items.push({ id: c.id, text: tr(c.title, c.vars), flow: "telegram" });
  }
  return items;
}

function SetupCard() {
  const karsara = useLook() === "karsara";
  const [setup, setSetup] = useState(null);
  const [report, setReport] = useState(null);
  const [later, setLater] = useState(readLater);
  useEffect(() => {
    let alive = true;
    api("/api/setup").then((r) => alive && setSetup(r), () => {});
    loadDoctor().then((r) => alive && setReport(r));
    return () => {
      alive = false;
    };
  }, []);
  const items = setupItems(setup, report).filter((item) => !later.has(item.id));
  if (!items.length) return null;
  const putOff = (id) => {
    const next = new Set(later).add(id);
    setLater(next);
    try {
      localStorage.setItem(SETUP_LATER, JSON.stringify([...next]));
    } catch {
      // storage unavailable: hidden for this page only
    }
  };
  if (karsara) {
    // Karsara's SetupRow (Karsara Setup.jsx): an icon tile, the line, «وصل کن», and ✕ for «بعداً».
    return (
      <section className="rounded-2xl border border-warn/40 bg-warn/5 p-4" aria-label={t("هنوز وصل نیستند")}>
        <p className="mb-3 text-sm font-medium">{t("این‌ها هنوز وصل نیستند:")}</p>
        <ul className="divide-y">
          {items.map((item) => {
            const Icon = item.flow === "telegram" ? Send : Sparkles;
            return (
              <li key={item.id} className="space-y-3 py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-warn/15 text-warn">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium" dir="auto">{item.text}</p>
                  </div>
                  <a href={`#/setup/${item.flow}`} className="kc-pill shrink-0">{t("وصل کن")}</a>
                  <button type="button" className="kc-icon-btn shrink-0" onClick={() => putOff(item.id)} aria-label={t("بعداً")} title={t("بعداً")}>
                    <X className="size-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    );
  }
  return (
    <section className="g-box rounded-2xl border border-warn/40 bg-warn/5 p-4 text-start" aria-label={t("هنوز وصل نیستند")} dir={isRtl ? "rtl" : "ltr"}>
      <p className="mb-2 text-sm font-medium">{t("این‌ها هنوز وصل نیستند:")}</p>
      <ul className="divide-y">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <span className="min-w-0 flex-1" dir="auto">{item.text}</span>
            <a href={`#/setup/${item.flow}`} className="g-btn inline-flex min-h-9 items-center rounded-lg border px-3 text-xs hover:bg-muted">{t("وصل کن")}</a>
            <button type="button" onClick={() => putOff(item.id)} className="inline-flex min-h-9 items-center px-2 text-xs text-muted-foreground hover:text-foreground">{t("بعداً")}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function chatDir(value) {
  // Chat UI is Persian-first: English text is LTR (dir.js decides); Persian, digits-only and
  // empty are RTL, so a Persian line that opens with an English name stays right-aligned.
  return textDir(value) === "ltr" ? "ltr" : "rtl";
}

// One bad message never blanks the thread: it alone shows «نمایش این پیام ممکن نشد».
function SafeUserMessage() {
  return <MessageBoundary><UserMessage /></MessageBoundary>;
}

function SafeAssistantMessage() {
  return <MessageBoundary><AssistantMessage /></MessageBoundary>;
}

// A tg.note (runtime.jsx noteMessage): a report card or one quiet line, in the thread's time order.
function SafeSystemMessage() {
  return <MessageBoundary><SystemMessage /></MessageBoundary>;
}

function SystemMessage() {
  const note = useAuiState((s) => s.message.metadata?.custom?.note);
  const guest = useAuiState((s) => s.message.metadata?.custom?.guest);
  if (guest) return <GuestNote from={guest.from} />;
  if (!note) return null;
  return (
    <MessagePrimitive.Root className="my-2">
      <NoteRow note={note} />
    </MessagePrimitive.Root>
  );
}

// A note from the person this chat was privately shared with (guest.js): their words, labelled as
// theirs. It is not the owner's message and the agent never acts on it. The look per skin is in
// styles.css (.g-guest-note).
function GuestNote({ from }) {
  const createdAt = useAuiState((s) => s.message.createdAt);
  const text = useAuiState((s) => (Array.isArray(s.message.content) ? s.message.content.map((p) => p?.text || "").join("\n") : ""));
  return (
    <MessagePrimitive.Root className="group my-3 flex flex-col items-stretch">
      <div className="g-guest-note rounded-2xl bg-muted/60 px-3 py-2">
        <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <StickyNote className="size-3.5" /> {t("یادداشتِ {name} · ایجنت آن را اجرا نمی‌کند", { name: from || t("مهمان") })}
        </p>
        <p className="chat-text whitespace-pre-wrap break-words leading-7" dir={chatDir(text)}>{text}</p>
      </div>
      <span className="flex items-center gap-2"><MessageTime at={createdAt} /></span>
    </MessagePrimitive.Root>
  );
}

// One clock for every message's elapsed time: a tick each half minute, only while something listens.
const tickClock = { listeners: new Set(), timer: null, tick: 0 };
function subscribeClock(onChange) {
  tickClock.listeners.add(onChange);
  tickClock.timer ??= setInterval(() => {
    tickClock.tick += 1;
    for (const listener of tickClock.listeners) listener();
  }, 30_000);
  return () => {
    tickClock.listeners.delete(onChange);
    if (!tickClock.listeners.size) {
      clearInterval(tickClock.timer);
      tickClock.timer = null;
    }
  };
}

// When, as a clock ("14:03", "yesterday 14:03" — not "3 minutes ago"), while the pointer
// rests on the message; the exact date and time (weekday, seconds) as its tooltip. The timeAgo
// preference keeps the elapsed time instead ("2 days 2 hours ago").
function MessageTime({ at }) {
  useSyncExternalStore(subscribeClock, () => tickClock.tick, () => 0);
  const text = useFlag("timeAgo") ? fullAgo(at) : clockLabel(at);
  if (!text) return null;
  return (
    <span className="text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-80" title={exactTime(at)}>
      {text}
    </span>
  );
}

// The agent's own `later` reminder coming due: one folded line, not a message to the person (a colleague
// 10-24: «چرا چیزی که من نباید کاری براش بکنم رو به من میگه»). A tap shows what it wrote and when.
function ReminderMessage({ framed }) {
  const [open, setOpen] = useState(false);
  const setAt = clockLabel(framed.setAt);
  return (
    <MessagePrimitive.Root className="msg-in my-2 flex flex-col items-start">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="press flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground">
        <Clock className="size-3.5" />
        <span>{t("یادآور خودکار ایجنت")}</span>
        <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="chat-text mt-1 max-w-[88%] whitespace-pre-wrap break-words rounded-xl border bg-muted/40 px-3 py-2 text-[13px] leading-6 text-foreground/80" dir={chatDir(framed.text)}>
          {setAt ? <div className="mb-1 text-[11px] text-muted-foreground">ایجنت این را {setAt} برای خودش گذاشته بود</div> : null}
          {framed.text}
        </div>
      ) : null}
    </MessagePrimitive.Root>
  );
}

function UserMessage() {
  const { chatId, readOnly } = useContext(ChatContext);
  const custom = useAuiState((s) => s.message.metadata?.custom);
  // Waiting in the queue: shown above the composer (QueuePeek), not here — unless there is no composer.
  const waiting = useAuiState((s) => inPeek(s.message));
  const messageId = useAuiState((s) => s.message.id);
  const createdAt = useAuiState((s) => s.message.createdAt);
  const links = useFlag("editLinks"); // «ویرایش» و «برگشت» زیر پیام
  const text = useAuiState((s) => {
    const parts = s.message.content || s.message.parts || [];
    if (typeof parts === "string") return parts;
    return (Array.isArray(parts) ? parts : []).map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n");
  });
  // A mother chat: a colleague's Telegram message is theirs (muted, named); what the owner types
  // here is a note to the assistant that the colleague never sees (telegram.js userSide).
  const chat = useContext(ChatRecord);
  const from = custom?.from;
  const { theirs: colleague, reminder, ownerNote, editable } = userSide(from, text, chat);
  const framed = reminder ? reminderFrame(text) : null;
  const dir = chatDir(framed ? framed.text : text);
  // Replies to a part of an answer and «به چت جدید»: the quotes as cards, not raw «>» lines.
  const quoted = useMemo(() => (colleague || ownerNote || reminder ? null : parseQuoted(text)), [text, colleague, ownerNote, reminder]);
  // A queued message that ran shows at its place with no label; one that never ran is muted.
  const label = queueLabel(custom);
  const dropped = queueDropped(custom);
  // message.id is `u<eventId>`; rewind truncates the chat back to this event.
  const eventId = typeof messageId === "string" && messageId.startsWith("u") ? Number(messageId.slice(1)) : null;
  const canEdit = chatId && eventId && !readOnly && editable;
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rewindOpen, setRewindOpen] = useState(false);
  const rewind = () => setRewindOpen(true);
  if ((waiting && !readOnly) || queueRemoved(custom)) return null;
  if (reminder) return <ReminderMessage framed={framed} />;
  const peer = colleague && from.kind === "peer" ? peerFrame(text) : null;
  const shown = peer ? peer.text : colleague ? stripSender(text, from.name) : ownerNote ? stripOwnerFrame(text) : text;

  const act = async (body) => {
    setBusy(true);
    try {
      const { files } = (await api(`/api/chats/${chatId}/rewind`, { method: "POST", body: { eventId, ...body } })) || {};
      // Claude's file edits since that message (the owner's own chats): put back, or why not.
      if (files?.restored) toast.success(t("{n} فایل به حالت قبل از این پیام برگشت.", { n: num(files.restored) }));
      else if (files?.error) toast.error(t("فایل‌ها برنگشتند: {error}", { error: files.error }));
      else if (body.files === false) toast.success(t("گفتگو به پیش از این پیام برگشت."));
      setEditing(null);
      setRewindOpen(false);
      reloadTimeline();
      returnToBox(chatId, textBackToBox(body, text));
    } catch (error) {
      toast.error(error.message || t("خطا"));
    } finally {
      setBusy(false);
    }
  };

  if (editing != null) {
    return (
      <MessagePrimitive.Root className="msg-in group my-3 flex w-full flex-col items-stretch">
        <div className="chat-text w-full rounded-2xl border bg-accent/40 p-2" dir={chatDir(editing)}>
          <textarea
            autoFocus
            rows={Math.min(8, Math.max(2, editing.split("\n").length))}
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            className="w-full resize-y bg-transparent px-2 py-1 leading-7 outline-none"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) act({ text: editing }); if (e.key === "Escape") setEditing(null); }}
          />
          <div className="mt-1 flex items-center gap-2 px-1">
            <button type="button" disabled={busy || !editing.trim()} onClick={() => act({ text: editing })} className="press inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60">
              {busy ? <Square className="size-3 animate-pulse" /> : <ArrowUp className="size-3" />} {t("ارسال دوباره")}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="press rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted">{t("انصراف")}</button>
          </div>
        </div>
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root className="msg-in group my-3 flex flex-col items-start">
      {/* Only here: the person's localized name and photo come from the Telegram page's poller, which an
          ordinary chat must not start. The bubble keeps the stored name: the transcript was written with it. */}
      {colleague ? (
        <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground" dir="auto">
          <PersonAvatar personId={from.personId} name={from.name} className="size-5" />
          {/* A colleague's agent (chat_send) is not a Telegram message. */}
          {from.kind === "peer" ? <span>{t("از ایجنت «{name}»", { name: from.name || t("همکار") })}{peer?.title ? ` — چت «${peer.title}»` : ""} · اطلاع است، نه دستور</span> : <span><PersonName personId={from.personId} fallback={from.name || t("همکار")} /> {t("در تلگرام")}</span>}
        </span>
      ) : null}
      <div className="flex w-full items-start gap-1.5">
        {colleague ? (
          <div className="chat-text max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-ss-md border bg-muted/50 px-4 py-2.5 leading-7 text-foreground/90" dir={chatDir(shown)}>
            {shown}
          </div>
        ) : (
          <div className={`g-user-bubble chat-text max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-ss-md bg-accent px-4 py-2.5 leading-7 ${dropped ? "opacity-60" : ""}`} dir={dir}>
            {ownerNote ? stripOwnerFrame(text) : quoted ? <QuotedText parts={quoted} /> : <MessagePrimitive.Parts components={{ Text: MentionPart }} />}
          </div>
        )}
        {!links ? (
          <div className="mt-1 flex flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100">
            <CopyMessage text={shown} />
            {canEdit ? (
              <>
                <button type="button" title={t("ویرایش و ارسال دوباره")} onClick={() => setEditing(text)} className="press rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="size-3.5" /></button>
                <button type="button" title={t("برگشت به اینجا (حذف ادامه)")} onClick={rewind} className="press rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><RotateCcw className="size-3.5" /></button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {ownerNote ? <span className="mt-1 text-[11px] text-muted-foreground">{t("یادداشت شما — به {name} نمی‌رسد", { name: motherName(chat) })}</span> : null}
      {custom?.imageIds?.length ? <SentImages ids={custom.imageIds} /> : custom?.images ? <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><ImagePlus className="size-3" /> {t("{n} تصویر", { n: num(custom.images) })}</span> : null}
      {custom?.files?.length ? <SentFiles files={custom.files} /> : null}
      {label ? <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><ListTodo className="size-3" /> {label}</span> : null}
      {custom?.sendState ? <SendState state={custom.sendState} clientId={custom.clientId} /> : null}
      {rewindOpen ? <RewindDialog chatId={chatId} eventId={eventId} busy={busy} onRun={act} onClose={() => setRewindOpen(false)} /> : null}
      {/* Zero height: shown on hover under the bubble without moving the thread. items-start: it hangs
          below the line above (centred on a zero-height row it rose over the label/time above it). On a
          touch screen, where it always shows, it takes its height, so a wrapped line never overlaps. */}
      <span className="mt-1 flex h-0 flex-wrap items-start gap-x-3 gap-y-1 overflow-visible whitespace-nowrap leading-4 pointer-coarse:h-auto">
        <MessageTime at={createdAt} />
        {links ? <CopyMessage text={shown} labeled /> : null}
        {canEdit && links ? (
          <>
            <button type="button" onClick={rewind} disabled={busy} title={t("گفتگو از اینجا به بعد پاک می‌شود")} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
              <RotateCcw className="size-3" /> {t("برگشت به اینجا")}
            </button>
            <button type="button" onClick={() => setEditing(text)} title={t("ویرایش و ارسال دوباره")} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
              <Pencil className="size-3" /> {t("ویرایش")}
            </button>
          </>
        ) : null}
      </span>
    </MessagePrimitive.Root>
  );
}

// Copy a message the owner (or a colleague) sent, as it reads in the bubble.
function CopyMessage({ text, labeled = false }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => toast.error(t("کپی نشد")));
  const Icon = copied ? Check : Copy;
  return labeled ? (
    <button type="button" onClick={copy} title={t("کپی پیام")} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
      <Icon className="size-3" /> {copied ? t("کپی شد") : t("کپی")}
    </button>
  ) : (
    <button type="button" onClick={copy} title={t("کپی پیام")} className="press rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
      <Icon className={`size-3.5 ${copied ? "text-ok" : ""}`} />
    </button>
  );
}

// A message still on its way (outbox.js): its state, and on a failure «ارسال دوباره» / «ویرایش».
function SendState({ state, clientId }) {
  const karsara = useLook() === "karsara";
  if (state === "failed" && karsara) {
    return (
      <span className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <span className="flex items-center gap-1 text-bad"><AlertCircle className="size-3.5" /> {FAILED_LABEL}</span>
        <button type="button" onClick={() => retrySend(clientId)} className="g-btn inline-flex min-h-9 items-center gap-1 rounded-lg border px-3 py-1 text-xs hover:bg-muted">
          <RotateCcw className="size-3.5" /> {t("ارسال دوباره")}
        </button>
        <button type="button" onClick={() => editSend(clientId)} className="min-h-9 px-2 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">{t("ویرایش")}</button>
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="mt-1 flex items-center gap-2 text-xs text-bad">
        {FAILED_LABEL}
        <button type="button" onClick={() => retrySend(clientId)} className="press rounded-md px-1.5 py-0.5 underline hover:bg-bad/10">{t("ارسال دوباره")}</button>
        <button type="button" onClick={() => editSend(clientId)} className="press rounded-md px-1.5 py-0.5 text-muted-foreground underline hover:bg-muted">{t("ویرایش")}</button>
      </span>
    );
  }
  return (
    <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
      {state === "sending" ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} {state === "sending" ? SENDING_LABEL : SENT_LABEL}
    </span>
  );
}

function AssistantMessage() {
  const { readOnly } = useContext(ChatContext);
  const run = useAuiState((s) => s.message.metadata?.custom?.run);
  const { work, answer } = useMemo(() => {
    const split = splitRun(run?.parts || []);
    // Chapter dividers sit among the answer parts in the run's order; suggestion cards close it.
    return { work: split.work, answer: answerItems(run?.parts, split.answer, split.other) };
  }, [run]);
  if (!run) return null;
  const running = run.status === "running";
  const textStatus = (part) => ({ type: running && part === run.parts.at(-1) ? "running" : "complete" });
  return (
    <MessagePrimitive.Root className="msg-in group my-3">
      <WorkLog
        run={run}
        parts={work}
        renderText={(part) => <MarkdownText text={part.text} status={textStatus(part)} compact />}
        renderReasoning={(part) => <Reasoning text={part.text} status={{ type: running && !part.done ? "running" : "complete" }} />}
      />
      {answer.map((part, i) =>
        part.type === "tool" ? (
          <ToolCard key={part.callId || i} {...toolProps(part)} />
        ) : part.type === "suggestion" ? (
          <SuggestionCard key={`s${part.id || i}`} part={part} readOnly={readOnly} />
        ) : part.type === "chapter" ? (
          <ChapterDivider key={`c${i}`} id={chapterAnchor(run.id, run.parts.indexOf(part))} part={part} />
        ) : isNoReply(part.text) ? (
          <p key={`t${i}`} className="text-sm text-muted-foreground">{t("💬 جوابی لازم نبود")}</p>
        ) : (
          <MarkdownText key={`t${i}`} text={part.text} status={textStatus(part)} />
        ),
      )}
      {/* Continued under the owner's message (a later piece of the same run): one footer, at its end. */}
      {run.continued ? null : <RunFooter run={run} />}
      <KeptActions />
    </MessagePrimitive.Root>
  );
}

// Over the composer: the chapter list and this chat's open suggestions (each hidden while empty).
function ThreadTools() {
  const { chatId, chapters } = useRuntimeChat();
  return (
    <div className="absolute -top-10 start-3 flex items-center gap-2">
      <ChapterToc chapters={chapters} />
      <ChatSuggestions chatId={chatId} />
    </div>
  );
}

// Under a run that failed: «دوباره» (the kept message again, else go on from where it stopped),
// «حل شد» (no longer an error: runStatus "resolved" until the next run), «بستن» (archive). Shown for
// a kept message (under its run) and for the chat's last run when that ended in an error.
// The chat is the thread's own (ChatContext): a side chat's panel sits outside App's ChatRecord, so
// only the failed-last-run case (its runStatus) and «بستن» need the record. A sub-agent's read-only
// thread gets the bar too (no other way out of «خطا»); a shared page has no chat id.
function keptBar({ chatId, record, kept, lastFailed }) {
  const id = chatId || record?.id || null;
  const chat = record && record.id === id ? record : null;
  if (!id || (!kept && !(lastFailed && chat?.runStatus === "error"))) return null;
  // «بستن» archives a sidebar row; a side, sub-agent, mother or global chat has none.
  return { id, closable: Boolean(chat) && !chat.mother && !chat.global && !chat.parentChatId && !chat.sideOf };
}

function KeptActions() {
  const custom = useAuiState((s) => s.message.metadata?.custom);
  const { chatId } = useContext(ChatContext);
  const record = useContext(ChatRecord);
  const [busy, setBusy] = useState(false);
  const karsara = useLook() === "karsara";
  const kept = Boolean(custom?.onRetry);
  const bar = keptBar({ chatId, record, kept, lastFailed: Boolean(custom?.last) && custom?.run?.status === "error" });
  if (!bar) return null;
  const { id, closable } = bar;
  const act = async (fn, done) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast.success(done);
    } catch (error) {
      toast.error(error.status === 409 ? t("هنوز در حال کار است") : error.message || t("انجام نشد"));
    } finally {
      setBusy(false);
    }
  };
  // custom.onRetry already reports its own error to the chat (runtime.jsx onError).
  const retry = () => act(kept ? custom.onRetry : () => api(`/api/chats/${id}/retry`, { method: "POST" }));
  const resolve = () => act(() => api(`/api/chats/${id}/resolve`, { method: "POST" }), t("حل شد"));
  const close = () =>
    act(async () => {
      await api(`/api/chats/${id}`, { method: "PATCH", body: { archived: true } });
      navigate(null);
    }, t("بسته شد"));
  const line = kept ? t("ایجنت جوابی نداد؛ پیامت نگه داشته شد.") : t("این کار با خطا تمام شد.");
  if (karsara) {
    return (
      <div className="g-box mt-2 flex flex-wrap items-center gap-3 rounded-xl border bg-card px-3 py-2 text-sm" dir={isRtl ? "rtl" : "ltr"}>
        <span className="text-bad">{line}</span>
        <button type="button" disabled={busy} onClick={retry} className="g-btn inline-flex min-h-11 min-w-28 items-center justify-center gap-1.5 rounded-lg border px-3 hover:bg-muted disabled:opacity-50">
          <RotateCcw className="size-4" /> {t("دوباره")}
        </button>
        <button type="button" disabled={busy} onClick={resolve} className="g-btn inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 hover:bg-muted disabled:opacity-50">
          <Check className="size-4" /> {t("حل شد")}
        </button>
        {closable ? (
          <button type="button" disabled={busy} onClick={close} className="inline-flex min-h-11 items-center gap-1.5 px-3 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-60">
            <Archive className="size-4" /> {t("بستن")}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="text-bad">{line}</span>
      <button type="button" disabled={busy} onClick={retry} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 hover:bg-muted disabled:opacity-50">
        <RotateCcw className="size-3" /> {t("دوباره")}
      </button>
      <button type="button" disabled={busy} onClick={resolve} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 hover:bg-muted disabled:opacity-50">
        <Check className="size-3" /> {t("حل شد")}
      </button>
      {closable ? (
        <button type="button" disabled={busy} onClick={close} className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 hover:bg-muted disabled:opacity-50">
          <Archive className="size-3" /> {t("بستن")}
        </button>
      ) : null}
    </div>
  );
}

function MarkdownText({ text, status, compact = false }) {
  const dir = chatDir(text);
  return (
    <div className={`sd-block ${compact ? "leading-7" : "g-answer leading-8"} [&_pre]:my-2`} dir={dir}>
      <Streamdown dir={dir} BlockComponent={DirBlock} plugins={plugins} controls={controls} isAnimating={status?.type === "running"} shikiTheme={["github-light", "github-dark"]}>
        {text}
      </Streamdown>
    </div>
  );
}

function Reasoning({ text, status }) {
  const [open, setOpen] = useState(false);
  const running = status?.type === "running";
  const dir = chatDir(text);
  return (
    <div className="my-1.5">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <Brain className="size-4" />
        <span className={running ? "agent-pulse" : ""}>{running ? t("در حال فکر کردن") : t("فکر کرد")}</span>
        <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open || running ? (
        <div
          dir={dir}
          className={`chat-text mt-1.5 whitespace-pre-wrap border-s-2 ps-3 text-sm leading-7 text-muted-foreground ${running && !open ? "line-clamp-3" : ""}`}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

function compactTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function RunFooter({ run }) {
  const { chatId } = useContext(ChatContext);
  const [why, setWhy] = useState(false);
  const karsara = useFlag("runFooterDetailed"); // «زیر جواب: مدت، مدل و توکن»
  if (!run) return null;
  const copyable = run.status !== "running";
  // «چرا؟» once the reply is done; a shared page has no chat id (and no session to ask with).
  const explainable = Boolean(chatId && run.runId && run.status !== "running");
  const seconds = run.endedAt && run.startedAt ? Math.max(1, Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 1000)) : null;
  const model = run.model && run.status !== "running" ? run.model : null;
  const done = run.status !== "running";
  const moved = fallbackLabel(run);
  const answeredAt = done && run.endedAt ? formatAnsweredAt(run.endedAt) : null;
  const actions = copyable ? (
    <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex items-center">
      <ActionBarPrimitive.Copy
        className="g-icon-btn rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={t("کپی پاسخ")}
      >
        <MessagePrimitive.If copied><Check className="size-3.5 text-ok" /></MessagePrimitive.If>
        <MessagePrimitive.If copied={false}><Copy className="size-3.5" /></MessagePrimitive.If>
      </ActionBarPrimitive.Copy>
      {explainable ? <WhyButton open={why} onToggle={() => setWhy(!why)} /> : null}
      <ForkButton run={run} />
    </ActionBarPrimitive.Root>
  ) : null;

  // Karsara skin: plain muted text and a ring, no pills; Karsara's footer — the run's length, model,
  // «۳.۶M توکن», then the elapsed time (MessageTime), no clock time in the meta.
  if (karsara) {
    const kTokens = done ? answerTokens(run.usage) : null;
    return (
      <>
      {moved ? <div className="mt-2 text-xs text-muted-foreground" dir="auto">{moved}</div> : null}
      <div className="mt-2 flex min-h-7 flex-wrap items-center gap-2">
        {run.status === "running" ? <RunPhase run={run} /> : null}
        {run.status === "error" ? <span className="text-xs text-bad" dir="auto">{run.error || t("خطا")}</span> : null}
        {run.status === "cancelled" ? <span className="text-xs text-muted-foreground" dir="auto">{run.error || t("متوقف شد")}</span> : null}
        {done && (seconds || model || kTokens) ? (
          <div className="g-run-meta flex items-center gap-1.5 text-xs text-muted-foreground">
            {seconds ? (
              <span className="inline-flex items-center gap-1" title={formatDuration(seconds)}>
                <Clock className="size-3 opacity-70" />
                <span>{formatDuration(seconds, { compact: true })}</span>
              </span>
            ) : null}
            {seconds && model ? <span className="text-border">·</span> : null}
            {model ? <span className="max-w-40 truncate" title={model} dir="ltr">{model}</span> : null}
            {kTokens && (seconds || model) ? <span className="text-border">·</span> : null}
            {kTokens ? <span title={kTokens.title}>{kTokens.label}</span> : null}
          </div>
        ) : null}
        {done ? <MessageTime at={run.endedAt || run.startedAt} /> : null}
        {actions}
        {explainable && !why ? <WhyFlag count={run.manifestChanges} onClick={() => setWhy(true)} /> : null}
      </div>
      {explainable && why ? <WhyPanel chatId={chatId} runId={run.runId} /> : null}
      </>
    );
  }

  return (
    <>
    {moved ? <div className="mt-2 text-xs text-muted-foreground" dir="auto">{moved}</div> : null}
    <div className="mt-2 flex min-h-7 flex-wrap items-center gap-2">
      {run.status === "running" ? <RunPhase run={run} /> : null}
      {run.status === "error" ? (
        <span className="rounded-md bg-bad/10 px-2 py-0.5 text-xs text-bad" dir="auto">{run.error || t("خطا")}</span>
      ) : null}
      {run.status === "cancelled" ? (
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground" dir="auto">
          {run.error || t("متوقف شد")}
        </span>
      ) : null}

      {/* One quiet line, like Claude's: clock and model; duration and tokens on hover. */}
      {done && (answeredAt || model) ? (
        <span
          className="g-run-meta text-xs text-muted-foreground/80"
          title={[
            seconds && t("طول کشید: {duration}", { duration: formatDuration(seconds) }),
            run.usage && t("{tokens} توکن (ورودی {input} · خروجی {output})", { tokens: compactTokens(run.usage.input + run.usage.output), input: num(run.usage.input), output: num(run.usage.output) }),
          ].filter(Boolean).join(" · ") || undefined}
        >
          {[answeredAt, model].filter(Boolean).join(" · ")}
        </span>
      ) : null}
      {actions}
      {explainable && !why ? <WhyFlag count={run.manifestChanges} onClick={() => setWhy(true)} /> : null}
    </div>
    {explainable && why ? <WhyPanel chatId={chatId} runId={run.runId} /> : null}
    </>
  );
}

// What the running turn is doing (run-phase.js): a retry or a closed limit in words. The shared
// clock lets a retry label expire.
function RunPhase({ run }) {
  const karsara = useLook() === "karsara";
  useSyncExternalStore(subscribeClock, () => tickClock.tick, () => 0);
  const label = phaseLabel(run.phase, run.phaseDetail, { at: run.phaseAt, now: Date.now() });
  if (karsara) {
    return (
      <span className="g-run-phase inline-flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-block size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/35 border-t-primary" aria-hidden />
        {label}
      </span>
    );
  }
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      className="g-run-phase inline-flex items-center gap-2 rounded-full border border-signal/25 bg-signal/10 px-2.5 py-1 text-xs text-signal"
    >
      <span className="agent-dots" aria-hidden>
        <i /><i /><i />
      </span>
      <span className="agent-pulse">{label}</span>
    </motion.span>
  );
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// Voice dictation: one tap records, the next stops; the clip goes to
// /api/transcribe and the text joins what is in the box. It never sends the message. Hidden where
// the browser cannot record (no microphone API, or a page not served over https), and until the
// install has speech to text set up (a colleague 2026-10-24: he spoke 30 seconds into an unset one
// and got «502»). A setup the service refused (bad key or model) shows a crossed microphone that
// says why instead of recording.
const stt = { status: null, listeners: new Set(), asked: false };
export const STT_EVENT = "griffin:stt";
function loadStt() {
  stt.asked = true;
  return api("/api/stt").then(
    (s) => {
      stt.status = { configured: Boolean(s.configured), broken: s.broken || null };
      for (const listener of stt.listeners) listener();
    },
    () => {},
  );
}
function subscribeStt(onChange) {
  stt.listeners.add(onChange);
  if (!stt.asked) loadStt();
  return () => stt.listeners.delete(onChange);
}
if (typeof window !== "undefined") window.addEventListener(STT_EVENT, () => loadStt());
function DictateButton({ value, setText, focus, size, className = "mb-1" }) {
  const sttStatus = useSyncExternalStore(subscribeStt, () => stt.status, () => null);
  const [state, setState] = useState("idle"); // idle | recording | working
  // A recording or its transcription in progress holds a new version's reload off.
  const busy = state !== "idle";
  useEffect(() => (busy ? holdReload() : undefined), [busy]);
  const [elapsed, setElapsed] = useState(0);
  const latest = useRef(value);
  latest.current = value;
  const session = useRef(null); // { recorder, stream, timer }
  const starting = useRef(false); // between the tap and the microphone answering
  const mounted = useRef(true);
  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof window.MediaRecorder === "function";
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const s = session.current;
      if (!s) return;
      clearInterval(s.timer);
      s.recorder.onstop = null;
      try {
        s.recorder.stop();
      } catch {
        /* already stopped */
      }
      s.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);
  if (!supported || !sttStatus?.configured) return null;

  const finish = async (chunks, mime) => {
    if (!mounted.current) return;
    const recorded = new Blob(chunks, { type: mime || chunks[0]?.type || "audio/webm" });
    if (!recorded.size) return setState("idle");
    setState("working");
    try {
      const blob = await toWav(recorded);
      const res = await fetch("/api/transcribe", { method: "POST", credentials: "same-origin", headers: { "content-type": blob.type }, body: blob });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `http ${res.status}`);
      if (!res.ok) loadStt(); // a refused key or model shows on the microphone from now on
      if (!mounted.current) return;
      if (body.text) setText(joinDictation(latest.current, body.text));
      else toast(t("چیزی شنیده نشد."));
      focus?.();
    } catch (error) {
      toast.error(t("تبدیل گفتار به متن انجام نشد: {error}", { error: t(error.message) }));
    } finally {
      if (mounted.current) setState("idle");
    }
  };
  const stop = () => {
    const s = session.current;
    if (!s) return;
    clearInterval(s.timer);
    try {
      s.recorder.stop();
    } catch {
      /* already stopped */
    }
  };
  const openSttSettings = () => {
    writeSetting("griffin.settings.section", "chat");
    window.location.hash = "/settings";
  };
  const start = async () => {
    if (sttStatus.broken) {
      loadStt(); // fixed meanwhile in Settings: the next tap records
      return toast.error(sttStatus.broken.error, { action: { label: t("تنظیمات"), onClick: openSttSettings } });
    }
    // One recording at a time: a second tap while the browser asks for the microphone must not
    // open a second stream that nothing would ever close.
    if (starting.current || session.current) return undefined;
    starting.current = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      starting.current = false;
      return toast.error(t("به میکروفون دسترسی داده نشد."));
    }
    starting.current = false;
    if (!mounted.current) {
      stream.getTracks().forEach((track) => track.stop());
      return undefined;
    }
    const mime = pickAudioMime((m) => window.MediaRecorder.isTypeSupported?.(m));
    const recorder = new window.MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = (event) => event.data?.size && chunks.push(event.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      session.current = null;
      finish(chunks, recorder.mimeType || mime);
    };
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const ms = Date.now() - startedAt;
      setElapsed(ms);
      if (ms >= MAX_RECORD_MS) stop();
    }, 500);
    session.current = { recorder, stream, timer };
    setElapsed(0);
    setState("recording");
    recorder.start();
  };
  const btn = `g-icon-btn ${className} shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground`;
  if (state === "working") {
    return <span className={btn} title={t("در حال تبدیل گفتار به متن")} aria-live="polite"><Loader2 className={`${size} animate-spin`} /></span>;
  }
  if (state === "recording") {
    return (
      <button type="button" onClick={stop} className={`${className} flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 text-xs`} title={t("پایان ضبط و نوشتن متن")} aria-label={t("پایان ضبط")}>
        <span className="size-2 animate-pulse rounded-full bg-red-500" aria-hidden /> {recordClock(elapsed, locale)}
      </button>
    );
  }
  if (sttStatus.broken) {
    return (
      <button type="button" onClick={start} className={`${btn} text-warn`} title={sttStatus.broken.error} aria-label={t("تبدیل صدا به متن تنظیم درست ندارد")}>
        <MicOff className={size} />
      </button>
    );
  }
  return (
    <button type="button" onClick={start} className={btn} title={t("گفتن به‌جای نوشتن")} aria-label={t("ضبط صدا برای نوشتن پیام")}>
      <Mic className={size} />
    </button>
  );
}

// compact (the side panel under the Karsara skin): no chips row, no toolbar, no «بعداً».
function Composer({ agentLabel, variant = "dock", mode = "agent", model = "", agent = "griffin", onModeChange, onModelChange, effort, onEffortChange, top = null, compact = false, placeholder: own = "" }) {
  const running = useAuiState((s) => s.thread.isRunning);
  const hero = variant === "hero";
  const touch = useTouchPrimary();
  // The look draws the box (Karsara's: flat, the microphone inside, a square send); the flags pick its
  // pieces (ui-prefs.js «کادر پیام»).
  const karsara = useLook() === "karsara";
  const { flags } = useUiPrefs();
  const inputRef = useRef(null);
  const rootRef = useRef(null);
  const aui = useAui();
  const { value: composerText, setText } = unstable_useComposerInput();
  // The suggested next message: a row above the input, or ghost text in the empty box (Karsara skin).
  const next = useNextStep();
  // What was being typed in this chat comes back after a reload or a look at another chat
  // (draft.js). The composer is mounted once per chat, so this runs once per chat.
  const { boxId: chatId, sendQuotes, settings: runSettings } = useRuntimeChat();
  // What a note for later starts a new chat with: this composer's choices (notes.js noteBody).
  const laterOptions = { repo: runSettings?.repo ?? undefined, model: runSettings?.model, agent: runSettings?.agent, mode: runSettings?.mode, effort: runSettings?.effort, groupId: runSettings?.groupId || undefined };
  const boxText = useRef(composerText);
  boxText.current = composerText;
  // A message that did not reach the server returns to this box, above what was typed since.
  useEffect(() => {
    const onRestore = (event) => {
      const detail = event.detail || {};
      if (detail.handled || detail.chatId !== chatId || !detail.text) return;
      detail.handled = true;
      setText([detail.text, boxText.current].filter((t) => t?.trim()).join("\n"));
    };
    window.addEventListener(RESTORE_EVENT, onRestore);
    return () => window.removeEventListener(RESTORE_EVENT, onRestore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);
  // Quotes added with «به گفتگو» wait folded above the input and join the message when it is sent.
  const quotes = useSyncExternalStore(quoteStore.subscribe, () => quoteStore.get(chatId));
  const quotesOnly = quotes.length > 0 && !composerText.trim();
  // Attached pictures and files live only in this page: a new version waits for them to be sent or removed.
  const hasAttached = useAuiState((s) => (s.composer.attachments?.length || 0) > 0);
  useEffect(() => (hasAttached ? holdReload() : undefined), [hasAttached]);
  // A file the adapter refused (empty, over 10 MB, a type the server does not take): say why —
  // assistant-ui swallows the error from paste, drop and the add button.
  useAuiEvent("composer.attachmentAddError", (event) =>
    toast.error(event?.reason === "not-accepted" ? t("این فایل پیوست نمی‌شود.") : event?.message || t("این فایل افزوده نشد.")),
  );
  // More than a message may carry: the newest extras leave at once, with the reason, so a send
  // never fails on the count (and the composer never loses what it already had).
  const attachedItems = useAuiState((s) => s.composer.attachments);
  useEffect(() => {
    const extra = overLimit(attachedItems || []);
    if (!extra.length) return;
    const files = (attachedItems || []).filter((a) => !isImageAttachment(a));
    const images = (attachedItems || []).filter((a) => isImageAttachment(a));
    // One toast however many times the effect fires before the removals land (a drop of many files).
    toast.error(countProblem({ files, images }) || t("بیش از سقف یک پیام"), { id: "attach-over-limit" });
    for (const id of extra) {
      try {
        Promise.resolve(aui.composer().attachment({ id }).remove()).catch(() => {});
      } catch {
        /* a composer that is gone has nothing to remove */
      }
    }
  }, [attachedItems, aui]);
  // Files dragged onto the chat (anywhere in it, not only the box) are attached like the add button
  // does; the adapters refuse what the server would refuse, with the reason as a toast.
  useEffect(() => {
    const zone = rootRef.current?.closest("[data-griffin-chat]");
    if (!zone) return undefined;
    let depth = 0;
    const show = (on) => zone.toggleAttribute("data-drop", on);
    const onEnter = (event) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth += 1;
      show(true);
    };
    const onOver = (event) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (event) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) show(false);
    };
    const onDrop = (event) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth = 0;
      show(false);
      for (const file of Array.from(event.dataTransfer.files || [])) {
        Promise.resolve(aui.composer().addAttachment(file)).catch(() => {});
      }
      inputRef.current?.focus();
    };
    zone.addEventListener("dragenter", onEnter);
    zone.addEventListener("dragover", onOver);
    zone.addEventListener("dragleave", onLeave);
    zone.addEventListener("drop", onDrop);
    return () => {
      zone.removeEventListener("dragenter", onEnter);
      zone.removeEventListener("dragover", onOver);
      zone.removeEventListener("dragleave", onLeave);
      zone.removeEventListener("drop", onDrop);
      show(false);
    };
  }, [aui]);
  const draftSkip = useRef(true);
  useEffect(() => {
    const draft = loadDraft(browserStorage(), chatId);
    if (draft && !composerText) setText(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // The first pass sees the still-empty box: it must not erase the draft being restored.
    if (draftSkip.current) {
      draftSkip.current = false;
      return;
    }
    saveDraft(browserStorage(), chatId, composerText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerText]);
  // Esc anywhere in this thread stops the running turn, as the stop button does.
  // The box itself is assistant-ui's (cancelOnEscape); an open dialog, menu or the «/» list, or a
  // focused field, keeps its own Esc (keys.js). A side chat stops only for an Esc inside it.
  const escRunning = useRef(running);
  escRunning.current = running;
  useEffect(() => {
    const onKey = (event) => {
      const root = rootRef.current;
      const thread = root?.closest("[data-griffin-thread]");
      const target = event.target instanceof Element ? event.target : null;
      const inside = Boolean(target && thread?.contains(target));
      const loose = !target || target === document.body;
      if (!inside && !(loose && !root?.closest(".side-panel"))) return;
      const layerOpen = Boolean(document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'));
      if (!escCancels(event, { running: escRunning.current, layerOpen })) return;
      event.preventDefault();
      aui.composer.cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [aui]);
  const focusInput = () => inputRef.current?.focus();
  // A queued message taken back with "edit" (QueuePeek): above what is in the box, like a restore.
  const takeBack = (text) => {
    setText([text, boxText.current].filter((s) => s?.trim()).join("\n"));
    focusInput();
  };
  // Only quotes in the box (a reply with nothing typed): the composer itself cannot send an empty
  // box, so Enter (Ctrl+Enter on a phone) sends them here; Ctrl/⌘+Shift+Enter sends them «فوری».
  const onInputKey = (event) => {
    if (event.key !== "Enter" || event.nativeEvent?.isComposing || !quotesOnly || hasAttached) return;
    const force = event.shiftKey && (event.ctrlKey || event.metaKey);
    if (!force && (event.shiftKey || (submitMode(touch) === "ctrlEnter" && !(event.ctrlKey || event.metaKey)))) return;
    event.preventDefault();
    sendQuotes(force && running);
  };
  // «فوری» while the agent works: this message reaches it now instead of waiting in the queue.
  const canForce = running && (composerText.trim() || hasAttached || quotes.length > 0);
  const forceSend = () => {
    if (quotesOnly && !hasAttached) sendQuotes(true);
    else aui.composer.send({ steer: true });
    focusInput();
  };
  const forceButton = canForce ? (
    <button
      type="button"
      onClick={forceSend}
      className={`g-force flex shrink-0 items-center justify-center gap-1 text-primary hover:bg-primary/10 ${karsara ? "h-8 rounded-md px-2 text-xs" : "h-9 rounded-full px-2.5 text-xs"}`}
      title={touch ? t("فوری: همین حالا وسط کار به ایجنت برسد، نه بعد از آن") : `${t("فوری: همین حالا وسط کار به ایجنت برسد، نه بعد از آن")} (Ctrl+Shift+Enter)`}
      aria-label={t("ارسال فوری")}
    >
      <Zap className="size-4" />
      <span>{t("فوری")}</span>
    </button>
  ) : null;
  // A Telegram chat says who the box reaches (App.jsx): only the assistant, never the colleague.
  const placeholder = flags.nextGhost && next
    ? ""
    : own
    ? own
    : karsara
    ? running ? t("پیام بده تا وسط کار به ایجنت برسد…") : t("کاری را شرح دهید یا سؤالی بپرسید")
    : running ? (hero ? t("پیام بده تا وسط کار برسد…") : t("پیام بده تا وسط کار به ایجنت برسد…")) : t("از {agent} بپرس…", { agent: agentLabel });
  const input = (
    <ComposerPrimitive.Input
      ref={inputRef}
      data-reload-safe=""
      rows={1}
      // A phone opens its keyboard on any focus: there the box waits for a tap (also on thread
      // switch, run start and scroll-to-bottom, which the library ties to autoFocus).
      autoFocus={!touch}
      dir={composerText.trim() ? chatDir(composerText) : isRtl ? "rtl" : "ltr"}
      submitMode={submitMode(touch)}
      onKeyDown={onInputKey}
      aria-label={t("پیام به {agent}", { agent: agentLabel })}
      placeholder={placeholder}
      className={`scrollbar-thin relative z-[1] min-w-0 resize-none bg-transparent outline-none placeholder:text-muted-foreground ${
        karsara
          ? `max-h-[70dvh] px-1.5 py-2 text-start text-[15px] leading-7 ${hero ? "min-h-16" : "min-h-10"}`
          : `max-h-[70dvh] min-h-10 flex-1 px-1 py-2 text-start ${hero ? "text-sm leading-6" : "leading-7"}`
      }`}
    />
  );
  const runAccount = useRunAccount(model, agent);
  // «پیشنهاد پیام بعدی داخل کادر»: the suggestion as ghost text in the empty box (Tab takes it).
  const ghost = flags.nextGhost && next ? (
    <div className="pointer-events-none max-h-28 overflow-hidden px-1.5 py-2 text-start text-[15px] leading-7 text-muted-foreground [overflow-wrap:anywhere]" dir={chatDir(next)}>
      <span>{next}</span>
      <button
        type="button"
        onClick={() => {
          setText(next);
          focusInput();
        }}
        className="pointer-events-auto ms-2 whitespace-nowrap rounded-md border px-1.5 align-middle text-[11px] leading-5 hover:border-primary hover:text-foreground pointer-coarse:px-2.5 pointer-coarse:text-xs pointer-coarse:leading-6"
        aria-label={t("نوشتن پیشنهاد در کادر: {text}", { text: next })}
        title={t("پیشنهاد را در کادر می‌نویسد؛ فرستاده نمی‌شود")}
      >
        {touch ? t("پذیرفتن") : "Tab"}
      </button>
    </div>
  ) : null;
  // «بعداً» (flag laterButton): the send button's own menu — right-click, or hold on a phone — keeps the
  // text as a note for later (not in the side panel, not while running).
  const laterOn = flags.laterButton && !compact && !running;
  const laterHint = laterOn ? (touch ? t(" · نگه دارید: بعداً") : t(" · راست‌کلیک: بعداً")) : "";
  const withLater = (send) =>
    laterOn ? (
      <SendLater
        text={composerText}
        chatId={chatId}
        options={laterOptions}
        disabled={hasAttached || quotes.length > 0}
        disabledTitle={t("یادداشت فقط متن نگه می‌دارد؛ پیوست و نقل‌قول را بردارید")}
        onSaved={() => {
          setText("");
          saveDraft(browserStorage(), chatId, "");
        }}
      >
        {send}
      </SendLater>
    ) : (
      send
    );
  // «هشدار موتور غیر Claude»: Karsara's line under the box when the chat runs on anything but its plain Claude login.
  const nonClaude = flags.nonClaudeHint && runAccount && runAccount.split("-")[0] !== "claude" ? <div className="kc-note px-3 pb-2">{t("ابزارها و تصویر ممکن است کامل کار نکنند")}</div> : null;
  // «حالت سریع کنار مدل» / «حلقهٔ مصرف»: readouts at the end of the bar under the box (the
  // server-resources gauge that sat here is gone: its alerts are at the bottom of the sidebar).
  const barEnd = (
    <>
      {flags.fastChip ? <FastToggle /> : null}
      {flags.composerStats ? <UsageRing chatId={chatId} running={running} /> : null}
    </>
  );
  const fastInMenu = flags.fastChip ? null : <FastSwitch />;
  if (karsara) {
    return (
      <div ref={rootRef} className="min-w-0">
        {compact ? null : top}
        {flags.scheduledPeek ? <ScheduledPeek chatId={chatId} /> : null}
        {/* Even in the side panel: a waiting message is not in its thread. */}
        <QueuePeek chatId={chatId} onEdit={takeBack} />
        <TasksPeek chatId={chatId} />
        <ComposerPrimitive.Root className="composer-box g-composer relative z-[1] rounded-xl border bg-card focus-within:border-primary/60">
          {quotes.length ? (
            <div className="flex flex-col gap-1 px-2 pt-2">
              {quotes.map((q) => (
                <QuoteChip key={q.id} chatId={chatId} quote={q} onDone={focusInput} />
              ))}
            </div>
          ) : null}
          <ComposerAssist inputRef={inputRef} next={next} />
      <MentionBackdrop inputRef={inputRef} />
          <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} />
          <div className="flex items-end gap-1 px-2 py-1.5">
            {/* The input and the ghost suggestion share one grid cell. */}
            <div className="grid min-w-0 flex-1 [&>*]:min-w-0 [&>*]:[grid-area:1/1]" onClick={(event) => event.target === event.currentTarget && focusInput()}>
              {input}
              {ghost}
            </div>
            <DictateButton value={composerText} setText={setText} focus={focusInput} size="size-5" />
            {forceButton}
            {running ? (
              <ComposerPrimitive.Cancel className={KC_SEND} data-stop="" title={t("توقف")}>
                <Square className="size-3.5 fill-current" />
              </ComposerPrimitive.Cancel>
            ) : quotesOnly ? (
              <button type="button" onClick={sendQuotes} className={KC_SEND} title={t("ارسال نقل‌قول‌ها")} aria-label={t("ارسال")}>
                <CornerDownLeft className="size-4" />
              </button>
            ) : (
              withLater(
                <ComposerPrimitive.Send className={KC_SEND} title={`${touch ? t("ارسال") : t("ارسال (Enter)")}${laterHint}`}>
                  <CornerDownLeft className="size-4" />
                </ComposerPrimitive.Send>,
              )
            )}
          </div>
          {nonClaude}
        </ComposerPrimitive.Root>
        {compact ? null : <div className="g-composer-bar mt-1 flex min-w-0 items-center gap-1">
          <ComposerPrimitive.AddAttachment className="g-icon-btn flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted" title={t("افزودن فایل یا تصویر")} aria-label={t("افزودن فایل یا تصویر")}>
            <Plus className="size-4" />
          </ComposerPrimitive.AddAttachment>
          {onModeChange ? <ModeToggle mode={mode} onChange={onModeChange} /> : null}
          <span className="flex-1" />
          {onModelChange ? <ModelPicker model={model} agent={agent} onChange={onModelChange} compact footer={fastInMenu} /> : null}
          {onEffortChange ? <EffortPicker effort={effort} model={model} agent={agent} onChange={onEffortChange} /> : null}
          {barEnd}
        </div>}
      </div>
    );
  }

  return (
    <>
    {top ? <div className={chatId && !hero && !flags.repoChipsAlways ? "g-repo-top" : undefined}>{top}</div> : null}
    {flags.scheduledPeek ? <ScheduledPeek chatId={chatId} /> : null}
    <QueuePeek chatId={chatId} onEdit={takeBack} />
    <TasksPeek chatId={chatId} />
    <ComposerPrimitive.Root ref={rootRef} className="composer-box g-composer relative z-[1] rounded-2xl border bg-card shadow-sm focus-within:border-primary/60">
      {quotes.length ? (
        <div className="flex flex-col gap-1 px-2 pt-2">
          {quotes.map((q) => (
            <QuoteChip key={q.id} chatId={chatId} quote={q} onDone={() => inputRef.current?.focus()} />
          ))}
        </div>
      ) : null}
      <ComposerAssist inputRef={inputRef} next={next} />
          <MentionBackdrop inputRef={inputRef} />
      <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} />
      <div className={`flex items-end gap-1 px-2 ${hero ? "py-1.5" : "pb-2 pt-2"}`}>
        {flags.nextGhost ? (
          <div className="grid min-w-0 flex-1 [&>*]:min-w-0 [&>*]:[grid-area:1/1]" onClick={(event) => event.target === event.currentTarget && focusInput()}>
            {input}
            {ghost}
          </div>
        ) : input}
        <div className="mb-0.5 flex shrink-0 items-center gap-1">
          {forceButton}
          {running ? (
            <ComposerPrimitive.Cancel data-stop="" className="g-send flex size-9 items-center justify-center rounded-full bg-foreground text-background" title={t("توقف")}>
              {hero ? (
                <span className="agent-dots agent-dots-on-dark" aria-hidden><i /><i /><i /></span>
              ) : (
                <Square className="size-3.5 fill-current" />
              )}
            </ComposerPrimitive.Cancel>
          ) : quotesOnly ? (
            <button type="button" onClick={sendQuotes} className="g-send flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground" title={t("ارسال نقل‌قول‌ها")}>
              <ArrowUp className="size-5" />
            </button>
          ) : (
            // Send is the one filled (accent) button while it can send; empty, it is plain like the
            // microphone.
            withLater(
              <ComposerPrimitive.Send className="g-send flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-50" title={`${t("ارسال")}${laterHint}`}>
                <ArrowUp className="size-5" />
              </ComposerPrimitive.Send>,
            )
          )}
        </div>
      </div>
      {running && !hero ? (
        <div className="flex items-center gap-2 px-3 pb-2 text-xs text-primary">
          <span className="agent-dots" aria-hidden><i /><i /><i /></span>
          {canForce ? t("«فوری» پیام را همین حالا وسط کار به ایجنت می‌رساند") : t("پیام جدید وسط کار ارسال می‌شود")}
        </div>
      ) : null}
      {nonClaude}
    </ComposerPrimitive.Root>
    {/* Under the box: +, microphone and mode; model and effort at the far end. The box keeps its width for text. */}
    <div className="g-composer-bar mt-1.5 flex min-w-0 flex-wrap items-center gap-0.5 px-1">
      <ComposerPrimitive.AddAttachment className="g-icon-btn flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" title={t("افزودن فایل یا تصویر")} aria-label={t("افزودن فایل یا تصویر")}>
        <Plus className="size-4" />
      </ComposerPrimitive.AddAttachment>
      <DictateButton value={composerText} setText={setText} focus={focusInput} size="size-4" className="" />
      {onModeChange ? <ModeToggle mode={mode} onChange={onModeChange} named={hero} /> : null}
      <span className="flex-1" />
      {onModelChange ? <ModelPicker model={model} agent={agent} onChange={onModelChange} compact footer={fastInMenu} /> : null}
      {onEffortChange ? <EffortPicker effort={effort} model={model} agent={agent} onChange={onEffortChange} /> : null}
      {barEnd}
    </div>
    </>
  );
}

// Karsara skin: a square send/stop the size of the icon buttons; its fill comes from the skin's
// g-send rule (accent only while it can send).
const KC_SEND = "g-send g-icon-btn flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground disabled:opacity-50";

function ComposerImage() {
  return (
    <AttachmentPrimitive.Root className="relative ms-3 mt-3 inline-block size-16 overflow-hidden rounded-lg border">
      <AttachmentThumb />
      <AttachmentPrimitive.Remove className="absolute end-0.5 top-0.5 rounded-full bg-background/80 p-0.5">
        <X className="size-3" />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

// A PDF or text file waiting in the composer: its name in a chip on the pictures' row, built like
// the picture thumbnail (border, remove button). A picture stays a thumbnail.
function ComposerAttachment() {
  const image = useAuiState((s) => isImageAttachment(s.attachment));
  const name = useAuiState((s) => s.attachment?.name || "");
  if (image) return <ComposerImage />;
  return (
    <AttachmentPrimitive.Root className="g-file-chip relative ms-3 mt-3 inline-flex h-9 max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-lg border px-2 text-xs" title={name}>
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate" dir="ltr">{name}</span>
      <AttachmentPrimitive.Remove className="shrink-0 rounded-full p-0.5 hover:bg-muted" aria-label={t("حذف این فایل")}>
        <X className="size-3" />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

// Under a message: the pictures it carried, as thumbnails that open full size in a new tab.
function SentImages({ ids }) {
  return (
    <span className="mt-1.5 flex max-w-[88%] flex-wrap gap-1.5">
      {ids.map((id) => (
        <a key={id} href={`/api/media/${id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border bg-muted/40">
          <img src={`/api/media/${id}`} alt={t("تصویر پیوست")} loading="lazy" className="max-h-56 max-w-full object-contain" />
        </a>
      ))}
    </span>
  );
}

// Under a message: the files it carried, by name and size; a stored one opens (or downloads) on click.
function SentFiles({ files }) {
  return (
    <span className="mt-1 flex max-w-full flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {files.map((file, i) => {
        const body = (
          <>
            <FileText className="size-3 shrink-0" />
            <span className="min-w-0 truncate" dir="ltr">{file.name}</span>
            {file.bytes ? <span className="shrink-0" dir="ltr">{formatBytes(file.bytes)}</span> : null}
          </>
        );
        return file.mediaId ? (
          <a key={`${file.name}-${i}`} href={`/api/media/${file.mediaId}`} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 underline-offset-2 hover:text-foreground hover:underline" title={file.name}>{body}</a>
        ) : (
          <span key={`${file.name}-${i}`} className="flex min-w-0 items-center gap-1" title={file.name}>{body}</span>
        );
      })}
    </span>
  );
}

function AttachmentThumb() {
  const image = useAuiState((s) => s.attachment?.content?.find?.((part) => part.type === "image")?.image ?? null);
  const file = useAuiState((s) => s.attachment?.file ?? null);
  const [fileUrl, setFileUrl] = useState(null);
  useEffect(() => {
    if (!file) return undefined;
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const src = image || fileUrl;
  return src ? <img src={src} alt="" className="size-full object-cover" /> : <div className="size-full bg-muted" />;
}

// «برگشت به اینجا» (from Karsara): the conversation, the files Claude Code's editing tools changed
// since that message, or both. The dialog first asks the server what would change (dryRun).
function RewindDialog({ chatId, eventId, busy, onRun, onClose }) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    let alive = true;
    api(`/api/chats/${chatId}/rewind`, { method: "POST", body: { eventId, dryRun: true } })
      .then((body) => alive && setPreview(body))
      .catch((error) => alive && setPreview({ error: error.message === "busy" ? t("این گفتگو در حال کار است؛ بعد از پایان کار دوباره امتحان کنید.") : error.message }));
    return () => {
      alive = false;
    };
  }, [chatId, eventId]);
  const choices = rewindChoices(preview);
  const choice = "press rounded-full border px-3.5 py-2 text-sm hover:bg-muted disabled:opacity-50";
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] overlay" />
        <Dialog.Content className="pop fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-5 text-sm shadow-2xl">
          <div className="mb-3 flex items-center">
            <Dialog.Title className="font-semibold">{t("برگشت به پیش از این پیام")}</Dialog.Title>
            <Dialog.Close className="press ms-auto rounded-full p-1.5 hover:bg-muted" aria-label={t("بستن")}><X className="size-4" /></Dialog.Close>
          </div>
          {preview?.error ? (
            <p className="leading-6 text-destructive" dir="auto">{preview.error}</p>
          ) : (
            <Dialog.Description asChild>
              <div className="space-y-2 leading-6 text-muted-foreground">
                <p>{t("این پیام و هرچه بعد از آن آمده از گفتگو پاک می‌شود.")}</p>
                <p>{filesLine(preview?.files)}</p>
                <p className="text-xs">{t("فقط تغییرهایی که با ابزار ویرایش فایل انجام شده برمی‌گردد. کاری که با دستور ترمینال، git یا روی سرورها شده سر جایش می‌ماند.")}</p>
              </div>
            </Dialog.Description>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {choices.both ? <button type="button" disabled={busy} onClick={() => onRun({})} className={`${choice} border-transparent bg-primary text-primary-foreground hover:bg-primary`}>{t("گفتگو و فایل‌ها")}</button> : null}
            {choices.conversation ? <button type="button" disabled={busy} onClick={() => onRun({ files: false })} className={choices.both ? choice : `${choice} border-transparent bg-primary text-primary-foreground hover:bg-primary`}>{choices.both ? t("فقط گفتگو") : t("برگشت گفتگو")}</button> : null}
            {choices.files ? <button type="button" disabled={busy} onClick={() => onRun({ conversation: false })} className={choice}>{t("فقط فایل‌ها")}</button> : null}
            <Dialog.Close className={choice}>{t("انصراف")}</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
