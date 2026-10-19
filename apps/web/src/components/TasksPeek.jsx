import { useContext, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, ChevronDown, ExternalLink, FileText, Loader2, Network, Square, SquareTerminal } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { TASKS_LABEL, endedLabel, pollMs, recentEnded, runningChildren, runningFor, taskKind, taskTitle, visibleTasks } from "../tasks-peek.js";
import { ChatChildrenContext } from "./Tool.jsx";
import { t } from "../i18n.js";

const plainBtn = "press rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50";

/**
 * Config CLAUDE_BACKGROUND_TASKS: above the composer, like QueuePeek — the background shells and
 * agents Claude Code started in this chat that still run after its answer, each with its own stop.
 * Nothing shows when there are none (with the setting off the list is always empty).
 */
export function TasksPeek({ chatId }) {
  const [tasks, setTasks] = useState([]);
  const [ended, setEnded] = useState([]);
  const [output, setOutput] = useState(null); // { id, text, truncated } or { id, error }
  const [gone, setGone] = useState(() => new Set());
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const items = useMemo(() => visibleTasks(tasks, gone), [tasks, gone]);
  // This chat's own sub-agents (delegate / ask_agent) that run now sit in the same list: one place
  // for «what is running behind this answer», each with its chat and its stop.
  const children = useContext(ChatChildrenContext);
  const agents = useMemo(() => runningChildren(children).filter((c) => !gone.has(c.id)), [children, gone]);
  const [detail, setDetail] = useState(null); // id of the running row that is opened

  useEffect(() => {
    if (!chatId) return undefined;
    let alive = true;
    let timer = null;
    const load = async () => {
      let count = 0;
      let enabled = true;
      try {
        const data = await api(`/api/chats/${chatId}/tasks`);
        count = (data?.tasks?.length || 0) + (data?.ended?.length || 0);
        // The setting is off: asked once per chat, then never again.
        enabled = data?.enabled !== false || count > 0;
        if (alive) {
          setTasks(data?.tasks || []);
          setEnded(data?.ended || []);
          setNow(Date.now());
        }
      } catch {
        /* the next poll tries again */
      }
      if (alive && enabled) timer = setTimeout(load, pollMs(count));
    };
    setTasks([]);
    setEnded([]);
    setOutput(null);
    setGone(new Set());
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [chatId]);

  const done = useMemo(() => recentEnded(ended, now), [ended, now]);
  useEffect(() => {
    if (!items.length && !agents.length && !done.length) setOpen(false);
  }, [items.length, agents.length, done.length]);

  // The end of an ended task's output (GET …/tasks/:id/output); a second click hides it.
  const showOutput = async (task) => {
    if (output?.id === task.id) return setOutput(null);
    try {
      const data = await api(`/api/chats/${chatId}/tasks/${encodeURIComponent(task.id)}/output`);
      setOutput({ id: task.id, ...data });
    } catch (error) {
      setOutput({ id: task.id, error: error?.message || String(error) });
    }
  };

  const stop = async (task) => {
    if (!window.confirm(`«${taskTitle(task)}» متوقف شود؟`)) return;
    setBusy(task.id);
    try {
      await api(`/api/chats/${chatId}/tasks/${encodeURIComponent(task.id)}/stop`, { method: "POST" });
      setGone((prev) => new Set(prev).add(task.id));
    } catch (error) {
      toast.error(`متوقف نشد: ${error?.message || error}`);
    } finally {
      setBusy(null);
    }
  };

  const stopAgent = async (child) => {
    if (!window.confirm(`«${child.title}» متوقف شود؟`)) return;
    setBusy(child.id);
    try {
      await api(`/api/chats/${child.id}/cancel`, { method: "POST" });
      setGone((prev) => new Set(prev).add(child.id));
    } catch (error) {
      toast.error(`متوقف نشد: ${error?.message || error}`);
    } finally {
      setBusy(null);
    }
  };

  const running = items.length + agents.length;
  const first = items[0] || agents[0] || done[0];
  const more = running + done.length - 1;
  return (
    <AnimatePresence initial={false}>
      {first ? (
        <motion.div
          key="tasks"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className="g-peek g-tasks-peek relative z-0 mx-3 -mb-3 rounded-t-xl border border-b-0 bg-muted px-3 pb-3.5 pt-1.5 text-xs"
        >
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full min-w-0 items-center gap-1.5 py-0.5 text-start text-muted-foreground hover:text-foreground">
            {running ? <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" /> : <CheckCircle2 className="size-3.5 shrink-0 text-ok" />}
            <span className="shrink-0 text-foreground">{running ? TASKS_LABEL : endedLabel(first.status)}</span>
            <span className="min-w-0 flex-1 truncate" dir="auto">{first.title || taskTitle(first)}</span>
            {more > 0 ? <span className="g-tag shrink-0 tabular-nums" dir="ltr">+{more.toLocaleString("fa-IR")}</span> : null}
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
                {items.map((task) => {
                  const opened = detail === task.id;
                  return (
                    <li key={task.id} className="g-note-item rounded-lg border px-2.5 py-1.5">
                      <div className="flex items-center gap-2">
                        <button type="button" aria-expanded={opened} onClick={() => setDetail(opened ? null : task.id)} className="flex min-w-0 flex-1 items-center gap-2 text-start">
                          <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px]" dir="auto">{taskTitle(task)}</span>
                            <span className="block text-muted-foreground">{taskKind(task.type)} · {runningFor(task.startedAt, now)}</span>
                          </span>
                          <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${opened ? "rotate-180" : ""}`} />
                        </button>
                        <button type="button" className={`g-text-btn ${plainBtn} flex shrink-0 items-center gap-1`} disabled={busy != null} onClick={() => stop(task)}>
                          <Square className="size-3" /> توقف
                        </button>
                      </div>
                      {opened ? (
                        <div className="mt-1.5 space-y-1 text-muted-foreground">
                          {task.detail ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 font-mono text-[11px] leading-5 text-foreground" dir="ltr">{task.detail}</pre> : null}
                          <p>
                            <span dir="ltr" className="font-mono">{task.id}</span>
                            {task.subagentType ? ` · ${task.subagentType}` : ""}
                            {" — "}خروجی بعد از پایان کار خوانده می‌شود (Claude Code تا آن موقع فایل خروجی را اعلام نمی‌کند).
                          </p>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
                {agents.map((child) => (
                  <li key={child.id} className="g-note-item flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
                    <Network className="size-3.5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px]" dir="auto">{child.title}</p>
                      <p className="text-muted-foreground">{t("زیرایجنت گریفین · در حال کار")}</p>
                    </div>
                    <button type="button" className={`g-text-btn ${plainBtn} flex shrink-0 items-center gap-1`} onClick={() => navigate(child.id)}>
                      <ExternalLink className="size-3" /> دیدن چت
                    </button>
                    <button type="button" className={`g-text-btn ${plainBtn} flex shrink-0 items-center gap-1`} disabled={busy != null} onClick={() => stopAgent(child)}>
                      <Square className="size-3" /> توقف
                    </button>
                  </li>
                ))}
                {done.map((task) => (
                  <li key={task.id} className="g-note-item rounded-lg border px-2.5 py-1.5">
                    <div className="flex items-center gap-2">
                      <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px]" dir="auto">{taskTitle(task)}</p>
                        <p className="text-muted-foreground">{taskKind(task.type)} · {endedLabel(task.status)}</p>
                      </div>
                      <button type="button" className={`g-text-btn ${plainBtn} flex shrink-0 items-center gap-1`} aria-expanded={output?.id === task.id} onClick={() => showOutput(task)}>
                        <FileText className="size-3" /> خروجی
                      </button>
                    </div>
                    {output?.id === task.id ? (
                      output.error ? (
                        <p className="mt-1.5 text-bad" dir="auto">{output.error}</p>
                      ) : (
                        <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 font-mono text-[11px] leading-5" dir="ltr">{output.truncated ? "…\n" : ""}{output.text || t("(خالی)")}</pre>
                      )
                    ) : null}
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
