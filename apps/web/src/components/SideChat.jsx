import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, History, PanelRight, X } from "lucide-react";
import { api, useTimeline } from "../api.js";
import { textDir } from "../dir.js";
import { sidePaths } from "../side.js";
import { GriffinRuntime } from "../runtime.jsx";
import { isRtl, t } from "../i18n.js";
import { Thread } from "./Thread.jsx";
import { submitMode, useTouchPrimary } from "../touch.js";

// Side chat: a separate question next to a chat, without adding to it. It starts
// with that chat's conversation as context (server: seedTurns). A panel beside the thread on a
// desktop, a full-screen sheet on a phone; closing only hides it.

/** Header button that opens the side chat of the current chat. */
export function SideChatButton({ open, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={open}
      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-muted ${open ? "bg-muted text-foreground" : "text-muted-foreground"}`}
      title={t("چت کناری: یک سؤال جدا، بدون به‌هم‌زدن این گفتگو")}
    >
      <PanelRight className="size-4" />
      <span className="hidden sm:inline">{t("چت کناری")}</span>
    </button>
  );
}

export function SidePanel({ parentId, state, dispatch, settings, agentLabel, onError, seed, onSeedConsumed }) {
  const { open, activeId, sides } = state;

  useEffect(() => {
    if (!open || !parentId) return undefined;
    let alive = true;
    api(sidePaths.list(parentId))
      .then((data) => alive && dispatch({ type: "loaded", parentId, chats: data?.chats }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, parentId, dispatch]);

  // A seed (a quote from «به چت کناری») always lands on the fresh start screen.
  useEffect(() => {
    if (seed != null && activeId) dispatch({ type: "new" });
  }, [seed, activeId, dispatch]);

  if (!open || !parentId) return null;
  const active = sides.find((c) => c.id === activeId) || null;

  return (
    <aside className="side-panel fixed inset-0 z-40 flex flex-col bg-background md:static md:z-auto md:w-[26rem] md:shrink-0 md:border-s" aria-label={t("چت کناری")} dir={isRtl ? "rtl" : "ltr"}>
      <header className="flex min-w-0 items-center gap-1 border-b px-2 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)]">
        <h2 className="min-w-0 flex-1 truncate px-1.5 text-sm font-medium" dir="auto">{active?.title || t("چت کناری")}</h2>
        {activeId ? (
          <button type="button" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted" onClick={() => dispatch({ type: "new" })} title={t("چت‌های کناری و چت تازه")}>
            <History className="size-4" />
          </button>
        ) : null}
        <button type="button" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted" onClick={() => dispatch({ type: "close" })} title={t("بستن (چت کناری می‌ماند)")}>
          <X className="size-4" />
        </button>
      </header>
      {activeId ? (
        <SideThread key={activeId} chat={active} chatId={activeId} settings={settings} agentLabel={agentLabel} onError={onError} />
      ) : (
        <SideStart parentId={parentId} sides={sides} dispatch={dispatch} onError={onError} seed={seed} onSeedConsumed={onSeedConsumed} />
      )}
    </aside>
  );
}

// The same thread as the main chat, bound to the side chat: it streams, steers and queues alike.
function SideThread({ chat, chatId, settings, agentLabel, onError }) {
  const { timeline } = useTimeline(chatId);
  return (
    <div className="min-h-0 flex-1">
      <GriffinRuntime chatId={chatId} timeline={timeline} settings={settings} kept={chat?.kept || []} onError={onError}>
        <Thread chatId={chatId} agentLabel={agentLabel} agent={settings.agent} mode={settings.mode} model={settings.model} />
      </GriffinRuntime>
    </div>
  );
}

// No side chat picked: earlier ones of this chat, and a box that starts a new one.
function SideStart({ parentId, sides, dispatch, onError, seed, onSeedConsumed }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const touch = useTouchPrimary();
  const inputRef = useRef(null);
  useEffect(() => {
    if (!seed) return;
    setText(seed);
    onSeedConsumed?.();
    inputRef.current?.focus();
  }, [seed, onSeedConsumed]);
  // The box grows with its text (a quoted selection is often many lines), then scrolls.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      const { chat } = await api(sidePaths.create(parentId), { method: "POST", body: { text: value, images: [] } });
      setText("");
      dispatch({ type: "created", chat });
    } catch (error) {
      onError?.(error);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {sides.length ? (
          <>
            <p className="px-2.5 pb-1 pt-1 text-xs text-muted-foreground">{t("چت‌های کناری قبلی")}</p>
            <ul>
              {sides.map((chat) => (
                <li key={chat.id}>
                  <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-muted" onClick={() => dispatch({ type: "select", id: chat.id })}>
                    {chat.runStatus === "running" ? <span className="size-1.5 shrink-0 rounded-full bg-primary" title={t("در حال اجرا")} /> : null}
                    <span className="min-w-0 flex-1 truncate" dir="auto">{chat.title || t("چت کناری")}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">{t("یک سؤال جدا بپرس؛ گفتگوی اصلی دست نمی‌خورد، ولی چت کناری آن را می‌بیند.")}</p>
        )}
      </div>
      <div className="px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2">
        <div className="flex items-end gap-1 rounded-2xl border bg-card px-2 py-1.5 shadow-sm focus-within:border-primary/60">
          <textarea
            ref={inputRef}
            rows={1}
            dir={textDir(text) === "ltr" ? "ltr" : "rtl"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              const sends = submitMode(touch) === "enter" ? !e.shiftKey : e.ctrlKey || e.metaKey;
              if (sends) {
                e.preventDefault();
                send();
              }
            }}
            aria-label={t("پیام چت کناری")}
            placeholder={t("سؤال کناری‌ات را بنویس")}
            className="scrollbar-thin max-h-[45dvh] min-h-10 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-2 leading-7 outline-none placeholder:text-muted-foreground"
          />
          <button type="button" className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-30" onClick={send} disabled={sending || !text.trim()} title={t("ارسال")}>
            <ArrowUp className="size-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
