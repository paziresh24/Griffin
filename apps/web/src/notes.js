// Notes ("later"): a message written now and sent later — by hand, or at a time
// picked relative to now, as Telegram's scheduled send does. Pure helpers + the shared store.
import { lang, locale, num, t } from "./i18n.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The choices in the "later" menu. `at(now)` is the run time in ms; null = no time. */
export const LATER_CHOICES = [
  { key: "none", label: t("فقط ذخیره کن (خودم اجرا می‌کنم)"), at: () => null },
  { key: "15m", label: t("{n} دقیقه بعد", { n: num(15) }), at: (now) => now + 15 * MINUTE },
  { key: "1h", label: t("{n} ساعت بعد", { n: num(1) }), at: (now) => now + HOUR },
  { key: "2h", label: t("{n} ساعت بعد", { n: num(2) }), at: (now) => now + 2 * HOUR },
  { key: "4h", label: t("{n} ساعت بعد", { n: num(4) }), at: (now) => now + 4 * HOUR },
  { key: "8h", label: t("{n} ساعت بعد", { n: num(8) }), at: (now) => now + 8 * HOUR },
  { key: "1d", label: t("فردا همین ساعت"), at: (now) => now + 24 * HOUR },
];

const fa = (n) => num(n, { useGrouping: false });
const two = (n) => num(n, { minimumIntegerDigits: 2, useGrouping: false });

const dayStart = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "17:20", "tomorrow 09:00", or "12 Oct 09:00" for a time further away (local clock). */
export function clockLabel(atMs, nowMs = Date.now()) {
  const d = new Date(atMs);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const days = Math.round((dayStart(atMs) - dayStart(nowMs)) / (24 * HOUR));
  if (days === 0) return time;
  if (days === 1) return t("فردا {time}", { time });
  if (days === -1) return t("دیروز {time}", { time });
  const date = new Intl.DateTimeFormat(lang === "fa" ? "fa-IR-u-ca-persian" : locale, { day: "numeric", month: "long" }).format(d);
  return `${date} ${time}`;
}

/** How far a run time is from now: "in 15 minutes", "in 2 hours"; past = "due". */
export function untilLabel(atMs, nowMs = Date.now()) {
  const left = atMs - nowMs;
  if (left <= 0) return t("موعدش رسیده");
  if (left < MINUTE) return t("کمتر از یک دقیقه دیگر");
  if (left < HOUR) return t("{n} دقیقه دیگر", { n: fa(Math.round(left / MINUTE)) });
  if (left < 24 * HOUR) {
    // Rounded once, so 1 h 59.6 min reads "2 hours", never "1 hour and 60 minutes".
    const total = Math.round(left / MINUTE);
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return minutes && hours < 4 ? t("{h} ساعت و {m} دقیقه دیگر", { h: fa(hours), m: fa(minutes) }) : t("{n} ساعت دیگر", { n: fa(Math.round(left / HOUR)) });
  }
  return t("{n} روز دیگر", { n: fa(Math.round(left / (24 * HOUR))) });
}

/** The note's time line: "in 2 hours (17:20)", or "no time". */
export function noteWhen(note, nowMs = Date.now()) {
  if (!note?.runAt) return t("بدون زمان · هر وقت خواستید");
  const at = Date.parse(note.runAt);
  return `${untilLabel(at, nowMs)} (${clockLabel(at, nowMs)})`;
}

/** Where it goes: a new chat, or an existing one by title. */
export function noteTarget(note) {
  if (!note?.chatId) return t("چت جدید");
  return t("در چت «{title}»", { title: note.chatTitle || t("حذف‌شده") });
}

/** The sidebar's list: the person's own notes; an agent's reminder shows only in its own chat. */
export const sidebarNotes = (items) => (items || []).filter((note) => !note.reminder);

/** A first line for the card: the note's opening words. */
export function noteTitle(note, max = 80) {
  const line = String(note?.text || "").trim().split("\n")[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `<input type="datetime-local">` value <-> ms, in the local clock. */
export function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(value) {
  const ms = new Date(String(value || "")).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** The body of POST /api/notes for what the composer holds. */
export function noteBody({ text, chatId = null, atMs = null, options = {} }) {
  const body = { text: String(text || "").trim(), runAt: atMs ? new Date(atMs).toISOString() : null };
  if (chatId) body.chatId = chatId;
  else {
    const picked = {};
    // An empty repo is a choice ("no repo"); any other empty value means "the default".
    for (const [key, value] of Object.entries(options || {})) if (typeof value === "string" && (value || key === "repo")) picked[key] = value;
    body.options = picked;
  }
  return body;
}

/** The server's refusals, in the owner's words. */
export function noteError(error) {
  const text = String(error?.message || error || "");
  const known = {
    "runAt is in the past": t("این زمان گذشته است؛ زمان دیگری انتخاب کنید"),
    "invalid runAt": t("زمان درست نیست"),
    "chat not found": t("این چت دیگر وجود ندارد"),
    "text required": t("متن خالی است"),
    "text too long": t("متن خیلی بلند است"),
    "unknown repo": t("این ریپو روی سرور نیست"),
  };
  if (known[text]) return known[text];
  if (text.startsWith("already")) return t("این یادداشت قبلاً اجرا شده");
  return text || t("انجام نشد");
}

/** One store for the sidebar list and the composer. `api(path, { method, body })`. */
export function createNotesStore(api) {
  let state = { items: [], busy: {}, loaded: false };
  const listeners = new Set();
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const path = (id, tail = "") => `/api/notes/${encodeURIComponent(id)}${tail}`;
  const store = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    async refresh() {
      try {
        const data = await api("/api/notes");
        set({ items: Array.isArray(data?.notes) ? data.notes : [], loaded: true });
      } catch {
        // An older server without the endpoint: the section just stays empty.
        set({ loaded: true });
      }
    },
    async create(body) {
      const data = await api("/api/notes", { method: "POST", body });
      await store.refresh();
      return data?.note || null;
    },
    async act(id, run) {
      if (!id || state.busy[id]) return null;
      set({ busy: { ...state.busy, [id]: true } });
      try {
        return await run();
      } finally {
        const { [id]: _done, ...busy } = state.busy;
        set({ busy });
        await store.refresh();
      }
    },
    update: (id, patch) => store.act(id, () => api(path(id), { method: "PATCH", body: patch })),
    remove: (id) => store.act(id, () => api(path(id), { method: "DELETE" })),
    /** Resolves to the chat the note went to (or null). */
    run: (id) => store.act(id, async () => (await api(path(id, "/run"), { method: "POST" }))?.chat || null),
  };
  return store;
}
