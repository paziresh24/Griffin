import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { unstable_useComposerInput, useAuiState } from "@assistant-ui/react";
import { AtSign, Bot, ChevronDown, GitFork, MessagesSquare, RefreshCw, Sparkles, X, Zap } from "lucide-react";
import { insertMention, mentionHandle, mentionQuery, mentionSpans } from "@griffin/timeline";
import { Popover } from "radix-ui";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { useFlag, useLook } from "../ui-prefs.js";
import {
  acceptsNextStep, dismissNextStep, enterPicks, fastNote, filterCommands, forkRunId, isClearCommand, moveIndex, nextStepReturnsOn, pickCommand, shownNextStep, slashQuery,
} from "../assist.js";
import { isRtl, locale, t } from "../i18n.js";
import { MENU } from "./Controls.jsx";
import { readChatsCache } from "../chats-cache.js";
import { SECTION, mentionRows, ownAgents, recentChats } from "../mention-pick.js";
import { MentionText } from "./Mention.jsx";

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
    // No chat yet (the new-chat page): the list of the engine a new chat runs on.
    const key = `${chatId || ""}|${model || ""}`;
    const cached = commandInfo.get(key);
    if (!cached || Date.now() - cached.at > 60_000) commandInfo.set(key, { at: Date.now(), promise: api(`/api/commands${chatId ? `?chat=${chatId}` : ""}`).catch(() => null) });
    let alive = true;
    commandInfo.get(key).promise.then((d) => alive && d && setInfo(d));
    return () => {
      alive = false;
    };
  }, [chatId, model]);
  return info;
}

// The agents «@» can tag: this install's own (GET /api/agents) and the colleagues' on the network
// (GET /api/network, connected ones) — one request a minute each, shared by every composer on the page.
// The owner's recent chats come from the sidebar's own list (chats-cache.js) when «@» is typed.
let tagSources = { at: 0, promise: null };
function useMentionables() {
  const [sources, setSources] = useState({ profiles: [], network: [] });
  useEffect(() => {
    if (!tagSources.promise || Date.now() - tagSources.at > 60_000) {
      tagSources = {
        at: Date.now(),
        promise: Promise.all([
          api("/api/agents").then((d) => d?.agents || [], () => []),
          api("/api/network").then((d) => (d?.agents || []).filter((a) => a.connected), () => []),
        ]).then(([profiles, network]) => ({ profiles, network })),
      };
    }
    let alive = true;
    tagSources.promise.then((v) => alive && setSources(v));
    return () => {
      alive = false;
    };
  }, []);
  return sources;
}

// The composer's «@» tags as chips (owner 2026-10-21, «مثل دیسکورد»): a copy of the box's text sits
// right behind the textarea, its words see-through, only the tags painted — so the owner's own text,
// caret and selection stay the textarea's. Only a tag that names a known agent (or a closed @«chat»)
// is a chip; a half-typed «@so» is not. Kept on the textarea's box: size, font, padding and scroll.
const MIRRORED = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingBottom", "paddingInlineStart", "paddingInlineEnd", "direction", "textAlign"];
export function MentionBackdrop({ inputRef }) {
  const chat = useContext(ChatRecord);
  const { value: text } = unstable_useComposerInput();
  const sources = useMentionables();
  const ref = useRef(null);
  const agents = [...ownAgents(sources.profiles, chat?.agent), ...sources.network];
  const handles = agents.map((a) => mentionHandle(a, agents));
  const tagged = mentionSpans(text, handles).some((s) => s.tag);
  useLayoutEffect(() => {
    const input = inputRef.current;
    const box = ref.current;
    if (!input || !box) return undefined;
    const sync = () => {
      const cs = getComputedStyle(input);
      for (const k of MIRRORED) box.style[k] = cs[k];
      // The scrollbar's side: start of the line in a right-to-left box.
      const bar = input.offsetWidth - input.clientWidth - input.clientLeft * 2;
      box.style.top = `${input.offsetTop + input.clientTop}px`;
      box.style.left = `${input.offsetLeft + input.clientLeft + (cs.direction === "rtl" ? bar : 0)}px`;
      box.style.width = `${input.clientWidth}px`;
      box.style.height = `${input.clientHeight}px`;
      box.scrollTop = input.scrollTop;
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(input);
    input.addEventListener("scroll", sync);
    return () => {
      ro.disconnect();
      input.removeEventListener("scroll", sync);
    };
  }, [inputRef, tagged, text]);
  if (!tagged) return null;
  return (
    <div ref={ref} aria-hidden="true" className="g-mention-backdrop pointer-events-none absolute z-0 overflow-hidden whitespace-pre-wrap break-words text-transparent">
      <MentionText text={text} handles={handles} />
      {"\u200b"}
    </div>
  );
}

// The suggested next message shown for the open chat (null when none). The composer asks once and
// hands it to ComposerAssist (Tab, the row) and, under the Karsara skin, to its ghost text.
export function useNextStep() {
  const chat = useContext(ChatRecord);
  const { value: text } = unstable_useComposerInput();
  const running = useAuiState((s) => s.thread.isRunning);
  const [dismissed, setDismissed] = useState(null);
  useEffect(() => setDismissed((d) => dismissNextStep(d, { suggestion: chat?.suggestion, text, running })), [text, running, chat?.suggestion]);
  return shownNextStep({ suggestion: chat?.suggestion, text, running, dismissed, returns: nextStepReturnsOn() });
}

// Above the composer's input: the «/» list, the suggested next message (Tab), the auto-continue
// row with its cancel, and Claude's fast-mode switch. Keys are caught on the input itself, before
// the composer's own Enter. Under the Karsara skin the next step is ghost text in the box, fast
// sits in the toolbar under it and the auto-continue notice in the header, so none show here.
export function ComposerAssist({ inputRef, next = null }) {
  const chat = useContext(ChatRecord);
  const headerResume = useFlag("headerCounts"); // the auto-continue notice sits in the header instead
  const ghost = useFlag("nextGhost"); // the next step is ghost text in the box instead
  const { value: text, setText } = unstable_useComposerInput();
  const [index, setIndex] = useState(0);
  const [moved, setMoved] = useState(false);
  const chatId = chat?.id || null;
  const info = useCommandInfo(chatId, chat?.model);
  const query = slashQuery(text);
  const list = query == null ? [] : filterCommands(info?.commands || [], query);
  // «@» tags our own agents, the colleagues' agents and the owner's recent chats (owner 2026-10-20): the
  // server tells the chat's agent to work with them here (mention-pick.js, mentions.mjs).
  const sources = useMentionables();
  const caret = inputRef.current?.selectionStart ?? String(text || "").length;
  const at = !list.length ? mentionQuery(text, caret) : null;
  const [dismissedAt, setDismissedAt] = useState(null);
  const own = ownAgents(sources.profiles, chat?.agent);
  const agents = [...own, ...sources.network]; // every taggable agent: the handles' twin rule reads them all
  const mentions = at && at.start !== dismissedAt ? mentionRows({ own, network: sources.network, chats: recentChats(readChatsCache()?.chats, chatId), query: at.query }) : [];

  useEffect(() => {
    setIndex(0);
    setMoved(false);
  }, [query, at?.query]);
  useEffect(() => {
    if (!at) setDismissedAt(null);
  }, [at?.start]);

  const choose = (command) => {
    if (command.local && command.name === "clear") {
      setText("");
      navigate(null);
    } else setText(pickCommand(command));
    inputRef.current?.focus();
  };
  const tag = (agent) => {
    const input = inputRef.current;
    const out = insertMention(text, input?.selectionStart ?? String(text || "").length, agent, agents);
    setText(out.text);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange?.(out.caret, out.caret);
    });
  };
  const state = useRef(null);
  state.current = { list, index, moved, query, next, text, choose, mentions, tag, at };
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
      if (s.mentions.length) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          stop(e);
          setIndex(moveIndex(s.index, s.mentions.length, e.key === "ArrowDown" ? 1 : -1));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          stop(e);
          s.tag(s.mentions[s.index] || s.mentions[0]);
          return;
        }
        if (e.key === "Escape") {
          stop(e);
          setDismissedAt(s.at?.start ?? null);
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

  // On the new-chat page (no chat yet) only the «/» list.
  const cancelResume = () => api(`/api/chats/${chat.id}/limit-resume`, { method: "DELETE" }).catch((e) => toast.error(e.message));
  const resumeShown = Boolean(chat?.limitResumeAt) && !headerResume;
  const nextShown = next && !ghost;
  if (!list.length && !mentions.length && !nextShown && !resumeShown) return null;

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
      {mentions.length ? (
        <div className="overflow-hidden rounded-lg border bg-card">
          <ul role="listbox" aria-label={t("تگ با @")} className="scrollbar-thin max-h-72 overflow-y-auto pb-1">
            {mentions.map((a, i) => {
              const kind = a.kind || "network";
              const heading = i === 0 || (mentions[i - 1].kind || "network") !== kind;
              return (
                <li key={`${kind}:${a.id}`} role="option" aria-selected={i === index}>
                  {heading ? (
                    <p className={`flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] text-muted-foreground ${i ? "mt-1 border-t" : ""}`}>
                      <AtSign className="size-3 shrink-0" />
                      {SECTION[kind]}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => tag(a)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-start ${i === index ? "bg-muted" : "hover:bg-muted/60"}`}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-medium text-primary">
                      {kind === "chat" ? <MessagesSquare className="size-3.5" /> : kind === "agent" ? <Bot className="size-3.5" /> : (a.name || "?").slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1 truncate" dir="auto">
                      <span className="font-medium text-foreground">{a.name}</span>
                      {kind === "network" && a.owner ? <span className="text-muted-foreground"> {t("· ایجنتِ {owner}", { owner: a.owner })}</span> : null}
                      {kind === "agent" && a.domain ? <span className="text-muted-foreground"> · {a.domain}</span> : null}
                      {kind === "chat" && a.runStatus === "running" ? <span className="text-muted-foreground"> {t("· در حال کار")}</span> : null}
                    </span>
                    {kind === "chat" ? null : <span className="shrink-0 text-muted-foreground" dir="auto">@{mentionHandle(a, agents)}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
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
    </div>
  );
}

// The fast switch flips at once; the chat record (the sidebar list) catches up a moment later, and a
// failed save flips it back.
function useFast(chat) {
  const [mine, setMine] = useState(null);
  const saved = Boolean(chat?.fast);
  useEffect(() => setMine(null), [saved, chat?.id]);
  const on = mine ?? saved;
  const toggle = () => {
    setMine(!on);
    api(`/api/chats/${chat.id}`, { method: "PATCH", body: { fast: !on } }).catch((e) => {
      setMine(null);
      toast.error(e.message);
    });
  };
  return [on, toggle];
}

// Claude's fast mode applies to the owner's own top-level chat only.
const fastAllowed = (chat, info) => info?.engine === "claude" && !chat.sideOf && !chat.parentChatId && (chat.caller || "owner") === "owner";

// Karsara skin: «⚡ سریع ▾» in the toolbar under the box, a switch in its popover.
export function FastToggle() {
  const chat = useContext(ChatRecord);
  const info = useCommandInfo(chat?.id || null, chat?.model);
  const [open, setOpen] = useState(false);
  const [on, toggle] = useFast(chat);
  if (!chat || !fastAllowed(chat, info)) return null;
  const note = fastNote({ fast: on, fastState: chat.fastState, model: chat.model });
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
        <Popover.Content align="end" side="top" sideOffset={8} collisionPadding={16} className={`${MENU} p-3`} dir={isRtl ? "rtl" : "ltr"}>
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

// Griffin skin: the same switch as a section at the foot of the model menu, like Claude's.
export function FastSwitch() {
  const chat = useContext(ChatRecord);
  const info = useCommandInfo(chat?.id || null, chat?.model);
  const [on, toggle] = useFast(chat);
  if (!chat || !fastAllowed(chat, info)) return null;
  const note = fastNote({ fast: on, fastState: chat.fastState, model: chat.model });
  return (
    <>
      <div className="my-1 h-px bg-border" />
      <p className="px-2.5 pt-1.5 text-xs text-muted-foreground">{t("حالت سریع")}</p>
      <button type="button" role="switch" aria-checked={on} onClick={toggle} title={t("فقط Opus، از مصرف اضافهٔ حساب؛ از نوبت بعد اثر می‌کند")} className="g-menu-row flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-muted">
        <span className="flex-1">{t("روشن کردن حالت سریع")}</span>
        <span dir="ltr" className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-primary" : "bg-muted-foreground/30"}`}>
          <span className={`absolute top-0.5 size-4 rounded-full bg-background shadow transition-transform ${on ? "translate-x-[1.125rem]" : "translate-x-0.5"}`} />
        </span>
      </button>
      {on && note ? <p className="px-2.5 pb-1 text-xs text-warn" dir="auto">{t("هنوز سریع نیست: {note}", { note })}</p> : null}
    </>
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
