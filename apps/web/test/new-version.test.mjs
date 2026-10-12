import test from "node:test";
import assert from "node:assert/strict";
import { bundleOf, createVersionWatch } from "../src/new-version.js";

const OLD = "/assets/index-old111.js";
const NEW = "/assets/index-new222.js";
const GAP = 15000;

function shell(src) {
  return `<!doctype html><html><head><meta charset="UTF-8" /><title>Griffin</title>
<script type="module" crossorigin src="${src}"></script>
<link rel="stylesheet" crossorigin href="/assets/index-aaa.css">
</head><body><div id="root"></div></body></html>`;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// A harness: fake clock, fake fetchShell, hidden flag, counting reload/onAvailable.
function rig({ current = OLD, minGapMs } = {}) {
  const s = {
    t: 1_000_000,
    hidden: false,
    fetches: 0,
    reloads: 0,
    availables: 0,
    // next: "new" | "old" | "fail" | "junk" | "dev" | a deferred
    next: "new",
  };
  const fetchShell = () => {
    s.fetches += 1;
    const n = s.next;
    if (n === "new") return Promise.resolve(shell(NEW));
    if (n === "old") return Promise.resolve(shell(OLD));
    if (n === "fail") return Promise.reject(new Error("502"));
    if (n === "throw") throw new Error("offline");
    if (n === "junk") return Promise.resolve("<html><body>Bad Gateway</body></html>");
    if (n === "dev") return Promise.resolve('<script type="module" src="/src/main.jsx"></script>');
    return n.promise;
  };
  const opts = {
    current,
    fetchShell,
    isHidden: () => s.hidden,
    reload: () => { s.reloads += 1; },
    onAvailable: () => { s.availables += 1; },
    now: () => s.t,
  };
  if (minGapMs !== undefined) opts.minGapMs = minGapMs;
  s.w = createVersionWatch(opts);
  s.advance = (ms) => { s.t += ms; };
  return s;
}

async function safeCheck(w) {
  try { await w.check(); } catch { /* a failed fetch must not matter; tolerate either style */ }
}

// ---------- bundleOf ----------

test("new-version: bundleOf reads the module script src from a Vite shell", () => {
  assert.equal(bundleOf(shell("/assets/index-abc123.js")), "/assets/index-abc123.js");
  assert.equal(bundleOf('<script type="module" src="/assets/index-Xy_9-z.js"></script>'), "/assets/index-Xy_9-z.js");
});

test("new-version: bundleOf accepts any attribute order and crossorigin", () => {
  assert.equal(bundleOf('<script src="/assets/index-A1.js" type="module"></script>'), "/assets/index-A1.js");
  assert.equal(bundleOf('<script crossorigin type="module" src="/assets/index-A2.js"></script>'), "/assets/index-A2.js");
  assert.equal(bundleOf('<script src="/assets/index-A3.js" crossorigin type="module"></script>'), "/assets/index-A3.js");
  assert.equal(bundleOf('<script type="module" src="/assets/index-A4.js" crossorigin></script>'), "/assets/index-A4.js");
});

test("new-version: bundleOf keeps a base prefix", () => {
  assert.equal(bundleOf('<script type="module" crossorigin src="/k/assets/index-X.js"></script>'), "/k/assets/index-X.js");
});

test("new-version: bundleOf is null for a dev shell, an error page and junk input", () => {
  assert.equal(bundleOf('<script type="module" src="/@vite/client"></script><script type="module" src="/src/main.jsx"></script>'), null);
  assert.equal(bundleOf('<script type="module" src="/src/main.jsx"></script>'), null);
  assert.equal(bundleOf("<html><body><h1>502 Bad Gateway</h1></body></html>"), null);
  assert.equal(bundleOf(""), null);
  assert.equal(bundleOf(null), null);
  assert.equal(bundleOf(undefined), null);
  assert.equal(bundleOf(42), null);
  assert.equal(bundleOf({}), null);
});

// ---------- inert ----------

test("new-version: with no current bundle the watch is inert", async () => {
  const s = rig({ current: null });
  await s.w.check();
  s.advance(GAP * 10);
  await s.w.check();
  s.hidden = false;
  s.w.visibilityChanged();
  await flush();
  s.hidden = true;
  s.w.visibilityChanged();
  await flush();
  assert.equal(s.fetches, 0);
  assert.equal(s.reloads, 0);
  assert.equal(s.availables, 0);
  assert.equal(s.w.available(), false);
});

// ---------- gap ----------

test("new-version: checks within the gap do not fetch; after the gap they do", async () => {
  const s = rig();
  s.next = "old";
  await s.w.check();
  assert.equal(s.fetches, 1);
  s.advance(GAP - 1);
  await s.w.check();
  assert.equal(s.fetches, 1, "inside the gap");
  s.advance(1);
  await s.w.check();
  assert.equal(s.fetches, 2, "gap elapsed");
  assert.equal(s.w.available(), false, "same bundle is not a new version");
  assert.equal(s.availables, 0);
  assert.equal(s.reloads, 0);
});

test("new-version: minGapMs is honoured and defaults to 15s", async () => {
  const s = rig({ minGapMs: 1000 });
  s.next = "old";
  await s.w.check();
  s.advance(999);
  await s.w.check();
  assert.equal(s.fetches, 1);
  s.advance(1);
  await s.w.check();
  assert.equal(s.fetches, 2);

  const d = rig();
  d.next = "old";
  await d.w.check();
  d.advance(14999);
  await d.w.check();
  assert.equal(d.fetches, 1);
  d.advance(1);
  await d.w.check();
  assert.equal(d.fetches, 2);
});

// ---------- in-flight ----------

test("new-version: a check while a fetch is in flight does not fetch again", async () => {
  const s = rig();
  const def = deferred();
  s.next = def;
  const p1 = s.w.check();
  s.advance(GAP * 2); // even past the gap, the pending fetch blocks
  const p2 = s.w.check();
  assert.equal(s.fetches, 1);
  def.resolve(shell(NEW));
  await p1;
  await p2;
  assert.equal(s.fetches, 1);
  assert.equal(s.w.available(), true);
  assert.equal(s.availables, 1);
});

// ---------- failures never flag ----------

for (const kind of ["fail", "throw", "junk", "dev"]) {
  test(`new-version: a ${kind} shell never counts as a new version`, async () => {
    const s = rig();
    s.hidden = true;
    s.next = kind;
    await safeCheck(s.w);
    await flush();
    assert.equal(s.fetches, 1);
    assert.equal(s.w.available(), false);
    assert.equal(s.reloads, 0);
    assert.equal(s.availables, 0);
    // the watch keeps working afterwards
    s.advance(GAP);
    s.next = "new";
    await s.w.check();
    assert.equal(s.fetches, 2);
    assert.equal(s.w.available(), true);
    assert.equal(s.reloads, 1);
  });
}

test("new-version: a failed in-flight fetch frees the watch for the next check", async () => {
  const s = rig();
  const def = deferred();
  s.next = def;
  const p = s.w.check();
  def.reject(new Error("cdn"));
  try { await p; } catch { /* tolerated */ }
  await flush();
  assert.equal(s.w.available(), false);
  s.advance(GAP);
  s.next = "old";
  await s.w.check();
  assert.equal(s.fetches, 2);
});

// ---------- hidden / visible outcomes ----------

test("new-version: hidden tab with a new version reloads once, without onAvailable", async () => {
  const s = rig();
  s.hidden = true;
  await s.w.check();
  assert.equal(s.w.available(), true);
  assert.equal(s.reloads, 1);
  assert.equal(s.availables, 0);
});

test("new-version: visible tab with a new version gets onAvailable once and no reload", async () => {
  const s = rig();
  await s.w.check();
  assert.equal(s.w.available(), true);
  assert.equal(s.availables, 1);
  assert.equal(s.reloads, 0);
  for (let i = 0; i < 3; i++) {
    s.advance(GAP * 2);
    await s.w.check();
    s.w.visibilityChanged(); // still visible
    await flush();
  }
  assert.equal(s.fetches, 1, "a known new version stops fetching");
  assert.equal(s.availables, 1);
  assert.equal(s.reloads, 0, "never reloads while visible");
});

test("new-version: reload happens at most once across repeated checks and visibility changes", async () => {
  const s = rig();
  s.hidden = true;
  await s.w.check();
  assert.equal(s.reloads, 1);
  for (let i = 0; i < 3; i++) {
    s.advance(GAP * 2);
    s.hidden = false;
    s.w.visibilityChanged();
    await flush();
    s.hidden = true;
    s.w.visibilityChanged();
    await flush();
    await s.w.check();
    const release = s.w.hold();
    release();
  }
  assert.equal(s.reloads, 1);
  assert.equal(s.availables, 0);
  assert.equal(s.fetches, 1);
});

// ---------- hold ----------

test("new-version: an active hold blocks the reload of a hidden tab; the new version is announced instead", async () => {
  const s = rig();
  const release = s.w.hold();
  s.hidden = true;
  await s.w.check();
  assert.equal(s.w.available(), true);
  assert.equal(s.reloads, 0);
  assert.equal(s.availables, 1);
  s.w.visibilityChanged(); // hidden again, still held
  await flush();
  assert.equal(s.reloads, 0);
  release();
  assert.equal(s.reloads, 1, "last release while hidden reloads");
});

test("new-version: releasing the last hold while visible does not reload", async () => {
  const s = rig();
  const release = s.w.hold();
  await s.w.check();
  assert.equal(s.availables, 1);
  release();
  assert.equal(s.reloads, 0);
  s.hidden = true;
  s.w.visibilityChanged();
  assert.equal(s.reloads, 1, "leaving the tab then reloads");
});

test("new-version: releasing a hold with no new version known does not reload", async () => {
  const s = rig();
  s.hidden = true;
  const release = s.w.hold();
  s.next = "old";
  await s.w.check();
  release();
  assert.equal(s.reloads, 0);
});

test("new-version: double release is idempotent; only the last real release reloads", async () => {
  const s = rig();
  const a = s.w.hold();
  const b = s.w.hold();
  s.hidden = true;
  await s.w.check();
  assert.equal(s.reloads, 0);
  a();
  a();
  assert.equal(s.reloads, 0, "b is still held");
  s.w.visibilityChanged();
  assert.equal(s.reloads, 0);
  b();
  assert.equal(s.reloads, 1);
  b();
  a();
  assert.equal(s.reloads, 1);
});

// ---------- visibilityChanged ----------

test("new-version: becoming hidden with a known new version and no hold reloads", async () => {
  const s = rig();
  await s.w.check();
  assert.equal(s.availables, 1);
  assert.equal(s.reloads, 0);
  s.hidden = true;
  s.w.visibilityChanged();
  await flush();
  assert.equal(s.reloads, 1);
});

test("new-version: becoming hidden with no new version known does nothing", async () => {
  const s = rig();
  s.hidden = true;
  s.w.visibilityChanged();
  await flush();
  assert.equal(s.reloads, 0);
  assert.equal(s.availables, 0);
});

test("new-version: becoming visible triggers a check, subject to the gap", async () => {
  const s = rig();
  s.next = "old";
  s.hidden = false;
  s.w.visibilityChanged();
  await flush();
  assert.equal(s.fetches, 1);
  s.advance(GAP - 1);
  s.w.visibilityChanged();
  await flush();
  assert.equal(s.fetches, 1, "inside the gap");
  s.advance(1);
  s.next = "new";
  s.w.visibilityChanged();
  await flush();
  assert.equal(s.fetches, 2);
  assert.equal(s.w.available(), true);
  assert.equal(s.availables, 1);
  assert.equal(s.reloads, 0);
});

// ---------- Round 2/3: page-level helpers ----------
// pageBusy(typed, fields): only fields the owner typed into count (Round 3 replaces the DOM-scan version).

import { pageBusy, AWAY_MS, awayLongEnough, RELOAD_GAP_MS, mayAutoReload } from "../src/new-version.js";

function field(value, { attrs = {}, isConnected = true, tag = "textarea" } = {}) {
  const a = { ...attrs };
  const f = {
    tagName: tag.toUpperCase(),
    value,
    hasAttribute: (n) => Object.prototype.hasOwnProperty.call(a, n),
    getAttribute: (n) => (Object.prototype.hasOwnProperty.call(a, n) ? String(a[n]) : null),
  };
  if (isConnected !== "omit") f.isConnected = isConnected;
  return f;
}

test("new-version: pageBusy with missing arguments is false", () => {
  const f = field("typed text");
  const typed = new Set([f]);
  assert.equal(pageBusy(), false);
  assert.equal(pageBusy(null, [f]), false);
  assert.equal(pageBusy(undefined, [f]), false);
  assert.equal(pageBusy(typed), false);
  assert.equal(pageBusy(typed, null), false);
  assert.equal(pageBusy(typed, undefined), false);
  assert.equal(pageBusy(new Set(), []), false);
  assert.equal(pageBusy(typed, []), false);
});

test("new-version: the auto-resize helper (value x, aria-hidden, never typed in) is not busy", () => {
  const helper = field("x", { attrs: { "aria-hidden": "true", tabindex: "-1" } });
  assert.equal(pageBusy(new Set(), [helper]), false);
  assert.equal(pageBusy(new WeakSet(), [helper]), false);
});

test("new-version: a field the app pre-filled but nobody typed in is not busy", () => {
  const settings = field("https://example.internal", { tag: "input" });
  const login = field("hidden-login-value", { tag: "input" });
  const other = field("");
  const typed = new Set([other]);
  assert.equal(pageBusy(typed, [settings, login, other]), false);
});

test("new-version: a typed-in field with non-blank text makes the page busy", () => {
  const f = field("نیمه‌کاره");
  assert.equal(pageBusy(new Set([f]), [f]), true);
  const w = new WeakSet([f]);
  assert.equal(pageBusy(w, [field("x"), f]), true, "WeakSet and a mixed list");
  assert.equal(pageBusy(new Set([f]), new Set([f])), true, "any iterable of fields");
  function* gen() { yield field("prefilled"); yield f; }
  assert.equal(pageBusy(new Set([f]), gen()), true, "a generator");
  const zero = field("0", { tag: "input" });
  assert.equal(pageBusy(new Set([zero]), [zero]), true, "0 is text");
});

test("new-version: a typed-in field that is blank or only whitespace is not busy", () => {
  const a = field("");
  const b = field("   ");
  const c = field("\n\t ");
  assert.equal(pageBusy(new Set([a, b, c]), [a, b, c]), false);
});

test("new-version: a typed-in field marked data-reload-safe is not busy", () => {
  const safe = field("draft kept elsewhere", { attrs: { "data-reload-safe": "" } });
  assert.equal(pageBusy(new Set([safe]), [safe]), false);
  const other = field("real text");
  assert.equal(pageBusy(new Set([safe, other]), [safe, other]), true, "another typed field still counts");
});

test("new-version: a typed-in field removed from the page is not busy; isConnected undefined counts as connected", () => {
  const gone = field("sent message", { isConnected: false });
  assert.equal(pageBusy(new Set([gone]), [gone]), false);
  const legacy = field("still here", { isConnected: "omit" });
  assert.equal(legacy.isConnected, undefined);
  assert.equal(pageBusy(new Set([legacy]), [legacy]), true);
  const live = field("still here", { isConnected: true });
  assert.equal(pageBusy(new Set([live]), [gone, live]), true);
});

test("new-version: dialogs no longer make the page busy", () => {
  const dialog = field("", { tag: "div", attrs: { role: "dialog" } });
  assert.equal(pageBusy(new Set([dialog]), [dialog]), false);
  assert.equal(pageBusy(new Set(), [dialog]), false);
});

test("new-version: AWAY_MS is one minute and awayLongEnough needs hidden, a start time and the full minute", () => {
  assert.equal(AWAY_MS, 60000);
  const t = 5_000_000;
  assert.equal(awayLongEnough({ hidden: true, hiddenSince: t, now: t + AWAY_MS }), true);
  assert.equal(awayLongEnough({ hidden: true, hiddenSince: t, now: t + AWAY_MS + 1 }), true);
  assert.equal(awayLongEnough({ hidden: true, hiddenSince: t, now: t + AWAY_MS - 1 }), false);
  assert.equal(awayLongEnough({ hidden: false, hiddenSince: t, now: t + AWAY_MS * 10 }), false);
  assert.equal(awayLongEnough({ hidden: true, hiddenSince: null, now: t }), false);
  assert.equal(awayLongEnough({ hidden: true, hiddenSince: undefined, now: t }), false);
  assert.equal(awayLongEnough({ hidden: true, now: t }), false);
  assert.equal(awayLongEnough({ hidden: true, hiddenSince: 0, now: AWAY_MS }), true, "0 is a real start time");
});

test("new-version: RELOAD_GAP_MS is ten minutes and mayAutoReload respects it", () => {
  assert.equal(RELOAD_GAP_MS, 600000);
  const now = 9_000_000_000;
  assert.equal(mayAutoReload(null, now), true);
  assert.equal(mayAutoReload(undefined, now), true);
  assert.equal(mayAutoReload("", now), true);
  assert.equal(mayAutoReload("garbage", now), true);
  assert.equal(mayAutoReload("0", now), true);
  assert.equal(mayAutoReload("-5", now), true);
  assert.equal(mayAutoReload(String(now - RELOAD_GAP_MS), now), true, "exactly the gap");
  assert.equal(mayAutoReload(String(now - RELOAD_GAP_MS - 1), now), true);
  assert.equal(mayAutoReload(String(now - RELOAD_GAP_MS + 1), now), false, "within the gap");
  assert.equal(mayAutoReload(String(now), now), false, "just reloaded");
  assert.equal(mayAutoReload(String(now + 1000), now), true, "clock went backwards");
});
