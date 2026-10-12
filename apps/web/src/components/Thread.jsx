import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActionBarPrimitive, AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, unstable_useComposerInput, useAuiState,
} from "@assistant-ui/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { motion } from "motion/react";
import {
  ArrowDown, ArrowUp, Brain, Check, ChevronDown, Clock, Copy, ImagePlus, ListTodo, Loader2, Mic, Pencil, Quote, RotateCcw, Square, Trash2, X,
} from "lucide-react";
import { ToolCard } from "./Tool.jsx";
import { formatAnsweredAt, formatDuration, splitRun, toolProps, WorkLog } from "./Work.jsx";
import { textDir } from "../dir.js";
import { AgentGlyph, EffortPicker, ModeToggle, ModelPicker } from "./Controls.jsx";
import { agentMeta } from "../brand.js";
import { pickSuggestions } from "../suggestions.js";
import { locale, num, t, isRtl } from "../i18n.js";
import { toast } from "sonner";
import { api, reloadTimeline } from "../api.js";
import { RESTORE_EVENT, editSend, retrySend, useRuntimeChat } from "../runtime.jsx";
import { FAILED_LABEL, SENDING_LABEL, SENT_LABEL } from "../outbox.js";
import { quoteStore } from "../quotes.js";
import { SelectionActions } from "./SelectionActions.jsx";
import { QuoteChip } from "./QuoteChip.jsx";
import { ComposerAssist, ForkButton } from "./ComposerAssist.jsx";
import { submitMode, useTouchPrimary } from "../touch.js";
import { loadDraft, saveDraft } from "../draft.js";
import { MAX_RECORD_MS, joinDictation, pickAudioMime, recordClock, toWav } from "../dictation.js";
import { holdReload } from "../new-version.js";
import { LaterButton } from "./Notes.jsx";
import { WhyButton, WhyPanel } from "./Why.jsx";
import { answerItems, chapterAnchor } from "../chat-tools.js";
import { ChapterDivider, ChapterToc, ChatSuggestions, SuggestionCard } from "./ChatTools.jsx";

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
      />
    </ThreadPrimitive.Root>
    </ChatContext.Provider>
  );
}

function ThreadBody({ runInfo, readOnly, agentLabel, agent, fresh, recentTitles, onSuggestion, mode, model, onModeChange, onModelChange, effort, onEffortChange, composerTop }) {
  // New chat: composer centered with suggestions under it. Ongoing chat: docked composer.
  const showHero = fresh && !readOnly;
  const composerProps = { agentLabel, mode, model, agent, onModeChange, onModelChange, effort, onEffortChange, top: composerTop };

  return (
    <ThreadPrimitive.Viewport className="scrollbar-thin relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className={`mx-auto flex w-full max-w-3xl flex-1 flex-col px-3 pt-4 sm:px-6 ${showHero ? "justify-center" : ""}`}>
        {showHero ? (
          <WelcomeHero
            agent={agent}
            recentTitles={recentTitles}
            onSuggestion={onSuggestion}
            {...composerProps}
          />
        ) : (
          <>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            <div className="min-h-6 flex-1" />
          </>
        )}
      </div>
      {readOnly || showHero ? null : (
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto w-full max-w-3xl bg-gradient-to-t from-background via-background to-transparent px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2 sm:px-6">
          <ThreadPrimitive.ScrollToBottom className="absolute -top-10 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border bg-card shadow disabled:invisible">
            <ArrowDown className="size-4" />
          </ThreadPrimitive.ScrollToBottom>
          <ThreadTools />
          {runInfo}
          <Composer {...composerProps} variant="dock" />
        </ThreadPrimitive.ViewportFooter>
      )}
    </ThreadPrimitive.Viewport>
  );
}

function WelcomeHero({ agent, agentLabel, recentTitles, onSuggestion, mode, model, onModeChange, onModelChange, effort, onEffortChange, top }) {
  const meta = agentMeta(agent);
  const suggestions = useMemo(
    () => pickSuggestions(agent, { count: 4, recentTitles, salt: String(recentTitles[0] || "") }),
    [agent, recentTitles],
  );

  return (
    <motion.div
      className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 py-6"
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
      }}
    >
      <motion.div variants={fadeUp} className="welcome-glow">
        <AgentGlyph id={agent} className="size-14" />
      </motion.div>
      <motion.div variants={fadeUp} className="text-center">
        <h2 className="text-xl font-semibold" dir="auto">{meta.label}</h2>
        <p className="mt-1 text-sm text-muted-foreground" dir="auto">{meta.blurb}</p>
      </motion.div>
      <motion.div variants={fadeUp} className="w-full">
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
        />
      </motion.div>
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
    </motion.div>
  );
}

const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 380, damping: 28 } },
};

function chatDir(value) {
  // Chat UI is Persian-first: only pure Latin stays LTR; anything else (Persian,
  // digits-only, empty) is RTL so English-leading mixed lines stay right-aligned.
  return textDir(value) === "ltr" ? "ltr" : "rtl";
}

// A message sent while a run was busy: waiting, then it reached the agent (started) or a Stop or
// a delete cleared it before it ran (dropped).
const QUEUE_LABELS = {
  waiting: t("در صف؛ بعد از کار فعلی اجرا می‌شود"),
  started: t("از صف اجرا شد"),
  dropped: t("از صف کنار رفت؛ اجرا نشد"),
};

function UserMessage() {
  const { chatId, readOnly } = useContext(ChatContext);
  const custom = useAuiState((s) => s.message.metadata?.custom);
  const messageId = useAuiState((s) => s.message.id);
  const text = useAuiState((s) => {
    const parts = s.message.content || s.message.parts || [];
    if (typeof parts === "string") return parts;
    return (Array.isArray(parts) ? parts : []).map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n");
  });
  const dir = chatDir(text);
  const label = custom?.intent === "queue" ? QUEUE_LABELS[custom.queueState] || QUEUE_LABELS.waiting : custom?.intent === "steer" ? t("وسط کار به ایجنت رسید") : null;
  // message.id is `u<eventId>`; rewind truncates the chat back to this event.
  const eventId = typeof messageId === "string" && messageId.startsWith("u") ? Number(messageId.slice(1)) : null;
  const canEdit = chatId && eventId && !readOnly;
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

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
      <MessagePrimitive.Root className="group my-3 flex w-full flex-col items-stretch">
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
    <MessagePrimitive.Root className="group my-3 flex flex-col items-start">
      <div className="flex items-start gap-1.5">
        <div className="chat-text max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-ss-md bg-accent px-4 py-2.5 leading-7" dir={dir}>
          <MessagePrimitive.Parts />
        </div>
        {canEdit ? (
          <div className="mt-1 flex flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button type="button" title={t("ویرایش و ارسال دوباره")} onClick={() => setEditing(text)} className="press rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="size-3.5" /></button>
            <button type="button" title={t("برگشت به اینجا (حذف ادامه)")} onClick={() => { if (confirm(t("گفتگو از اینجا به بعد پاک شود؟"))) act({}); }} className="press rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><RotateCcw className="size-3.5" /></button>
          </div>
        ) : null}
      </div>
      {custom?.images ? <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><ImagePlus className="size-3" /> {t("{n} تصویر", { n: num(custom.images) })}</span> : null}
      {label ? <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><ListTodo className="size-3" /> {label}</span> : null}
      {custom?.sendState ? <SendState state={custom.sendState} clientId={custom.clientId} /> : null}
    </MessagePrimitive.Root>
  );
}

// A message still on its way (outbox.js): its state, and on a failure «ارسال دوباره» / «ویرایش».
function SendState({ state, clientId }) {
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
    <MessagePrimitive.Root className="group my-3">
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

// Under a run that failed before anything reached the owner: the message is kept on the server.
function KeptActions() {
  const custom = useAuiState((s) => s.message.metadata?.custom);
  const [busy, setBusy] = useState(false);
  if (!custom?.onRetry) return null;
  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
      <span>{t("این پیام به ایجنت نرسید و نگه داشته شد.")}</span>
      <button type="button" disabled={busy} onClick={() => act(custom.onRetry)} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 hover:bg-muted disabled:opacity-50">
        <RotateCcw className="size-3" /> {t("ارسال دوباره")}
      </button>
      <button type="button" disabled={busy} onClick={() => act(custom.onDelete)} className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 hover:bg-muted disabled:opacity-50">
        <Trash2 className="size-3" /> {t("حذف")}
      </button>
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
  if (!run) return null;
  const copyable = run.status !== "running";
  // «چرا؟» once the reply is done; a shared page has no chat id (and no session to ask with).
  const explainable = Boolean(chatId && run.runId && run.status !== "running");
  const seconds = run.endedAt && run.startedAt ? Math.max(1, Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 1000)) : null;
  const model = run.model && run.status !== "running" ? run.model : null;
  const done = run.status !== "running";
  const answeredAt = done && run.endedAt ? formatAnsweredAt(run.endedAt) : null;

  return (
    <>
    <div className="mt-2 flex min-h-7 flex-wrap items-center gap-2">
      {run.status === "running" ? <RunPhase phase={run.phase} /> : null}
      {run.status === "error" ? (
        <span className="rounded-md bg-bad/10 px-2 py-0.5 text-xs text-bad" dir="auto">{run.error || t("خطا")}</span>
      ) : null}
      {run.status === "cancelled" ? (
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground" dir="auto">
          {run.error || t("متوقف شد")}
        </span>
      ) : null}

      {done && (answeredAt || seconds || model || run.usage) ? (
        <div className="flex items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground">
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
          {run.usage ? (
            <>
              <span className="text-border">·</span>
              <span
                dir="ltr"
                title={t("ورودی {input} (کش {cached}) · خروجی {output} · {requests} درخواست · کانتکست {context}", { input: num(run.usage.input), cached: num(run.usage.cached), output: num(run.usage.output), requests: num(run.usage.requests), context: num(run.usage.context) })}
              >
                {compactTokens(run.usage.input + run.usage.output)} tok
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      {copyable ? (
        <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex items-center">
          <ActionBarPrimitive.Copy
            className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={t("کپی پاسخ")}
          >
            <MessagePrimitive.If copied><Check className="size-3.5 text-ok" /></MessagePrimitive.If>
            <MessagePrimitive.If copied={false}><Copy className="size-3.5" /></MessagePrimitive.If>
          </ActionBarPrimitive.Copy>
          {explainable ? <WhyButton open={why} onToggle={() => setWhy(!why)} /> : null}
          <ForkButton run={run} />
        </ActionBarPrimitive.Root>
      ) : null}
    </div>
    {explainable && why ? <WhyPanel chatId={chatId} runId={run.runId} /> : null}
    </>
  );
}

const PHASES = { connecting: t("در حال اتصال"), working: t("در حال کار"), summarizing: t("خلاصه‌سازی") };

function RunPhase({ phase }) {
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs text-primary"
    >
      <span className="agent-dots" aria-hidden>
        <i /><i /><i />
      </span>
      <span className="agent-pulse">{PHASES[phase] || t("در حال کار")}</span>
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
function DictateButton({ value, setText, focus, size }) {
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
  const btn = "mb-0.5 shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted";
  if (state === "working") {
    return <span className={btn} title={t("در حال تبدیل گفتار به متن")} aria-live="polite"><Loader2 className={`${size} animate-spin`} /></span>;
  }
  if (state === "recording") {
    return (
      <button type="button" onClick={stop} className="mb-1 flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 text-xs" title={t("پایان ضبط و نوشتن متن")} aria-label={t("پایان ضبط")}>
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

function Composer({ agentLabel, variant = "dock", mode = "agent", model = "", agent = "griffin", onModeChange, onModelChange, effort, onEffortChange, top = null }) {
  const running = useAuiState((s) => s.thread.isRunning);
  const hero = variant === "hero";
  const touch = useTouchPrimary();
  const inputRef = useRef(null);
  const { value: composerText, setText } = unstable_useComposerInput();
  // What was being typed in this chat comes back after a reload or a look at another chat
  // (draft.js). The composer is mounted once per chat, so this runs once per chat.
  const { boxId: chatId, sendQuotes, settings } = useRuntimeChat();
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
  return (
    <>
    {top}
    <ComposerPrimitive.Root className="composer-box rounded-2xl border bg-card shadow-sm focus-within:border-primary/60">
      {quotes.length ? (
        <div className="flex flex-col gap-1 px-2 pt-2">
          {quotes.map((q) => (
            <QuoteChip key={q.id} chatId={chatId} quote={q} onDone={() => inputRef.current?.focus()} />
          ))}
        </div>
      ) : null}
      <ComposerAssist inputRef={inputRef} />
      <ComposerPrimitive.Attachments components={{ Attachment: ComposerImage }} />
      <div className={`flex items-end gap-1 px-2 ${hero ? "py-1.5" : "pb-2 pt-2"}`}>
        <ComposerPrimitive.AddAttachment className="mb-0.5 shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted" title={t("افزودن تصویر")}>
          <ImagePlus className={hero ? "size-4" : "size-5"} />
        </ComposerPrimitive.AddAttachment>
        <DictateButton value={composerText} setText={setText} focus={() => inputRef.current?.focus()} size={hero ? "size-4" : "size-5"} />
        <LaterButton
          text={composerText}
          chatId={chatId}
          options={{ repo: settings?.repo, model: settings?.model, agent: settings?.agent, mode: settings?.mode, effort: settings?.effort }}
          disabled={quotes.length > 0}
          disabledTitle={t("یادداشت فقط متن نگه می‌دارد؛ نقل‌قول را بردارید")}
          size={hero ? "size-4" : "size-5"}
          onSaved={() => {
            setText("");
            saveDraft(browserStorage(), chatId, "");
          }}
        />
        <ComposerPrimitive.Input
          ref={inputRef}
          data-reload-safe=""
          rows={1}
          autoFocus
          dir={isRtl ? "rtl" : "auto"}
          submitMode={submitMode(touch)}
          placeholder={running ? (hero ? t("پیام بده تا وسط کار برسد…") : t("پیام بده تا وسط کار به ایجنت برسد…")) : t("از {agent} بپرس…", { agent: agentLabel })}
          className={`scrollbar-thin min-w-0 flex-1 resize-none bg-transparent px-1 text-start outline-none placeholder:text-muted-foreground ${
            hero
              ? "max-h-12 min-h-10 py-2 text-sm leading-6"
              : "max-h-[45vh] min-h-10 py-2 leading-7"
          }`}
        />
        <div className="mb-0.5 flex shrink-0 items-center gap-1">
          {onModeChange ? <ModeToggle mode={mode} onChange={onModeChange} icons /> : null}
          {onModelChange ? <ModelPicker model={model} agent={agent} onChange={onModelChange} icons /> : null}
          {onEffortChange ? <EffortPicker effort={effort} model={model} agent={agent} onChange={onEffortChange} /> : null}
          {running ? (
            <ComposerPrimitive.Cancel className="flex size-9 items-center justify-center rounded-full bg-foreground text-background" title={t("توقف")}>
              {hero ? (
                <span className="agent-dots agent-dots-on-dark" aria-hidden><i /><i /><i /></span>
              ) : (
                <Square className="size-3.5 fill-current" />
              )}
            </ComposerPrimitive.Cancel>
          ) : quotesOnly ? (
            <button type="button" onClick={sendQuotes} className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground" title={t("ارسال نقل‌قول‌ها")}>
              <ArrowUp className="size-5" />
            </button>
          ) : (
            // Send is the one filled (accent) button while it can send; empty, it is plain like the
            // microphone.
            <ComposerPrimitive.Send className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-50" title={t("ارسال")}>
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
    </>
  );
}

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
