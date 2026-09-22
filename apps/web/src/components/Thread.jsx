import { useEffect, useMemo, useState } from "react";
import {
  ActionBarPrimitive, AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState,
} from "@assistant-ui/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { motion } from "motion/react";
import {
  ArrowDown, ArrowUp, Brain, Check, ChevronDown, Clock, Copy, ImagePlus, ListTodo, Square, X,
} from "lucide-react";
import { ToolCard } from "./Tool.jsx";
import { formatDuration, splitRun, toolProps, WorkLog } from "./Work.jsx";
import { textDir } from "../dir.js";
import { AgentGlyph, ModeToggle, ModelPicker } from "./Controls.jsx";
import { agentMeta } from "../brand.js";
import { pickSuggestions } from "../suggestions.js";

const plugins = { code };

export function Thread({
  header,
  runInfo,
  readOnly = false,
  agentLabel = "ایجنت",
  agent = "griffin",
  fresh = false,
  recentTitles = [],
  onSuggestion,
  mode = "agent",
  model = "",
  onModeChange,
  onModelChange,
}) {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      {header}
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
      />
    </ThreadPrimitive.Root>
  );
}

function ThreadBody({ runInfo, readOnly, agentLabel, agent, fresh, recentTitles, onSuggestion, mode, model, onModeChange, onModelChange }) {
  // New chat: composer centered with suggestions under it. Ongoing chat: docked composer.
  const showHero = fresh && !readOnly;
  const composerProps = { agentLabel, mode, model, agent, onModeChange, onModelChange };

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
          {runInfo}
          <Composer {...composerProps} variant="dock" />
        </ThreadPrimitive.ViewportFooter>
      )}
    </ThreadPrimitive.Viewport>
  );
}

function WelcomeHero({ agent, agentLabel, recentTitles, onSuggestion, mode, model, onModeChange, onModelChange }) {
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
        <h2 className="text-xl font-semibold" dir="rtl">{meta.label}</h2>
        <p className="mt-1 text-sm text-muted-foreground" dir="rtl">{meta.blurb}</p>
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
            dir="rtl"
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

function UserMessage() {
  const custom = useAuiState((s) => s.message.metadata?.custom);
  const text = useAuiState((s) => {
    const parts = s.message.content || s.message.parts || [];
    if (typeof parts === "string") return parts;
    return (Array.isArray(parts) ? parts : []).map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n");
  });
  const dir = chatDir(text);
  const label = custom?.intent === "queue" ? "در صف؛ بعد از کار فعلی اجرا می‌شود" : custom?.intent === "steer" ? "وسط کار به ایجنت رسید" : null;
  return (
    <MessagePrimitive.Root className="group my-3 flex flex-col items-start">
      <div className="chat-text max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-ss-md bg-accent px-4 py-2.5 leading-7" dir={dir}>
        <MessagePrimitive.Parts />
      </div>
      {custom?.images ? <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><ImagePlus className="size-3" /> {custom.images} تصویر</span> : null}
      {label ? <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><ListTodo className="size-3" /> {label}</span> : null}
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const run = useAuiState((s) => s.message.metadata?.custom?.run);
  const { work, answer } = useMemo(() => splitRun(run?.parts || []), [run]);
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
        ) : (
          <MarkdownText key={`t${i}`} text={part.text} status={textStatus(part)} />
        ),
      )}
      <RunFooter run={run} />
    </MessagePrimitive.Root>
  );
}

function MarkdownText({ text, status, compact = false }) {
  const dir = chatDir(text);
  return (
    <div className={`sd-block ${compact ? "leading-7" : "leading-8"} [&_pre]:my-2`} dir={dir}>
      <Streamdown dir={dir} plugins={plugins} isAnimating={status?.type === "running"} shikiTheme={["github-light", "github-dark"]}>
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
        <span className={running ? "agent-pulse" : ""}>{running ? "در حال فکر کردن" : "فکر کرد"}</span>
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

function RunFooter({ run }) {
  if (!run) return null;
  const copyable = run.status !== "running";
  const seconds = run.endedAt && run.startedAt ? Math.max(1, Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 1000)) : null;
  const model = run.model && run.status !== "running" ? run.model : null;
  const done = run.status !== "running";

  return (
    <div className="mt-2 flex min-h-7 flex-wrap items-center gap-2">
      {run.status === "running" ? <RunPhase phase={run.phase} /> : null}
      {run.status === "error" ? (
        <span className="rounded-md bg-bad/10 px-2 py-0.5 text-xs text-bad" dir="auto">{run.error || "خطا"}</span>
      ) : null}
      {run.status === "cancelled" ? (
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground" dir="auto">
          {run.error || "متوقف شد"}
        </span>
      ) : null}

      {done && (seconds || model) ? (
        <div className="flex items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground">
          {seconds ? (
            <span className="inline-flex items-center gap-1" title={formatDuration(seconds)}>
              <Clock className="size-3 opacity-70" />
              <span>{formatDuration(seconds, { compact: true })}</span>
            </span>
          ) : null}
          {seconds && model ? <span className="text-border">·</span> : null}
          {model ? (
            <span className="max-w-40 truncate font-medium text-foreground/70" title={model} dir="ltr">
              {model}
            </span>
          ) : null}
        </div>
      ) : null}

      {copyable ? (
        <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex items-center">
          <ActionBarPrimitive.Copy
            className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="کپی پاسخ"
          >
            <MessagePrimitive.If copied><Check className="size-3.5 text-ok" /></MessagePrimitive.If>
            <MessagePrimitive.If copied={false}><Copy className="size-3.5" /></MessagePrimitive.If>
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      ) : null}
    </div>
  );
}

const PHASES = { connecting: "در حال اتصال", working: "در حال کار", summarizing: "خلاصه‌سازی" };

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
      <span className="agent-pulse">{PHASES[phase] || "در حال کار"}</span>
    </motion.span>
  );
}

function Composer({ agentLabel, variant = "dock", mode = "agent", model = "", agent = "griffin", onModeChange, onModelChange }) {
  const running = useAuiState((s) => s.thread.isRunning);
  const hero = variant === "hero";
  return (
    <ComposerPrimitive.Root className="rounded-2xl border bg-card shadow-sm focus-within:border-primary/60">
      <ComposerPrimitive.Attachments components={{ Attachment: ComposerImage }} />
      <div className={`flex items-end gap-1 px-2 ${hero ? "py-1.5" : "pb-2 pt-2"}`}>
        <ComposerPrimitive.AddAttachment className="mb-0.5 shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted" title="افزودن تصویر">
          <ImagePlus className={hero ? "size-4" : "size-5"} />
        </ComposerPrimitive.AddAttachment>
        <ComposerPrimitive.Input
          rows={1}
          autoFocus
          dir="rtl"
          submitMode="enter"
          unstable_insertNewlineOnTouchEnter
          placeholder={running ? (hero ? "پیام بده تا وسط کار برسد…" : "پیام بده تا وسط کار به ایجنت برسد…") : `از ${agentLabel} بپرس…`}
          className={`scrollbar-thin min-w-0 flex-1 resize-none bg-transparent px-1 text-right outline-none placeholder:text-muted-foreground ${
            hero
              ? "max-h-12 min-h-10 py-2 text-sm leading-6"
              : "max-h-48 min-h-10 py-2 leading-7"
          }`}
        />
        <div className="mb-0.5 flex shrink-0 items-center gap-1">
          {onModeChange ? <ModeToggle mode={mode} onChange={onModeChange} icons /> : null}
          {onModelChange ? <ModelPicker model={model} agent={agent} onChange={onModelChange} icons /> : null}
          {running ? (
            <ComposerPrimitive.Cancel className="flex size-9 items-center justify-center rounded-full bg-foreground text-background" title="توقف">
              {hero ? (
                <span className="agent-dots agent-dots-on-dark" aria-hidden><i /><i /><i /></span>
              ) : (
                <Square className="size-3.5 fill-current" />
              )}
            </ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-30" title="ارسال">
              <ArrowUp className="size-5" />
            </ComposerPrimitive.Send>
          )}
        </div>
      </div>
      {running && !hero ? (
        <div className="flex items-center gap-2 px-3 pb-2 text-xs text-primary">
          <span className="agent-dots" aria-hidden><i /><i /><i /></span>
          پیام جدید وسط کار ارسال می‌شود
        </div>
      ) : null}
    </ComposerPrimitive.Root>
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
