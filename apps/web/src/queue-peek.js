// A message sent while a run was busy waits in the server's queue (intent "queue"). The owner's own
// waiting messages show above the composer like a scheduled «بعداً» note (QueuePeek.jsx), not as a
// bubble in the thread; once one reaches the agent (queueState "started") it
// shows at its place, and one a Stop cleared (dropped) shows muted «اجرا نشد»; one the owner took
// out from the peek (removed: deleted, or back in the box to edit) leaves the thread.
// Works on assistant-ui's converted messages (runtime.jsx convertMessage): id `u<eventId>`,
// metadata.custom { intent, queueState, sendState, from, images, legacy }.
import { t } from "./i18n.js";
import { isSystemText, stripOwnerFrame } from "./telegram.js";

export const QUEUE_WAITING_LABEL = t("در صف");
export const QUEUE_DROPPED_LABEL = t("اجرا نشد");
export const STEER_LABEL = t("وسط کار به ایجنت رسید");

export const messageText = (message) =>
  (Array.isArray(message?.content) ? message.content : []).map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n");

// A colleague's words put into the owner's chat (related.mjs chat_send, PEER_HEAD): never the owner's draft.
const PEER_TEXT = /^\s*📥 /;

// Waiting in the queue and the owner's own words (a colleague's Telegram line, a third-party
// «📥 …» or a server line «[…]» stays in the thread: it is not the owner's to edit or delete). Landed
// on the server (`u<eventId>`), or still on its way (outbox.js `c<clientId>`, sending or sent): one
// that failed stays in the thread for «ارسال دوباره».
export function inPeek(message) {
  const custom = message?.metadata?.custom;
  if (message?.role !== "user" || custom?.intent !== "queue" || custom.queueState) return false;
  const id = String(message.id);
  const onItsWay = id.startsWith("c") && (custom.sendState === "sending" || custom.sendState === "sent");
  if (!onItsWay && (!/^u\d+$/.test(id) || custom.sendState)) return false;
  if (custom.from && custom.from.kind !== "owner_web") return false;
  // From before user.queue existed (timeline legacyBehind): the server does not track it, so it
  // cannot be taken out — it stays in the thread as it was.
  if (custom.legacy) return false;
  const text = messageText(message);
  return !isSystemText(text) && !PEER_TEXT.test(text);
}

/** The peek's items, oldest (next to run) first: { key, eventId, text, images, files, sendState }
 *  (files: the names and sizes of the files it carries; the page keeps no bytes of them). One on
 *  its way has no eventId yet (nothing to take out) and its send state; the key is its client id,
 *  which the landed copy keeps, so the row stays put when it lands. */
export function waitingQueued(messages) {
  return (messages || []).filter(inPeek).map((m) => {
    const custom = m.metadata.custom;
    const landed = m.id.startsWith("u");
    return {
      key: custom.clientId || m.id,
      eventId: landed ? Number(m.id.slice(1)) : null,
      text: stripOwnerFrame(messageText(m)),
      images: custom.images || 0,
      files: Array.isArray(custom.files) ? custom.files : [],
      sendState: landed ? null : custom.sendState,
    };
  });
}

/** The confirm before «ویرایش» takes a message back into the box, or null when nothing is lost:
 *  its pictures and files stay with the server copy, which the take-back removes. */
export function editLossWarning(item) {
  const lost = [];
  if (item?.images) lost.push(t("تصویرهای"));
  if (item?.files?.length) lost.push(`فایل‌های پیوستِ (${item.files.map((f) => `«${f.name}»`).join(t("، "))})`);
  if (!lost.length) return null;
  return `${lost.join(t(" و "))} این پیام به جعبهٔ پیام برنمی‌گردند و باید دوباره پیوست شوند. ادامه؟`;
}

// The failed run's bar has «دوباره» and «حل شد» (Thread.jsx KeptActions), no «حذف» of its own.
export const QUEUE_MERGED_TOAST = t("با پیام‌های دیگر یکی شده و پشت پیام ناموفق منتظر است؛ «حل شد» زیر آن پیام همه را کنار می‌گذارد");

// The toast when «حذف»/«ویرایش» in the peek fails. 409 merged: a silent failure joined it to other
// queued messages in one kept item (runner.mjs unqueue): only «حل شد» under the failed run drops it.
export function takeOutError(error) {
  if (error?.status === 409 && error.message === "merged") return QUEUE_MERGED_TOAST;
  if (error?.status === 404 || error?.status === 409) return t("دیگر در صف نیست؛ اجرا شد یا کنار رفت");
  return error?.message || t("انجام نشد");
}

export const queueRemoved = (custom) => custom?.intent === "queue" && custom.queueState === "removed";

/** The quiet line under a user bubble about the queue or a steer, or null. */
export function queueLabel(custom) {
  if (custom?.intent === "steer") return STEER_LABEL;
  if (custom?.intent !== "queue" || custom.queueState === "started" || queueRemoved(custom)) return null;
  if (custom.queueState) return QUEUE_DROPPED_LABEL;
  // Still on its way (outbox.js): its send state says enough.
  return custom.sendState ? null : QUEUE_WAITING_LABEL;
}

export const queueDropped = (custom) => queueLabel(custom) === QUEUE_DROPPED_LABEL;
