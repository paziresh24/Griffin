// The sidebar's drag and drop (the rules are in drag.js), on pointer events rather than the browser's
// own drag and drop: that one only half works on Safari and not at all on a phone (owner 2026-10-24:
// «چرا همچنان نمیشه چت و گروه‌ها و دکمه‌های بالا رو جابجا کرد؟»). A mouse drag starts after a few
// pixels; a finger has to rest on the row a moment first, so a swipe still scrolls the list. A short
// press is still a click; a drag never ends in one.
//
// What can be dragged spreads chatDragProps / groupDragProps / useNavDrag's props; a place to drop is
// a zone (useSectionDrop, useNavDrag) found under the pointer by its data-dz attribute. The zone draws
// the drop itself through [data-drop] = "chat" | "before" | "after" (styles.css .g-drop).
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { api } from "../api.js";
import { chatDropPatch, moveItem } from "../drag.js";
import { t } from "../i18n.js";

const zones = new Map(); // data-dz id → { want(payload, event, el), drop(payload, side) }
let nextZone = 1;
let session = null;

const MOUSE_SLOP = 5;
const TOUCH_HOLD_MS = 320;
const TOUCH_SLOP = 8;

function zoneAt(x, y) {
  const el = document.elementFromPoint(x, y)?.closest?.("[data-dz]");
  const zone = el ? zones.get(el.getAttribute("data-dz")) : null;
  return zone ? { el, zone } : null;
}

function mark(el, side) {
  if (session.marked && session.marked !== el) session.marked.removeAttribute("data-drop");
  session.marked = side ? el : null;
  if (el && side) el.setAttribute("data-drop", side);
}

// The list under the pointer scrolls by itself near its top and bottom edges.
function autoScroll(x, y) {
  const box = session.scroller?.getBoundingClientRect();
  if (!box) return;
  const edge = 36;
  if (y < box.top + edge) session.scroller.scrollTop -= 14;
  else if (y > box.bottom - edge) session.scroller.scrollTop += 14;
}

function start() {
  const { el, x, y } = session;
  const box = el.getBoundingClientRect();
  const ghost = el.cloneNode(true);
  ghost.removeAttribute("data-dz");
  ghost.classList.add("g-drag-ghost");
  Object.assign(ghost.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  document.body.append(ghost);
  session.ghost = ghost;
  session.box = box;
  session.started = true;
  session.scroller = el.closest(".overflow-y-auto");
  el.setAttribute("data-dragging", "");
  document.documentElement.classList.add("g-dragging");
  navigator.vibrate?.(8);
  move(x, y);
}

function move(x, y) {
  session.ghost.style.transform = `translate(${x - session.x}px, ${y - session.y}px)`;
  const hit = zoneAt(x, y);
  const side = hit ? hit.zone.want(session.payload, { clientX: x, clientY: y }, hit.el) : null;
  session.target = side ? { ...hit, side } : null;
  mark(hit?.el, side);
  autoScroll(x, y);
}

function finish(drop) {
  const s = session;
  session = null;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onCancel);
  window.removeEventListener("keydown", onKey, true);
  clearTimeout(s.timer);
  if (!s.started) return;
  s.ghost?.remove();
  s.el.removeAttribute("data-dragging");
  s.marked?.removeAttribute("data-drop");
  document.documentElement.classList.remove("g-dragging");
  // The press that ended a drag is not a click on what it started on (a link would open).
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 60);
  if (drop && s.target) s.target.zone.drop(s.payload, s.target.side);
}

function onMove(event) {
  if (!session || event.pointerId !== session.pointerId) return;
  const far = Math.hypot(event.clientX - session.x, event.clientY - session.y);
  if (!session.started) {
    if (session.touch) {
      if (far > TOUCH_SLOP) finish(false); // a swipe: the list scrolls
      return;
    }
    if (far < MOUSE_SLOP) return;
    start();
  }
  event.preventDefault();
  move(event.clientX, event.clientY);
}
const onUp = (event) => session && event.pointerId === session.pointerId && finish(true);
const onCancel = () => session && finish(false);
const onKey = (event) => {
  if (event.key !== "Escape" || !session?.started) return;
  event.preventDefault();
  finish(false);
};
// A started drag on a phone must not scroll the page under the finger.
if (typeof window !== "undefined") {
  window.addEventListener("touchmove", (event) => session?.started && event.preventDefault(), { passive: false });
  // A finger resting on a row opens the phone's long-press menu (and the row's own «گزینه‌ها»): not while dragging.
  window.addEventListener("contextmenu", (event) => {
    if (!session?.started) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

function begin(event, payload) {
  if (session || (event.pointerType === "mouse" && event.button !== 0)) return;
  if (event.target.closest?.("[data-no-drag], input, textarea")) return;
  const touch = event.pointerType !== "mouse";
  session = { payload, el: event.currentTarget, x: event.clientX, y: event.clientY, pointerId: event.pointerId, touch, started: false };
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
  if (touch) session.timer = setTimeout(() => session && !session.started && start(), TOUCH_HOLD_MS);
}

// The browser's own drag (a link dragged out, an image) would take over the pointer.
const noNativeDrag = (event) => event.preventDefault();

/** A chat row: dragging it carries the chat. */
export function chatDragProps(chat) {
  return { onPointerDown: (event) => begin(event, { kind: "chat", chat }), onDragStart: noNativeDrag, "data-drag-handle": "" };
}

/** A section's heading: dragging it moves the section among those of the same `scope`. */
export function groupDragProps(orderId, scope = "groups") {
  if (!orderId) return {};
  return { onPointerDown: (event) => begin(event, { kind: "group", id: orderId, scope }), onDragStart: noNativeDrag, "data-drag-handle": "" };
}

/** A zone's id and its latest handlers (they change every render; the registration does not). */
function useZone(handlers) {
  const id = useRef(null);
  if (!id.current) id.current = String(nextZone++);
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const key = id.current;
    zones.set(key, { want: (...args) => latest.current.want(...args), drop: (...args) => latest.current.drop(...args) });
    return () => zones.delete(key);
  }, []);
  return id.current;
}

const below = (event, el) => {
  const box = el.getBoundingClientRect();
  return event.clientY > box.top + box.height / 2;
};

const moved = (chat, patch) =>
  api(`/api/chats/${chat.id}`, { method: "PATCH", body: patch }).catch(() => toast.error(t("جابه‌جایی گفتگو انجام نشد؛ دوباره امتحان کنید.")));
const saveGroupOrder = (order) => api("/api/groups/order", { method: "PUT", body: { order } }).catch(() => toast.error(t("ترتیب گروه‌ها ذخیره نشد؛ دوباره امتحان کنید.")));

/**
 * A section of the list as a drop zone: a chat dropped on it moves there (`target`: a group, «بدون
 * گروه» or «سنجاق‌شده», drag.js chatDropPatch), and a heading dropped on it goes before or after it.
 * `slots` says which headings it takes: one per scope ({ scope, id, order, onOrder? }) — the owner's
 * groups ("groups", saved on the server; a section of the ungrouped chats is "none" there) and the
 * sections of a grouping ("sections:repo", …, handed to `onOrder`).
 */
export function useSectionDrop({ target = null, slots = [] }) {
  const slotFor = (payload) => slots.find((slot) => slot.id && slot.scope === payload.scope && slot.id !== payload.id);
  const dz = useZone({
    want: (payload, event, el) => {
      if (payload.kind === "chat") return chatDropPatch(payload.chat, target) ? "chat" : null;
      if (payload.kind === "group" && slotFor(payload)) return below(event, el) ? "after" : "before";
      return null;
    },
    drop: (payload, side) => {
      if (side === "chat") return moved(payload.chat, chatDropPatch(payload.chat, target));
      const slot = slotFor(payload);
      if (!slot) return;
      const list = moveItem(slot.order, payload.id, slot.id, side === "after");
      if (list === slot.order) return;
      if (slot.onOrder) slot.onOrder(list);
      else saveGroupOrder(list);
    },
  });
  return { "data-dz": dz };
}

/**
 * One of the top sections (تلگرام، جاب، …): dragged onto another, it takes that place; `onOrder` gets
 * the new order of ids. `horizontal` for a row of icons, where before/after is the reading side.
 */
export function useNavDrag({ id, ids, onOrder, horizontal = false }) {
  const dz = useZone({
    want: (payload, event, el) => {
      if (payload.kind !== "nav" || payload.id === id) return null;
      if (!horizontal) return below(event, el) ? "after" : "before";
      const box = el.getBoundingClientRect();
      const rtl = getComputedStyle(el).direction === "rtl";
      return (event.clientX < box.left + box.width / 2) === rtl ? "after" : "before";
    },
    drop: (payload, side) => {
      const list = moveItem(ids, payload.id, id, side === "after");
      if (list !== ids) onOrder(list);
    },
  });
  return {
    "data-dz": dz,
    "data-drop-axis": horizontal ? "x" : undefined,
    "data-drag-handle": "",
    onPointerDown: (event) => begin(event, { kind: "nav", id }),
    onDragStart: noNativeDrag,
  };
}
