import { useEffect, useState, useSyncExternalStore } from "react";
import { Popover, Switch } from "radix-ui";
import { ChevronDown, Network, Pencil, Square, X } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { BRAND, readSetting, writeSetting } from "../brand.js";
import { uiFlag, uiPrefsReady, useFlag } from "../ui-prefs.js";
import { TelegramFolders } from "./TelegramChat.jsx";
import { ago } from "../chat-list.js";
import { isRtlText } from "../dir.js";
import { exactTime } from "../elapsed.js";
import { isRtl, num, t } from "../i18n.js";
import {
  PICKUPS, clock, connectionLine, initialOf, legacyThreads, messageAuthor, motherName, noteLine, othersThreads, peopleSections, personChip, pollStore, stateChip, threadState,
  waitingKind, waitingSend, watchHint,
} from "../telegram.js";

// Telegram v2: the assistant answers colleagues in the owner's Telegram on his behalf. Each watched person (or group) has one mother chat: their
// messages land there and every real piece of work becomes a thread beside it. The "🌐 … — all" chat is the
// desk: reports from every mother chat and what waits for the owner. What the owner writes in
// Griffin reaches only the assistant; a «📤» card marks every message that went to a colleague.

const PEOPLE = "/api/telegram/people";
const FEED = "/api/telegram/feed";
const POLL_MS = 15_000;

// One poller per endpoint for the whole page (telegram.js pollStore).
const store = pollStore((path) => api(path), POLL_MS);
export const useTelegram = (path) => useSyncExternalStore(store.subscribe(path), () => store.data(path));
export const refreshTelegram = store.refresh;
export const FEED_PATH = FEED;
export const PEOPLE_PATH = PEOPLE;
export const usePerson = (id) => useTelegram(PEOPLE)?.people?.find((p) => p.id === id) || null;

// A person as the Telegram page shows them: the localized name (server: fa_name, else Telegram's) and
// the Telegram profile photo; with no photo (or one that fails to load) a circle with the first letter.
export function PersonAvatar({ personId = null, name = "", className = "size-8" }) {
  const person = usePerson(personId);
  const [broken, setBroken] = useState(null);
  if (person?.photo && broken !== person.photo) {
    return <img src={person.photo} alt="" loading="lazy" onError={() => setBroken(person.photo)} className={`g-avatar shrink-0 rounded-full object-cover ${className}`} />;
  }
  return (
    <span aria-hidden className={`g-avatar flex shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground ${className}`}>
      {initialOf(person?.name || name)}
    </span>
  );
}

export function PersonName({ personId = null, fallback = "" }) {
  return usePerson(personId)?.name || fallback;
}

const failed = (error) => toast.error(error.message || t("انجام نشد"));

// The server stores a person's access whole: what is not changed is sent back as it was.
export async function patchAccess(id, patch) {
  const { persons = [] } = await api("/api/telegram/persons");
  const current = persons.find((p) => p.id === id)?.access || {};
  const result = await api(`/api/telegram/persons/${id}`, { method: "PATCH", body: { access: { ...current, ...patch } } });
  refreshTelegram();
  return result;
}

// Turning the watcher on also makes the mother chat; it opens.
export async function watchOn(id, { open = true } = {}) {
  try {
    const { chatId } = await patchAccess(id, { watch: true });
    toast.success(t("پاسخ خودکار روشن شد"));
    if (open && chatId) navigate(chatId);
  } catch (error) {
    failed(error);
  }
}

// Open a person's mother chat; a person whose watcher is off has none (409) and none is made.
export async function openMother(personId, chatId = null) {
  try {
    const id = chatId || (await api(`/api/telegram/persons/${personId}/mother`, { method: "POST" })).chatId;
    if (id) navigate(id);
  } catch (error) {
    if (error.status === 409) toast.error(t("پاسخ خودکار به این شخص خاموش است — اول روشنش کنید"));
    else failed(error);
  }
}

export async function globalChatId() {
  const id = store.data(FEED)?.globalChatId || (await api("/api/telegram/global", { method: "POST" })).chatId;
  if (!id) throw new Error(t("چت «همه» ساخته نشد"));
  return id;
}

export async function openGlobal(replace = false) {
  try {
    const id = await globalChatId();
    if (replace) window.location.replace(`#/c/${id}`);
    else navigate(id);
  } catch (error) {
    failed(error);
  }
}

// #/telegram and #/telegram/<person>: the person's mother chat when the watcher is on, else the
// desk. replace(): Back must not land on this redirect again.
export function TelegramRedirect({ personId }) {
  useEffect(() => {
    if (!personId) return void openGlobal(true);
    let alive = true;
    // «تلگرام مثل خود تلگرام» draws this address itself (App.jsx): wait for the flags before leaving it.
    uiPrefsReady.then(() => {
      if (!alive || uiFlag("telegramChat")) return;
      api(`/api/telegram/persons/${personId}/mother`, { method: "POST" }).then(
        ({ chatId }) => (chatId ? window.location.replace(`#/c/${chatId}`) : openGlobal(true)),
        (error) => {
          if (error.status !== 409) failed(error);
          openGlobal(true);
        },
      );
    });
    return () => {
      alive = false;
    };
  }, [personId]);
  return <p className="py-10 text-center text-sm text-muted-foreground">{t("در حال باز کردن…")}</p>;
}

const TONE = {
  ok: "bg-ok/12 text-ok",
  primary: "bg-signal/12 text-signal",
  warn: "bg-warn/15 text-warn",
  bad: "bg-bad/12 text-bad",
  muted: "bg-muted text-muted-foreground",
};

export function Chip({ chip, className = "" }) {
  if (!chip) return null;
  return <span className={`shrink-0 whitespace-nowrap rounded-full px-1.5 text-[11px] leading-5 ${TONE[chip.tone] || TONE.muted} ${className}`}>{chip.label}</span>;
}

export const Dots = () => <span className="agent-dots shrink-0 text-signal" aria-hidden><i /><i /><i /></span>;

export function Toggle({ checked, onChange, label, disabled = false, title }) {
  return (
    <Switch.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      dir="ltr"
      title={title}
      aria-label={label}
      className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors disabled:opacity-50 data-[state=checked]:bg-primary"
    >
      <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.375rem]" />
    </Switch.Root>
  );
}

// ---------- the sidebar's Telegram tab ----------

// «تلگرام مثل خود تلگرام» (flag telegramChat): folders as icons and every person in one list (TelegramChat.jsx).
export function TelegramList(props) {
  return useFlag("telegramChat") ? <TelegramFolders {...props} /> : <TelegramListClassic {...props} />;
}

function TelegramListClassic({ query, activeId, activePersonId, onNavigate }) {
  const people = useTelegram(PEOPLE);
  const feed = useTelegram(FEED);
  // Stays as the owner left it across reloads and pages (owner 2026-10-19).
  const [offOpen, setOffOpenState] = useState(() => readSetting("griffin.telegram.offOpen", "") === "1");
  const setOffOpen = (open) => {
    setOffOpenState(open);
    writeSetting("griffin.telegram.offOpen", open ? "1" : "0");
  };
  const waiting = feed?.waiting || [];
  const sections = peopleSections(people?.people, { query, waiting });
  const waitsFor = new Set(waiting.map((w) => w.personId));
  const line = connectionLine(feed);
  const globalActive = Boolean(activeId && activeId === feed?.globalChatId);
  const open = (person) => {
    openMother(person.id, person.chatId);
    onNavigate?.();
  };
  const row = (p) => (
    <PersonRow key={p.id} person={p} active={(activeId && p.chatId === activeId) || p.id === activePersonId} waits={waitsFor.has(p.id)} onOpen={() => open(p)} />
  );
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
        {waiting.length ? (
          <span className="shrink-0 rounded-full bg-bad px-1.5 text-[11px] leading-5 tabular-nums text-white" title={t("منتظر شما")}>{num(waiting.length)}</span>
        ) : null}
      </button>
      {!people ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("در حال بارگذاری…")}</p> : null}
      {[[t("افراد"), sections.people], [t("گروه‌ها"), sections.groups]].map(([title, items]) =>
        items.length ? (
          <div key={title} className="mb-2">
            <p className="flex items-center px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
              <span className="flex-1">{title}</span>
              <span className="tabular-nums">{num(items.length)}</span>
            </p>
            <ul>{items.map(row)}</ul>
          </div>
        ) : null,
      )}
      {people && !sections.people.length && !sections.groups.length ? (
        <p className="px-3 py-4 text-center text-xs leading-5 text-muted-foreground">{t("پاسخ خودکار برای کسی روشن نیست. از «خاموش» یکی را روشن کنید تا {name} جوابش را بدهد.", { name: BRAND.name })}</p>
      ) : null}
      {sections.off.length ? (
        <div className="mb-2">
          <button type="button" onClick={() => setOffOpen(!offOpen)} aria-expanded={offOpen} className="flex w-full items-center gap-1.5 rounded-md px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground hover:text-foreground">
            <ChevronDown className={`size-3 shrink-0 transition-transform ${offOpen ? "" : "-rotate-90 rtl:rotate-90"}`} />
            <span className="flex-1 text-start" title={t("جواب خودکار نمی‌گیرند؛ گفتگوهای شما هنوز می‌توانند برایشان پیام بفرستند")}>{t("پاسخ خودکار خاموش")}</span>
            <span className="tabular-nums">{sections.off.length.toLocaleString("fa-IR")}</span>
          </button>
          {offOpen || query.trim() ? <ul>{sections.off.map((p) => <OffRow key={p.id} person={p} onNavigate={onNavigate} />)}</ul> : null}
        </div>
      ) : null}
    </div>
  );
}

function PersonRow({ person: p, active, waits, onOpen }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start ${active ? "bg-muted" : "hover:bg-muted/60"}`}>
        <PersonAvatar personId={p.id} name={p.name} className="size-8" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-sm" dir="auto">{p.name}</span>
            {waits ? <span className="size-1.5 shrink-0 rounded-full bg-bad" title={t("منتظر شما")} /> : null}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            <Chip chip={personChip(p)} />
            {p.openThreads ? <span className="shrink-0 text-[11px] text-primary">{t("{n} ترد", { n: num(p.openThreads) })}</span> : null}
          </span>
        </span>
        {p.running ? <Dots /> : null}
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title={exactTime(p.state?.at || p.lastAt)}>{ago(p.state?.at || p.lastAt)}</span>
      </button>
    </li>
  );
}

// A person whose watcher is off: a look at the last messages and the switch; opening never makes a chat.
// «Off» is only the auto-reply: the owner's chats still write to them, and each such line names the
// chat that sent it and opens it (a colleague 2026-10-24: «چطور به من پیام داد وقتی خاموشم؟ و کلیک
// روی من پیامی که داده بود را نشان نمی‌داد»).
function OffRow({ person: p, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    api(`/api/telegram/persons/${p.id}/messages?limit=5`).then((r) => alive && setMessages(r.messages || []), () => alive && setMessages([]));
    return () => {
      alive = false;
    };
  }, [open, p.id]);
  return (
    <li>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-start text-muted-foreground hover:bg-muted/60 data-[state=open]:bg-muted">
            <PersonAvatar personId={p.id} name={p.name} className="size-6" />
            <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{p.name}</span>
            {p.group ? <span className="shrink-0 text-[11px]">{t("گروه")}</span> : null}
            <span className="shrink-0 text-[11px] tabular-nums" title={exactTime(p.lastAt)}>{ago(p.lastAt)}</span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="left" align="start" sideOffset={6} collisionPadding={12} className="g-menu pop z-50 w-72 rounded-xl border bg-card p-3 text-sm shadow-xl" dir={isRtl ? "rtl" : "ltr"}>
            <div className="flex items-center gap-2">
              <PersonAvatar personId={p.id} name={p.name} className="size-10" />
              <div className="min-w-0">
                <p className="truncate font-medium" dir="auto">{p.name}</p>
                {p.username ? <p className="ltr truncate text-xs text-muted-foreground">@{p.username}</p> : null}
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{t("{name} خودش جوابشان را نمی‌دهد؛ گفتگوهای شما هنوز می‌توانند برایشان پیام بفرستند.", { name: BRAND.name })}</p>
            <ul className="scrollbar-thin my-2 max-h-72 space-y-1.5 overflow-y-auto">
              {messages == null ? <li className="text-xs text-muted-foreground">{t("در حال خواندن…")}</li> : null}
              {messages?.length === 0 ? <li className="text-xs text-muted-foreground">{t("پیامی نیست.")}</li> : null}
              {(messages || []).map((m) => (
                <li key={m.id} className={`rounded-lg px-2 py-1.5 text-xs leading-5 ${m.direction === "out" ? "bg-primary/8" : "bg-muted/50"}`}>
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate" dir="auto">{messageAuthor(m)}</span>
                    <span className="shrink-0 tabular-nums" title={exactTime(m.at)}>{ago(m.at)}</span>
                  </span>
                  <span className="line-clamp-3 whitespace-pre-wrap break-words" dir="auto">{m.text}</span>
                  {m.data?.fromChat ? (
                    <a
                      href={`#/c/${m.data.fromChat}`}
                      onClick={() => {
                        setOpen(false);
                        onNavigate?.();
                      }}
                      className="mt-0.5 inline-block text-primary hover:underline"
                    >
                      {t("باز کردن همان گفتگو")}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
            <label className="flex items-center justify-between gap-3 border-t pt-2">
              <span className="text-xs">{t("روشن کردن پاسخ خودکار")}</span>
              <Toggle
                checked={false}
                label={t("روشن کردن پاسخ خودکار")}
                onChange={() => {
                  setOpen(false);
                  watchOn(p.id);
                  onNavigate?.();
                }}
              />
            </label>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </li>
  );
}

// ---------- a mother chat's header ----------

export function WatchPill({ personId }) {
  const person = usePerson(personId);
  if (!person) return null;
  const toggle = () =>
    patchAccess(personId, { watch: !person.watch }).then(() => toast.success(person.watch ? t("پاسخ خودکار خاموش شد") : t("پاسخ خودکار روشن شد")), failed);
  return (
    <button
      type="button"
      onClick={toggle}
      title={person.watch ? t("{name} پیام‌های این نفر را می‌گیرد و جواب می‌دهد", { name: BRAND.name }) : t("{name} به پیام‌های این نفر کاری ندارد", { name: BRAND.name })}
      className={`press shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${person.watch ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground"}`}
    >
      {person.watch ? t("پاسخ خودکار روشن") : t("پاسخ خودکار خاموش")}
    </button>
  );
}

// ---------- the side panel (beside the chat on a wide screen, a bottom sheet on a phone) ----------

function PanelShell({ sheet, onCloseSheet, children }) {
  return (
    <>
      {sheet ? <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={onCloseSheet} /> : null}
      <aside
        className={`scrollbar-thin overflow-y-auto bg-card p-3 md:static md:z-auto md:block md:max-h-none md:w-72 md:shrink-0 md:rounded-none md:border-s md:border-t-0 md:bg-card/50 md:pb-3 md:shadow-none ${
          sheet ? "fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] rounded-t-2xl border-t pb-[max(env(safe-area-inset-bottom),0.75rem)] shadow-xl" : "hidden"
        }`}
      >
        {sheet ? (
          <button type="button" onClick={onCloseSheet} className="float-end rounded-lg p-1.5 text-muted-foreground hover:bg-muted md:hidden" aria-label={t("بستن")}>
            <X className="size-4" />
          </button>
        ) : null}
        {children}
      </aside>
    </>
  );
}

const Heading = ({ children }) => <h3 className="mb-1.5 mt-5 px-1 text-xs font-medium text-muted-foreground first:mt-0">{children}</h3>;
const Empty = ({ children }) => <p className="px-1 text-xs leading-5 text-muted-foreground">{children}</p>;

const HELP_KEY = "griffin.telegram.help";

export function GlobalPanel({ chat, sheet, onCloseSheet }) {
  const feed = useTelegram(FEED);
  const [help, setHelp] = useState(() => readSetting(HELP_KEY, "open") === "open");
  const toggleHelp = (open) => {
    setHelp(open);
    writeSetting(HELP_KEY, open ? "open" : "closed");
  };
  if (!chat) return null;
  const waiting = feed?.waiting || [];
  const threads = feed?.threads || [];
  const pause = (paused) =>
    api("/api/telegram/pause", { method: "POST", body: { paused } }).then(() => {
      refreshTelegram();
      toast.success(paused ? t("{name} در تلگرام متوقف شد", { name: BRAND.name }) : t("{name} در تلگرام دوباره روشن شد", { name: BRAND.name }));
    }, failed);
  const act = (item, action) =>
    api(`/api/telegram/waiting/${item.id}`, { method: "POST", body: { action } }).then(() => {
      refreshTelegram();
      if (action === "send") toast.success(waitingSend(item.kind, item.op)?.done || t("انجام شد"));
    }, failed);
  return (
    <PanelShell sheet={sheet} onCloseSheet={onCloseSheet}>
      <details open={help} onToggle={(e) => toggleHelp(e.currentTarget.open)} className="g-box rounded-xl border bg-card px-3 py-2 text-xs leading-6">
        <summary className="cursor-pointer font-medium">{t("این بخش چطور کار می‌کند؟")}</summary>
        <p className="mt-1 text-muted-foreground">
          {t("{name} از طرف شما در تلگرام جواب همکاران را می‌دهد. هر کسی که پاسخ خودکارش روشن است یک چت مادر دارد: پیام‌هایش آنجا می‌آید و هر کار واقعی‌اش یک ترد کنار همان چت می‌شود. در «🌐 {name} — همه» گزارش همه را می‌بینید و چیزهایی که منتظر شماست. آنچه اینجا می‌نویسید فقط به {name} می‌رسد، نه به همکار؛ هر پیامی که به همکار می‌رود یک کارت «📤 فرستاد» دارد.", { name: BRAND.name })}
        </p>
      </details>

      <label className="mt-3 flex items-center justify-between gap-3 rounded-xl border px-3 py-2">
        <span className="text-xs">
          {t("{name} در تلگرام:", { name: BRAND.name })} <b className={feed?.paused ? "text-muted-foreground" : "text-ok"}>{feed?.paused ? t("متوقف") : t("روشن")}</b>
        </span>
        <Toggle checked={Boolean(feed) && !feed.paused} disabled={!feed} onChange={(on) => pause(!on)} label={t("{name} در تلگرام", { name: BRAND.name })} title={t("متوقف: به هیچ پیامی جواب نمی‌دهد؛ پیام‌ها فقط ثبت می‌شوند")} />
      </label>

      <Heading>{t("منتظر شما ({n})", { n: num(waiting.length) })}</Heading>
      {waiting.length ? (
        <ul className="space-y-2">
          {waiting.map((item) => (
            <li key={item.id} className="rounded-xl border bg-card p-2.5 text-xs">
              <p className="flex items-center gap-2">
                <PersonAvatar personId={item.personId} name={item.name} className="size-5" />
                <span className="min-w-0 flex-1 truncate font-medium" dir="auto"><PersonName personId={item.personId} fallback={item.name} /></span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{clock(item.at)}</span>
              </p>
              {waitingKind(item.kind, item.reason, item.op) ? <p className="mt-0.5 text-muted-foreground">{waitingKind(item.kind, item.reason, item.op)}</p> : null}
              {item.text ? <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words leading-5" dir="auto">{item.text}</p> : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {waitingSend(item.kind, item.op) ? (
                  <button type="button" onClick={() => act(item, "send")} className="press rounded-lg bg-primary px-2.5 py-1 text-primary-foreground">{waitingSend(item.kind, item.op).label}</button>
                ) : null}
                {item.chatId ? <button type="button" onClick={() => navigate(item.chatId)} className="press rounded-lg border px-2.5 py-1 hover:bg-muted">{t("باز کردن")}</button> : null}
                <button type="button" onClick={() => act(item, "dismiss")} className="press rounded-lg px-2.5 py-1 text-muted-foreground hover:bg-muted">{t("ولش کن")}</button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{feed ? t("چیزی منتظر شما نیست.") : t("در حال بارگذاری…")}</Empty>
      )}

      <Heading>{t("ترد‌های باز ({n})", { n: num(threads.length) })}</Heading>
      {threads.length ? (
        <ul className="space-y-1">
          {threads.map((th) => (
            <li key={th.thread}>
              <button type="button" onClick={() => navigate(th.thread)} className="w-full rounded-lg px-2 py-1.5 text-start text-xs hover:bg-muted">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" dir="auto">{th.title}</span>
                  {th.state === "running" ? <Dots /> : null}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground" dir="auto">
                  <PersonName personId={th.personId} fallback={th.person} />
                  {th.joined?.length ? t(" · همراه: {names}", { names: th.joined.join(t("، ")) }) : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{t("تردی باز نیست.")}</Empty>
      )}
    </PanelShell>
  );
}

export function MotherPanel({ chat, sheet, onCloseSheet }) {
  const person = usePerson(chat?.personId);
  const feed = useTelegram(FEED);
  const [rows, setRows] = useState([]); // this person's threads, for the old 🧵 ones still open
  const [log, setLog] = useState(null); // the Telegram conversation, read when its section opens
  const personId = chat?.personId;
  useEffect(() => {
    if (!personId) return undefined;
    let alive = true;
    api(`/api/telegram/persons/${personId}/threads`).then((r) => alive && setRows(r.threads || []), () => {});
    return () => {
      alive = false;
    };
  }, [personId]);
  if (!chat) return null;
  const legacy = legacyThreads(rows, chat);
  const watch = Boolean(person?.watch);
  const threads = chat.children || [];
  const running = threads.filter((th) => th.runStatus === "running");
  const done = threads.filter((th) => th.runStatus !== "running");
  const others = othersThreads(feed?.threads, chat.id);
  const setAccess = (patch, message) => patchAccess(personId, patch).then(() => message && toast.success(message), failed);
  const readLog = (open) => {
    if (open && !log) api(`/api/telegram/persons/${personId}/messages?limit=30`).then((r) => setLog(r.messages || []), () => setLog([]));
  };
  const close = (id) => api(`/api/telegram/threads/${id}/close`, { method: "POST" }).then(() => setRows((list) => list.filter((c) => c.id !== id)), failed);
  const thread = (th) => <ThreadItem key={th.id} thread={th} personId={personId} others={others} />;
  return (
    <PanelShell sheet={sheet} onCloseSheet={onCloseSheet}>
      <PersonHeader personId={personId} person={person} fallback={motherName(chat)} />

      <div className="mt-3 space-y-3 rounded-xl border px-3 py-2.5">
        <label className="flex items-center justify-between gap-3" title={watchHint()}>
          <span className="text-xs">{watch ? t("پاسخ خودکار به این شخص: روشن") : t("پاسخ خودکار به این شخص: خاموش")}<span className="mt-0.5 block text-[11px] leading-5 text-muted-foreground">{watchHint()}</span></span>
          <Toggle checked={watch} disabled={!person} onChange={(on) => setAccess({ watch: on }, on ? t("پاسخ خودکار روشن شد") : t("پاسخ خودکار خاموش شد"))} label={t("پاسخ خودکار")} />
        </label>
        <label className="block text-xs">
          {t("پیام‌ها را کی بردارد؟")}
          <select
            value={Number(person?.pickupEvery) || 0}
            disabled={!watch}
            onChange={(e) => setAccess({ pickupEvery: Number(e.target.value) }, t("ذخیره شد"))}
            className="mt-1 w-full rounded-lg border bg-card px-2 py-1.5 text-xs text-foreground disabled:opacity-50"
          >
            {PICKUPS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
      </div>

      <Heading>{t("ترد‌ها")}</Heading>
      {threads.length ? (
        <>
          {running.length ? <p className="mb-1 px-1 text-[11px] text-muted-foreground">{t("در جریان ({n})", { n: num(running.length) })}</p> : null}
          <ul className="space-y-1">{running.map(thread)}</ul>
          {done.length ? <p className="mb-1 mt-3 px-1 text-[11px] text-muted-foreground">{t("تمام‌شده")}</p> : null}
          <ul className="space-y-1">{done.map(thread)}</ul>
        </>
      ) : (
        <Empty>{t("هنوز تردی باز نشده؛ کار واقعی‌ای که این نفر بخواهد اینجا یک ترد می‌شود.")}</Empty>
      )}

      {legacy.length ? (
        <>
          <Heading>{t("ترد‌های قدیمی")}</Heading>
          <ul className="space-y-1">
            {legacy.map((c) => (
              <li key={c.id} className="flex items-center rounded-lg hover:bg-muted">
                <button type="button" onClick={() => navigate(c.id)} className="min-w-0 flex-1 truncate px-2 py-1.5 text-start text-xs" dir="auto">{c.title}</button>
                <button type="button" onClick={() => close(c.id)} className="press me-1 shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-background">{t("بستن")}</button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <details onToggle={(e) => readLog(e.currentTarget.open)} className="mt-5">
        <summary className="cursor-pointer px-1 text-xs font-medium text-muted-foreground">{t("گفتگوی تلگرام")}</summary>
        <ul className="mt-2 space-y-1.5">
          {log == null ? <li className="px-1 text-xs text-muted-foreground">{t("در حال خواندن…")}</li> : null}
          {log?.length === 0 ? <li className="px-1 text-xs text-muted-foreground">{t("پیامی نیست.")}</li> : null}
          {(log || []).map((m) => (
            <li key={m.id} className={`rounded-lg px-2 py-1.5 text-xs leading-5 ${m.direction === "out" ? "bg-primary/8" : "bg-muted/60"}`}>
              <span className="flex gap-2 text-[11px] text-muted-foreground">
                <span>{messageAuthor(m)}</span>
                <span className="ms-auto tabular-nums">{clock(m.at)}</span>
              </span>
              <span className="block whitespace-pre-wrap break-words" dir="auto">{m.text}</span>
            </li>
          ))}
        </ul>
      </details>
    </PanelShell>
  );
}

// The mother panel's head: photo, localized name (editable; empty = automatic again), Telegram's own name.
export function PersonHeader({ personId, person, fallback }) {
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const name = person?.name || fallback;
  const save = async () => {
    const value = editing.trim();
    // Telegram's own name (or no change) is nothing to save: written, it would pin the Latin name as
    // the localized one for good (fa-names.mjs fills only rows left empty).
    if (value && (value === person?.tgName || value === person?.name)) return setEditing(null);
    setBusy(true);
    try {
      const result = await api(`/api/telegram/persons/${personId}`, { method: "PATCH", body: { name: value } });
      refreshTelegram();
      // Empty = automatic again; until the server has filled it, Telegram's name stays up.
      toast.success(value ? t("نام ذخیره شد") : result?.person?.fa_name || isRtlText(result?.person?.name) ? t("نام به حالت خودکار برگشت") : t("نام به حالت خودکار برگشت؛ نام فارسی به‌زودی نمایش داده می‌شود"));
      setEditing(null);
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-1">
      <div className="flex items-center gap-2.5">
        <PersonAvatar personId={personId} name={name} className="size-10" />
        <div className="min-w-0 flex-1">
          {editing == null ? (
            <p className="flex items-center gap-1">
              <span className="min-w-0 truncate text-sm font-medium" dir="auto">{name}</span>
              {person ? (
                <button type="button" onClick={() => setEditing(isRtlText(person.name) ? person.name : "")} className="press shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title={t("تغییر نام")} aria-label={t("تغییر نام")}>
                  <Pencil className="size-3" />
                </button>
              ) : null}
            </p>
          ) : (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <input
                autoFocus
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                dir="auto"
                className="min-w-0 flex-1 rounded-md border bg-card px-2 py-1 text-sm"
                aria-label={t("نام فارسی")}
              />
              <button type="submit" disabled={busy} className="press shrink-0 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">{t("ذخیره")}</button>
            </form>
          )}
          {person?.tgName && person.tgName !== person.name ? <p className="ltr truncate text-[11px] text-muted-foreground" dir="auto">{person.tgName}</p> : null}
          {person?.username ? <p className="ltr truncate text-[11px] text-muted-foreground">@{person.username}</p> : null}
        </div>
      </div>
      {editing != null ? <p className="mt-1 text-[11px] text-muted-foreground">{t("خالی بگذارید تا خودکار فارسی شود. Esc: انصراف")}</p> : null}
    </div>
  );
}

function ThreadItem({ thread: th, personId, others }) {
  const [menu, setMenu] = useState(false);
  const join = (target) => {
    setMenu(false);
    api(`/api/telegram/threads/${target.thread}/join`, { method: "POST", body: { person: personId } }).then(() => {
      refreshTelegram();
      toast.success(t("به «{title}» پیوست", { title: target.title }));
    }, failed);
  };
  return (
    <li className="flex items-center rounded-lg hover:bg-muted">
      <button type="button" onClick={() => navigate(th.id)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-start text-xs">
        <span className="min-w-0 flex-1 truncate" dir="auto">{String(th.title || t("ترد")).replace(/^🧵\s*[^:]*:\s*/, "")}</span>
        {th.runStatus === "running" ? <Dots /> : <span className="shrink-0 text-[11px] text-muted-foreground">{threadState(th.runStatus)}</span>}
      </button>
      {th.runStatus === "running" ? (
        <button
          type="button"
          onClick={() => api(`/api/chats/${th.id}/cancel`, { method: "POST" }).then(() => toast.success(t("متوقف شد")), failed)}
          className="press rounded-md p-1.5 text-muted-foreground hover:bg-bad/10 hover:text-bad"
          title={t("توقف این ترد")}
          aria-label={t("توقف این ترد")}
        >
          <Square className="size-3.5" />
        </button>
      ) : null}
      {others.length ? (
        <Popover.Root open={menu} onOpenChange={setMenu}>
          <Popover.Trigger asChild>
            <button type="button" className="press me-1 rounded-md p-1.5 text-muted-foreground hover:bg-background" title={t("همان مسئلهٔ ترد دیگری است")} aria-label={t("همان مسئلهٔ ترد دیگری است")}>
              <Network className="size-3.5" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="end" sideOffset={6} collisionPadding={12} className="g-menu pop z-50 max-h-72 w-64 overflow-y-auto rounded-xl border bg-card p-1 text-sm shadow-xl" dir={isRtl ? "rtl" : "ltr"}>
              <p className="px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">{t("همان مسئلهٔ…")}</p>
              {others.map((o) => (
                <button key={o.thread} type="button" onClick={() => join(o)} className="g-menu-row block w-full rounded-lg px-2.5 py-2 text-start hover:bg-muted">
                  <span className="block truncate text-xs" dir="auto">{o.title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground" dir="auto"><PersonName personId={o.personId} fallback={o.person} /></span>
                </button>
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </li>
  );
}

// ---------- tg.note rows in a chat (Thread.jsx draws them as system messages) ----------

export function NoteRow({ note }) {
  // The person's localized name, not the one the note was written with (the server fills it in later).
  const person = usePerson(note.personId);
  const named = person ? { ...note, name: person.name } : note;
  // The desk's supervisor: something needs the owner's eye; opens the person's mother chat.
  if (note.kind === "watch") {
    const body = (
      <span className="flex items-start gap-2 text-xs leading-5">
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words" dir="auto">{noteLine(named)}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{clock(note.at)}</span>
      </span>
    );
    const box = "g-box block w-full rounded-xl border border-warn/40 bg-warn/5 px-3 py-2 text-start";
    return note.chatId ? (
      <button type="button" onClick={() => navigate(note.chatId)} className={`${box} hover:border-warn`}>{body}</button>
    ) : (
      <div className={box}>{body}</div>
    );
  }
  // A colleague's message that went to a fork, not into this chat (server proposals.mjs): where it
  // went and why, and «بیار اینجا» to bring it in by the owner's own click.
  if (note.kind === "proposal") return <ProposalNote note={note} />;
  if (note.kind === "report") {
    const chip = stateChip(note.state);
    const sent = Array.isArray(note.sent) ? note.sent.filter(Boolean) : [];
    const body = (
      <>
        <span className="flex items-center gap-2 text-xs">
          <PersonAvatar personId={note.personId} name={note.name} className="size-5" />
          <span className="min-w-0 truncate font-medium" dir="auto">{named.name || t("همکار")}</span>
          <Chip chip={chip} />
          <span className="ms-auto shrink-0 tabular-nums text-muted-foreground">{clock(note.at)}</span>
        </span>
        {note.text ? <span className="mt-1 block whitespace-pre-wrap break-words text-sm leading-6" dir="auto">{note.text}</span> : null}
        {sent.map((line, i) => (
          <span key={i} className="mt-1 block whitespace-pre-wrap break-words rounded-lg bg-primary/8 px-2 py-1 text-xs leading-5" dir="auto">📤 {line}</span>
        ))}
      </>
    );
    return note.chatId ? (
      <button type="button" onClick={() => navigate(note.chatId)} className="g-box block w-full rounded-xl border bg-card px-3 py-2 text-start hover:border-primary/40">{body}</button>
    ) : (
      <div className="g-box rounded-xl border bg-card px-3 py-2">{body}</div>
    );
  }
  // «روشن کن» already pressed (or turned on elsewhere): the card says so and the button goes.
  const switchedOn = note.kind === "unwatched" && person?.watch;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 px-4 text-center text-xs leading-5 text-muted-foreground">
      <span className="min-w-0 whitespace-pre-wrap break-words" dir="auto">{switchedOn ? t("✅ {v} پیام داد — پاسخ خودکار به او روشن شد", { v: named.name || t("کسی") }) : noteLine(named)}</span>
      {note.kind === "unwatched" && note.text ? <span className="w-full truncate opacity-80" dir="auto">«{note.text}»</span> : null}
      {note.kind === "unwatched" && !switchedOn ? <span className="w-full opacity-80">{watchHint()}</span> : null}
      {note.kind === "unwatched" && note.personId && !switchedOn ? (
        <button type="button" onClick={() => watchOn(note.personId, { open: false })} className="press rounded-md border px-2 py-0.5 text-foreground hover:bg-muted">{t("روشن کن")}</button>
      ) : null}
      {note.at ? <span className="tabular-nums opacity-70">{clock(note.at)}</span> : null}
    </div>
  );
}

function ProposalNote({ note }) {
  const [state, setState] = useState("open");
  const bring = async () => {
    setState("busy");
    try {
      await api(`/api/chats/${note.here}/proposals/${note.proposalId}/accept`, { method: "POST" });
      setState("done");
    } catch (error) {
      setState("open");
      toast.error(error?.status === 404 ? t("این پیام قبلاً آورده شده") : t("آوردن پیام ممکن نشد"));
    }
  };
  return (
    <div className="g-box rounded-xl border bg-card px-3 py-2 text-xs leading-5">
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words" dir="auto">
          {t("📥 پیام {v} {v2} به «{v3}» رفت{v4}", { v: note.name || t("همکار"), v2: note.mine ? t("دربارهٔ همین کار بود؛ چون اینجا مشغول بودید") : t("موضوع دیگری بود؛"), v3: note.title || t("انشعاب"), v4: note.text ? ` — ${note.text}` : "" })}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{clock(note.at)}</span>
      </span>
      <span className="mt-2 flex gap-2">
        <button type="button" onClick={() => navigate(note.chatId)} className="press rounded-md border px-2 py-0.5 hover:bg-muted">{t("باز کن")}</button>
        {state === "done" ? (
          <span className="px-2 py-0.5 text-muted-foreground">{t("آورده شد")}</span>
        ) : (
          <button type="button" disabled={state === "busy"} onClick={bring} className="press rounded-md border px-2 py-0.5 hover:bg-muted disabled:opacity-50">{t("بیار اینجا")}</button>
        )}
      </span>
    </div>
  );
}
