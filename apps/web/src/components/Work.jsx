import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Brain, ChevronDown, Wrench } from "lucide-react";
import { unwrapResult } from "../result.js";
import { ToolCard, stepTitle } from "./Tool.jsx";
import { locale, num, t } from "../i18n.js";
import { useSkin } from "../skin.js";

// Tools whose output is the answer itself; they stay visible outside the collapsed work log.
// send_to_person: every message that reached a colleague keeps its «📤» card in sight.
const RESULT_TOOLS = new Set(["show_media", "s3_get", "visualize", "ask_owner", "ask_agent", "send_to_person"]);

// Splits an assistant run into the work log (thinking, tool calls, narration between them) and the
// answer (text after the last working tool, plus charts/files/questions wherever they appeared).
// An answered question is history: it stays where it happened in the work log. Only a question
// still waiting for the owner is pulled out — otherwise it sat under all later work (2026-09-24).
const isResult = (part) =>
  part.type === "tool" && RESULT_TOOLS.has(part.name) && !(part.name === "ask_owner" && part.status !== "running");

// The part types this renderer can draw. Any other type (a `suggestion` card, a `chapter` divider,
// or one added later) has no text and no tool fields: it is returned apart in `other` for the
// thread to draw (chat-tools.js answerItems), and otherwise not shown.
const DRAWN_PARTS = new Set(["text", "reasoning", "tool"]);

export function splitRun(parts) {
  const visible = (parts || []).filter((part) => DRAWN_PARTS.has(part?.type));
  const other = (parts || []).filter((part) => part && !DRAWN_PARTS.has(part.type));
  let lastWork = -1;
  visible.forEach((part, i) => {
    if (part.type === "tool" && !isResult(part)) lastWork = i;
  });
  const work = [];
  const answer = [];
  visible.forEach((part, i) => {
    if (isResult(part)) answer.push(part);
    else if (part.type === "reasoning" || i <= lastWork) work.push(part);
    else answer.push(part);
  });
  return { work, answer, other };
}

export function toolProps(part) {
  const { result, isError } = unwrapResult(part);
  return {
    toolName: part.name,
    args: part.args && typeof part.args === "object" ? part.args : {},
    result,
    isError,
    callId: part.callId || null,
    status: { type: part.status === "running" ? "running" : "complete" },
  };
}

export function WorkLog({ run, parts, renderText, renderReasoning }) {
  const running = run.status === "running";
  const [open, setOpen] = useState(null);
  const karsara = useSkin() === "karsara";
  const expanded = open ?? running;
  if (!parts.length) return null;

  const tools = parts.filter((p) => p.type === "tool").length;
  const thoughts = parts.filter((p) => p.type === "reasoning").length;
  const seconds = run.endedAt && run.startedAt ? Math.max(1, Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 1000)) : null;
  const summary = [
    seconds ? t("{duration} کار", { duration: formatDuration(seconds, { compact: true }) }) : running ? t("در حال کار") : t("کار"),
    tools ? t("{n} ابزار", { n: num(tools) }) : null,
    thoughts ? t("{n} فکر", { n: num(thoughts) }) : null,
  ].filter(Boolean).join(" · ");
  const current = running ? [...parts].reverse().find((p) => p.type === "tool") : null;
  const currentTitle = current && !expanded ? (
    stepTitle(current.name, current.args)
      ? <span dir="auto" className="max-w-64 truncate text-xs opacity-70">{stepTitle(current.name, current.args)}</span>
      : <span className="ltr max-w-48 truncate text-xs opacity-70">{current.name}</span>
  ) : null;
  const body = (part, i) => (
    <div key={part.callId || `${part.type}-${i}`} className="relative">
      {karsara ? null : <span className="absolute -start-[1.3rem] top-3 size-2 rounded-full border-2 border-background bg-border" />}
      {part.type === "tool" ? (
        <ToolCard {...toolProps(part)} />
      ) : part.type === "reasoning" ? (
        renderReasoning(part, run)
      ) : (
        <div className="py-1 text-sm text-muted-foreground">{renderText(part, run, true)}</div>
      )}
    </div>
  );

  // Karsara skin: a flat row (a ring while running, no icon box, no motion) and no timeline dots.
  if (karsara) {
    return (
      <div className="my-2">
        <button type="button" onClick={() => setOpen(!expanded)} aria-expanded={expanded} className="g-worklog-head flex items-center gap-2 rounded-md py-1 pe-2 text-sm text-muted-foreground hover:text-foreground">
          {running ? <span className="inline-block size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/35 border-t-primary" aria-hidden /> : <Brain className="size-3.5" />}
          <span>{summary}</span>
          {currentTitle}
          <ChevronDown className={`size-3.5 ${expanded ? "rotate-180" : ""}`} />
        </button>
        {expanded ? <div className="ms-2 mt-0.5 border-s ps-2">{parts.map(body)}</div> : null}
      </div>
    );
  }

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="g-worklog-head group/work flex items-center gap-2 rounded-lg py-1 pe-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className={`flex size-6 items-center justify-center rounded-md bg-muted transition-colors group-hover/work:bg-accent ${running ? "text-primary" : ""}`}>
          {running ? <Wrench className="size-3.5 animate-pulse" /> : <Brain className="size-3.5" />}
        </span>
        <span className={running ? "shimmer" : ""}>{summary}</span>
        {currentTitle}
        <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }} className="flex">
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="log"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="ms-3 mt-1 border-s ps-4">{parts.map(body)}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// When an answer arrived, on the browser clock: the time today, with the date on any other day.
const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" });
const dayKey = new Intl.DateTimeFormat("en-CA", {});

export function formatAnsweredAt(iso, now = new Date()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = clock.format(at);
  return dayKey.format(at) === dayKey.format(now) ? time : t("{day}، {time}", { day: day.format(at), time });
}

export function formatDuration(seconds, { compact = false } = {}) {
  if (seconds < 60) return compact ? t("{s}ث", { s: num(seconds) }) : t("{s} ثانیه", { s: num(seconds) });
  const m = num(Math.floor(seconds / 60));
  const rest = seconds % 60;
  const s = num(rest);
  if (compact) return rest ? t("{m}د {s}ث", { m, s }) : t("{m}د", { m });
  return rest ? t("{m} دقیقه و {s} ثانیه", { m, s }) : t("{m} دقیقه", { m });
}
