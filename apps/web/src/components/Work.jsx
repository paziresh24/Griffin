import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Brain, ChevronDown, Wrench } from "lucide-react";
import { unwrapResult } from "../result.js";
import { ToolCard, stepLine, stepTitle } from "./Tool.jsx";
import { locale, num, t } from "../i18n.js";
import { useFlag, useLook } from "../ui-prefs.js";
import { groupLabel, groupNow, groupWork } from "../work-groups.js";

// Tools whose output is the answer itself; they stay visible outside the collapsed work log.
// send_to_person: every message that reached a colleague keeps its «📤» card in sight; owner_task:
// the chore the board links to (its run often ends with no answer, so it was all folded away);
// consult: another model's answer, which the agent usually works on after (folded away otherwise).
const RESULT_TOOLS = new Set(["show_media", "s3_get", "visualize", "preview_start", "ask_owner", "ask_agent", "consult", "send_to_person", "owner_task"]);

// Splits an assistant run into the work log (thinking, tool calls, narration between them) and the
// answer (text after the last working tool, plus charts/files/questions wherever they appeared).
// An answered question is history: it stays where it happened in the work log. A question still
// open is pulled out — otherwise it sat under all later work. Open means not answered,
// not only "still running": a run that stopped leaves its question unanswered, and the card still
// takes an answer (as a new message); folded into the log it was never seen.
// Closed without an answer, so it stays history: the nag guard's duplicate, a plan-limit card once
// over, a withdrawn card, a chain nobody watches (scheduler/job/ops: refused for the owner), and a
// question the tool itself refused (a tool choice, an empty question: an error with its own text).
// Open: still waiting, or the run stopped/died (no result) or the owner did not answer in time.
function askClosed(part) {
  if (part.status === "running") return false;
  const { result, isError } = unwrapResult(part);
  if (result?.answered || result?.duplicate || part.args?.kind === "plan-fallback") return true;
  if (/nobody is watching|withdrawn/.test(String(result?.reason || ""))) return true;
  return Boolean(isError && result && !result.cancelled);
}
const isResult = (part) =>
  part.type === "tool" && RESULT_TOOLS.has(part.name) && !(part.name === "ask_owner" && askClosed(part));

// The built-in AskUserQuestion, when the host routed it through ask_owner, lands twice: as the native
// call (raw JSON, no card) and as the ask_owner card, whose callId is `<native callId>:ask:<n>`
// (Karsara's canUseAskUserQuestion; migrated chats carry both). The native twin is dropped once every
// one of its questions has its card: asked one at a time, a stopped run leaves the later ones only there.
// ExitPlanMode too: with PLAN_APPROVAL its plan is the ask_owner card `<native callId>:ask:plan`.
const TWINNED = new Set(["AskUserQuestion", "ExitPlanMode"]);
function askTwins(parts) {
  const cards = new Map();
  for (const part of parts) {
    const id = part?.type === "tool" && part.name === "ask_owner" ? String(part.callId || "") : "";
    if (id.includes(":ask:")) cards.set(id.slice(0, id.indexOf(":ask:")), (cards.get(id.slice(0, id.indexOf(":ask:"))) || 0) + 1);
  }
  const ids = new Set();
  for (const part of parts) {
    if (part?.type !== "tool" || !TWINNED.has(part.name)) continue;
    const asked = part.name === "AskUserQuestion" && Array.isArray(part.args?.questions) ? part.args.questions.length : 1;
    if ((cards.get(part.callId) || 0) >= Math.max(1, asked)) ids.add(part.callId);
  }
  return ids;
}

// The part types this renderer can draw. Any other type (a `suggestion` card, a `chapter` divider,
// or one added later) has no text and no tool fields: it is returned apart in `other` for the
// thread to draw (chat-tools.js answerItems), and otherwise not shown.
const DRAWN_PARTS = new Set(["text", "reasoning", "tool"]);

export function splitRun(parts) {
  const twins = askTwins(parts || []);
  const visible = (parts || []).filter((part) => DRAWN_PARTS.has(part?.type) && !(TWINNED.has(part.name) && twins.has(part.callId)));
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
  const karsara = useLook() === "karsara";
  // Folded by default, also while running (like Claude): the head says in one line
  // what the agent is doing right now. «مراحل کار باز، هنگام اجرا» (ui-prefs.js) keeps it open instead.
  const openWhileRunning = useFlag("workLogOpen");
  // «روایت بین مراحل» (like Claude Desktop): the agent's narration stays on the page and only the
  // steps between two narrations fold, each group on its own.
  const inline = useFlag("workInline");
  const expanded = open ?? (openWhileRunning ? running : false);
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
  const now = running && !openWhileRunning && !expanded ? nowLine(parts) : null;
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

  if (inline) return <InlineWork run={run} parts={parts} body={body} renderText={renderText} running={running} karsara={karsara} />;

  // The Karsara look: a flat row (a ring while running, no icon box, no motion) and no timeline dots.
  if (karsara) {
    return (
      <div className="my-2">
        <button type="button" onClick={() => setOpen(!expanded)} aria-expanded={expanded} className="g-worklog-head flex items-center gap-2 rounded-md py-1 pe-2 text-sm text-muted-foreground hover:text-foreground">
          {running ? <span className="inline-block size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/35 border-t-primary" aria-hidden /> : <Brain className="size-3.5" />}
          {now ? (
            <span dir="auto" className="min-w-0 flex-1 truncate">{now}</span>
          ) : (
            <>
              <span>{summary}</span>
              {currentTitle}
            </>
          )}
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
        <span className={`flex size-6 items-center justify-center rounded-md bg-muted transition-colors group-hover/work:bg-accent ${running ? "text-signal" : ""}`}>
          {running ? <Wrench className="size-3.5 animate-pulse" /> : <Brain className="size-3.5" />}
        </span>
        {now ? (
          <span dir="auto" className="shimmer min-w-0 flex-1 truncate">{now}</span>
        ) : (
          <>
            <span className={running ? "shimmer" : ""}>{summary}</span>
            {currentTitle}
          </>
        )}
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

// The work as narration plus folded step groups (flag workInline): «الان چک می‌کنم» stays as text,
// the commands that follow fold into «۳ دستور اجرا شد ⌄»; the group still running shows its newest step.
function InlineWork({ run, parts, body, renderText, running, karsara }) {
  const segments = groupWork(parts);
  return (
    <div className="my-2 flex flex-col gap-1">
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <div key={`t${i}`} className="py-1 text-[15px] leading-7">{renderText(seg.part, run)}</div>
        ) : (
          <StepGroup key={`s${i}`} parts={seg.parts} body={body} active={running && i === segments.length - 1} karsara={karsara} />
        ),
      )}
    </div>
  );
}

function StepGroup({ parts, body, active, karsara }) {
  const [open, setOpen] = useState(null);
  const expanded = open ?? false;
  const failed = !active && parts.some((p) => p.type === "tool" && toolProps(p).isError);
  const label = active ? groupNow(parts, stepLine) : groupLabel(parts, stepLine);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!expanded)} aria-expanded={expanded} className="g-worklog-head group/work flex max-w-full items-center gap-2 rounded-lg py-1 pe-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        {active ? (
          <span className="inline-block size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/35 border-t-primary" aria-hidden />
        ) : failed ? (
          <span className="size-2 shrink-0 rounded-full bg-bad" title={t("خطا")} aria-hidden />
        ) : (
          <Brain className="size-3.5 shrink-0" />
        )}
        <span dir="auto" className={`min-w-0 truncate ${active ? "shimmer" : ""}`}>{label}</span>
        <ChevronDown className={`size-3.5 shrink-0 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div key="log" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }} className="overflow-hidden">
            <div className={`ms-3 mt-1 border-s ps-4 ${karsara ? "ms-2 ps-2" : ""}`}>{parts.map(body)}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// The one line a folded, running work log shows: the newest step — a tool's plain title, the agent's
// own narration ("checking the disk…"), or that it is thinking.
export function nowLine(parts) {
  const last = parts[parts.length - 1];
  if (!last) return t("در حال کار");
  if (last.type === "reasoning") return t("در حال فکر کردن…");
  if (last.type === "tool") return stepLine(last.name, last.args) || t("در حال اجرای یک ابزار…");
  const text = String(last.text || "").replace(/\s+/g, " ").trim();
  const sentence = text.split(/(?<=[.!?؟。])\s/)[0]; // i18n-ignore (Persian question mark)
  return sentence ? sentence.slice(0, 160) : t("در حال کار");
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
