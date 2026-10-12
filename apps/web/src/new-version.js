// After an update the server serves a new web bundle, but an open tab keeps running the old one
// until it is reloaded. The page asks the server's shell (index.html,
// served no-cache) now and then which bundle it would load; a different one means a new version. A
// tab left hidden for a minute reloads by itself (the composer's draft and quotes survive a reload —
// draft.js, quotes.js); a visible tab shows a notice and reloads when the owner taps it or leaves
// the tab. What lives only in this page holds the reload off: a voice recording, pictures attached
// but not sent, a message on its way or not delivered (outbox.js), an answer on its way, text the
// owner typed in any other box.

const BUNDLE = /<script\b[^>]*\bsrc=["']([^"']*\/assets\/index-[\w-]+\.js)["']/i;

// The main bundle a shell loads, or null for anything else (the dev shell, an error page).
export function bundleOf(html) {
  if (typeof html !== "string") return null;
  for (const tag of html.match(/<script\b[^>]*>/gi) || []) {
    if (!/\btype=["']module["']/i.test(tag)) continue;
    const found = BUNDLE.exec(tag);
    if (found) return found[1];
  }
  return null;
}

export function createVersionWatch({ current, fetchShell, isHidden, reload, onAvailable, now = Date.now, minGapMs = 15_000 }) {
  let lastFetch = -Infinity;
  let inFlight = false;
  let known = false;
  let told = false;
  let reloaded = false;
  let holds = 0;

  let latest = null;
  const reloadOnce = () => {
    if (reloaded) return;
    reloaded = true;
    reload(latest);
  };
  const settle = () => {
    if (!known) return;
    if (isHidden() && holds === 0) return reloadOnce();
    if (!told && !reloaded) {
      told = true;
      onAvailable(latest);
    }
  };

  const check = async () => {
    if (!current || inFlight || known || now() - lastFetch < minGapMs) return;
    inFlight = true;
    lastFetch = now();
    try {
      const found = bundleOf(await fetchShell());
      if (found && found !== current) {
        latest = found;
        known = true;
        settle();
      }
    } catch {
      /* offline, a gateway error, a restart in progress: ask again later */
    } finally {
      inFlight = false;
    }
  };

  const hold = () => {
    holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds -= 1;
      if (holds === 0 && known && isHidden()) reloadOnce();
    };
  };

  const visibilityChanged = () => {
    if (isHidden()) {
      if (known && holds === 0) reloadOnce();
    } else {
      check();
    }
  };

  return { check, hold, visibilityChanged, available: () => known };
}

// What the page holds that a reload would lose and nothing saves: text the owner typed into a box
// that is still on the page and still not empty. Only typed boxes count (`typed` is filled by an
// input listener): a box filled by the app (Settings fields, the login form, the helper textarea
// the auto-growing chat box leaves in the body) is not work. A box marked `data-reload-safe` (the
// main composer, whose draft is kept — draft.js; the sidebar search) never counts.
export function pageBusy(typed, fields) {
  if (!typed || !fields) return false;
  for (const field of fields) {
    if (!typed.has(field) || field.isConnected === false) continue;
    if (field.hasAttribute?.("data-reload-safe")) continue;
    if (String(field.value ?? "").trim()) return true;
  }
  return false;
}

const TEXT_FIELDS = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="number"], input[type="tel"], input[type="password"]';

// A tab counts as away only after it has stayed hidden this long: a glance at another tab, or the
// phone's file picker and camera (they hide the page), never reload under the owner.
export const AWAY_MS = 60_000;
// At most one automatic reload in this window per tab: a server that answers with two versions in
// turn must not reload the page over and over.
export const RELOAD_GAP_MS = 10 * 60_000;

export function awayLongEnough({ hidden, hiddenSince, now }) {
  return Boolean(hidden) && hiddenSince != null && now - hiddenSince >= AWAY_MS;
}

export function mayAutoReload(lastReloadAt, now) {
  const last = Number(lastReloadAt);
  return !Number.isFinite(last) || last <= 0 || now - last >= RELOAD_GAP_MS || now < last;
}

// The page's own watch: started once from main.jsx; components hold the reload off through
// holdReload() and the app shows its notice through onNewVersion().
let watch = null;
const listeners = new Set();
let pendingNotice = false;

export function onNewVersion(listener) {
  listeners.add(listener);
  if (pendingNotice) listener();
  return () => listeners.delete(listener);
}

export function holdReload() {
  return watch ? watch.hold() : () => {};
}

export function reloadNow() {
  window.location.reload();
}

const LAST_RELOAD = "griffin:auto-reload-at";
function readSession(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeSession(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* private mode: no cap, the reload still happens */
  }
}
function notify() {
  if (pendingNotice) return;
  pendingNotice = true;
  for (const listener of listeners) listener();
}

export function startVersionWatch() {
  if (watch || typeof document === "undefined") return;
  const script = document.querySelector('script[type="module"][src*="/assets/index-"]');
  const current = script?.getAttribute("src") || null;
  if (!current) return; // the dev server: nothing to compare
  const shell = current.slice(0, current.indexOf("assets/index-")); // "/" or the base path
  let hiddenSince = document.visibilityState === "hidden" ? Date.now() : null;
  let awayTimer = null;
  // Boxes the owner typed in (pageBusy): kept weakly, a removed box simply drops out.
  const typedFields = new WeakSet();
  const typedList = new Set();
  document.addEventListener(
    "input",
    (event) => {
      const field = event.target;
      // Text only: a touched select, checkbox or date always has a value and is not unsaved work.
      if (field?.matches?.(TEXT_FIELDS) && !typedFields.has(field)) {
        typedFields.add(field);
        typedList.add(new WeakRef(field));
      }
    },
    true,
  );
  const typedNow = () => {
    const fields = [];
    for (const ref of typedList) {
      const field = ref.deref();
      if (!field || !field.isConnected) typedList.delete(ref);
      else fields.push(field);
    }
    return fields;
  };
  watch = createVersionWatch({
    current,
    fetchShell: async () => {
      const res = await fetch(shell, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) throw new Error(`http ${res.status}`);
      return res.text();
    },
    // "Hidden" for the watch = away long enough with nothing on the page a reload would lose.
    isHidden: () => awayLongEnough({ hidden: document.visibilityState === "hidden", hiddenSince, now: Date.now() }) && !pageBusy(typedFields, typedNow()),
    reload: () => {
      if (!mayAutoReload(readSession(LAST_RELOAD), Date.now())) return notify();
      writeSession(LAST_RELOAD, String(Date.now()));
      reloadNow();
    },
    onAvailable: notify,
  });
  // While hidden, look again every minute: the page may be busy the first time, or the new
  // version may be found only later.
  const whileAway = () => {
    clearInterval(awayTimer);
    awayTimer = setInterval(() => watch.visibilityChanged(), AWAY_MS + 1000);
  };
  if (hiddenSince != null) whileAway();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenSince = Date.now();
      whileAway();
    } else {
      clearInterval(awayTimer);
      hiddenSince = null;
      watch.visibilityChanged();
    }
  });
  window.addEventListener("focus", () => watch.check());
  window.addEventListener("online", () => watch.check());
  setInterval(() => watch.check(), 3 * 60_000);
  watch.check();
}
