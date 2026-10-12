import { createContext, useContext, useEffect, useRef, useState } from "react";
import { unstable_useComposerInput, useAuiState } from "@assistant-ui/react";
import { GitFork, RefreshCw, Sparkles, X, Zap } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import {
  acceptsNextStep, dismissNextStep, enterPicks, fastNote, filterCommands, forkRunId, isClearCommand, moveIndex, pickCommand, shownNextStep, slashQuery,
} from "../assist.js";
import { locale, t } from "../i18n.js";

// The open chat's record (App provides it): suggestion, auto-continue time, fast mode.
// A side chat's thread is outside it and gets none of this.
export const ChatRecord = createContext(null);

const clock = (ms) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });

// Above the composer's input: the «/» list, the suggested next message (Tab), the auto-continue
// row with its cancel, and Claude's fast-mode switch. Keys are caught on the input itself, before
// the composer's own Enter.
export function ComposerAssist({ inputRef }) {
  const chat = useContext(ChatRecord);
  const { value: text, setText } = unstable_useComposerInput();
  const running = useAuiState((s) => s.thread.isRunning);
  // { engine, commands } of the open chat (GET /api/commands), refreshed when its model changes.
  const [info, setInfo] = useState(null);
  const [index, setIndex] = useState(0);
  const [moved, setMoved] = useState(false);
  const [dismissed, setDismissed] = useState(null);
  const chatId = chat?.id || null;
  const query = chatId ? slashQuery(text) : null;
  const list = query == null ? [] : filterCommands(info?.commands || [], query);
  const next = shownNextStep({ suggestion: chat?.suggestion, text, running, dismissed });

  useEffect(() => {
    setInfo(null);
    if (!chatId) return undefined;
    let alive = true;
    api(`/api/commands?chat=${chatId}`).then((d) => alive && setInfo(d)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [chatId, chat?.model]);
  useEffect(() => {
    setIndex(0);
    setMoved(false);
  }, [query]);
  useEffect(() => setDismissed((d) => dismissNextStep(d, { suggestion: chat?.suggestion, text, running })), [text, running, chat?.suggestion]);

  const choose = (command) => {
    if (command.local && command.name === "clear") {
      setText("");
      navigate(null);
    } else setText(pickCommand(command));
    inputRef.current?.focus();
  };
  const state = useRef(null);
  state.current = { list, index, moved, query, next, text, choose };
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return undefined;
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onKey = (e) => {
      const s = state.current;
      if (e.isComposing) return;
      if (s.list.length) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          stop(e);
          setIndex(moveIndex(s.index, s.list.length, e.key === "ArrowDown" ? 1 : -1));
          setMoved(true);
          return;
        }
        const pick = s.list[s.index] || s.list[0];
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && enterPicks(pick, s.query, s.moved))) {
          stop(e);
          s.choose(pick);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey && isClearCommand(s.text)) {
        stop(e);
        setText("");
        navigate(null);
        return;
      }
      if (s.next && acceptsNextStep(e)) {
        stop(e);
        setText(s.next);
      }
    };
    input.addEventListener("keydown", onKey);
    return () => input.removeEventListener("keydown", onKey);
  }, [inputRef, setText]);

  if (!chat) return null;
  const fastShown = info?.engine === "claude" && !chat.sideOf && !chat.parentChatId && (chat.caller || "owner") === "owner";
  const note = fastShown ? fastNote({ fast: chat.fast, fastState: chat.fastState, model: chat.model }) : null;
  const setFast = () => api(`/api/chats/${chat.id}`, { method: "PATCH", body: { fast: !chat.fast } }).catch((e) => toast.error(e.message));
  const cancelResume = () => api(`/api/chats/${chat.id}/limit-resume`, { method: "DELETE" }).catch((e) => toast.error(e.message));
  if (!list.length && !next && !chat.limitResumeAt && !fastShown) return null;

  return (
    <div className="flex flex-col gap-1 px-2 pt-2 text-xs">
      {list.length ? (
        <ul role="listbox" aria-label={t("فرمان‌ها")} className="scrollbar-thin max-h-56 overflow-y-auto rounded-lg border bg-card py-1" dir="ltr">
          {list.map((c, i) => (
            <li key={`${c.name}-${i}`} role="option" aria-selected={i === index}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(c)}
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-start ${i === index ? "bg-muted" : "hover:bg-muted/60"}`}
              >
                <span className="shrink-0 font-mono text-foreground">/{c.name}</span>
                {c.argumentHint ? <span className="shrink-0 font-mono text-muted-foreground">{c.argumentHint}</span> : null}
                <span className="min-w-0 truncate text-muted-foreground" dir="auto">{c.description}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {chat.limitResumeAt ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted/60 ps-2 text-muted-foreground">
          <RefreshCw className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{t("سقف مصرف پر شد؛ ساعت {time} خودکار ادامه می‌دهد.", { time: clock(chat.limitResumeAt) })}</span>
          <button type="button" onClick={cancelResume} className="flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg px-2 hover:bg-muted hover:text-foreground" aria-label={t("لغو ادامهٔ خودکار")}>
            <X className="size-3.5" /> {t("لغو")}
          </button>
        </div>
      ) : null}
      {next ? (
        <button type="button" onClick={() => { setText(next); inputRef.current?.focus(); }} className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-start text-muted-foreground hover:bg-muted" title={t("Tab یا لمس: در کادر نوشته می‌شود؛ فقط با ارسال شما فرستاده می‌شود")}>
          <Sparkles className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" dir="auto">{next}</span>
          <kbd className="shrink-0 rounded border px-1 text-[10px]">Tab</kbd>
        </button>
      ) : null}
      {fastShown ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={setFast}
            aria-pressed={Boolean(chat.fast)}
            title={t("حالت سریع Claude: فقط روی Opus، از مصرف اضافهٔ حساب")}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${chat.fast ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
          >
            <Zap className="size-3" /> {t("سریع")}
          </button>
          {note ? <span className="text-muted-foreground">{note}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

// «ادامه در گفتگوی تازه از اینجا» under a finished reply of the owner's chat.
export function ForkButton({ run }) {
  const chat = useContext(ChatRecord);
  const [busy, setBusy] = useState(false);
  const runId = forkRunId(run, chat);
  if (!runId) return null;
  const fork = async () => {
    setBusy(true);
    try {
      const { chat: forked } = await api(`/api/chats/${chat.id}/fork`, { method: "POST", body: { runId } });
      navigate(forked.id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" disabled={busy} onClick={fork} title={t("ادامه در گفتگوی تازه از اینجا")} aria-label={t("ادامه در گفتگوی تازه از اینجا")} className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50">
      <GitFork className="size-3.5" />
    </button>
  );
}
