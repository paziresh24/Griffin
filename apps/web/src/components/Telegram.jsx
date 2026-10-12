import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { ArrowRight, Eye, EyeOff, GitMerge, MessageCircle, MoreHorizontal, Plus, Settings2, X } from "lucide-react";
import { toast } from "sonner";
import { api, navigate, usePolling } from "../api.js";
import { agentMeta } from "../brand.js";
import { AgentPicker } from "./Controls.jsx";
import { locale, num, t } from "../i18n.js";

// Telegram: every person has one mother chat with all their messages. Each
// message opens a new thread or joins an open one; the person's threads sit beside it like side
// chats. Per person: watcher on/off and a timed pickup instead of a run per message. An issue can
// be grouped from several people (merge threads).

const PICKUPS = [
  { value: 0, label: t("با هر پیام") },
  { value: 15, label: t("هر ۱۵ دقیقه") },
  { value: 30, label: t("هر ۳۰ دقیقه") },
  { value: 60, label: t("هر ۱ ساعت") },
  { value: 120, label: t("هر ۲ ساعت") },
  { value: 240, label: t("هر ۴ ساعت") },
];

const shortTitle = (title) => String(title || "").replace(/^🧵\s*[^:]*:\s*/, "") || t("رشته");
const time = (at) => {
  if (!at) return "";
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(locale, today ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export function TelegramPage({ personId, onBack }) {
  return personId ? <MotherChat key={personId} personId={personId} /> : <Directory onBack={onBack} />;
}

function Directory({ onBack }) {
  const data = usePolling("/api/telegram/mothers", 10_000);
  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pb-10 pt-4 sm:px-6">
        <div className="mb-4 flex items-center gap-2">
          <button type="button" onClick={onBack} className="rounded-full p-2 hover:bg-muted" aria-label={t("بازگشت")}>
            <ArrowRight className="size-4 rtl-mirror" />
          </button>
          <h1 className="text-lg font-semibold">{t("تلگرام")}</h1>
          <button type="button" onClick={() => { window.location.hash = "/settings"; }} className="ms-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs">
            <Settings2 className="size-3.5" /> {t("اتصال تلگرام")}
          </button>
        </div>
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          {t("هر نفر یک چت مادر دارد؛ پیام‌هایش آن‌جا می‌آید و هر پیام یا رشتهٔ تازه باز می‌کند یا به یک رشتهٔ باز می‌رود.")}
        </p>
        {[[t("افراد"), false], [t("گروه‌ها"), true]].map(([title, group]) => {
          const items = (data?.mothers || []).filter((m) => Boolean(m.group) === group);
          return items.length ? (
        <section key={title} className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">{title} ({items.length})</h2>
        <ul className="space-y-1">
          {items.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => { window.location.hash = `/telegram/${m.id}`; }} className="flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-start hover:bg-muted">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm" dir="auto">{m.name}</span>
                  <span className="block truncate text-xs text-muted-foreground" dir="auto">{m.lastText}</span>
                </span>
                {m.openThreads ? <span className="text-xs text-primary">{t("{n} رشتهٔ باز", { n: num(m.openThreads) })}</span> : null}
                {m.watch ? null : <EyeOff className="size-3.5 text-muted-foreground" />}
              </button>
            </li>
          ))}
        </ul>
        </section>
          ) : null;
        })}
        {data && !data.mothers?.length ? <p className="py-10 text-center text-sm text-muted-foreground">{t("هنوز پیامی از کسی نیامده.")}</p> : null}
      </div>
    </div>
  );
}

function MotherChat({ personId }) {
  const [person, setPerson] = useState(null);
  const [messages, setMessages] = useState(null);
  const [threads, setThreads] = useState([]);
  const bottom = useRef(null);

  const load = useCallback(async () => {
    const [m, th] = await Promise.all([
      api(`/api/telegram/persons/${personId}/messages?limit=300`).catch(() => null),
      api(`/api/telegram/persons/${personId}/threads`).catch(() => null),
    ]);
    if (m) setMessages(m.messages || []);
    if (th) setThreads(th.threads || []);
  }, [personId]);

  useEffect(() => {
    api("/api/telegram/persons").then((r) => setPerson((r.persons || []).find((p) => p.id === personId) || null)).catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [personId, load]);

  const count = messages?.length || 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count]);

  const byId = useMemo(() => new Map(threads.map((th) => [th.id, th])), [threads]);
  const open = threads.filter((th) => !th.closed);
  const closed = threads.filter((th) => th.closed);

  const patchAccess = async (patch, done) => {
    try {
      const { person: next } = await api(`/api/telegram/persons/${personId}`, { method: "PATCH", body: { access: { ...(person?.access || {}), ...patch } } });
      setPerson(next);
      if (done) toast.success(done);
    } catch (error) {
      toast.error(error.message);
    }
  };
  const watch = typeof person?.access?.watch === "boolean" ? person.access.watch : person?.category === "team";
  const pickupEvery = Number(person?.access?.pickupEvery) || 0;

  const route = async (messageId, thread) => {
    try {
      const r = await api(`/api/telegram/persons/${personId}/route`, { method: "POST", body: { messageId, thread } });
      toast.success(thread === "new" ? t("رشتهٔ تازه باز شد") : t("به رشته رفت"));
      load();
      return r;
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b px-3 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)]">
          <button type="button" onClick={() => { window.location.hash = "/telegram"; }} className="rounded-full p-2 hover:bg-muted" aria-label={t("بازگشت")}>
            <ArrowRight className="size-4 rtl-mirror" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium" dir="auto">{person?.display_name || "…"}</h1>
            <p className="truncate text-[11px] text-muted-foreground ltr">{person?.username ? `@${person.username}` : person?.external_id}</p>
          </div>
          <button
            type="button"
            onClick={() => patchAccess({ watch: !watch }, watch ? t("واچر خاموش شد") : t("واچر روشن شد"))}
            className={`press flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${watch ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground"}`}
            title={t("وقتی روشن است، پیام‌های این نفر خودکار رشته باز می‌کنند یا به رشتهٔ باز می‌روند")}
          >
            {watch ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />} {watch ? t("واچر روشن") : t("واچر خاموش")}
          </button>
          <select
            value={pickupEvery}
            onChange={(e) => patchAccess({ pickupEvery: Number(e.target.value) }, t("زمان‌بندی برداشت ذخیره شد"))}
            className="rounded-full border bg-card px-2 py-1.5 text-xs"
            title={t("برداشت پیام‌ها: با هر پیام، یا جمع‌شده سر هر بازه")}
          >
            {PICKUPS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <AgentPicker agent={person?.access?.agent || "griffin"} onChange={(agent) => patchAccess({ agent }, t("ایجنت: {agent}", { agent: agentMeta(agent).label }))} className="min-w-[9rem]" />
        </header>
        {open.length ? (
          <div className="scrollbar-thin flex gap-1.5 overflow-x-auto border-b px-3 py-2 md:hidden">
            {open.map((th) => (
              <button key={th.id} type="button" onClick={() => navigate(th.id)} className="shrink-0 rounded-full border px-2.5 py-1 text-xs" dir="auto">
                🧵 {shortTitle(th.title)}
              </button>
            ))}
          </div>
        ) : null}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
          {!messages ? <p className="py-10 text-center text-sm text-muted-foreground">{t("در حال بارگذاری…")}</p> : null}
          {messages && !messages.length ? (
            <div className="flex flex-col items-center gap-2 py-16 text-sm text-muted-foreground"><MessageCircle className="size-6" />{t("پیامی نیست.")}</div>
          ) : null}
          <ul className="mx-auto max-w-3xl space-y-2">
            {(messages || []).map((m, i) => (
              <Bubble key={`${m.id}-${i}`} message={m} thread={byId.get(m.data?.threadId || m.data?.chatId)} open={open} onRoute={route} />
            ))}
          </ul>
          <div ref={bottom} />
        </div>
      </section>
      <ThreadsPanel open={open} closed={closed} onChanged={load} />
    </div>
  );
}

function Bubble({ message, thread, open, onRoute }) {
  const inbound = message.direction === "in";
  const queued = message.data?.queued;
  return (
    <li className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
      <div className={`group max-w-[85%] rounded-2xl px-3 py-2 text-sm ${inbound ? "bg-muted" : "bg-primary/10"}`}>
        <p className="whitespace-pre-wrap break-words leading-6" dir="auto">{message.text}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{time(message.at)}</span>
          {thread ? (
            <button type="button" onClick={() => navigate(thread.id)} className="rounded-full bg-background px-2 py-0.5 hover:text-foreground" dir="auto">
              🧵 {shortTitle(thread.title)}
            </button>
          ) : null}
          {queued ? <span className="rounded-full bg-background px-2 py-0.5">{t("در صف تا {time}", { time: time(queued) })}</span> : null}
          {inbound ? <RouteMenu open={open} onRoute={(target) => onRoute(message.id, target)} /> : null}
        </div>
      </div>
    </li>
  );
}

function RouteMenu({ open, onRoute }) {
  const [menu, setMenu] = useState(false);
  const pick = (target) => {
    setMenu(false);
    onRoute(target);
  };
  return (
    <Popover.Root open={menu} onOpenChange={setMenu}>
      <Popover.Trigger asChild>
        <button type="button" className="rounded p-0.5 hover:bg-background hover:text-foreground" aria-label={t("فرستادن به رشته")} title={t("فرستادن به رشته")}>
          <MoreHorizontal className="size-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="pop z-50 w-64 overflow-hidden rounded-xl border bg-card p-1 text-sm shadow-xl">
          <button type="button" onClick={() => pick("new")} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-muted">
            <Plus className="size-3.5 text-muted-foreground" /> {t("رشتهٔ تازه از این پیام")}
          </button>
          {open.length ? <p className="px-2.5 pb-1 pt-2 text-[11px] text-muted-foreground">{t("به رشتهٔ باز:")}</p> : null}
          {open.map((th) => (
            <button key={th.id} type="button" onClick={() => pick(th.id)} className="block w-full truncate rounded-lg px-2.5 py-2 text-start hover:bg-muted" dir="auto">
              🧵 {shortTitle(th.title)}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// The person's threads beside the mother chat (the end side, like the side-chat panel).
function ThreadsPanel({ open, closed, onChanged }) {
  const [showClosed, setShowClosed] = useState(false);
  const close = async (th) => {
    if (!window.confirm(t("رشتهٔ «{title}» بسته شود؟ کار در حالِ اجرایش متوقف می‌شود.", { title: shortTitle(th.title) }))) return;
    await api(`/api/telegram/threads/${th.id}/close`, { method: "POST" }).catch((e) => toast.error(e.message));
    onChanged();
  };
  return (
    <aside className="scrollbar-thin hidden w-80 shrink-0 overflow-y-auto border-s bg-card/50 p-3 md:block">
      <h2 className="mb-2 px-1 text-xs font-medium text-muted-foreground">{t("رشته‌های باز ({n})", { n: num(open.length) })}</h2>
      <ul className="space-y-1.5">
        {open.map((th) => (
          <li key={th.id} className="rounded-xl border bg-card p-2">
            <div className="flex items-start gap-1">
              <button type="button" onClick={() => navigate(th.id)} className="min-w-0 flex-1 text-start text-sm hover:underline" dir="auto">
                {shortTitle(th.title)}
              </button>
              {th.runStatus === "running" ? <span className="agent-dots mt-1.5 shrink-0 text-primary" aria-hidden><i /><i /><i /></span> : null}
              <GroupMenu thread={th} onChanged={onChanged} />
              <button type="button" onClick={() => close(th)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title={t("بستن رشته")} aria-label={t("بستن رشته")}>
                <X className="size-3.5" />
              </button>
            </div>
            {th.members.filter((m) => !m.closed).length > 1 ? (
              <p className="mt-1 text-[11px] text-muted-foreground" dir="auto">
                {t("با: {names}", { names: th.members.filter((m) => !m.closed).map((m) => m.name).join(t("، ")) })}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {!open.length ? <p className="px-1 py-4 text-xs text-muted-foreground">{t("رشتهٔ بازی نیست.")}</p> : null}
      {closed.length ? (
        <>
          <button type="button" onClick={() => setShowClosed(!showClosed)} className="mt-4 px-1 text-xs text-muted-foreground hover:text-foreground">
            {t("رشته‌های بسته ({n})", { n: num(closed.length) })} {showClosed ? "▾" : "◂"}
          </button>
          {showClosed ? (
            <ul className="mt-1 space-y-0.5">
              {closed.map((th) => (
                <li key={th.id}>
                  <button type="button" onClick={() => navigate(th.id)} className="block w-full truncate rounded-lg px-2 py-1.5 text-start text-xs text-muted-foreground hover:bg-muted" dir="auto">
                    {shortTitle(th.title)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

// Group one issue from several people: another open thread (anyone's) folds into this one.
function GroupMenu({ thread, onChanged }) {
  const [menu, setMenu] = useState(false);
  const [all, setAll] = useState(null);
  useEffect(() => {
    if (menu) api("/api/telegram/threads").then((r) => setAll(r.threads || [])).catch(() => setAll([]));
  }, [menu]);
  const merge = async (other) => {
    setMenu(false);
    if (!window.confirm(t("«{title}» ({names}) در این رشته ادغام شود؟ جواب‌های این رشته به همهٔ آن‌ها می‌رسد.", { title: shortTitle(other.title), names: other.members.join(t("، ")) }))) return;
    try {
      await api(`/api/telegram/threads/${other.id}/merge`, { method: "POST", body: { into: thread.id } });
      toast.success(t("ادغام شد"));
      onChanged();
    } catch (error) {
      toast.error(error.message);
    }
  };
  const others = (all || []).filter((th) => th.id !== thread.id);
  return (
    <Popover.Root open={menu} onOpenChange={setMenu}>
      <Popover.Trigger asChild>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title={t("گروه کردن با رشتهٔ دیگر")} aria-label={t("گروه کردن")}>
          <GitMerge className="size-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="pop z-50 max-h-80 w-72 overflow-y-auto rounded-xl border bg-card p-1 text-sm shadow-xl">
          <p className="px-2.5 py-1.5 text-[11px] text-muted-foreground">{t("همین مسئله از نفر دیگر — ادغام در این رشته:")}</p>
          {!all ? <p className="px-2.5 py-2 text-xs text-muted-foreground">…</p> : null}
          {all && !others.length ? <p className="px-2.5 py-2 text-xs text-muted-foreground">{t("رشتهٔ باز دیگری نیست.")}</p> : null}
          {others.map((th) => (
            <button key={th.id} type="button" onClick={() => merge(th)} className="block w-full rounded-lg px-2.5 py-2 text-start hover:bg-muted" dir="auto">
              <span className="block truncate">{shortTitle(th.title)}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{th.members.join(t("، "))}</span>
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
