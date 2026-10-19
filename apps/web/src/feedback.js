// «ارسال بازخورد» / «پشتیبانی» (owner 2026-10-18): the details a report carries besides what the
// person wrote — this page's last errors, version, browser, page and chat (Feedback.jsx shows them
// before sending; POST /api/feedback adds the server's).

export const FEEDBACK_EVENT = "griffin:feedback";
export const ABOUT_EVENT = "griffin:about";
const MAX_ERRORS = 15;
const errors = [];

/** Keep one error line of this page (newest last, the same line twice in a row counted once). */
export function recordError(value) {
  const line = String(value?.stack || value?.message || value || "").split("\n").slice(0, 3).join(" | ").slice(0, 400);
  if (!line || errors.at(-1)?.line === line) return;
  errors.push({ at: new Date().toISOString(), line });
  if (errors.length > MAX_ERRORS) errors.shift();
}
export const recentErrors = () => errors.map((e) => `${e.at} ${e.line}`);

/** Catch this page's uncaught errors and console.error lines once, at start. */
export function watchErrors(win = globalThis.window) {
  if (!win || win.__griffinErrorWatch) return;
  win.__griffinErrorWatch = true;
  win.addEventListener?.("error", (e) => recordError(e.error || e.message));
  win.addEventListener?.("unhandledrejection", (e) => recordError(e.reason));
  const original = console.error.bind(console);
  console.error = (...args) => {
    recordError(args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : "")).join(" "));
    original(...args);
  };
}

/** The chat open now, from the address (#/c/<id>). */
export const chatIdOf = (hash) => String(hash || "").match(/^#\/c\/([^/?#]+)/)?.[1] || "";

/** The body POST /api/feedback takes. */
export function feedbackPayload({ text, kind = "feedback", version = "", win = globalThis.window, nav = globalThis.navigator }) {
  const hash = win?.location?.hash || "";
  return {
    text: String(text || "").trim(),
    kind,
    version,
    browser: nav?.userAgent || "",
    viewport: win ? `${win.innerWidth}x${win.innerHeight}` : "",
    page: hash || "#/",
    chatId: chatIdOf(hash),
    errors: recentErrors(),
  };
}

export const openFeedback = (kind = "feedback") => window.dispatchEvent(new CustomEvent(FEEDBACK_EVENT, { detail: { kind } }));
export const openAbout = () => window.dispatchEvent(new CustomEvent(ABOUT_EVENT));
