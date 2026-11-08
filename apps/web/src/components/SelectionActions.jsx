import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, MessageSquarePlus, MoreHorizontal, PanelLeft, PanelRight, Reply, Send, SquarePen } from "lucide-react";
import { filterMentionables } from "@griffin/timeline";
import { toast } from "sonner";
import { SELECTION_QUOTE_MAX } from "../side.js";
import { newChatContextNote, quoteStore, withQuotes } from "../quotes.js";
import { api, listedChats, navigate } from "../api.js";
import { newClientId } from "../outbox.js";
import { recentChats } from "../mention-pick.js";
import { useAutosize } from "../autosize.js";
import { useRuntimeChat } from "../runtime.jsx";
import { textDir } from "../dir.js";
import { useTouchPrimary } from "../touch.js";
import { isRtl, t } from "../i18n.js";
import { useModuleList } from "../module-hooks.js";
import { moduleView } from "../module-views.js";
import { moduleSelectionActions, selectionForModule } from "../modules.js";
import { MODULE_ICONS } from "./ModulePage.jsx";
import { ModuleActionDialog } from "./ModuleChatActions.jsx";
import { ChatRecord, MentionBackdropText, MentionList, useMentionPicker } from "./ComposerAssist.jsx";

// The side panel sits on the reading end's far side: left in RTL, right in LTR.
const SideIcon = isRtl ? PanelLeft : PanelRight;

// Reply to part of an answer: select text in an answer and a short toolbar offers
// «پاسخ» — a popup shows the selection, the owner writes what they think of it, and it waits folded
// above the composer until the message is sent — and «فرستادن به…»: the same popup with a target, a new
// chat (the note is then a required request; App handles griffin:new-chat-insert) or one of the recent
// chats (it goes there at once, and this chat stays open). Only selections inside an answer (.sd-block)
// count, never tool cards or the box. The rest sits behind «…»: «به چت کناری», which starts a side chat
// with the quote, and the enabled modules' own items (module.json selectionActions, e.g. board-app «به
// بک‌لاگ»): each opens that module's screen in a dialog with { chat: { id, title }, selection }.

// A very long selection is cut rather than carrying a whole answer.
const clip = (text) => (text.length > SELECTION_QUOTE_MAX ? `${text.slice(0, SELECTION_QUOTE_MAX).trimEnd()}…` : text);

// The main thread and the side chat each mount this; a selection belongs to the one it is in.
const inSide = (el) => Boolean(el?.closest?.(".side-panel"));

function selectionTarget(anchor) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = String(sel).trim();
  if (!text) return null;
  const node = sel.anchorNode;
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  if (!el?.closest?.(".sd-block") || inSide(el) !== inSide(anchor)) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;
  return { text, rect };
}

export function SelectionActions({ canSide = false }) {
  const { boxId, chatId } = useRuntimeChat();
  const [target, setTarget] = useState(null); // { text, rect } while a quotable selection is open
  const [quoting, setQuoting] = useState(null); // { text, x, y } while the note popup is open
  const [moduleOpen, setModuleOpen] = useState(null); // { module, action, selection } while a module's dialog is open
  const [more, setMore] = useState(false);
  const bar = useRef(null);
  const chat = useContext(ChatRecord);
  const moduleItems = moduleSelectionActions(useModuleList()).filter(({ module, action }) => moduleView(module.id, action.view));
  const anchor = useRef(null);
  const sync = useCallback(() => setTarget(selectionTarget(anchor.current)), []);
  // Whole inside the window, however long the selection or wide the toolbar.
  useLayoutEffect(() => {
    if (!bar.current) return;
    const half = bar.current.offsetWidth / 2 + 8;
    bar.current.style.left = `${Math.max(half, Math.min(window.innerWidth - half, target.rect.left + target.rect.width / 2))}px`;
  });
  useEffect(() => {
    if (!target) setMore(false);
  }, [target]);

  useEffect(() => {
    document.addEventListener("selectionchange", sync);
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      document.removeEventListener("selectionchange", sync);
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
    };
  }, [sync]);

  const drop = () => {
    setTarget(null);
    window.getSelection()?.removeAllRanges();
  };

  // The popup under the selection: «پاسخ» (kind "chat") or «فرستادن به…» (kind "send").
  const openPopup = (kind) => {
    if (!target) return;
    const text = clip(target.text);
    const width = Math.min(384, window.innerWidth - 24);
    const x = Math.max(12, Math.min(window.innerWidth - width - 12, target.rect.left + target.rect.width / 2 - width / 2));
    const y = Math.max(12, Math.min(window.innerHeight - 260, target.rect.bottom + 8));
    setQuoting({ text, x, y, width, kind });
    drop();
  };
  const addToChat = () => openPopup("chat");
  const sendElsewhere = () => openPopup("send");

  // into: a chat from the popup's list; none: a new chat. An existing chat gets the quote, the note and
  // the line naming this chat, as a queued message (it starts a run when none is going, server app.mjs).
  const submitQuote = async (note, into = null) => {
    if (quoting.kind === "send" && into) {
      const context = chatId ? newChatContextNote(chatId, chat?.title) : "";
      await api(`/api/chats/${into.id}/messages`, { method: "POST", body: { text: withQuotes([{ text: quoting.text, note }], context), intent: "queue", clientId: newClientId() } });
      setQuoting(null);
      toast.success(t("به «{name}» رفت", { name: into.name }), { action: { label: t("باز کردن"), onClick: () => navigate(into.id) } });
      return;
    }
    if (quoting.kind === "send") {
      window.dispatchEvent(new CustomEvent("griffin:new-chat-insert", { detail: { text: quoting.text, chatId, request: note.trim() } }));
      setQuoting(null);
      return;
    }
    quoteStore.add(boxId, { text: quoting.text, note });
    setQuoting(null);
    const side = inSide(anchor.current);
    [...document.querySelectorAll(".composer-box textarea")].find((box) => inSide(box) === side)?.focus();
  };

  const addToSide = () => {
    if (!target) return;
    window.dispatchEvent(new CustomEvent("griffin:side-insert", { detail: { quote: clip(target.text) } }));
    drop();
  };

  const openModule = (module, action) => {
    if (!target) return;
    setModuleOpen({ module, action, selection: selectionForModule(target.text) });
    drop();
  };
  const dialog = (
    <ModuleActionDialog
      open={moduleOpen}
      props={moduleOpen ? { chat: { id: chatId || chat?.id || "", title: chat?.title || "" }, selection: moduleOpen.selection } : null}
      onClose={() => setModuleOpen(null)}
    />
  );

  if (moduleOpen) {
    return (
      <>
        <span ref={anchor} hidden />
        {dialog}
      </>
    );
  }
  if (quoting) {
    return (
      <>
        <span ref={anchor} hidden />
        <QuotePopup quote={quoting} onSubmit={submitQuote} onCancel={() => setQuoting(null)} />
      </>
    );
  }
  if (!target) return <span ref={anchor} hidden />;
  // Above the selection; flips below near the viewport top (the effect above keeps it inside both edges).
  const x = target.rect.left + target.rect.width / 2;
  const threadTop = anchor.current?.closest("[data-griffin-chat]")?.querySelector("[data-griffin-thread]")?.getBoundingClientRect().top || 0;
  const below = target.rect.top - 44 < threadTop + 4; // not over the chat's header
  const y = below ? target.rect.bottom + 8 : target.rect.top - 44;
  const button = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 hover:bg-muted";
  // «چت کناری» stays a button of its own (owner 2026-11-05: «سه تا که بود خوب بود»); modules go behind «…».
  const side = canSide && !inSide(anchor.current);
  const moreItems = [
    ...moduleItems.map(({ module, action }) => ({ key: `${module.id}:${action.id}`, icon: MODULE_ICONS[action.icon] || MODULE_ICONS.puzzle, label: action.label, title: module.title, run: () => openModule(module, action) })),
  ];
  return (
    <>
      <span ref={anchor} hidden />
      <div
        ref={bar}
        className="g-sel-actions fixed z-50 flex items-center rounded-lg border bg-card p-0.5 text-xs shadow-lg"
        style={{ left: x, top: y, transform: `translateX(-50%)${below ? " translateY(100%)" : ""}` }}
        dir={isRtl ? "rtl" : "ltr"}
        onMouseDown={(e) => e.preventDefault()}
      >
        <button type="button" className={button} onClick={addToChat} title={t("این بخش را نقل کن و نظرت را دربارهٔ آن بنویس")}>
          <Reply className="size-3.5" /> {t("پاسخ")}
        </button>
        <span className="h-4 w-px bg-border" aria-hidden />
        <button type="button" className={button} onClick={sendElsewhere} title={t("این بخش را به چت جدید یا یکی از چت‌های دیگر بفرست")}>
          <Send className="size-3.5 rtl:-scale-x-100" /> {t("فرستادن به…")}
        </button>
        {side ? (
          <>
            <span className="h-4 w-px bg-border" aria-hidden />
            <button type="button" className={button} onClick={addToSide} title={t("با این نقل، چت کناری را شروع کن")}>
              <SideIcon className="size-3.5" /> {t("چت کناری")}
            </button>
          </>
        ) : null}
        {moreItems.length ? (
          <>
            <span className="h-4 w-px bg-border" aria-hidden />
            <div className="relative">
              <button type="button" className={`${button} px-1.5`} onClick={() => setMore(!more)} aria-expanded={more} aria-label={t("کارهای بیشتر با این متن")}>
                <MoreHorizontal className="size-3.5" />
              </button>
              {more ? (
                <div className={`absolute end-0 z-10 w-max min-w-36 rounded-lg border bg-card p-0.5 shadow-lg ${below ? "top-full mt-1" : "bottom-full mb-1"}`}>
                  {moreItems.map(({ key, icon: Icon, label, title, run }) => (
                    <button key={key} type="button" className={`${button} w-full`} onClick={run} title={title}>
                      <Icon className="size-3.5" /> {label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

// «فرستادن به…»: the new chat or one of the owner's chats (the sidebar's own list), newest first.
function TargetPicker({ into, onPick, from, open, onOpen }) {
  const [query, setQuery] = useState("");
  const chats = filterMentionables(recentChats(listedChats(), from), query, 30);
  const row = "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs hover:bg-muted";
  const pick = (chat) => {
    onPick(chat);
    onOpen(false);
  };
  return (
    <div className="flex flex-col gap-1">
      <button type="button" onClick={() => onOpen(!open)} aria-expanded={open} className="flex min-w-0 items-center gap-1.5 rounded-lg border bg-background px-2 py-1.5 text-start text-xs hover:border-primary/60">
        <span className="shrink-0 text-muted-foreground">{t("به:")}</span>
        <span className="min-w-0 flex-1 truncate" dir="auto">{into ? into.name : t("چت جدید")}</span>
        <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="rounded-lg border bg-card p-1">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onOpen(false);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (chats[0]) pick(chats[0]);
              }
            }}
            placeholder={t("جستجوی چت…")}
            aria-label={t("جستجوی چت")}
            dir="auto"
            className="mb-1 w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary/60"
          />
          <div className="scrollbar-thin max-h-48 overflow-y-auto">
            {query ? null : (
              <button type="button" className={row} onClick={() => pick(null)}>
                <SquarePen className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1">{t("چت جدید")}</span>
                {into ? null : <Check className="size-3.5 shrink-0 text-primary" />}
              </button>
            )}
            {chats.map((chat) => (
              <button key={chat.id} type="button" className={row} onClick={() => pick(chat)}>
                <MessageSquarePlus className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate" dir="auto">{chat.name}</span>
                {into?.id === chat.id ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
              </button>
            ))}
            {query && !chats.length ? <p className="px-2 py-2 text-xs text-muted-foreground">{t("چتی با این نام نیست.")}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QuotePopup({ quote, onSubmit, onCancel }) {
  const { chatId } = useRuntimeChat();
  const chat = useContext(ChatRecord);
  const [note, setNote] = useState("");
  const [into, setInto] = useState(null); // the chat it goes to (null: a new chat), kind "send" only
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = quote.kind === "send";
  const fresh = sending && !into; // a new chat: the note is the request it starts with
  const ready = !busy && (!fresh || Boolean(note.trim())); // required there; optional otherwise
  const box = useRef(null);
  const input = useRef(null);
  useAutosize(input, note);
  const touch = useTouchPrimary(); // on a phone Enter is a new line, as in the composer
  const picker = useMentionPicker({ inputRef: input, text: note, setText: setNote, chatId, chatAgent: chat?.agent });
  // On touch the popup docks at the top, where the on-screen keyboard does not cover it.
  const place = touch
    ? { left: 12, top: "max(12px, env(safe-area-inset-top))", width: "calc(100vw - 24px)" }
    : { left: quote.x, top: quote.y, width: quote.width };
  // A click outside closes it without adding (the selection can be picked again).
  useEffect(() => {
    const onDown = (event) => {
      if (!box.current?.contains(event.target)) onCancel();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onCancel]);
  // As the text grows the box stays whole on screen: it moves up, then scrolls only at the screen's height.
  useLayoutEffect(() => {
    if (touch || !box.current) return undefined;
    const keepInside = () => {
      box.current.style.top = `${Math.max(12, Math.min(quote.y, window.innerHeight - box.current.offsetHeight - 12))}px`;
    };
    keepInside();
    const watcher = new ResizeObserver(keepInside);
    watcher.observe(box.current);
    return () => watcher.disconnect();
  }, [touch, quote.y]);
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await onSubmit(note, into);
    } catch (error) {
      // Nothing is lost: the popup stays with what was written.
      toast.error(t("فرستاده نشد: {message}", { message: error.message }));
      setBusy(false);
    }
  };
  const action = !sending ? t("افزودن") : fresh ? t("شروع چت جدید") : t("فرستادن");
  return (
    <div
      ref={box}
      className="g-quote-pop scrollbar-thin fixed z-50 flex max-h-[calc(100dvh-24px)] flex-col gap-2 overflow-y-auto rounded-xl border bg-card p-2.5 text-sm shadow-xl"
      style={place}
      dir={isRtl ? "rtl" : "ltr"}
      role="dialog"
      aria-label={sending ? t("فرستادن این نقل به چت دیگر") : t("نقل به گفتگو")}
    >
      <div className="scrollbar-thin max-h-28 shrink-0 overflow-y-auto border-s-2 ps-2 text-xs text-muted-foreground" dir={textDir(quote.text)}>
        {quote.text}
      </div>
      {sending ? <TargetPicker into={into} onPick={setInto} from={chatId} open={picking} onOpen={setPicking} /> : null}
      <MentionList picker={picker} />
      <div className="relative shrink-0 rounded-lg border bg-background focus-within:border-primary/60">
        <MentionBackdropText inputRef={input} text={note} />
        <textarea
          ref={input}
          autoFocus
          rows={2}
          value={note}
          dir={note ? textDir(note) : isRtl ? "rtl" : "ltr"}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || picker.onKey(event)) return;
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            } else if (!touch && event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          aria-label={fresh ? t("خواسته‌ات از چت جدید") : t("نظر دربارهٔ این بخش")}
          placeholder={fresh ? t("در چت جدید چه می‌خواهی؟") : into ? t("چیزی که با این متن می‌خواهی (اختیاری)") : t("نظرت دربارهٔ این بخش (اختیاری)")}
          className="scrollbar-thin relative z-[1] block max-h-[60dvh] w-full resize-none rounded-lg bg-transparent px-2 py-1.5 outline-none"
        />
      </div>
      <div className="flex shrink-0 justify-end gap-2 text-xs">
        <button type="button" className="rounded-md px-2.5 py-1 hover:bg-muted" onClick={onCancel}>{t("انصراف")}</button>
        <button type="button" className="g-btn-primary rounded-md bg-primary px-2.5 py-1 text-primary-foreground disabled:opacity-50" disabled={!ready} onClick={submit} title={touch ? action : `${action} (Enter)`}>
          {action}
        </button>
      </div>
    </div>
  );
}
