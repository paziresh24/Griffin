import { createContext, useContext, useEffect, useRef, useState } from "react";
import { unstable_useComposerInput, useAuiState } from "@assistant-ui/react";
import { ChevronDown, GitFork, RefreshCw, Sparkles, X, Zap } from "lucide-react";
import { Popover } from "radix-ui";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { useSkin } from "../skin.js";
import {
  acceptsNextStep, dismissNextStep, enterPicks, fastNote, filterCommands, forkRunId, isClearCommand, moveIndex, pickCommand, shownNextStep, slashQuery,
} from "../assist.js";
import { isRtl, locale, t } from "../i18n.js";

// The open chat's record (App provides it): suggestion, auto-continue time, fast mode.
// A side chat's thread is outside it and gets none of this.
export const ChatRecord = createContext(null);

const clock = (ms) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });

// { engine, commands } of a chat (GET /api/commands): one request per chat and model (a minute at
// most) shared by every part of the composer that asks.
const commandInfo = new Map();
function useCommandInfo(chatId, model) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    setInfo(null);
    if (!chatId) return undefined;
    const key = `${chatId}|${model || ""}`;
    const cached = commandInfo.get(key);
    if (!cached || Date.now() - cached.at > 60_000) commandInfo.set(key, { at: Date.now(), promise: api(`/api/commands?chat=${chatId}`).catch(() => null) });
    let alive = true;
    commandInfo.get(key).promise.then((d) => alive && d && setInfo(d));
    return () => {
      alive = false;
    };
  }, [chatId, model]);
  return info;
}

// The suggested next message shown for the open chat (null when none). The composer asks once and
// hands it to ComposerAssist (Tab, the row) and, under the Karsara skin, to its ghost text.
export function useNextStep() {
  const chat = useContext(ChatRecord);
  const { value: text } = unstable_useComposerInput();
  const running = useAuiState((s) => s.thread.isRunning);
  const [dismissed, setDismissed] = useState(null);
  useEffect(() => setDismissed((d) => dismissNextStep(d, { suggestion: chat?.suggestion, text, running })), [text, running, chat?.suggestion]);
  return shownNextStep({ suggestion: chat?.suggestion, text, running, dismissed });
}

// Above the composer's input: the «/» list, the suggested next message (Tab), the auto-continue
// row with its cancel, and Claude's fast-mode switch. Keys are caught on the input itself, before
// the composer's own Enter. Under the Karsara skin the next step is ghost text in the box, fast
// sits in the toolbar under it and the auto-continue notice in the header, so none show here.
export function ComposerAssist({ inputRef, next = null }) {
  const chat = useContext(ChatRecord);
  const karsara = useSkin() === "karsara";
  const { value: text, setText } = unstable_useComposerInput();
  const [index, setIndex] = useState(0);
  const [moved, setMoved] = useState(false);
  const chatId = chat?.id || null;
  const info = useCommandInfo(chatId, chat?.model);
  const query = chatId ? slashQuery(text) : null;
  const list = query == null ? [] : filterCommands(info?.commands || [], query);

  useEffect(() => {
    setIndex(0);
    setMoved(false);
  }, [query]);

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
  const fastShown = !karsara && fastAllowed(chat, info);
  const note = fastShown ? fastNote({ fast: chat.fast, fastState: chat.fastState, model: chat.model }) : null;
  const setFast = () => api(`/api/chats/${chat.id}`, { method: "PATCH", body: { fast: !chat.fast } }).catch((e) => toast.error(e.message));
  const cancelResume = () => api(`/api/chats/${chat.id}/limit-resume`, { method: "DELETE" }).catch((e) => toast.error(e.message));
  const resumeShown = Boolean(chat.limitResumeAt) && !karsara;
  const nextShown = next && !karsara;
  if (!list.length && !nextShown && !resumeShown && !fastShown) return null;

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
      {resumeShown ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted/60 ps-2 text-muted-foreground">
          <RefreshCw className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{t("سقف مصرف پر شد؛ ساعت {time} خودکار ادامه می‌دهد.", { time: clock(chat.limitResumeAt) })}</span>
          <button type="button" onClick={cancelResume} className="flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg px-2 hover:bg-muted hover:text-foreground" aria-label={t("لغو ادامهٔ خودکار")}>
            <X className="size-3.5" /> {t("لغو")}
          </button>
        </div>
      ) : null}
      {nextShown ? (
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

// Claude's fast mode applies to the owner's own top-level chat only.
const fastAllowed = (chat, info) => info?.engine === "claude" && !chat.sideOf && !chat.parentChatId && (chat.caller || "owner") === "owner";

// Karsara skin: «⚡ سریع ▾» in the toolbar under the box, a switch in its popover.
export function FastToggle() {
  const chat = useContext(ChatRecord);
  const info = useCommandInfo(chat?.id || null, chat?.model);
  const [open, setOpen] = useState(false);
  if (!chat || !fastAllowed(chat, info)) return null;
  const on = Boolean(chat.fast);
  const note = fastNote({ fast: on, fastState: chat.fastState, model: chat.model });
  const toggle = () => api(`/api/chats/${chat.id}`, { method: "PATCH", body: { fast: !on } }).catch((e) => toast.error(e.message));
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={`g-text-btn inline-flex shrink-0 items-center gap-1 px-1 text-[13px] hover:text-foreground ${on ? "text-primary" : "text-muted-foreground"}`} aria-label={on ? t("حالت سریع: روشن") : t("حالت سریع: خاموش")} title={t("حالت سریع Claude: فقط روی Opus، از مصرف اضافهٔ حساب")}>
          <Zap className={`size-3.5 shrink-0 ${on ? "fill-current" : ""}`} />
          <span className="max-[480px]:hidden">{t("سریع")}</span>
          {on && note ? <span className="size-1.5 shrink-0 rounded-full bg-warn" aria-hidden /> : null}
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" side="top" sideOffset={8} collisionPadding={16} className="g-menu pop z-50 w-72 max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-3 shadow-xl" dir={isRtl ? "rtl" : "ltr"}>
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{t("سریع")}</span>
              <span className="block text-xs text-muted-foreground">{t("هزینهٔ اضافه؛ فقط Opus. از نوبت بعد این گفتگو اثر می‌کند.")}</span>
            </span>
            <button type="button" role="switch" aria-checked={on} aria-label={t("حالت سریع")} onClick={toggle} dir="ltr" className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-primary" : "bg-muted"}`}>
              <span className={`block size-5 rounded-full bg-background shadow transition-transform ${on ? "translate-x-[1.375rem]" : "translate-x-0.5"}`} />
            </button>
          </div>
          {on && note ? <p className="mt-2 text-xs text-warn" dir="auto">{t("هنوز سریع نیست: {note}", { note })}</p> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
    <button type="button" disabled={busy} onClick={fork} title={t("ادامه در گفتگوی تازه از اینجا")} aria-label={t("ادامه در گفتگوی تازه از اینجا")} className="g-icon-btn rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50">
      <GitFork className="size-3.5" />
    </button>
  );
}
