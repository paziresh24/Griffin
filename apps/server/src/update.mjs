// Updates the owner takes himself (owner 2026-10-18: «پایین سایدبار آپدیت جدید بیاد و هرکس خواست
// بازش کنه و چنج لاگ‌های فارسی‌ش رو بخونه، بعد اگر خواست دکمه آپدیت رو بزنه»).
//
// The host side does the network and the install (deploy/capsule/autoupdate: griffin-pull on each
// install, griffin-autoupdate on .46). It shares one folder with the app, <data>/update:
//   available.json  written by the host: the newest published release {commit, at, changes}
//   request.json    written here when the owner presses «ری‌استارت و اعمال»: {commit, at}
//   policy.json     written by the host: {auto, quietSec, gapLeftSec, autoFailed} — when it switches by itself
//   status.json     written by the host: {state, commit, at, size}; state is downloading|ready|
//                   download-failed (fetched on its own as soon as it is published) or installing|failed
// The host switches only to a release that was requested; the download does not wait for it.
import fs from "node:fs";
import path from "node:path";

const SHA = /^[0-9a-f]{12}$/;
const mtime = (file) => {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
};
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Changes newer than `current` (newest first). An install runs a commit of main (a merge), which an
 *  entry names as `main`; an MR's own commit never matches it (every offer said «۱۰ تغییر», the old
 *  fallback, 2026-10-24). Current older than the whole list: all of it. */
export function changesSince(changes, current, max = 60) {
  if (!Array.isArray(changes)) return [];
  const clean = changes.filter((c) => c && typeof c.text === "string" && /^[0-9a-f]{7,40}$/.test(String(c.commit || "")));
  const same = (sha) => Boolean(sha) && (String(sha).startsWith(current) || current.startsWith(String(sha)));
  const at = current ? clean.findIndex((c) => same(c.main) || same(c.commit)) : -1;
  return (at < 0 ? clean : clean.slice(0, at)).slice(0, max);
}

const PERSIAN = /[\u0600-\u06FF]/;

// The changelog is always shown in Persian (owner 2026-10-18: «چنج لاگ همیشه فارسی باشه، حتی اگر
// فارسی نوشته نشده باشه… با ai خودشون»): a line written in English (a commit title) is put into
// plain Persian by this install's own model, once, and kept in fa.json next to the offer, by commit.
export const TRANSLATE_PROMPT = `These are changelog lines of an internal assistant app (Griffin), one per item, mostly git
commit titles. Rewrite each one as ONE short line of plain everyday Persian for the people who use the
app: what changed for them, no file names, function names, ticket ids or English jargon (keep product
names like Claude, Telegram, GitLab as they are). Reply with ONLY a JSON array of strings, same order,
same count.`;

export function parseTranslation(raw, count) {
  const text = String(raw || "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const list = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(list) || list.length !== count) return null;
    return list.map((x) => String(x || "").trim().slice(0, 300));
  } catch {
    return null;
  }
}

export function createUpdates({ dir, current = null, now = () => new Date(), translate = null, log = console }) {
  const file = (name) => path.join(dir, name);
  let fa = null; // commit -> Persian line
  let translating = null;
  let failedAt = 0;
  const cache = () => (fa ??= read(file("fa.json")) || {});

  /** The same list with every line in Persian; English ones still waiting are translated in the background. */
  function persian(changes) {
    const list = Array.isArray(changes) ? changes : [];
    const known = cache();
    const todo = list.filter((c) => !PERSIAN.test(c.text) && !known[c.commit]);
    // A failed try waits half an hour: every page load asked again (an out-of-credit account was
    // called every minute and a half on a colleague's install, 2026-10-21).
    if (todo.length && translate && !translating && Date.now() - failedAt > 30 * 60_000) {
      const batch = todo.slice(0, 40);
      translating = Promise.resolve()
        .then(() => translate(`${TRANSLATE_PROMPT}\n\n${JSON.stringify(batch.map((c) => c.text))}`))
        .then((raw) => {
          const out = parseTranslation(raw, batch.length);
          if (!out) throw new Error("the model did not answer with the list");
          const next = { ...cache() };
          batch.forEach((c, i) => out[i] && PERSIAN.test(out[i]) && (next[c.commit] = out[i]));
          fa = next;
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file("fa.json"), JSON.stringify(next));
        })
        .catch((error) => {
          failedAt = Date.now();
          log.error?.(`[update] changelog translation: ${error?.message || error}`);
        })
        .finally(() => (translating = null));
    }
    return list.map((c) => (PERSIAN.test(c.text) ? c : known[c.commit] ? { ...c, text: known[c.commit] } : c));
  }

  /** Waits for a translation in flight (tests). */
  const settled = () => translating || Promise.resolve();

  function state() {
    const available = read(file("available.json"));
    const release = available && SHA.test(String(available.commit || "")) ? available : null;
    const newer = release && release.commit !== current ? release : null;
    const request = read(file("request.json"));
    const status = read(file("status.json"));
    const policy = read(file("policy.json"));
    return {
      current,
      available: newer ? { commit: newer.commit, at: newer.at || null, changes: persian(changesSince(newer.changes, current)) } : null,
      translating: Boolean(translating),
      // A press is for «the update», not one commit: a release published after it is taken by the same
      // press (a colleague 2026-10-24 waited two idle hours — a newer release had come, and his press
      // no longer matched it — until he pressed again).
      requested: newer && SHA.test(String(request?.commit || "")) ? newer.commit : null,
      // A failure only counts for the release still offered (a newer one starts fresh).
      status: newer && status?.commit === newer.commit ? { state: status.state, at: status.at || null, size: Number(status.size) || 0 } : null,
      // When the host last looked for a release (it rewrites available.json every minute).
      checkedAt: mtime(file("available.json")),
      // How this install takes a release by itself (written by griffin-pull); app.mjs adds `live` (what is
      // going on in it right now), so the sidebar can say what it is waiting for.
      policy: policy && typeof policy === "object"
        ? { auto: policy.auto !== false, quietSec: Number(policy.quietSec) || 0, gapLeftSec: Number(policy.gapLeftSec) || 0, autoFailed: policy.autoFailed === true }
        : null,
    };
  }

  function request(commit) {
    const { available } = state();
    if (!available) return { error: "آپدیت تازه‌ای نیست" };
    if (commit && commit !== available.commit) return { error: "این نسخه دیگر تازه‌ترین نیست؛ صفحه را دوباره باز کنید" };
    fs.mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({ commit: available.commit, at: now().toISOString() });
    const tmp = file(`request.json.${process.pid}`);
    try {
      fs.writeFileSync(tmp, body);
      try {
        fs.renameSync(tmp, file("request.json"));
      } catch (error) {
        // update/ is a sticky world-writable folder shared with the host's puller: renaming over a
        // request.json the host (another user) wrote is refused. The host makes it world-writable,
        // so writing into the same file is what works.
        if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
        fs.writeFileSync(file("request.json"), body);
      }
    } catch (error) {
      return { error: `درخواست آپدیت نوشته نشد (${error?.code || error?.message}). فایل request.json در پوشهٔ update مال کاربر دیگری است و نوشتنی نیست.` };
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* the tmp file is ours, or already gone */ }
    }
    return { ok: true, commit: available.commit };
  }

  return { state, request, persian, settled };
}
