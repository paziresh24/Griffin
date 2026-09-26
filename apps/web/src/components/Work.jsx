import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Brain, ChevronDown, Wrench } from "lucide-react";
import { unwrapResult } from "../result.js";
import { ToolCard } from "./Tool.jsx";

// Tools whose output is the answer itself; they stay visible outside the collapsed work log.
const RESULT_TOOLS = new Set(["show_media", "s3_get", "visualize", "ask_owner", "ask_agent"]);

// Splits an assistant run into the work log (thinking, tool calls, narration between them) and the
// answer (text after the last working tool, plus charts/files/questions wherever they appeared).
// An answered question is history: it stays where it happened in the work log. Only a question
// still waiting for the owner is pulled out — otherwise it sat under all later work (2026-09-24).
const isResult = (part) =>
  part.type === "tool" && RESULT_TOOLS.has(part.name) && !(part.name === "ask_owner" && part.status !== "running");

export function splitRun(parts) {
  let lastWork = -1;
  parts.forEach((part, i) => {
    if (part.type === "tool" && !isResult(part)) lastWork = i;
  });
  const work = [];
  const answer = [];
  parts.forEach((part, i) => {
    if (isResult(part)) answer.push(part);
    else if (part.type === "reasoning" || i <= lastWork) work.push(part);
    else answer.push(part);
  });
  return { work, answer };
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
  const expanded = open ?? running;
  if (!parts.length) return null;

  const tools = parts.filter((p) => p.type === "tool").length;
  const thoughts = parts.filter((p) => p.type === "reasoning").length;
  const seconds = run.endedAt && run.startedAt ? Math.max(1, Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 1000)) : null;
  const summary = [
    seconds ? `${formatDuration(seconds, { compact: true })} کار` : running ? "در حال کار" : "کار",
    tools ? `${tools.toLocaleString("fa-IR")} ابزار` : null,
    thoughts ? `${thoughts.toLocaleString("fa-IR")} فکر` : null,
  ].filter(Boolean).join(" · ");
  const current = running ? [...parts].reverse().find((p) => p.type === "tool") : null;

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        className="group/work flex items-center gap-2 rounded-lg py-1 pe-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className={`flex size-6 items-center justify-center rounded-md bg-muted transition-colors group-hover/work:bg-accent ${running ? "text-primary" : ""}`}>
          {running ? <Wrench className="size-3.5 animate-pulse" /> : <Brain className="size-3.5" />}
        </span>
        <span className={running ? "shimmer" : ""}>{summary}</span>
        {current && !expanded ? <span className="ltr max-w-48 truncate text-xs opacity-70">{current.name}</span> : null}
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
            <div className="ms-3 mt-1 border-s ps-4">
              {parts.map((part, i) => (
                <div key={part.callId || `${part.type}-${i}`} className="relative">
                  <span className="absolute -start-[1.3rem] top-3 size-2 rounded-full border-2 border-background bg-border" />
                  {part.type === "tool" ? (
                    <ToolCard {...toolProps(part)} />
                  ) : part.type === "reasoning" ? (
                    renderReasoning(part, run)
                  ) : (
                    <div className="py-1 text-sm text-muted-foreground">{renderText(part, run, true)}</div>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// When an answer arrived, on the Tehran clock: "۰۹:۳۴" today, with the date on any other day.
const TEHRAN = "Asia/Tehran";
const clock = new Intl.DateTimeFormat("fa-IR", { timeZone: TEHRAN, hour: "2-digit", minute: "2-digit", hour12: false });
const day = new Intl.DateTimeFormat("fa-IR", { timeZone: TEHRAN, day: "numeric", month: "long" });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TEHRAN });

export function formatAnsweredAt(iso, now = new Date()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = clock.format(at);
  return dayKey.format(at) === dayKey.format(now) ? time : `${day.format(at)}، ${time}`;
}

export function formatDuration(seconds, { compact = false } = {}) {
  const fa = (n) => n.toLocaleString("fa-IR");
  if (seconds < 60) return compact ? `${fa(seconds)}ث` : `${fa(seconds)} ثانیه`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (compact) return rest ? `${fa(minutes)}د ${fa(rest)}ث` : `${fa(minutes)}د`;
  return rest ? `${fa(minutes)} دقیقه و ${fa(rest)} ثانیه` : `${fa(minutes)} دقیقه`;
}
