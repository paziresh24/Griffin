// Telegram v2 as pure functions (the components in Telegram.jsx only draw the result): who shows
// in the sidebar and where, the one-word state of each person, who wrote a line of a Telegram
// conversation, and how a «tg.note» event reads. The model the owner reads: the assistant answers
// colleagues on his behalf; each watched person has one mother chat; what he writes in Griffin
// reaches only the assistant; everything sent to a colleague shows as a «📤» card.
import { BRAND } from "./brand.js";
import { locale, num, t } from "./i18n.js";

// state.state of GET /api/telegram/people (kv tgstate) and of a report note.
const STATES = {
  sent: { label: t("📤 جواب رفت"), tone: "ok" },
  edited: { label: t("✏️ پیام قبلی به‌روز شد"), tone: "muted" },
  working: { label: t("⏳ در حال کار"), tone: "primary" },
  waiting: { label: t("🙋 منتظر شما"), tone: "warn" },
  no_reply: { label: t("💬 جوابی لازم نبود"), tone: "muted" },
  owner: { label: t("🔇 خودتان جواب دادید"), tone: "muted" },
  queued: { label: t("🕒 در صف"), tone: "muted" },
  failed: { label: t("⚠️ ارسال نشد"), tone: "bad" },
  paused: { label: t("⏸ متوقف"), tone: "muted" },
};

export const clock = (stamp) => {
  const at = stamp ? new Date(stamp) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
};

// A queued person shows until when: the pickup queue's due time when known.
export function stateChip(state, due = null) {
  const known = STATES[state];
  if (!known) return null;
  const until = state === "queued" ? clock(due) : "";
  return { id: state, tone: known.tone, label: until ? t("{label} تا {until}", { label: known.label, until }) : known.label };
}

export const personChip = (person) => stateChip(person?.state?.state, person?.queued?.due ?? person?.state?.at);

// Sidebar sections: people and groups whose watcher is on (or who have something waiting for the
// owner), newest first; the rest go under "off". A search narrows all three by name: the
// localized one shown, Telegram's own (often Latin) or the @username.
export function peopleSections(people, { query = "", waiting = [] } = {}) {
  const q = String(query).trim().toLowerCase();
  const waits = new Set((waiting || []).map((w) => w.personId));
  const shown = (people || []).filter((p) => !q || `${p.name || ""} ${p.tgName || ""} ${p.username || ""}`.toLowerCase().includes(q));
  const on = (p) => Boolean(p.watch) || waits.has(p.id);
  const newest = (a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || ""));
  const live = shown.filter(on).sort(newest);
  return {
    people: live.filter((p) => !p.group),
    groups: live.filter((p) => p.group),
    off: shown.filter((p) => !on(p)).sort(newest),
  };
}

// Who wrote a line of a person's Telegram conversation (GET /persons/:id/messages).
export function messageAuthor(message, assistant = BRAND.name) {
  if (message?.direction !== "out") return t("او");
  const by = message.data?.by;
  return by === "owner" ? t("شما") : by === "session" ? t("جلسهٔ دیگر") : assistant;
}

// A colleague's message enters the mother chat as «name»: text — the bubble already says who.
export function stripSender(text, name) {
  const value = String(text ?? "");
  if (!name) return value;
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`^\\s*«?${escaped}»?\\s*:\\s*`), "");
}

// The owner's web note reaches the agent framed («<owner> از داخل <platform> — …»: …); the bubble
// already says it is his private note, so the frame is not shown.
export function stripOwnerFrame(text) {
  return String(text ?? "").replace(/^\s*«[^«»]* از داخل [^»]*»\s*:\s*/, ""); // i18n-ignore: matches the server's frame
}

export const isNoReply = (text) => String(text ?? "").trim() === "[NO_REPLY]";

// A system line the server put in the chat ("[automatic sub-task report …]"), not something the owner typed.
export const isSystemText = (text) => /^\s*\[/.test(String(text ?? ""));

// The person a mother chat is for: its title is «👤 name».
export const motherName = (chat) => chat?.ownerLabel || String(chat?.title || "").replace(/^👤\s*/, "");

// A tg.note that is one line (a report is drawn as a card).
export function noteLine(note, assistant = BRAND.name) {
  switch (note?.kind) {
    case "owner_line":
      return t("{who} در تلگرام: {text}", { who: note.by === "session" ? t("جلسهٔ دیگر") : t("شما"), text: note.text || "" });
    case "unwatched":
      return t("📭 {name} پیام داد — واچر خاموش", { name: note.name || t("کسی") });
    case "paused":
      return note.name
        ? t("⏸ {name} پیام داد — {assistant} در تلگرام متوقف است", { name: note.name, assistant })
        : t("⏸ {assistant} در تلگرام متوقف است", { assistant });
    case "watch":
      return `👁 ${note.text || ""}`;
    default:
      return String(note?.text || "");
  }
}

// assistant-ui takes a system message with exactly one text part; the note rides in metadata.
export function noteMessage(message) {
  return {
    id: message.id,
    role: "system",
    content: [{ type: "text", text: String(message.text || message.kind || "") }],
    createdAt: message.at ? new Date(message.at) : undefined,
    metadata: { custom: { note: message } },
  };
}

// The account line under the desk row ("🌐 … — all").
export function connectionLine(feed) {
  if (!feed) return null;
  if (feed.paused) return { text: t("متوقف"), tone: "muted" };
  const state = feed.account?.state;
  // "none": no Telegram account is connected (or it is turned off) — not a dropped connection.
  if (!state || state === "none") return { text: t("اکانت تلگرام وصل نیست"), tone: "bad" };
  if (state === "polling" || state === "webhook") return { text: t("وصل"), tone: "ok" };
  if (state === "starting") return { text: t("در حال وصل شدن"), tone: "muted" };
  return { text: t("قطع است"), tone: "bad", title: feed.account?.lastError || "" };
}

// Open threads of other people, for "the same issue as…" in a mother chat.
export const othersThreads = (threads, motherChatId) => (threads || []).filter((th) => th.motherChat !== motherChatId);

// Old 🧵 threads of this person (before the mother chats) that are still open, from GET
// /persons/:id/threads: not closed, and neither the mother chat nor its own threads (listed above).
export function legacyThreads(threads, chat) {
  const mine = new Set([chat?.id, ...(chat?.children || []).map((c) => c.id)]);
  return (threads || []).filter((th) => !th.closed && !mine.has(th.id));
}

// A thread chat's run state in words.
export const threadState = (runStatus) =>
  ({ running: t("در حال کار"), finished: t("تمام شد"), error: t("خطا"), cancelled: t("متوقف شد"), resolved: t("حل شد") })[runStatus] || "";

// The letter in an avatar with no photo: the name's first letter («👤 Ali» → A), else a question mark.
export const initialOf = (name) => String(name ?? "").match(/\p{L}/u)?.[0] || t("؟");

// Why a draft was held (desk.mjs holdReason), in words.
const HELD = { owner_replied: t("خودتان جواب داده بودید"), paused: t("پاسخ خودکار متوقف بود"), unwatched: t("واچرش خاموش بود") };
export const heldWhy = (reason) => HELD[reason] || HELD.owner_replied;

// A waiting item's kind in words (op: a held edit / delete of one of the assistant's sent messages).
export const waitingKind = (kind, reason = null, op = null) =>
  ({
    draft: t("{what} — {why}", {
      what: op === "edit" ? t("ویرایش پیام نگه‌داشته") : op === "delete" ? t("برداشتن پیام نگه‌داشته") : t("پیش‌نویس نگه‌داشته"),
      why: heldWhy(reason),
    }),
    brake: t("پیام‌های زیاد در یک ساعت؛ برای بعد ماند"),
    failed: t("ارسال نشد"),
  })[kind] || "";

// What "send" does to a waiting item (POST /api/telegram/waiting/:id {action:"send"}): a held draft
// goes out, a braked batch runs now, a failed answer is tried again.
export const waitingSend = (kind, op = null) =>
  (kind === "draft" && op ? { label: t("اعمال کن"), done: t("اعمال شد") } : null) ||
  ({
    draft: { label: t("بفرست"), done: t("فرستاده شد") },
    brake: { label: t("اجرا کن"), done: t("اجرا شد") },
    failed: { label: t("دوباره"), done: t("دوباره اجرا شد") },
  })[kind] || null;

// The status line under a send / edit / delete / hand-to-mother-chat card.
export function sentStatus(result, toPerson) {
  if (result?.held) return { text: t("نگه داشتم — {why}", { why: heldWhy(result.reason) }), warn: true };
  if (result?.skipped) return { text: t("فرستاده نشد (لازم نبود)") };
  if (result?.edited) return { text: t("✏️ ویرایش شد · #{id}", { id: result.id }) };
  if (result?.deleted) return { text: t("🗑 برداشته شد · #{id}", { id: result.id }) };
  if (result?.ok || result?.sent || result?.told) {
    if (!toPerson) return { text: t("به چت مادر رسید") };
    const before = result.unansweredBefore?.length;
    const sent = result.id != null ? t("📤 فرستاده شد · #{id}", { id: result.id }) : t("📤 فرستاده شد");
    return { text: before ? t("{sent} — قبلش {n} پیام بی‌جواب داشت", { sent, n: num(before) }) : sent, warn: before >= 2 };
  }
  return result?.error ? { text: String(result.error) } : null;
}

// Whose a user message is. Any `from` but the owner's own note relayed from the desk (owner_web) is
// someone else's words — a colleague, or their Telegram transcript handed over: a muted named
// bubble, never edited or rewound. In a mother chat the owner's own words are a private note.
export function userSide(from, text, chat) {
  const theirs = Boolean(from) && from.kind !== "owner_web";
  return { theirs, ownerNote: Boolean(chat?.mother) && !theirs && !isSystemText(text), editable: !from };
}

// One poller per endpoint for the whole page: the sidebar (desktop and phone drawer), the header
// pill and the side panel all read the same answer instead of polling it each. subscribe(path) is
// one function per path, because React re-subscribes whenever it gets a new one; and subscribing
// fetches only when nothing is loading and no poll is due (a new function per render used to fetch
// /people and /feed on every frame of a streaming chat).
export function pollStore(fetcher, pollMs) {
  const feeds = new Map();
  const of = (path) => {
    if (!feeds.has(path)) feeds.set(path, { data: null, listeners: new Set(), timer: null, loading: false, gen: 0, subscribe: null });
    return feeds.get(path);
  };
  async function load(path) {
    const f = of(path);
    const gen = ++f.gen;
    clearTimeout(f.timer);
    f.timer = null;
    f.loading = true;
    let data = f.data;
    try {
      data = await fetcher(path);
    } catch {
      // keep the last answer; the next tick asks again
    }
    if (gen !== f.gen) return; // a newer load (a refresh after a change) owns the result
    f.loading = false;
    f.data = data;
    for (const listener of f.listeners) listener();
    // The next poll, skipped when nobody listens by then.
    f.timer = setTimeout(() => {
      f.timer = null;
      if (f.listeners.size) load(path);
    }, pollMs);
  }
  function subscribe(path) {
    const f = of(path);
    f.subscribe ||= (onChange) => {
      f.listeners.add(onChange);
      if (!f.timer && !f.loading) load(path);
      return () => f.listeners.delete(onChange);
    };
    return f.subscribe;
  }
  const refresh = () => {
    for (const [path, f] of feeds) if (f.listeners.size) load(path);
  };
  return { subscribe, data: (path) => of(path).data, refresh };
}

export const PICKUPS = [
  { value: 0, label: t("با هر پیام") },
  { value: 15, label: t("هر ۱۵ دقیقه") },
  { value: 30, label: t("هر ۳۰ دقیقه") },
  { value: 60, label: t("هر ۱ ساعت") },
  { value: 120, label: t("هر ۲ ساعت") },
  { value: 240, label: t("هر ۴ ساعت") },
];
