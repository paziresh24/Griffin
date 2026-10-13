import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActionBarPrimitive, AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, unstable_useComposerInput, useAui, useAuiState,
} from "@assistant-ui/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { motion } from "motion/react";
import {
  AlertCircle, Archive, ArrowDown, ArrowUp, Brain, Check, ChevronDown, Clock, Copy, CornerDownLeft, ImagePlus, ListTodo, Loader2, Mic, Pencil, Plus, Quote, RotateCcw, Square, X,
} from "lucide-react";
import { ToolCard } from "./Tool.jsx";
import { formatAnsweredAt, formatDuration, splitRun, toolProps, WorkLog } from "./Work.jsx";
import { textDir } from "../dir.js";
import { AgentGlyph, EffortPicker, ModeToggle, ModelPicker, loadDoctor } from "./Controls.jsx";
import { agentMeta } from "../brand.js";
import { pickSuggestions } from "../suggestions.js";
import { locale, num, t, isRtl } from "../i18n.js";
import { toast } from "sonner";
import { api, navigate, reloadTimeline } from "../api.js";
import { RESTORE_EVENT, editSend, retrySend, useRuntimeChat } from "../runtime.jsx";
import { FAILED_LABEL, SENDING_LABEL, SENT_LABEL } from "../outbox.js";
import { quoteStore } from "../quotes.js";
import { SelectionActions } from "./SelectionActions.jsx";
import { QuoteChip } from "./QuoteChip.jsx";
import { ChatRecord, ComposerAssist, FastSwitch, FastToggle, ForkButton, useNextStep } from "./ComposerAssist.jsx";
import { NoteRow, PersonAvatar, PersonName } from "./Telegram.jsx";
import { isNoReply, motherName, stripOwnerFrame, stripSender, userSide } from "../telegram.js";
import { submitMode, useTouchPrimary } from "../touch.js";
import { loadDraft, saveDraft } from "../draft.js";
import { MAX_RECORD_MS, joinDictation, pickAudioMime, recordClock, toWav } from "../dictation.js";
import { holdReload } from "../new-version.js";
import { ScheduledPeek } from "./Notes.jsx";
import { QueuePeek } from "./QueuePeek.jsx";
import { inPeek, queueDropped, queueLabel, queueRemoved } from "../queue-peek.js";
import { HostChip, UsageRing } from "./ComposerStats.jsx";
import { WhyButton, WhyFlag, WhyPanel } from "./Why.jsx";
import { phaseLabel } from "../run-phase.js";
import { answerItems, chapterAnchor } from "../chat-tools.js";
import { ChapterDivider, ChapterToc, ChatSuggestions, SuggestionCard } from "./ChatTools.jsx";
import { tr } from "./Setup.jsx";
import { useSkin } from "../skin.js";
import { MessageBoundary } from "../boundary.js";
import { escCancels } from "../keys.js";
import { clockLabel, exactTime } from "../elapsed.js";

const ChatContext = createContext({ chatId: null, readOnly: false });

const plugins = { code };
// Code blocks stay compact: copy only. Tables keep download (CSV) and fullscreen — a wide table is
// unreadable inside the chat column.
const controls = { code: { copy: true, download: false }, table: { copy: true, download: true, fullscreen: true } };

export function Thread({
  header,
  runInfo,
  readOnly = false,
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
}) {
  return (
    <ChatContext.Provider value={{ chatId, readOnly }}>
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      {header}
      {readOnly ? null : <SelectionActions />}
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
      />
    </ThreadPrimitive.Root>
    </ChatContext.Provider>
  );
}

function ThreadBody({ runInfo, readOnly, agentLabel, agent, fresh, recentTitles, onSuggestion, mode, model, onModeChange, onModelChange, effort, onEffortChange, composerTop, compact, placeholder, board }) {
  // New chat page: the box is docked at the bottom like in a chat; the owner's
  // board — or, with nothing on it, the welcome and suggestions — fills the page above it. The
  // side chat (compact) keeps its composer in the middle.
  const showHero = fresh && !readOnly;
  const docked = showHero && !compact;
  const composerProps = { agentLabel, mode, model, agent, onModeChange, onModelChange, effort, onEffortChange, top: composerTop, compact, placeholder };

  return (
    // The hero has no messages to follow; a tall home-page board would be pulled to its bottom.
    <ThreadPrimitive.Viewport data-griffin-thread="" autoScroll={!showHero} className="scrollbar-thin relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className={`mx-auto flex w-full max-w-3xl flex-1 flex-col px-3 pt-4 sm:px-6 ${showHero && !board ? "justify-center" : ""}`}>
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
            <MessageBoundary>
              <ThreadPrimitive.Messages components={{ UserMessage: SafeUserMessage, AssistantMessage: SafeAssistantMessage, SystemMessage: SafeSystemMessage }} />
            </MessageBoundary>
            <div className="min-h-6 flex-1" />
          </>
        )}
      </div>
      {readOnly || (showHero && !docked) ? null : (
        <ThreadPrimitive.ViewportFooter className="g-thread-footer sticky bottom-0 mx-auto w-full max-w-3xl bg-gradient-to-t from-background via-background to-transparent px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2 sm:px-6">
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
  const karsara = useSkin() === "karsara";
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

  // Karsara skin: one quiet line, what is not connected yet, the composer. No glyph, no pills, no motion.
  if (karsara) {
    return (
      <div className={`mx-auto flex w-full ${board && docked ? "max-w-3xl" : "max-w-2xl"} flex-col gap-4 py-6`}>
        {board ? null : <h2 className="text-center text-lg font-medium text-foreground/90" dir="auto">{meta.blurb || meta.label}</h2>}
        {compact ? null : <SetupCard />}
        {board?.top}
        {docked ? bottom : null}
        {composer}
        {docked ? null : bottom}
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
  // Chat UI is Persian-first: only pure Latin stays LTR; anything else (Persian,
  // digits-only, empty) is RTL so English-leading mixed lines stay right-aligned.
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
  if (!note) return null;
  return (
    <MessagePrimitive.Root className="my-2">
      <NoteRow note={note} />
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
// rests on the message; the exact date and time (weekday, seconds) as its tooltip.
function MessageTime({ at }) {
  useSyncExternalStore(subscribeClock, () => tickClock.tick, () => 0);
  const text = clockLabel(at);
  if (!text) return null;
  return (
    <span className="text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-80" title={exactTime(at)}>
      {text}
    </span>
  );
}

function UserMessage() {
  const { chatId, readOnly } = useContext(ChatContext);
  const custom = useAuiState((s) => s.message.metadata?.custom);
  // Waiting in the queue: shown above the composer (QueuePeek), not here — unless there is no composer.
  const waiting = useAuiState((s) => inPeek(s.message));
  const messageId = useAuiState((s) => s.message.id);
  const createdAt = useAuiState((s) => s.message.createdAt);
  const karsara = useSkin() === "karsara";
  const text = useAuiState((s) => {
    const parts = s.message.content || s.message.parts || [];
    if (typeof parts === "string") return parts;
    return (Array.isArray(parts) ? parts : []).map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n");
  });
  // A mother chat: a colleague's Telegram message is theirs (muted, named); what the owner types
  // here is a note to the assistant that the colleague never sees (telegram.js userSide).
  const chat = useContext(ChatRecord);
  const from = custom?.from;
  const { theirs: colleague, ownerNote, editable } = userSide(from, text, chat);
  const dir = chatDir(text);
  // A queued message that ran shows at its place with no label; one that never ran is muted.
  const label = queueLabel(custom);
  const dropped = queueDropped(custom);
  // message.id is `u<eventId>`; rewind truncates the chat back to this event.
  const eventId = typeof messageId === "string" && messageId.startsWith("u") ? Number(messageId.slice(1)) : null;
  const canEdit = chatId && eventId && !readOnly && editable;
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const rewind = () => {
    if (confirm(t("گفتگو از اینجا به بعد پاک شود؟"))) act({});
  };
  if ((waiting && !readOnly) || queueRemoved(custom)) return null;

  const act = async (body) => {
    setBusy(true);
    try {
      await api(`/api/chats/${chatId}/rewind`, { method: "POST", body: { eventId, ...body } });
      setEditing(null);
      reloadTimeline();
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
          {from.kind === "peer" ? <span>{t("از ایجنت «{name}»", { name: from.name || t("همکار") })}</span> : <span><PersonName personId={from.personId} fallback={from.name || t("همکار")} /> {t("در تلگرام")}</span>}
        </span>
      ) : null}
      <div className="flex w-full items-start gap-1.5">
        {colleague ? (
          <div className="chat-text max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-ss-md border bg-muted/50 px-4 py-2.5 leading-7 text-foreground/90" dir={chatDir(stripSender(text, from.name))}>
            {stripSender(text, from.name)}
          </div>
        ) : (
          <div className={`g-user-bubble chat-text max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-ss-md bg-accent px-4 py-2.5 leading-7 ${dropped ? "opacity-60" : ""}`} dir={dir}>
            {ownerNote ? stripOwnerFrame(text) : <MessagePrimitive.Parts />}
          </div>
        )}
        {canEdit && !karsara ? (
          <div className="mt-1 flex flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button type="button" title={t("ویرایش و ارسال دوباره")} onClick={() => setEditing(text)} className="press rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="size-3.5" /></button>
            <button type="button" title={t("برگشت به اینجا (حذف ادامه)")} onClick={rewind} className="press rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><RotateCcw className="size-3.5" /></button>
          </div>
        ) : null}
      </div>
      {ownerNote ? <span className="mt-1 text-[11px] text-muted-foreground">{t("یادداشت شما — به {name} نمی‌رسد", { name: motherName(chat) })}</span> : null}
      {custom?.images ? <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><ImagePlus className="size-3" /> {t("{n} تصویر", { n: num(custom.images) })}</span> : null}
      {label ? <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><ListTodo className="size-3" /> {label}</span> : null}
      {custom?.sendState ? <SendState state={custom.sendState} clientId={custom.clientId} /> : null}
      {/* Zero height: shown on hover under the bubble without moving the thread. items-start: it hangs
          below the line above (centred on a zero-height row it rose over the label/time above it). On a
          touch screen, where it always shows, it takes its height, so a wrapped line never overlaps. */}
      <span className="mt-1 flex h-0 flex-wrap items-start gap-x-3 gap-y-1 overflow-visible whitespace-nowrap leading-4 pointer-coarse:h-auto">
        <MessageTime at={createdAt} />
        {canEdit && karsara ? (
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

// A message still on its way (outbox.js): its state, and on a failure «ارسال دوباره» / «ویرایش».
function SendState({ state, clientId }) {
  const karsara = useSkin() === "karsara";
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
  const karsara = useSkin() === "karsara";
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
  const line = kept ? t("پیامت به ایجنت نرسید و نگه داشته شد.") : t("این کار با خطا تمام شد.");
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
    <div className={`sd-block ${compact ? "leading-7" : "leading-8"} [&_pre]:my-2`} dir={dir}>
      <Streamdown dir={dir} plugins={plugins} controls={controls} isAnimating={status?.type === "running"} shikiTheme={["github-light", "github-dark"]}>
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
  const karsara = useSkin() === "karsara";
  if (!run) return null;
  const copyable = run.status !== "running";
  // «چرا؟» once the reply is done; a shared page has no chat id (and no session to ask with).
  const explainable = Boolean(chatId && run.runId && run.status !== "running");
  const seconds = run.endedAt && run.startedAt ? Math.max(1, Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 1000)) : null;
  const model = run.model && run.status !== "running" ? run.model : null;
  const done = run.status !== "running";
  const answeredAt = done && run.endedAt ? formatAnsweredAt(run.endedAt) : null;
  const tokens = run.usage ? (
    <span
      dir="ltr"
      title={t("ورودی {input} (کش {cached}) · خروجی {output} · {requests} درخواست · کانتکست {context}", { input: num(run.usage.input), cached: num(run.usage.cached), output: num(run.usage.output), requests: num(run.usage.requests), context: num(run.usage.context) })}
    >
      {compactTokens(run.usage.input + run.usage.output)} tok
    </span>
  ) : null;
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

  // Karsara skin: plain muted text and a ring, no pills.
  if (karsara) {
    return (
      <>
      <div className="mt-2 flex min-h-7 flex-wrap items-center gap-2">
        {run.status === "running" ? <RunPhase run={run} /> : null}
        {run.status === "error" ? <span className="text-xs text-bad" dir="auto">{run.error || t("خطا")}</span> : null}
        {run.status === "cancelled" ? <span className="text-xs text-muted-foreground" dir="auto">{run.error || t("متوقف شد")}</span> : null}
        {done && (answeredAt || seconds || model || run.usage) ? (
          <div className="g-run-meta flex items-center gap-1.5 text-xs text-muted-foreground">
            {answeredAt || seconds ? (
              <span className="inline-flex items-center gap-1" title={[answeredAt && t("جواب: {time}", { time: answeredAt }), seconds && t("طول کشید: {duration}", { duration: formatDuration(seconds) })].filter(Boolean).join(" · ")}>
                <Clock className="size-3 opacity-70" />
                {answeredAt ? <span>{answeredAt}</span> : null}
                {seconds ? <span className={answeredAt ? "opacity-70" : ""}>{answeredAt ? `(${formatDuration(seconds, { compact: true })})` : formatDuration(seconds, { compact: true })}</span> : null}
              </span>
            ) : null}
            {(answeredAt || seconds) && model ? <span className="text-border">·</span> : null}
            {model ? <span className="max-w-40 truncate" title={model} dir="ltr">{model}</span> : null}
            {tokens ? <><span className="text-border">·</span>{tokens}</> : null}
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

      {done && (answeredAt || seconds || model || run.usage) ? (
        <div className="g-run-meta flex items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground">
          {answeredAt || seconds ? (
            <span
              className="inline-flex items-center gap-1"
              title={[answeredAt && t("جواب: {time}", { time: answeredAt }), seconds && t("طول کشید: {duration}", { duration: formatDuration(seconds) })].filter(Boolean).join(" · ")}
            >
              <Clock className="size-3 opacity-70" />
              {answeredAt ? <span>{answeredAt}</span> : null}
              {answeredAt && seconds ? <span className="opacity-60">({formatDuration(seconds, { compact: true })})</span> : null}
              {!answeredAt && seconds ? <span>{formatDuration(seconds, { compact: true })}</span> : null}
            </span>
          ) : null}
          {(answeredAt || seconds) && model ? <span className="text-border">·</span> : null}
          {model ? (
            <span className="max-w-40 truncate font-medium text-foreground/70" title={model} dir="ltr">
              {model}
            </span>
          ) : null}
          {tokens ? (
            <>
              <span className="text-border">·</span>
              {tokens}
            </>
          ) : null}
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

// What the running turn is doing (run-phase.js): a retry or a closed limit in words. The shared
// clock lets a retry label expire.
function RunPhase({ run }) {
  const karsara = useSkin() === "karsara";
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
      className="g-run-phase inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs text-primary"
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
// the browser cannot record (no microphone API, or a page not served over https).
let sttConfigured = null; // null = not asked yet
function DictateButton({ value, setText, focus, size, className = "mb-1" }) {
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
    if (sttConfigured == null) api("/api/stt").then((s) => (sttConfigured = Boolean(s.configured)), () => {});
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
  if (!supported) return null;

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
  const start = async () => {
    if (sttConfigured === false) {
      sttConfigured = null; // asked again on the next tap
      api("/api/stt").then((s) => (sttConfigured = Boolean(s.configured)), () => {});
      return toast(t("تبدیل گفتار به متن هنوز راه نیفتاده (کلید OpenRouter در stt.api-key روی سرور نیست)."));
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
  const karsara = useSkin() === "karsara";
  const inputRef = useRef(null);
  const rootRef = useRef(null);
  const aui = useAui();
  const { value: composerText, setText } = unstable_useComposerInput();
  // The suggested next message: a row above the input, or ghost text in the empty box (Karsara skin).
  const next = useNextStep();
  // What was being typed in this chat comes back after a reload or a look at another chat
  // (draft.js). The composer is mounted once per chat, so this runs once per chat.
  const { boxId: chatId, sendQuotes } = useRuntimeChat();
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
  // Attached pictures live only in this page: a new version waits for them to be sent or removed.
  const hasAttached = useAuiState((s) => (s.composer.attachments?.length || 0) > 0);
  useEffect(() => (hasAttached ? holdReload() : undefined), [hasAttached]);
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
  // A Telegram chat says who the box reaches (App.jsx): only the assistant, never the colleague.
  const placeholder = karsara && next
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
      autoFocus
      dir={composerText.trim() ? chatDir(composerText) : isRtl ? "rtl" : "ltr"}
      submitMode={submitMode(touch)}
      aria-label={t("پیام به {agent}", { agent: agentLabel })}
      placeholder={placeholder}
      className={`scrollbar-thin min-w-0 resize-none bg-transparent outline-none placeholder:text-muted-foreground ${
        karsara
          ? `max-h-[70dvh] px-1.5 py-2 text-start text-[15px] leading-7 ${hero ? "min-h-16" : "min-h-10"}`
          : `max-h-[70dvh] min-h-10 flex-1 px-1 py-2 text-start ${hero ? "text-sm leading-6" : "leading-7"}`
      }`}
    />
  );
  if (karsara) {
    return (
      <div ref={rootRef} className="min-w-0">
        {compact ? null : top}
        {compact ? null : <ScheduledPeek chatId={chatId} />}
        {/* Even in the side panel: a waiting message is not in its thread. */}
        <QueuePeek chatId={chatId} onEdit={takeBack} />
        <ComposerPrimitive.Root className="composer-box g-composer relative z-[1] rounded-xl border bg-card focus-within:border-primary/60">
          {quotes.length ? (
            <div className="flex flex-col gap-1 px-2 pt-2">
              {quotes.map((q) => (
                <QuoteChip key={q.id} chatId={chatId} quote={q} onDone={focusInput} />
              ))}
            </div>
          ) : null}
          <ComposerAssist inputRef={inputRef} next={next} />
          <ComposerPrimitive.Attachments components={{ Attachment: ComposerImage }} />
          <div className="flex items-end gap-1 px-2 py-1.5">
            {/* The input and the ghost suggestion share one grid cell. */}
            <div className="grid min-w-0 flex-1 [&>*]:min-w-0 [&>*]:[grid-area:1/1]" onClick={(event) => event.target === event.currentTarget && focusInput()}>
              {input}
              {next ? (
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
              ) : null}
            </div>
            <DictateButton value={composerText} setText={setText} focus={focusInput} size="size-5" />
            {running ? (
              <ComposerPrimitive.Cancel className={KC_SEND} data-stop="" title={t("توقف")}>
                <Square className="size-3.5 fill-current" />
              </ComposerPrimitive.Cancel>
            ) : quotesOnly ? (
              <button type="button" onClick={sendQuotes} className={KC_SEND} title={t("ارسال نقل‌قول‌ها")} aria-label={t("ارسال")}>
                <CornerDownLeft className="size-4" />
              </button>
            ) : (
              <ComposerPrimitive.Send className={KC_SEND} title={touch ? t("ارسال") : t("ارسال (Enter)")}>
                <CornerDownLeft className="size-4" />
              </ComposerPrimitive.Send>
            )}
          </div>
        </ComposerPrimitive.Root>
        {compact ? null : <div className="g-composer-bar mt-1 flex min-w-0 items-center gap-1">
          <ComposerPrimitive.AddAttachment className="g-icon-btn flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted" title={t("افزودن تصویر")} aria-label={t("افزودن تصویر")}>
            <Plus className="size-4" />
          </ComposerPrimitive.AddAttachment>
          {onModeChange ? <ModeToggle mode={mode} onChange={onModeChange} /> : null}
          <span className="flex-1" />
          {onModelChange ? <ModelPicker model={model} agent={agent} onChange={onModelChange} compact /> : null}
          {onEffortChange ? <EffortPicker effort={effort} model={model} agent={agent} onChange={onEffortChange} /> : null}
          <FastToggle />
          <HostChip />
          <UsageRing chatId={chatId} running={running} />
        </div>}
      </div>
    );
  }

  return (
    <>
    {top}
    <ScheduledPeek chatId={chatId} />
    <QueuePeek chatId={chatId} onEdit={takeBack} />
    <ComposerPrimitive.Root ref={rootRef} className="composer-box g-composer relative z-[1] rounded-2xl border bg-card shadow-sm focus-within:border-primary/60">
      {quotes.length ? (
        <div className="flex flex-col gap-1 px-2 pt-2">
          {quotes.map((q) => (
            <QuoteChip key={q.id} chatId={chatId} quote={q} onDone={() => inputRef.current?.focus()} />
          ))}
        </div>
      ) : null}
      <ComposerAssist inputRef={inputRef} next={next} />
      <ComposerPrimitive.Attachments components={{ Attachment: ComposerImage }} />
      <div className={`flex items-end gap-1 px-2 ${hero ? "py-1.5" : "pb-2 pt-2"}`}>
        {input}
        <div className="mb-0.5 flex shrink-0 items-center gap-1">
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
            <ComposerPrimitive.Send className="g-send flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-50" title={t("ارسال")}>
              <ArrowUp className="size-5" />
            </ComposerPrimitive.Send>
          )}
        </div>
      </div>
      {running && !hero ? (
        <div className="flex items-center gap-2 px-3 pb-2 text-xs text-primary">
          <span className="agent-dots" aria-hidden><i /><i /><i /></span>
          {t("پیام جدید وسط کار ارسال می‌شود")}
        </div>
      ) : null}
    </ComposerPrimitive.Root>
    {/* Under the box: +, microphone and mode; model and effort at the far end. The box keeps its width for text. */}
    <div className="g-composer-bar mt-1.5 flex min-w-0 flex-wrap items-center gap-0.5 px-1">
      <ComposerPrimitive.AddAttachment className="g-icon-btn flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" title={t("افزودن فایل یا تصویر")} aria-label={t("افزودن فایل یا تصویر")}>
        <Plus className="size-4" />
      </ComposerPrimitive.AddAttachment>
      <DictateButton value={composerText} setText={setText} focus={focusInput} size="size-4" className="" />
      {onModeChange ? <ModeToggle mode={mode} onChange={onModeChange} named={hero} /> : null}
      <span className="flex-1" />
      {onModelChange ? <ModelPicker model={model} agent={agent} onChange={onModelChange} compact footer={<FastSwitch />} /> : null}
      {onEffortChange ? <EffortPicker effort={effort} model={model} agent={agent} onChange={onEffortChange} /> : null}
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
