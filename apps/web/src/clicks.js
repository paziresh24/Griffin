import { t } from "./i18n.js";
// «نقشهٔ کلیک‌ها» (server: ui-clicks.mjs): count what is clicked on this page — never what is written.
// A click is named by the control's own label (aria-label, title, a short button text), the page and
// the part of the screen; a click on nothing that reacts is «dead», on a disabled control «disabled»,
// three on one control within 1.5 s «rage»; where it landed is a cell of a 10×10 grid of the window.
// Counts are posted every 30 s and when the tab is hidden.

const INTERACTIVE =
  'button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], [role="link"], input, select, textarea, label, summary, [contenteditable="true"]';
// Text the person or an agent wrote: a click there is reading or selecting, never dead, never named.
const CONTENT = '[data-message], .aui-message, .streamdown, .prose, [data-streamdown], [role="log"], pre, code';
const MAX_TEXT = 24;

/** The page as a kind, without ids: "chat", "home", "settings:<section>", "telegram" … */
export function routeOf(hash = "", settingsSection = "") {
  const h = String(hash || "").replace(/^#\/?/, "");
  if (!h) return "home";
  const [first, second] = h.split("/");
  if (first === "c") return "chat";
  if (first === "settings") return settingsSection ? `settings:${String(settingsSection).slice(0, 20)}` : "settings";
  if (first === "m") return `m:${String(second || "").slice(0, 30)}`;
  return String(first).replace(/[^a-z-]/g, "").slice(0, 20) || "page";
}

/**
 * A control's name, safe to keep: its label up to the first «:», «»», «(» or «—» (labels often go on
 * with a chat title, a name or a number), digits as #. `text` only when short (a button's own word).
 */
export function cleanLabel({ track = "", aria = "", title = "", text = "", placeholder = "", href = "", tag = "", type = "" } = {}) {
  if (track) return String(track).slice(0, 60);
  const cut = (v) =>
    String(v || "")
      .split(/[:«(\n—]|\s-\s/)[0]
      .replace(/[0-9۰-۹٠-٩]+/g, "#")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  if (/^#\/c\//.test(href)) return "گفتگو در فهرست";
  const named = cut(aria) || cut(title);
  if (named) return named;
  if (tag === "input" || tag === "textarea" || tag === "select") return `${tag}${type ? `:${type}` : ""}${placeholder ? ` ${cut(placeholder)}` : ""}`;
  const word = String(text || "").replace(/\s+/g, " ").trim();
  if (word && word.length <= MAX_TEXT) return cut(word);
  if (href) return `لینک ${routeOf(href.startsWith("#") ? href : "")}`;
  return "";
}

/** The part of the screen, from the element's place (closest(sel) → boolean). */
export function areaOf(closest) {
  if (closest('[role="dialog"], [role="alertdialog"]')) return "dialog";
  if (closest("[data-radix-popper-content-wrapper], [role=menu], [role=listbox]")) return "menu";
  if (closest(".g-composer, .composer-box, .g-composer-bar")) return "composer";
  if (closest("aside, .g-sidebar")) return "sidebar";
  if (closest("header")) return "header";
  if (closest(CONTENT)) return "thread";
  return "page";
}

// The nearest own class (g-*/kc-*) or the tag, for a click on something with no name.
function shapeOf(el) {
  for (let node = el, depth = 0; node && depth < 4; node = node.parentElement, depth += 1) {
    const own = [...(node.classList || [])].find((c) => /^(g|kc)-[a-z-]+$/.test(c));
    if (own) return own;
  }
  return String(el?.tagName || "").toLowerCase();
}

/** One click as a counted row, or null (a click in written text, or on nothing). */
export function describeClick(target, { hash = "", section = "" } = {}) {
  const el = target?.nodeType === 1 ? target : target?.parentElement;
  if (!el?.closest) return null;
  const route = routeOf(hash, section);
  const closest = (sel) => Boolean(el.closest(sel));
  const area = areaOf(closest);
  const control = el.closest(INTERACTIVE);
  if (!control) {
    if (closest(CONTENT)) return null;
    // An icon or a picture that does nothing is the clearest dead click there is.
    const media = el.closest("svg, img");
    const alt = media?.getAttribute?.("alt") || media?.getAttribute?.("aria-label") || "";
    return { route, area, kind: "dead", key: `${media ? (media.tagName.toLowerCase() === "img" ? t("تصویر") : t("آیکن")) : shapeOf(el)}${alt ? ` ${cleanLabel({ aria: alt })}` : ""}`.slice(0, 60) };
  }
  const tag = control.tagName.toLowerCase();
  const key =
    cleanLabel({
      track: control.getAttribute("data-track") || "",
      aria: control.getAttribute("aria-label") || "",
      title: control.getAttribute("title") || "",
      text: tag === "input" || tag === "textarea" ? "" : control.textContent || "",
      placeholder: control.getAttribute("placeholder") || "",
      href: control.getAttribute("href") || "",
      tag,
      type: control.getAttribute("type") || "",
    }) || shapeOf(control);
  const disabled = control.disabled === true || control.getAttribute("aria-disabled") === "true";
  return { route, area, kind: disabled ? "disabled" : "click", key };
}

/** Where on the window, as "x,y" of a 10×10 grid ("x,y,m" on a narrow screen). */
export function cellOf(x, y, width, height) {
  const clamp = (v) => Math.max(0, Math.min(9, Math.floor(v * 10)));
  if (!(width > 0) || !(height > 0)) return null;
  return `${clamp(x / width)},${clamp(y / height)}${width < 768 ? ",m" : ""}`;
}

const SEP = "\u0001";
/** A tally of rows; rage = three clicks on one control within RAGE_MS. */
export function createTally({ now = () => Date.now(), rageMs = 1500 } = {}) {
  let counts = new Map();
  let recent = [];
  const add = (row) => {
    const k = [row.route, row.area, row.kind, row.key].join(SEP);
    counts.set(k, (counts.get(k) || 0) + 1);
  };
  return {
    add(row) {
      add(row);
      if (row.kind !== "click" && row.kind !== "dead") return;
      const t = now();
      recent = recent.filter((r) => t - r.at < rageMs);
      recent.push({ at: t, key: row.key, route: row.route });
      const same = recent.filter((r) => r.key === row.key && r.route === row.route);
      if (same.length === 3) add({ ...row, kind: "rage" });
    },
    take() {
      const rows = [...counts].map(([k, n]) => {
        const [route, area, kind, key] = k.split(SEP);
        return { route, area, kind, key, n };
      });
      counts = new Map();
      return rows;
    },
    size: () => counts.size,
  };
}

/** Starts counting on this page; returns a stop function. */
export function startClicks({ win = window, doc = document, send, everyMs = 30_000, section = () => "" } = {}) {
  const tally = createTally();
  let stopped = false;
  const post =
    send ||
    ((rows) => {
      const body = JSON.stringify({ rows });
      // A hidden tab may never run a fetch to the end: the beacon is kept by the browser.
      if (doc.visibilityState === "hidden" && win.navigator?.sendBeacon?.("/api/clicks", new Blob([body], { type: "application/json" }))) return;
      fetch("/api/clicks", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body, keepalive: true })
        .then((res) => res.json())
        .then((r) => r?.off && stop()) // CLICK_MAP=off on this install
        .catch(() => {});
    });
  const flush = () => {
    if (!tally.size()) return;
    post(tally.take());
  };
  tally.add({ route: routeOf(win.location.hash, section()), area: "page", kind: "load", key: "page" });
  const onClick = (event) => {
    if (event.button !== 0 || !event.isTrusted) return;
    const ctx = { hash: win.location.hash, section: section() };
    const row = describeClick(event.target, ctx);
    if (row && row.kind !== "disabled") tally.add(row);
    const cell = cellOf(event.clientX, event.clientY, win.innerWidth, win.innerHeight);
    if (cell) tally.add({ route: routeOf(ctx.hash, ctx.section), area: "screen", kind: "pos", key: cell });
  };
  // A disabled button gets no click event at all: its press is seen on the way up.
  const onPointerUp = (event) => {
    if (event.button !== 0 || !event.isTrusted) return;
    const row = describeClick(event.target, { hash: win.location.hash, section: section() });
    if (row?.kind === "disabled") tally.add(row);
  };
  const onHide = () => doc.visibilityState === "hidden" && flush();
  doc.addEventListener("click", onClick, { capture: true, passive: true });
  doc.addEventListener("pointerup", onPointerUp, { capture: true, passive: true });
  doc.addEventListener("visibilitychange", onHide);
  const timer = win.setInterval(flush, everyMs);
  function stop() {
    if (stopped) return;
    stopped = true;
    doc.removeEventListener("click", onClick, { capture: true });
    doc.removeEventListener("pointerup", onPointerUp, { capture: true });
    doc.removeEventListener("visibilitychange", onHide);
    win.clearInterval(timer);
  }
  return () => {
    flush();
    stop();
  };
}
