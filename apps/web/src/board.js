// The assistant's task board on the home page, as pure functions: the inbox store (what waits for
// the owner, from GET /api/inbox) and which chats show as working or just done. A task is a root
// chat, so the board is derived from the chat list the sidebar already holds; nothing here touches
// React or the DOM, so the node tests import it as is.
import { locale, num, t } from "./i18n.js";

const fa = (n) => num(Number(n || 0));
const time = (stamp) => {
  const ms = typeof stamp === "number" ? stamp : Date.parse(stamp || "");
  return Number.isFinite(ms) ? ms : 0;
};
const runningChildren = (chat) => (chat?.children || []).filter((k) => k.runStatus === "running").length;

/**
 * The inbox as a tiny external store (for useSyncExternalStore). Refreshes coalesce: a refresh asked
 * for while one is in flight runs once more after it, so the last change is never missed and a burst
 * of events costs two fetches. A failed fetch keeps the last list on screen.
 */
export function createInboxStore(fetcher) {
  let state = { items: [], count: 0, todos: {}, loaded: false };
  const listeners = new Set();
  let inflight = null;
  let again = false;
  const loop = async () => {
    while (again) {
      again = false;
      try {
        // .then: a fetcher that throws at once still yields first, so `inflight` is set before the loop ends.
        const data = await Promise.resolve().then(fetcher);
        const items = Array.isArray(data?.items) ? data.items : [];
        state = { items, count: Number(data?.count ?? items.length) || 0, todos: data?.todos || {}, loaded: true };
        for (const fn of listeners) fn();
      } catch {
        if (!state.loaded) state = { ...state, loaded: true };
      }
    }
    inflight = null;
  };
  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    refresh() {
      again = true;
      inflight ||= loop();
      return inflight;
    },
  };
}

export const SOURCE_TAGS = { telegram: t("تلگرام"), peer: t("همکار"), job: t("جاب"), ops: t("عملیات") };
export const sourceTag = (chat) => (chat?.global || chat?.mother ? SOURCE_TAGS.telegram : SOURCE_TAGS[chat?.source] || null);

// «در حال کار»: a chat whose run is running, whose subtask runs, or that waits for the plan limit to
// reset (it goes on by itself). Newest start first.
export function workingTasks(chats, todos = {}, { limit = 12 } = {}) {
  return (chats || [])
    .filter((c) => c.runStatus === "running" || runningChildren(c) > 0 || c.limitResumeAt)
    .map((c) => ({
      chat: c,
      todo: todos?.[c.id] || null,
      runningChildren: runningChildren(c),
      waiting: Boolean(c.waitingForOwner),
      // Stop also when only its subtasks run: cancelling the root cancels its delegates.
      stoppable: c.runStatus === "running" || runningChildren(c) > 0,
      resumeAt: c.runStatus === "running" ? null : c.limitResumeAt || null,
      since: c.runStartedAt || c.updatedAt,
    }))
    .sort((a, b) => time(b.since) - time(a.since))
    .slice(0, limit);
}

// "resolved": an error the owner marked «حل شد»; it stays here with the ✓.
const DONE = new Set(["finished", "error", "cancelled", "resolved"]);
const DAY = 24 * 3600_000;

// «تازه تمام شد»: the owner's and colleagues' (/mcp) tasks that ended in the last day — Telegram,
// jobs and the ops room report elsewhere. Unread first.
export function recentDone(chats, { isUnread = () => false, now = Date.now(), limit = 6 } = {}) {
  return (chats || [])
    .filter((c) => ["manual", "peer"].includes(c.source || "manual") && !c.mother && !c.global)
    // Waiting for the plan limit is still work (it is listed under «در حال کار»).
    .filter((c) => DONE.has(c.runStatus) && !runningChildren(c) && !c.limitResumeAt && now - Date.parse(c.updatedAt) <= DAY)
    .sort((a, b) => Number(Boolean(isUnread(b))) - Number(Boolean(isUnread(a))) || time(b.updatedAt) - time(a.updatedAt))
    .slice(0, limit);
}

// A working row's second line: «۲/۵ — <step>», when it resumes by itself, or plain «در حال کار».
export function stepLine(row) {
  const todo = row?.todo;
  if (todo?.total) return todo.current ? `${fa(todo.done)}/${fa(todo.total)} — ${todo.current}` : `${fa(todo.done)}/${fa(todo.total)}`;
  if (row?.resumeAt) {
    const clock = new Date(row.resumeAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
    return t("ساعت {time} خودش ادامه می‌دهد", { time: clock });
  }
  return t("در حال کار");
}

// An inbox card's head: its title (a chore's title is its body, shown in full below) and, for what
// came from someone else's chain, «از گفتگو با «…»» — on its own line, a phone has no room beside it.
export function cardHead(item) {
  return {
    title: item?.kind === "chore" ? "" : item?.title || item?.name || item?.chatTitle || "",
    who: item?.who ? t("از گفتگو با «{who}»", { who: item.who }) : null,
  };
}

// Whether the home page shows the board instead of the hero's blurb. `openSuggestions` (how many
// suggested chats are open) counts: they are listed under «منتظر شما» too.
export const hasBoard = (inbox, chats, openSuggestions = 0) =>
  Boolean(inbox?.count) || openSuggestions > 0 || workingTasks(chats).length > 0 || recentDone(chats).length > 0;
