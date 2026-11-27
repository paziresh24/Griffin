// One UI, personalised per user (owner, 2026-10-17): the look is appearance only (palette, font,
// radii, flat or framed — <html data-look>, styles.css), and every structural or behavioural choice is
// a flag. Both live on the server (GET/PUT/DELETE /api/ui-prefs) so every device shows the same.
// Precedence: the user's own choice > the snapshot taken on first load after the update > the
// install's preset (GRIFFIN_PRODUCT). «گریفین» and «کارسرا» are two presets of the same flags.
import { useSyncExternalStore } from "react";
import { api } from "./api.js";
import { LOOK_IDS, PREFS_REV, migrationSnapshot, presetOf, resolvePrefs } from "./ui-flags.js";

export * from "./ui-flags.js";

// --- The page's store: <html data-look>, a cache for the next first paint, and the server copy. ---
const CACHE = "griffin.ui"; // the resolved prefs, so the next load paints right before the server answers
const LEGACY_SKIN = "griffin.skin";
const LEGACY_NAV = "griffin.sidebar.nav.v2";

const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: this page only
  }
};
const parse = (raw) => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

let installLook = "griffin";
let state = null;
const listeners = new Set();

function legacySnapshot() {
  return migrationSnapshot({ savedSkin: read(LEGACY_SKIN), installLook, nav: parse(read(LEGACY_NAV)) });
}

function set(next) {
  state = next;
  if (!next) return;
  if (typeof document !== "undefined") document.documentElement.dataset.look = next.look;
  write(CACHE, JSON.stringify({ ...next, rev: PREFS_REV })); // what was resolved is current: the next load must not migrate it
  for (const listener of listeners) listener();
}

const snapshot = () => {
  if (!state) {
    const cached = parse(read(CACHE));
    state = cached ? resolvePrefs(cached, installLook) : legacySnapshot();
  }
  return state;
};

/** The install's preset is known (brand info): paint from the cache, or what this browser showed before the update. */
export function setInstallLook(install) {
  if (LOOK_IDS.includes(install)) installLook = install;
  state = null;
  set(snapshot());
}

/**
 * Signed in: take the server's copy — or, when the server has none yet (the first load after the
 * update), save this browser's snapshot there once.
 */
let markReady;
/** Settled once the server's copy is in (or could not be read): a redirect that hangs on a flag waits for it. */
export const uiPrefsReady = new Promise((resolve) => {
  markReady = resolve;
});

export async function loadUiPrefs({ request = api } = {}) {
  try {
    await loadFromServer(request);
  } finally {
    markReady();
  }
}

async function loadFromServer(request) {
  try {
    const { stored } = await request("/api/ui-prefs");
    if (stored) return set(resolvePrefs(stored, installLook));
    const snap = legacySnapshot();
    set(snap);
    await request("/api/ui-prefs", { method: "PUT", body: { ...snap, rev: PREFS_REV, migrated: true } });
  } catch {
    // offline: the cached prefs stay
  }
}

/** The user's own choice: a look and/or flags, saved for every device. */
export function setUiPrefs(patch) {
  const current = snapshot();
  // This revision: without it the flags of CHANGED_AT read as a copy from before they changed, and a
  // switch of theirs went straight back to the preset (2026-11-01: «یه سری از دکمه‌هاش کار نمیکنن»).
  const next = resolvePrefs({ look: patch.look || current.look, flags: { ...current.flags, ...(patch.flags || {}) }, rev: PREFS_REV }, installLook);
  set(next);
  return api("/api/ui-prefs", { method: "PUT", body: { look: next.look, flags: next.flags, rev: PREFS_REV } }).catch(() => {});
}

/** «برگرداندن به پیش‌فرض نصب»: nothing of the user's stays; the install's preset applies (and follows it). */
export function resetUiPrefs() {
  set(presetOf(installLook));
  return api("/api/ui-prefs", { method: "DELETE" }).catch(() => {});
}

export const installPreset = () => installLook;

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useUiPrefs = () => useSyncExternalStore(subscribe, snapshot, snapshot);
export const useLook = () => useUiPrefs().look;
export const useFlag = (key) => useUiPrefs().flags[key];
/** A flag outside React (after uiPrefsReady). */
export const uiFlag = (key) => snapshot().flags[key];
