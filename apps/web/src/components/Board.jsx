import { useState } from "react";
import { Archive, Check, ExternalLink, RotateCcw, Send, Square, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { AskCard } from "./Ask.jsx";
import { AgentGlyph } from "./Controls.jsx";
import { SidebarSuggestions, useSuggestions } from "./ChatTools.jsx";
import { refreshInbox } from "../inbox.js";
import { cardHead, recentDone, sourceTag, stepLine, workingTasks } from "../board.js";
import { ago } from "../chat-list.js";
import { isUnreadChat, seenOf, useSeenVersion } from "../seen.js";
import { waitingKind, waitingSend } from "../telegram.js";
import { api, navigate } from "../api.js";
import { exactTime } from "../elapsed.js";
import { num, t } from "../i18n.js";
import { focusChore } from "../focus.js";
import { useFlag } from "../ui-prefs.js";

// The assistant's work on the home page: what waits for the owner (answered or acted on in place) above
// the composer, what runs and what just ended under it. The data is board.js / inbox.js.

const fa = (n) => num(Number(n || 0));
const TAGS = { approval: t("تأیید"), question: t("سؤال"), telegram: t("تلگرام"), kept: t("پیام نرسید"), note: t("بعداً اجرا نشد"), chore: t("کار شما") };
const tag = "g-tag shrink-0 rounded bg-muted px-1.5 text-[11px] text-muted-foreground";
const btn = "g-btn press inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50 pointer-coarse:min-h-11";
const primaryBtn = "g-btn g-btn-primary press inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50 pointer-coarse:min-h-11";

// The count as a tag: "· ۱" would read as "۱۰" (the Persian zero is a dot).
const Heading = ({ count = 0, children }) => (
  <h3 className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
    {children}
    {count ? <span className={tag}>{fa(count)}</span> : null}
  </h3>
);

// Open suggested chats wait for him too, with or without inbox items. The sidebar's copy keeps the
// suggestion store fresh on every chat-list change; this one only reads it (one fetch when it mounts).
// «هر چیز فقط یک جا» (flag onePlace; a colleague 2026-10-24: «وقتی از یه موضوع چند جا پیام میاد… حس
// شلوغ‌پلوغی»): a question or an approval is answered in its own chat and is one linked line here, Telegram's
// waiting messages are one line to Telegram, suggestions stay in the sidebar only.
export function NeedsYou({ inbox }) {
  const onePlace = useFlag("onePlace");
  const suggestions = useSuggestions().open.length;
  if (!inbox.items.length && (!suggestions || onePlace)) return null;
  if (onePlace) {
    const telegram = inbox.items.filter((item) => item.kind === "telegram");
    const rest = inbox.items.filter((item) => item.kind !== "telegram");
    return (
      <section className="g-board w-full space-y-1" aria-label={t("منتظر شما")}>
        <Heading count={inbox.count}>{t("منتظر شما")}</Heading>
        <ul>
          {rest.map((item) => (item.kind === "approval" || item.kind === "question" ? <AskLine key={item.id} item={item} /> : <li key={item.id}><InboxCard item={item} /></li>))}
          {telegram.length ? (
            <li>
              <a href="#/telegram" className="g-list-row flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-muted pointer-coarse:min-h-11">
                <span className={tag}>{TAGS.telegram}</span>
                <span className="min-w-0 flex-1 truncate">{t("{fa} پیام منتظر شما در تلگرام", { fa: fa(telegram.length) })}</span>
                <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
              </a>
            </li>
          ) : null}
        </ul>
      </section>
    );
  }
  return (
    <section className="g-board w-full space-y-2" aria-label={t("منتظر شما")}>
      <Heading count={inbox.count}>{t("منتظر شما")}</Heading>
      {inbox.items.map((item) => <InboxCard key={item.id} item={item} />)}
      <SidebarSuggestions />
    </section>
  );
}

// A question or an approval as one line: the card with its buttons is in the chat that asked.
function AskLine({ item }) {
  const { title } = cardHead(item);
  const open = item.sourceChatId || item.chatId;
  return (
    <li>
      <a href={`#/c/${open}`} className="g-list-row flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-muted pointer-coarse:min-h-11">
        <span className={tag}>{TAGS[item.kind]}</span>
        <span className="min-w-0 flex-1 truncate" dir="auto">{title || item.question}</span>
        <span className="shrink-0 text-xs text-muted-foreground" title={exactTime(item.at)}>{ago(item.at)}</span>
      </a>
    </li>
  );
}

function InboxCard({ item }) {
  const [busy, setBusy] = useState(false);
  // One request per card; the card leaves with the refreshed inbox (or stays, e.g. a failed resend).
  async function act(request, done = null) {
    setBusy(true);
    try {
      await request();
      if (done) toast.success(done);
    } catch (caught) {
      toast.error(item.kind === "kept" && caught.status === 409 ? t("هنوز در حال کار است") : caught.message || t("انجام نشد"));
    } finally {
      setBusy(false);
      refreshInbox();
    }
  }
  const { title, who } = cardHead(item);
  const open = item.sourceChatId || item.chatId;
  const send = item.kind === "telegram" ? waitingSend(item.waitingKind, item.op) : null;

  return (
    <article className="g-box w-full rounded-xl border bg-card px-3 py-2.5 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className={tag}>{item.access ? t("دسترسی") : TAGS[item.kind] || item.kind}</span>
        {title ? <span className="min-w-0 flex-1 truncate font-medium text-foreground" dir="auto">{title}</span> : <span className="flex-1" />}
        <span className="shrink-0" title={exactTime(item.at)}>{ago(item.at)}</span>
        {open ? (
          <a href={`#/c/${open}`} onClick={item.kind === "chore" ? () => focusChore(item) : undefined} className="flex shrink-0 items-center gap-1 hover:text-foreground pointer-coarse:min-h-11">
            <ExternalLink className="size-3.5" /> {t("باز کردن")}
          </a>
        ) : null}
      </div>
      {who ? <p className="mt-0.5 truncate text-xs text-muted-foreground" dir="auto">{who}</p> : null}

      {item.kind === "approval" || item.kind === "question" ? (
        <AskCard args={{ question: item.question, options: item.options, multiSelect: item.multiSelect }} chatId={item.chatId} askId={item.askId} onDone={refreshInbox} />
      ) : (
        <div className="mt-1.5 space-y-2">
          {item.kind === "telegram" ? (
            <p className="text-xs text-muted-foreground">{waitingKind(item.waitingKind, item.reason, item.op)}</p>
          ) : null}
          {item.kind === "chore" ? <p className="font-medium" dir="auto">{item.title}</p> : null}
          {item.text || item.detail ? (
            <p className="line-clamp-4 whitespace-pre-wrap" dir="auto">
              {item.text || item.detail}
              {item.kind === "kept" && item.count > 1 ? <span className="text-muted-foreground">{t(" ({n} پیام)", { n: fa(item.count) })}</span> : null}
            </p>
          ) : null}
          {item.kind === "note" && item.error ? <p className="text-xs text-bad" dir="auto">{item.error}</p> : null}
          <div className="flex flex-wrap gap-2">
            {item.kind === "telegram" ? (
              <>
                {send ? (
                  <button type="button" disabled={busy} className={primaryBtn} onClick={() => act(() => api(`/api/telegram/waiting/${item.waitingId}`, { method: "POST", body: { action: "send" } }), send.done)}>
                    <Send className="size-3.5 rtl:-scale-x-100" /> {send.label}
                  </button>
                ) : null}
                <button type="button" disabled={busy} className={btn} onClick={() => act(() => api(`/api/telegram/waiting/${item.waitingId}`, { method: "POST", body: { action: "dismiss" } }))}>
                  <X className="size-3.5" /> {t("ولش کن")}
                </button>
              </>
            ) : item.kind === "kept" ? (
              <>
                <button type="button" disabled={busy} className={primaryBtn} onClick={() => act(() => api(`/api/chats/${item.chatId}/retry`, { method: "POST" }))}>
                  <RotateCcw className="size-3.5" /> {t("ارسال دوباره")}
                </button>
                {/* "Resolved" drops what was kept and stops counting the chat as failed; "Close" archives it. */}
                <button type="button" disabled={busy} className={btn} onClick={() => act(() => api(`/api/chats/${item.chatId}/resolve`, { method: "POST" }), t("حل شد"))}>
                  <Check className="size-3.5" /> {t("حل شد")}
                </button>
                <button type="button" disabled={busy} className={btn} onClick={() => act(() => api(`/api/chats/${item.chatId}`, { method: "PATCH", body: { archived: true } }))}>
                  <Archive className="size-3.5" /> {t("بستن")}
                </button>
              </>
            ) : item.kind === "note" ? (
              <>
                <button type="button" disabled={busy} className={primaryBtn} onClick={() => act(() => api(`/api/notes/${item.noteId}/run`, { method: "POST" }))}>
                  <RotateCcw className="size-3.5" /> {t("دوباره اجرا")}
                </button>
                <button type="button" disabled={busy} className={btn} onClick={() => act(() => api(`/api/notes/${item.noteId}`, { method: "DELETE" }))}>
                  <Trash2 className="size-3.5" /> {t("حذف")}
                </button>
              </>
            ) : item.kind === "chore" ? (
              <>
                <button type="button" disabled={busy} className={primaryBtn} onClick={() => act(() => api(`/api/inbox/chores/${item.choreId}`, { method: "POST", body: { action: "done" } }))}>
                  <Check className="size-3.5" /> {item.access ? t("دادم") : t("انجام شد")}
                </button>
                <button type="button" disabled={busy} className={btn} onClick={() => act(() => api(`/api/inbox/chores/${item.choreId}`, { method: "POST", body: { action: "dismiss" } }))}>
                  <X className="size-3.5" /> {t("ولش کن")}
                </button>
              </>
            ) : null}
          </div>
        </div>
      )}
    </article>
  );
}

export function TaskLists({ chats, inbox }) {
  useSeenVersion(); // opening a chat elsewhere clears its unread dot here
  const onePlace = useFlag("onePlace"); // the sidebar already shows what runs and what ended unread
  const working = workingTasks(chats, inbox.todos);
  const done = recentDone(chats, { isUnread: (c) => isUnreadChat(c, seenOf(c.id)) });
  if (onePlace || (!working.length && !done.length)) return null;
  return (
    <div className="g-board w-full space-y-4">
      {working.length ? (
        <section className="space-y-1" aria-label={t("در حال کار")}>
          <Heading count={working.length}>{t("در حال کار")}</Heading>
          <ul>
            {working.map((row) => <WorkingRow key={row.chat.id} row={row} />)}
          </ul>
        </section>
      ) : null}
      {done.length ? (
        <section className="space-y-1" aria-label={t("تازه تمام شد")}>
          <Heading>{t("تازه تمام شد")}</Heading>
          <ul>
            {done.map((chat) => {
              const dot = isUnreadChat(chat, seenOf(chat.id))
                ? "bg-signal"
                : chat.runStatus === "error" ? "bg-bad" : chat.runStatus === "cancelled" ? "bg-muted-foreground" : null;
              return (
                <li key={chat.id}>
                  <button type="button" onClick={() => navigate(chat.id)} className="g-list-row flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-muted pointer-coarse:min-h-11">
                    {dot ? <span className={`mx-1 size-2 shrink-0 rounded-full ${dot}`} /> : <Check className="size-4 shrink-0 text-ok" />}
                    <span className="min-w-0 flex-1 truncate" dir="auto">{chat.title || t("گفتگوی جدید")}</span>
                    <span className="shrink-0 text-xs text-muted-foreground" title={exactTime(chat.updatedAt)}>{ago(chat.updatedAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function WorkingRow({ row }) {
  const { chat } = row;
  const logos = useFlag("agentLogos");
  const source = sourceTag(chat);
  const request = (path, method, done) => api(path, { method }).then(() => toast.success(done), (e) => toast.error(e.message));
  return (
    <li className="g-list-row flex min-w-0 items-center gap-1 rounded-lg hover:bg-muted">
      <button type="button" onClick={() => navigate(chat.id)} className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-2 text-start pointer-coarse:min-h-11">
        {logos ? <AgentGlyph id={chat.agent} className="mt-0.5 size-4 shrink-0" /> : null}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <span className="min-w-0 truncate" dir="auto">{chat.title || t("گفتگوی جدید")}</span>
            {source ? <span className={tag}>{source}</span> : null}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate" dir="auto">{stepLine(row)}</span>
            {row.runningChildren ? <span className="shrink-0">{t("{n} زیرکار", { n: fa(row.runningChildren) })}</span> : null}
            {row.waiting ? <span className="g-tag shrink-0 rounded bg-warn/15 px-1.5 text-[11px] text-warn">{t("منتظر شما")}</span> : null}
            <span className="shrink-0" title={exactTime(row.since)}>{ago(row.since)}</span>
          </span>
        </span>
      </button>
      {row.stoppable ? (
        <button type="button" onClick={() => request(`/api/chats/${chat.id}/cancel`, "POST", t("متوقف شد"))} className="g-icon-btn shrink-0 rounded-md p-2 text-muted-foreground hover:bg-bad/10 hover:text-bad pointer-coarse:min-h-11" aria-label={t("توقف")}>
          <Square className="size-3.5" />
        </button>
      ) : null}
      {row.resumeAt ? (
        <button type="button" onClick={() => request(`/api/chats/${chat.id}/limit-resume`, "DELETE", t("ادامهٔ خودکار لغو شد"))} className={`${btn} me-1 shrink-0`}>
          {t("لغو")}
        </button>
      ) : null}
    </li>
  );
}
