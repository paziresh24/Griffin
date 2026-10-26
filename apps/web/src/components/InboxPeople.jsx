import { useEffect, useState } from "react";
import { ArrowRight, Inbox, Loader2, MessageSquare } from "lucide-react";
import { api, navigate, usePolling } from "../api.js";
import { initial, itemOutcome, peoplePath } from "../inbox-people.js";
import { locale, num, t } from "../i18n.js";

// The Telegram inbox by sender: one row per person (the latest first, as in Telegram), and one
// person's messages in order with what the inbox did with each. Read-only: what is shown is the
// senders' own text — third-party content — rendered as plain text.

const ago = (iso) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return t("الان");
  if (s < 5400) return t("{n} دقیقه", { n: num(Math.round(s / 60)) });
  if (s < 172800) return t("{n} ساعت", { n: num(Math.round(s / 3600)) });
  return t("{n} روز", { n: num(Math.round(s / 86400)) });
};
const time = (iso) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "");

const TONE = { routed: "text-primary", suggested: "text-primary", waiting: "text-muted-foreground", none: "text-muted-foreground", failed: "text-bad" };

function useLoad(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    // A reply that lands after the page moved to another person is dropped.
    let alive = true;
    const load = () => api(path).then((d) => alive && (setData(d), setError(null)), (e) => alive && setError(e.message));
    setData(null);
    load();
    const timer = setInterval(() => document.visibilityState === "visible" && load(), 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path]);
  return [data, error];
}

export function InboxPeoplePage({ peerId, onBack }) {
  const inboxChatId = usePolling("/api/inbox/status", 60_000)?.chatId || null;
  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 sm:px-6">
        {peerId ? <Person peerId={peerId} /> : <People inboxChatId={inboxChatId} onBack={onBack} />}
      </div>
    </div>
  );
}

function Header({ title, onBack, children }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت")}>
        <ArrowRight className="rtl-mirror size-4" />
      </button>
      <h1 className="min-w-0 truncate text-lg font-semibold" dir="auto">{title}</h1>
      {children}
    </div>
  );
}

const Avatar = ({ name }) => (
  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-sm font-semibold text-sky-600">{initial(name)}</span>
);

function People({ inboxChatId, onBack }) {
  const [data, error] = useLoad("/api/inbox/people");
  const people = data?.people || [];
  return (
    <>
      <Header title={t("Telegram inbox — افراد")} onBack={onBack}>
        {inboxChatId ? (
          <button type="button" onClick={() => navigate(inboxChatId)} className="press ms-auto flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs hover:bg-muted">
            <Inbox className="size-3.5" /> {t("گفتگوی inbox")}
          </button>
        ) : null}
      </Header>
      {error ? <p className="text-sm text-bad">{error}</p> : null}
      {!data && !error ? (
        <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : people.length ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          {people.map((p) => (
            <a key={p.peerId} href={peoplePath(p.peerId)} className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0 hover:bg-muted/60">
              <Avatar name={p.name} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">{p.name || `peer ${p.peerId}`}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{ago(p.lastAt)}</span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" dir="auto">{p.preview}</span>
                  {p.open ? (
                    <span className="ltr shrink-0 rounded-full bg-signal px-1.5 py-0.5 text-[11px] font-medium leading-none text-signal-foreground" aria-label={t("{n} در صف", { n: p.open })}>{p.open}</span>
                  ) : null}
                </span>
              </span>
            </a>
          ))}
        </div>
      ) : (
        <p className="rounded-xl border bg-card px-4 py-8 text-center text-sm text-muted-foreground">{t("هنوز پیامی به inbox نرسیده.")}</p>
      )}
    </>
  );
}

function Person({ peerId }) {
  const [data, error] = useLoad(`/api/inbox/people/${peerId}`);
  const back = () => { window.location.hash = peoplePath().slice(1); };
  return (
    <>
      <Header title={data?.name || `peer ${peerId}`} onBack={back} />
      {error ? <p className="text-sm text-bad">{error}</p> : null}
      {!data && !error ? (
        <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : data ? (
        <>
          {data.chats?.length ? (
            <div className="mb-4">
              <p className="mb-1.5 text-xs text-muted-foreground">{t("گفتگوهایی که به این شخص پیام داده‌اند")}</p>
              <div className="flex flex-wrap gap-1.5">
                {data.chats.map((c) => (
                  <button key={c.chatId} type="button" onClick={() => navigate(c.chatId)} disabled={!c.title} className="press flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50">
                    <MessageSquare className="size-3 shrink-0" />
                    <span className="truncate" dir="auto">{c.title || t("گفتگوی حذف‌شده")}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {data.total > data.items.length ? (
            <p className="mb-3 text-center text-xs text-muted-foreground">{t("{n} پیام قدیمی‌تر نشان داده نشده", { n: num(data.total - data.items.length) })}</p>
          ) : null}
          <div className="space-y-3">
            {data.items.map((item) => (
              <div key={item.id}>
                <div className="max-w-[85%] rounded-2xl rounded-ss-sm border bg-card px-3 py-2">
                  <p className="whitespace-pre-wrap break-words text-sm leading-6" dir="auto">{item.text}</p>
                  <p className="mt-1 text-end text-[11px] text-muted-foreground">{time(item.createdAt)}</p>
                </div>
                <div className="mt-1 flex flex-col items-start gap-0.5 ps-2">
                  {itemOutcome(item).map((o, i) =>
                    o.chatId ? (
                      <button key={i} type="button" onClick={() => navigate(o.chatId)} className={`text-xs hover:underline ${TONE[o.kind]}`} dir="auto">↳ {o.label}</button>
                    ) : (
                      <span key={i} className={`text-xs ${TONE[o.kind]}`} dir="auto">↳ {o.label}</span>
                    ),
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
