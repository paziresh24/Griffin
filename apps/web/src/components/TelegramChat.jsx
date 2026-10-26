import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { Bell, Check, CheckCheck, ChevronDown, ChevronLeft, Copy, Download, FileText, Link2, Menu, MessageCircle, Mic, Moon, MoreHorizontal, PanelLeft, Pencil, Reply, Send, Trash2, User, Users, Video, X, Zap } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { BRAND, readSetting, writeSetting } from "../brand.js";
import { ago } from "../chat-list.js";
import { exactTime } from "../elapsed.js";
import {
  PICKUPS, TG_FOLDERS, clock, connectionLine, conversationRows, folderCount, folderPeople, lineSource, personChip, tgMode, waitingKind, waitingSend, watchHint,
} from "../telegram.js";
import { Chip, Dots, FEED_PATH, PEOPLE_PATH, PersonAvatar, PersonHeader, Toggle, openGlobal, patchAccess, refreshTelegram, useTelegram } from "./Telegram.jsx";
import { t, isRtl } from "../i18n.js";

// «تلگرام مثل خود تلگرام» (flag telegramChat; owner 2026-10-24: «بخش چتا واقعا چت نیست»). A person's
// whole Telegram conversation as Telegram draws it, inside Griffin: what the assistant did hangs under
// the message it answers and opens its Griffin chat; every line it sent says which chat sent it; the
// box below writes either to the assistant (the colleague never sees it) or straight to the person.

const failed = (error) => toast.error(error.message || t("انجام نشد"));
const FOLDER_ICON = { all: MessageCircle, wait: Bell, run: Zap, personal: User, groups: Users, chats: Link2, off: Moon };
const MODE = {
  auto: { dot: "bg-ok", pill: "border-ok/40 bg-ok/10 text-ok", label: t("{name} جواب می‌دهد", { name: BRAND.name }) },
  chats: { dot: "bg-signal", pill: "border-signal/40 bg-signal/10 text-signal", label: t("فقط از گفتگوهای شما") },
  off: { dot: "border border-muted-foreground", pill: "text-muted-foreground", label: t("{name} کاری ندارد", { name: BRAND.name }) },
};
const FOLDER_KEY = "griffin.telegram.folder";
const PANEL_KEY = "griffin.telegram.chatPanel";

// ---------- the sidebar: folders as icons, everyone in one list ----------

export function TelegramFolders({ query, activeId, activePersonId, onNavigate }) {
  const people = useTelegram(PEOPLE_PATH);
  const feed = useTelegram(FEED_PATH);
  const [folder, setFolderState] = useState(() => readSetting(FOLDER_KEY, "all"));
  const setFolder = (id) => {
    setFolderState(id);
    writeSetting(FOLDER_KEY, id);
  };
  const waiting = feed?.waiting || [];
  const waits = new Set(waiting.map((w) => w.personId));
  const list = folderPeople(people?.people, folder, { query, waiting });
  const line = connectionLine(feed);
  const current = TG_FOLDERS.find((f) => f.id === folder) || TG_FOLDERS[0];
  const globalActive = Boolean(activeId && activeId === feed?.globalChatId);
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          openGlobal();
          onNavigate?.();
        }}
        className={`mb-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start ${globalActive ? "bg-muted" : "hover:bg-muted/60"}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{t("🌐 {name} — همه", { name: BRAND.name })}</span>
          {line ? <span className={`block truncate text-[11px] ${line.tone === "ok" ? "text-ok" : line.tone === "bad" ? "text-bad" : "text-muted-foreground"}`} title={line.title}>{line.text}</span> : null}
        </span>
        {waiting.length ? <span className="shrink-0 rounded-full bg-bad px-1.5 text-[11px] leading-5 tabular-nums text-white" title={t("منتظر شما")}>{waiting.length.toLocaleString("fa-IR")}</span> : null}
      </button>

      <nav className="flex gap-0.5" aria-label={t("دسته‌ها")}>
        {TG_FOLDERS.map((f) => {
          const Icon = FOLDER_ICON[f.id];
          const n = f.id === "all" ? 0 : folderCount(people?.people, f.id, waiting);
          const on = f.id === current.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFolder(f.id)}
              aria-pressed={on}
              aria-label={f.label}
              title={f.label}
              className={`press relative flex h-9 flex-1 items-center justify-center rounded-lg ${on ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            >
              <Icon className="size-[18px]" />
              {n ? (
                <span className={`absolute end-0.5 top-0.5 min-w-4 rounded-full px-1 text-[10px] leading-4 tabular-nums ${f.id === "wait" ? "bg-bad text-white" : on ? "bg-primary text-primary-foreground" : "bg-muted-foreground text-background"}`}>
                  {n.toLocaleString("fa-IR")}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{current.label}</p>

      {!people ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("در حال بارگذاری…")}</p> : null}
      <ul>
        {list.map((p) => (
          <FolderRow
            key={p.id}
            person={p}
            waits={waits.has(p.id)}
            active={p.id === activePersonId || (activeId && p.chatId === activeId)}
            onOpen={() => {
              window.location.hash = `/telegram/${p.id}`;
              onNavigate?.();
            }}
          />
        ))}
      </ul>
      {people && !list.length ? <p className="px-3 py-6 text-center text-xs text-muted-foreground">{query.trim() ? t("کسی پیدا نشد.") : t("این دسته خالی است.")}</p> : null}
    </div>
  );
}

function FolderRow({ person: p, waits, active, onOpen }) {
  const mode = tgMode(p);
  const sub = p.running ? (
    <span className="flex items-center gap-1 text-signal">{t("{name} دارد کار می‌کند", { name: BRAND.name })} <Dots /></span>
  ) : waits ? (
    <span className="text-bad">{t("منتظر شما")}</span>
  ) : mode === "chats" ? (
    <span dir="auto">{t("از گفتگوی «{v}»", { v: p.fromChats.at(-1)?.title || t("شما") })}</span>
  ) : (
    personChip(p)?.label || (p.username ? `@${p.username}` : "")
  );
  return (
    <li>
      <button type="button" onClick={onOpen} className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start ${active ? "bg-muted" : "hover:bg-muted/60"}`}>
        <PersonAvatar personId={p.id} name={p.name} className="size-9" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={`size-[7px] shrink-0 rounded-full ${MODE[mode].dot}`} title={MODE[mode].label} />
            {p.group ? <Users className="size-3 shrink-0 text-muted-foreground" aria-label={t("گروه")} /> : null}
            <span className="min-w-0 truncate text-sm" dir="auto">{p.name}</span>
            <span className="ms-auto shrink-0 text-[11px] tabular-nums text-muted-foreground" title={exactTime(p.lastAt)}>{ago(p.lastAt)}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{sub}</span>
            {waits ? <span className="size-2 shrink-0 rounded-full bg-bad" /> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

// ---------- the conversation page: #/telegram/<personId> ----------

// The conversation as Telegram has it (GET /api/telegram/chat/:id, read live from the owner's account;
// without one, the history this install kept): the newest page polled, older pages kept as loaded.
function useConversation(personId) {
  const [state, setState] = useState({ messages: null, live: false, more: false, readInboxMaxId: 0, unread: 0 });
  const older = useRef([]);
  const reload = useCallback(
    () =>
      api(`/api/telegram/chat/${personId}?limit=80`).then(
        (r) => {
          const latest = r.messages || [];
          const first = Number(latest[0]?.id) || Infinity;
          setState((s) => ({
            messages: [...older.current.filter((m) => Number(m.id) < first), ...latest],
            live: Boolean(r.live),
            more: older.current.length ? s.more : Boolean(r.more),
            readInboxMaxId: r.readInboxMaxId || 0,
            unread: r.unread || 0,
          }));
        },
        (error) => setState((s) => ({ ...s, messages: s.messages || [], error: error.message })),
      ),
    [personId],
  );
  const loadOlder = useCallback(async () => {
    const all = [...older.current];
    const oldest = Number(older.current[0]?.id || state.messages?.[0]?.id) || 0;
    if (!oldest) return;
    const r = await api(`/api/telegram/chat/${personId}?limit=80&before=${oldest}`).catch(failed);
    if (!r) return;
    older.current = [...(r.messages || []), ...all];
    setState((s) => ({ ...s, more: Boolean(r.more), messages: [...(r.messages || []), ...(s.messages || [])] }));
  }, [personId, state.messages]);
  useEffect(() => {
    older.current = [];
    reload();
    const timer = setInterval(() => document.visibilityState === "visible" && reload(), 4_000);
    return () => clearInterval(timer);
  }, [reload]);
  return { ...state, reload, loadOlder };
}

function useThreads(personId) {
  const [threads, setThreads] = useState([]);
  useEffect(() => {
    let alive = true;
    const load = () => api(`/api/telegram/persons/${personId}/threads`).then((r) => alive && setThreads(r.threads || []), () => {});
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [personId]);
  return threads;
}

// Telegram's own id of a line: the live rows carry it as msgId; a kept history line only when it has one.
const telegramId = (m) => {
  const id = Number(m?.data?.msgId ?? (m?.data?.by === "assistant" || m?.data?.by === "chat" ? null : m?.id));
  return Number.isInteger(id) && id > 0 ? id : null;
};
const snippet = (text, n = 90) => (String(text || "").length > n ? `${String(text).slice(0, n)}…` : String(text || ""));
const MEDIA_LABEL = { photo: t("عکس"), sticker: t("استیکر"), gif: t("گیف"), video: t("ویدیو"), voice: t("پیام صوتی"), audio: t("صدا"), file: t("فایل"), other: t("پیوست") };
const preview = (m) => m?.text || (m?.media ? `${m.media.emoji || ""} ${MEDIA_LABEL[m.media.kind] || t("پیوست")}`.trim() : "");

export function TelegramChat({ personId, onMenu }) {
  const people = useTelegram(PEOPLE_PATH);
  const feed = useTelegram(FEED_PATH);
  const person = people?.people?.find((p) => p.id === personId) || null;
  const convo = useConversation(personId);
  const { messages, live } = convo;
  const threads = useThreads(personId);
  const [panel, setPanelState] = useState(() => readSetting(PANEL_KEY, "open") === "open");
  const setPanel = (open) => {
    setPanelState(open);
    writeSetting(PANEL_KEY, open ? "open" : "closed");
  };
  const [sheet, setSheet] = useState(false);
  const [reply, setReply] = useState(null);
  const [editing, setEditing] = useState(null);
  const [notes, setNotes] = useState([]); // what the owner told the assistant from here (this visit only)
  const [flash, setFlash] = useState(null);
  const [unreadFrom, setUnreadFrom] = useState(null); // the «پیام‌های تازه» line: what was unread when opened
  const scroller = useRef(null);
  const atBottom = useRef(true);
  const marked = useRef(0);
  const mode = tgMode(person);
  const rows = conversationRows(messages, { group: Boolean(person?.group) });
  const waiting = (feed?.waiting || []).filter((w) => w.personId === personId);
  const running = (threads || []).filter((t) => !t.closed && t.runStatus === "running");
  const lastIn = [...rows].reverse().find((r) => r.type === "message" && r.message.direction === "in")?.key;
  const firstUnread = unreadFrom ? rows.find((r) => r.type === "message" && r.message.direction === "in" && Number(r.message.id) > unreadFrom)?.key : null;

  useEffect(() => {
    if (unreadFrom == null && messages && live && convo.unread) setUnreadFrom(convo.readInboxMaxId);
  }, [messages, live, convo.unread, convo.readInboxMaxId, unreadFrom]);
  // Read, as Telegram marks it: the conversation is open, on screen and scrolled to its end.
  useEffect(() => {
    const newest = Number(messages?.at(-1)?.id) || 0;
    if (!live || !convo.unread || !atBottom.current || document.visibilityState !== "visible" || marked.current >= newest) return;
    marked.current = newest;
    api(`/api/telegram/chat/${personId}/read`, { method: "POST" }).catch(() => {});
  }, [messages, live, convo.unread, personId]);
  // Follow new lines only while the owner is at the bottom (reading older ones is not interrupted).
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages?.length, notes, waiting.length, person?.running]);

  const jump = (m) => {
    const el = document.getElementById(`tg-${m.id}`);
    if (!el) return toast(t("آن پیام در این صفحه نیست؛ پیام‌های قبلی را بیاورید"));
    el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setFlash(m.id);
    setTimeout(() => setFlash(null), 1400);
  };
  const act = (path, body, done) =>
    api(`/api/telegram/chat/${personId}/${path}`, { method: "POST", body }).then(() => {
      if (done) toast.success(done);
      convo.reload();
    }, failed);
  const actions = {
    reply: (m) => {
      setEditing(null);
      setReply(m);
    },
    react: (m, emoji) => act("react", { messageId: telegramId(m), emoji: m.reactions?.some((r) => r.mine && r.emoji === emoji) ? null : emoji }),
    edit: (m) => {
      setReply(null);
      setEditing(m);
    },
    remove: (m) => act("delete", { messageId: telegramId(m) }, t("پیام برای همه حذف شد")),
    copy: (m) =>
      navigator.clipboard?.writeText(m.text || "").then(() => toast.success(t("کپی شد")), () => toast.error(t("کپی نشد"))),
  };

  if (!people) return <p className="py-10 text-center text-sm text-muted-foreground">{t("در حال باز کردن…")}</p>;
  if (!person) return <p className="py-10 text-center text-sm text-muted-foreground">{t("این شخص پیدا نشد.")}</p>;

  const work = (
    <div className="mt-1 space-y-1">
      {person.running ? (
        <WorkCard onClick={() => person.chatId && navigate(person.chatId)} title={t("{name} دارد روی این کار می‌کند", { name: BRAND.name })} badge={<span className="flex items-center gap-1 rounded-full bg-signal/12 px-2 text-[11px] leading-5 text-signal">{t("در حال کار")} <Dots /></span>} />
      ) : null}
      {running.map((th) => (
        <WorkCard key={th.id} onClick={() => navigate(th.id)} title={String(th.title || t("ترد")).replace(/^🧵\s*[^:]*:\s*/, "")} badge={<span className="flex items-center gap-1 rounded-full bg-signal/12 px-2 text-[11px] leading-5 text-signal">{t("در حال کار")} <Dots /></span>} />
      ))}
      {waiting.map((item) => <WaitingCard key={item.id} item={item} onDone={convo.reload} />)}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-2 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)] sm:px-4">
          <button type="button" onClick={onMenu} className="rounded-lg p-2 hover:bg-muted md:hidden" aria-label={t("منو")}><Menu className="size-5" /></button>
          <button type="button" onClick={() => (window.matchMedia("(min-width: 768px)").matches ? setPanel(!panel) : setSheet(true))} className="flex min-w-0 flex-1 items-center gap-2.5 text-start">
            <PersonAvatar personId={person.id} name={person.name} className="size-8" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium" dir="auto">{person.name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {person.running ? <span className="text-signal">{t("{name} دارد کار می‌کند…", { name: BRAND.name })}</span> : person.group ? t("گروه") : person.username ? <span dir="ltr">@{person.username}</span> : person.tgName}
              </span>
            </span>
          </button>
          <button type="button" onClick={() => (window.matchMedia("(min-width: 768px)").matches ? setPanel(true) : setSheet(true))} className={`press hidden shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] sm:flex ${MODE[mode].pill}`}>
            <span className={`size-1.5 rounded-full ${MODE[mode].dot}`} />
            {MODE[mode].label}
          </button>
          <button type="button" onClick={() => setPanel(!panel)} className="hidden rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground md:block" aria-label={t("پنل کناری")} title={t("پنل کناری")}>
            <PanelLeft className="size-4" />
          </button>
        </header>

        {mode === "chats" ? (
          <div className="flex items-center gap-3 border-b bg-signal/5 px-4 py-2 text-xs">
            <span className="w-0.5 self-stretch rounded bg-signal" />
            <span className="min-w-0 flex-1 leading-5">
              <b className="block font-medium text-signal">{t("چرا اینجاست؟")}</b>
              {t("گفتگوی «{title}» با {name} حرف زده. {name2} بقیهٔ پیام‌هایش را خودکار جواب نمی‌دهد.", { title: person.fromChats.at(-1)?.title, name: person.name, name2: BRAND.name })}
            </span>
            <button type="button" onClick={() => patchAccess(person.id, { watch: true }).then(() => toast.success(t("پاسخ خودکار روشن شد")), failed)} className="press shrink-0 rounded-lg border bg-card px-2.5 py-1 hover:bg-muted">
              {t("خودکار هم جواب بده")}
            </button>
          </div>
        ) : null}
        {messages && !live ? <p className="border-b bg-warn/10 px-4 py-1.5 text-xs text-muted-foreground">{t("اکانت تلگرام وصل نیست؛ آنچه {name} ثبت کرده نشان داده می‌شود (بدون ری‌اکشن، ویرایش و حذف).", { name: BRAND.name })}</p> : null}

        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="scrollbar-thin min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-0.5 px-3 py-4 sm:px-5">
            {convo.more ? (
              <button type="button" onClick={convo.loadOlder} className="press mb-2 self-center rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground hover:bg-muted">{t("پیام‌های قبلی")}</button>
            ) : null}
            {messages == null ? <p className="py-10 text-center text-sm text-muted-foreground">{t("در حال خواندن پیام‌ها…")}</p> : null}
            {messages?.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">{convo.error || t("هنوز پیامی نیست.")}</p> : null}
            {rows.map((row) =>
              row.type === "day" ? (
                <span key={row.key} className="sticky top-1.5 z-10 my-2 self-center rounded-full border bg-background/85 px-2.5 text-[11px] text-muted-foreground backdrop-blur">{row.label}</span>
              ) : (
                <Fragment key={row.key}>
                  {row.key === firstUnread ? <div className="my-2 flex items-center gap-3 text-[11px] text-bad before:h-px before:flex-1 before:bg-bad/40 after:h-px after:flex-1 after:bg-bad/40">{t("پیام‌های تازه")}</div> : null}
                  <Bubble row={row} person={person} live={live} personId={personId} flash={flash === row.message.id} onJump={jump} actions={actions}>
                    {row.key === lastIn ? work : null}
                  </Bubble>
                </Fragment>
              ),
            )}
            {!lastIn && (person.running || running.length || waiting.length) ? work : null}
            {notes.map((n) => (
              <div key={n.id} className="mt-2 max-w-[85%] self-end rounded-2xl rounded-ee-md border-[1.5px] border-dashed px-3 py-1.5 text-sm">
                <span className="block text-[11px] text-muted-foreground">{t("🔒 فقط {name} می‌بیند", { name: BRAND.name })}</span>
                <span className="whitespace-pre-wrap break-words" dir="auto">{n.text}</span>
                {person.chatId ? (
                  <button type="button" onClick={() => navigate(person.chatId)} className="mt-0.5 block text-[11px] text-primary hover:underline">{t("دیدن جوابش در گفتگوی {name} ›", { name: BRAND.name })}</button>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <Composer
          person={person}
          mode={mode}
          reply={reply}
          editing={editing}
          onClear={() => {
            setReply(null);
            setEditing(null);
          }}
          onSent={() => {
            atBottom.current = true;
            convo.reload();
          }}
          onNote={(text) => setNotes((list) => [...list, { id: Date.now(), text }])}
        />
      </div>

      {panel ? <aside className="scrollbar-thin hidden w-72 shrink-0 overflow-y-auto border-s bg-card/50 p-3 md:block"><PersonPanel person={person} threads={threads} /></aside> : null}
      {sheet ? (
        <>
          <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setSheet(false)} />
          <aside className="fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t bg-card p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] shadow-xl md:hidden">
            <button type="button" onClick={() => setSheet(false)} className="float-end rounded-lg p-1.5 text-muted-foreground hover:bg-muted" aria-label={t("بستن")}><X className="size-4" /></button>
            <PersonPanel person={person} threads={threads} />
          </aside>
        </>
      ) : null}
    </div>
  );
}

function WorkCard({ title, badge, onClick }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2 rounded-xl border bg-card px-2.5 py-1.5 text-start text-xs hover:border-primary/50">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-medium text-primary">{BRAND.name.slice(0, 1)}</span>
      <span className="min-w-0 flex-1 truncate font-medium" dir="auto">{title}</span>
      {badge}
      <ChevronLeft className="rtl-mirror size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

// Something of this person's waits for the owner (a held draft, a question): its buttons right here.
function WaitingCard({ item, onDone }) {
  const send = waitingSend(item.kind, item.op);
  const act = (action) =>
    api(`/api/telegram/waiting/${item.id}`, { method: "POST", body: { action } }).then(() => {
      refreshTelegram();
      onDone?.();
      if (action === "send") toast.success(send?.done || t("انجام شد"));
    }, failed);
  return (
    <div className="space-y-1">
      <div className="rounded-xl border border-dashed border-primary/60 bg-card px-3 py-2 text-xs">
        <span className="flex items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-medium text-primary">{BRAND.name.slice(0, 1)}</span>
          <span className="min-w-0 flex-1 font-medium">{waitingKind(item.kind, item.reason, item.op) || t("منتظر شما")}</span>
          <span className="shrink-0 rounded-full bg-bad px-2 text-[11px] leading-5 text-white">{t("منتظر شما")}</span>
        </span>
        {item.text ? <span className="mt-1 block whitespace-pre-wrap break-words text-sm leading-6" dir="auto">{item.text}</span> : null}
      </div>
      <div className="flex flex-wrap gap-1">
        {send ? <button type="button" onClick={() => act("send")} className="press flex-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">{send.label}</button> : null}
        {item.chatId ? <button type="button" onClick={() => navigate(item.chatId)} className="press flex-1 rounded-lg border bg-card px-3 py-1.5 text-xs hover:bg-muted">{t("باز کردن در {name}", { name: BRAND.name })}</button> : null}
        <button type="button" onClick={() => act("dismiss")} className="press flex-1 rounded-lg border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted">{t("ولش کن")}</button>
      </div>
    </div>
  );
}

const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "👏"];
const fileSize = (n) => (n == null ? "" : n < 1024 * 1024 ? t("{toLocaleString} کیلوبایت", { toLocaleString: Math.max(1, Math.round(n / 1024)).toLocaleString("fa-IR") }) : t("{toLocaleString} مگابایت", { toLocaleString: (n / 1024 / 1024).toLocaleString("fa-IR", { maximumFractionDigits: 1 }) }));
const seconds = (s) => (s == null ? "" : `${Math.floor(s / 60).toLocaleString("fa-IR")}:${String(Math.floor(s % 60)).padStart(2, "0").replace(/\d/g, (d) => t("۰۱۲۳۴۵۶۷۸۹")[d])}`);

function Media({ m, personId, live }) {
  const media = m.media;
  const id = telegramId(m);
  const src = (thumb) => `/api/telegram/chat/${personId}/media/${id}${thumb ? "?thumb=1" : ""}`;
  if (!live || !id) return <span className="block text-xs text-muted-foreground">[{MEDIA_LABEL[media.kind] || t("پیوست")}]</span>;
  if (media.kind === "photo" || media.kind === "sticker" || (media.kind === "gif" && media.size < 3e6)) {
    return (
      <a href={src(false)} target="_blank" rel="noreferrer" className="my-1 block">
        <img src={media.kind === "photo" ? src(false) : src(true)} alt={MEDIA_LABEL[media.kind]} loading="lazy" className={`max-h-80 max-w-full rounded-xl object-contain ${media.kind === "sticker" ? "size-32" : ""}`} />
      </a>
    );
  }
  const Icon = media.kind === "voice" || media.kind === "audio" ? Mic : media.kind === "video" || media.kind === "gif" ? Video : FileText;
  return (
    <a href={src(false)} target="_blank" rel="noreferrer" className="my-1 flex items-center gap-2.5 rounded-xl bg-background/50 p-1.5 pe-3 hover:bg-background/80">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-signal/15 text-signal"><Icon className="size-5" /></span>
      <span className="min-w-0">
        <b className="block truncate text-xs font-medium" dir="auto">{media.name || MEDIA_LABEL[media.kind]}</b>
        <span className="flex gap-2 text-[11px] text-muted-foreground">
          {media.seconds != null ? <span>{seconds(media.seconds)}</span> : null}
          <span>{fileSize(media.size)}</span>
          <Download className="size-3 self-center" />
        </span>
      </span>
    </a>
  );
}

function Bubble({ row, person, live, personId, flash, onJump, actions, children }) {
  const { message: m, first, last, replyTo } = row;
  const [menu, setMenu] = useState(false);
  const out = m.direction === "out";
  const source = lineSource(m);
  const from = !out && person.group ? m.data?.from : null;
  const tgId = telegramId(m);
  const canAct = live && tgId;
  const via =
    source?.kind === "auto" ? (
      <span className="text-[11px] font-normal text-muted-foreground">
        {t("با ")}
        <button type="button" onClick={() => source.chatId && navigate(source.chatId)} className="font-medium text-primary hover:underline">{BRAND.name}</button> {t("· خودکار")}
      </span>
    ) : source?.kind === "chat" ? (
      <span className="text-[11px] font-normal text-muted-foreground">
        {t("با {name} · از ", { name: BRAND.name })}
        <button type="button" onClick={() => source.chatId && navigate(source.chatId)} className="font-medium text-primary hover:underline" dir="auto">«{source.title || t("یک گفتگو")}»</button>
      </span>
    ) : null;
  const quoteName = (q) => (q.direction === "in" ? q.data?.from || person.name : lineSource(q)?.kind === "owner" ? t("شما") : BRAND.name);
  return (
    <div id={`tg-${m.id}`} className={`group relative flex max-w-[88%] flex-col ${out ? "self-end" : "self-start"} ${first ? "mt-2" : ""}`}>
      <div
        onContextMenu={(e) => {
          if (!canAct) return;
          e.preventDefault();
          setMenu(true);
        }}
        className={`relative min-w-24 break-words rounded-2xl px-3 py-1.5 text-sm leading-7 ${out ? "bg-accent" : "border bg-muted/50"} ${
          last ? (out ? "rounded-ee-md" : "rounded-es-md") : ""
        } ${flash ? "ring-2 ring-primary/60" : ""}`}
      >
        {(from || via) && first ? (
          <span className="flex flex-wrap items-baseline gap-1.5 text-xs font-medium">
            {from ? <span className="text-signal" dir="auto">{from}</span> : null}
            {via}
          </span>
        ) : null}
        {m.fwd ? <span className="block text-[11px] text-signal">{t("بازارسال از")} <b className="font-medium" dir="auto">{m.fwd}</b></span> : null}
        {replyTo ? (
          <button
            type="button"
            onClick={() => onJump(replyTo)}
            className={`my-1 block w-full rounded-md border-s-[3px] px-2 py-0.5 text-start text-xs leading-5 ${out ? "border-primary bg-primary/10" : "border-signal bg-signal/8"}`}
          >
            <b className={`block font-medium ${out ? "text-primary" : "text-signal"}`} dir="auto">{quoteName(replyTo)}</b>
            <span className="block truncate opacity-80" dir="auto">{preview(replyTo)}</span>
          </button>
        ) : null}
        {m.media ? <Media m={m} personId={personId} live={live} /> : null}
        {m.text ? <span className="whitespace-pre-wrap" dir="auto">{m.text}</span> : null}
        <span className="relative top-1.5 float-end ms-2.5 flex items-center gap-1 text-[10.5px] tabular-nums text-muted-foreground" title={exactTime(m.at)}>
          {m.edited ? <span>{t("ویرایش‌شده")}</span> : null}
          {clock(m.at)}
          {out && live ? (m.read ? <CheckCheck className="size-3.5 text-primary" aria-label={t("خوانده شد")} /> : <Check className="size-3.5" aria-label={t("رسید")} />) : null}
        </span>
        {m.reactions?.length ? (
          <span className="clear-both flex flex-wrap gap-1 pt-1.5">
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                disabled={!canAct}
                onClick={() => actions.react(m, r.emoji)}
                className={`press rounded-full border px-1.5 text-xs leading-5 ${r.mine ? "border-primary bg-primary/15" : "bg-background/60"}`}
              >
                {r.emoji} {r.count > 1 || !r.mine ? r.count.toLocaleString("fa-IR") : ""}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {children}
      {canAct ? (
        <Popover.Root open={menu} onOpenChange={setMenu}>
          <Popover.Trigger asChild>
            <button
              type="button"
              className={`absolute top-1 flex size-7 items-center justify-center rounded-lg border bg-card text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 ${out ? "-start-9" : "-end-9"} max-md:opacity-60`}
              aria-label={t("کارهای این پیام")}
              title={t("کارهای این پیام")}
            >
              <MoreHorizontal className="size-4" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content side="top" align={out ? "end" : "start"} sideOffset={6} collisionPadding={12} className="g-menu pop z-50 w-56 rounded-xl border bg-card p-1 text-sm shadow-xl" dir={isRtl ? "rtl" : "ltr"}>
              <div className="flex flex-wrap justify-between gap-0.5 border-b px-1 pb-1">
                {QUICK.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => {
                      setMenu(false);
                      actions.react(m, e);
                    }}
                    className={`press rounded-md p-1 text-lg leading-none hover:bg-muted ${m.reactions?.some((r) => r.mine && r.emoji === e) ? "bg-primary/15" : ""}`}
                  >
                    {e}
                  </button>
                ))}
              </div>
              {[
                [Reply, t("پاسخ"), () => actions.reply(m)],
                m.text ? [Copy, t("کپی متن"), () => actions.copy(m)] : null,
                out && (m.text || m.media) ? [Pencil, t("ویرایش"), () => actions.edit(m)] : null,
                out || !person.group ? [Trash2, t("حذف برای همه"), null] : null,
              ]
                .filter(Boolean)
                .map(([Icon, label, fn]) =>
                  fn ? (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        setMenu(false);
                        fn();
                      }}
                      className="g-menu-row flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start hover:bg-muted"
                    >
                      <Icon className="size-4 text-muted-foreground" />
                      {label}
                    </button>
                  ) : (
                    <DeleteRow key={label} onConfirm={() => {
                      setMenu(false);
                      actions.remove(m);
                    }} />
                  ),
                )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </div>
  );
}

// Deleting is for everyone and cannot be undone: the row asks once more in place.
function DeleteRow({ onConfirm }) {
  const [sure, setSure] = useState(false);
  return sure ? (
    <div className="flex items-center gap-1 rounded-lg bg-bad/10 px-2 py-1 text-xs">
      <span className="min-w-0 flex-1 text-bad">{t("از تلگرام هر دو طرف پاک شود؟")}</span>
      <button type="button" onClick={onConfirm} className="press rounded-md bg-bad px-2 py-0.5 text-white">{t("حذف")}</button>
      <button type="button" onClick={() => setSure(false)} className="press rounded-md px-2 py-0.5 text-muted-foreground hover:bg-muted">{t("نه")}</button>
    </div>
  ) : (
    <button type="button" onClick={() => setSure(true)} className="g-menu-row flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-bad hover:bg-bad/10">
      <Trash2 className="size-4" />
      {t("حذف برای همه")}
    </button>
  );
}

// Who the box writes to: the assistant (through the person's chat here; the colleague never sees it) or
// the person, straight from the owner's Telegram account. Editing one of the owner's lines takes the box.
function Composer({ person, mode, reply, editing, onClear, onSent, onNote }) {
  const canAssistant = Boolean(person.chatId);
  const [to, setTo] = useState(canAssistant ? "assistant" : "direct");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  useEffect(() => setTo(person.chatId ? "assistant" : "direct"), [person.id, person.chatId]);
  useEffect(() => {
    if (editing) setText(editing.text || "");
    if (editing || reply) box.current?.focus();
  }, [editing, reply]);
  const first = person.group ? person.name : String(person.name || "").split(" ")[0];
  const target = editing ? "direct" : to;
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      if (editing) {
        await api(`/api/telegram/chat/${person.id}/edit`, { method: "POST", body: { messageId: telegramId(editing), text: value } });
        toast.success(t("ویرایش شد"));
        onSent();
      } else if (to === "assistant") {
        const said = reply ? t("دربارهٔ این پیام در تلگرام: «{snippet}»\n\n{value}", { snippet: snippet(preview(reply), 300), value }) : value;
        await api(`/api/chats/${person.chatId}/messages`, { method: "POST", body: { text: said, intent: "queue" } });
        onNote(value);
        toast.success(t("به {name} رسید؛ {first} نمی‌بیند", { name: BRAND.name, first }));
      } else {
        const replyTo = telegramId(reply);
        await api("/api/telegram/send", { method: "POST", body: { chat: person.key, text: value, ...(replyTo ? { replyTo } : {}) } });
        onSent();
      }
      setText("");
      onClear();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };
  const bar = editing || reply;
  return (
    <div className="px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-1 sm:px-4">
      <div className="mx-auto max-w-3xl space-y-1">
        {bar ? (
          <div className="flex items-center gap-2 px-2 text-xs">
            {editing ? <Pencil className="size-4 shrink-0 text-primary" /> : <Reply className="size-4 shrink-0 text-primary" />}
            <span className="min-w-0 flex-1">
              <b className="block font-medium text-primary">{editing ? t("ویرایش پیام") : to === "assistant" ? t("به {name} دربارهٔ این پیام", { name: BRAND.name }) : t("پاسخ به این پیام")}</b>
              <span className="block truncate text-muted-foreground" dir="auto">{preview(bar)}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                if (editing) setText("");
                onClear();
              }}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
              aria-label={t("لغو")}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
        <div className="rounded-2xl border bg-card p-1.5 focus-within:border-primary/60">
          {editing ? null : (
            <div className="flex flex-wrap items-center gap-1 px-1 pb-1 text-xs" role="group" aria-label={t("گیرنده")}>
              <span className="text-muted-foreground">{t("بفرست برای:")}</span>
              <button
                type="button"
                disabled={!canAssistant}
                onClick={() => setTo("assistant")}
                aria-pressed={to === "assistant"}
                title={canAssistant ? undefined : t("پاسخ خودکار به {first} خاموش است؛ {name} گفتگویی با او ندارد", { first, name: BRAND.name })}
                className={`press rounded-full border px-2.5 py-0.5 disabled:opacity-40 ${to === "assistant" ? "border-primary bg-primary/12 text-foreground" : "text-muted-foreground"}`}
              >
                {BRAND.name}
              </button>
              <button type="button" onClick={() => setTo("direct")} aria-pressed={to === "direct"} className={`press rounded-full border px-2.5 py-0.5 ${to === "direct" ? "border-primary bg-primary/12 text-foreground" : "text-muted-foreground"}`} dir="auto">
                {t("{first} در تلگرام", { first })}
              </button>
              <span className="ms-auto text-[11px] text-muted-foreground">{to === "assistant" ? t("{first} این را نمی‌بیند", { first }) : t("مستقیم از حساب تلگرام شما")}</span>
            </div>
          )}
          <div className="flex items-end gap-1.5">
            <textarea
              ref={box}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape") {
                  if (editing) setText("");
                  onClear();
                }
              }}
              rows={1}
              dir="auto"
              placeholder={editing ? t("متن تازه") : target === "assistant" ? t("به {name} بگویید… مثلاً «کوتاه‌تر جواب بده»", { name: BRAND.name }) : t("پیام به {name}", { name: person.name })}
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground"
            />
            <button type="button" onClick={send} disabled={busy || !text.trim()} className="press flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40" aria-label={editing ? t("ذخیرهٔ ویرایش") : t("فرستادن")}>
              {editing ? <Check className="size-4" /> : <Send className="size-4 rtl:-scale-x-100" />}
            </button>
          </div>
        </div>
        {mode === "off" && !canAssistant ? <p className="px-2 text-[11px] text-muted-foreground">{t("{name} با {first} کاری ندارد؛ برای اینکه از طرف شما جواب بدهد پاسخ خودکار را از پنل کنار روشن کنید.", { name: BRAND.name, first })}</p> : null}
      </div>
    </div>
  );
}

function PersonPanel({ person, threads }) {
  const [threadsOpen, setThreadsOpen] = useState(true);
  const setAccess = (patch, message) => patchAccess(person.id, patch).then(() => message && toast.success(message), failed);
  const open = (threads || []).filter((t) => !t.closed);
  return (
    <div className="space-y-4">
      <PersonHeader personId={person.id} person={person} fallback={person.name} />
      <div className="space-y-3 rounded-xl border bg-card px-3 py-2.5">
        <label className="flex items-center justify-between gap-3">
          <span className="text-xs">
            {t("{name} خودکار جواب بدهد", { name: BRAND.name })}
            <span className="mt-0.5 block text-[11px] leading-5 text-muted-foreground">{watchHint()}</span>
          </span>
          <Toggle checked={Boolean(person.watch)} onChange={(on) => setAccess({ watch: on }, on ? t("پاسخ خودکار روشن شد") : t("پاسخ خودکار خاموش شد"))} label={t("پاسخ خودکار")} />
        </label>
        <label className="block text-xs">
          {t("پیام‌ها را کی بردارد؟")}
          <select
            value={Number(person.pickupEvery) || 0}
            disabled={!person.watch}
            onChange={(e) => setAccess({ pickupEvery: Number(e.target.value) }, t("ذخیره شد"))}
            className="mt-1 w-full rounded-lg border bg-card px-2 py-1.5 text-xs text-foreground disabled:opacity-50"
          >
            {PICKUPS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        {personChip(person) ? <p className="text-[11px] text-muted-foreground">{t("آخرین وضعیت:")} <Chip chip={personChip(person)} /></p> : null}
      </div>

      {person.chatId ? (
        <button type="button" onClick={() => navigate(person.chatId)} className="flex w-full items-center gap-2 rounded-xl border bg-card px-3 py-2 text-start text-xs hover:border-primary/50">
          <span className="min-w-0 flex-1">
            <b className="block font-medium">{t("گفتگوی {name} دربارهٔ {name2}", { name: BRAND.name, name2: person.name })}</b>
            <span className="text-[11px] text-muted-foreground">{t("هر کاری که برای پیام‌هایش کرده، قدم‌به‌قدم")}</span>
          </span>
          <ChevronLeft className="rtl-mirror size-3.5 text-muted-foreground" />
        </button>
      ) : null}

      {open.length ? (
        <div>
          <button type="button" onClick={() => setThreadsOpen(!threadsOpen)} className="mb-1 flex w-full items-center gap-1 px-1 text-xs font-medium text-muted-foreground">
            <ChevronDown className={`size-3 transition-transform ${threadsOpen ? "" : "-rotate-90 rtl:rotate-90"}`} />
            {t("کارهای باز ({toLocaleString})", { toLocaleString: open.length.toLocaleString("fa-IR") })}
          </button>
          {threadsOpen ? (
            <ul className="space-y-0.5">
              {open.map((th) => (
                <li key={th.id}>
                  <button type="button" onClick={() => navigate(th.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-xs hover:bg-muted">
                    <span className="min-w-0 flex-1 truncate" dir="auto">{String(th.title || t("ترد")).replace(/^🧵\s*[^:]*:\s*/, "")}</span>
                    {th.runStatus === "running" ? <Dots /> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {person.fromChats?.length ? (
        <div>
          <p className="mb-1 px-1 text-xs font-medium text-muted-foreground">{t("گفتگوهای شما که با {v} حرف زده‌اند", { v: person.group ? t("این گروه") : t("او") })}</p>
          <ul className="space-y-0.5">
            {[...person.fromChats].reverse().map((c) => (
              <li key={c.chatId}>
                <button type="button" onClick={() => navigate(c.chatId)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-xs hover:bg-muted">
                  <span className="min-w-0 flex-1 truncate" dir="auto">{c.title || t("گفتگو")}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{ago(c.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
