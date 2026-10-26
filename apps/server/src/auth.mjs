import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { clientAddress, DEFAULT_TRUSTED_PROXIES, fromThisMachine, normalizeIp, trusts } from "./listen.mjs";
import { passkeyRoutes } from "./passkeys.mjs";
import { newRecoveryCodes, newTotpSecret, otpauthUri, recoveryHash, totpMatch } from "./totp.mjs";

const COOKIE = "griffin_session";
// A sign-in lasts a day, counted from when it was made (owner 2026-10-25: «عمر لاگین 24 ساعت»):
// a cookie copied off a device is dead by tomorrow. A passkey makes the daily sign-in one touch.
const SESSION_MS = 24 * 3_600_000;
// A Karsara install moved onto Griffin keeps its kv (session_secret, session_version,
// session_revoked), so its devices still hold a valid karsara_session: accepted within the same
// lifetime and re-issued as Griffin's cookie on first use.
const KARSARA_COOKIE = "karsara_session";
const FAILURE_WINDOW_MS = 15 * 60_000;
const GLOBAL_FAILURE_WINDOW_MS = 10 * 60_000;
// Wrong second-step codes after a right token, across every address: past this many in the window,
// code sign-in from the network closes until it ends (only someone holding the token gets here).
const CODE_MISS_CAP = 10;
const PENDING_SETUP_MS = 10 * 60_000;

// Local owner auth with no external identity provider, so it keeps working when a shared
// SSO is down. The owner token lives in the data volume (0600).
// Two-step sign-in (a colleague 2026-10-24: «هر کسی اون سکرت رو داشته باشه می‌تونه لاگین کنه… کل
// پذیرش رو»): once the owner turns it on, the token alone no longer opens Griffin from the network —
// a sign-in also needs the 6-digit code of an authenticator app (or a one-time recovery code), and
// the token as a Bearer header works only from this machine itself (its own scripts, the CLI on the
// server). A request from this machine needs no code: whoever can send one already has the data folder.
// The app secret lives in the secret store (secrets.mjs), never in the database.
export function createAuth({
  dataDir,
  store,
  secrets = null,
  issuer = "Griffin",
  // Only with GRIFFIN_REQUIRE_2FA=on (index.mjs): until two-step sign-in is set up, a signed-in page can
  // only set it up — every other /api call answers 403 { setupRequired }. Off by default: everyone is
  // offered it in the sidebar instead (owner 2026-10-25: «برای همه پیشنهادش رو بده»), and forcing it
  // goes install by install first.
  requireTwoStep = false,
  // onEvent({ kind: "login" | "code-miss" | "code-locked" | "2fa-on" | "2fa-off" | "passkey-added" | "passkey-removed", ip, via, name, userAgent }) — the owner hears of each.
  onEvent = null,
  secureCookie = false,
  publicUrl = "",
  trustedProxies = DEFAULT_TRUSTED_PROXIES,
  globalFailureCap = 50,
  globalOverflowDelayMs = 2_000,
}) {
  const tokenFile = path.join(dataDir, "owner.token");
  if (!fs.existsSync(tokenFile)) {
    fs.writeFileSync(tokenFile, `${crypto.randomBytes(24).toString("base64url")}\n`, { mode: 0o600 });
  }
  const ownerToken = () => fs.readFileSync(tokenFile, "utf8").trim();
  // A new owner token, written whole (temp file + rename) so a crash never leaves it empty.
  function writeOwnerToken() {
    const token = crypto.randomBytes(24).toString("base64url");
    const tmp = `${tokenFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    fs.renameSync(tmp, tokenFile);
    return token;
  }
  const isOwnerToken = (value) => {
    const given = Buffer.from(String(value || ""));
    const expected = Buffer.from(ownerToken());
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };

  let secret = store.getKv("session_secret");
  if (!secret) {
    secret = crypto.randomBytes(32).toString("base64url");
    store.setKv("session_secret", secret);
  }

  let publicOrigin = null;
  let publicHost = null;
  try {
    if (publicUrl) ({ origin: publicOrigin, host: publicHost } = new URL(publicUrl));
  } catch {
    /* invalid PUBLIC_URL: same-origin only */
  }

  // Where the app secret is kept: the secret store when given (always in index.mjs), else the kv.
  const TOTP_SECRET = "auth/totp";
  const box = secrets || {
    get: (name) => store.getKv(`secret:${name}`) || null,
    set: (name, value) => store.setKv(`secret:${name}`, value),
    delete: (name) => store.deleteKv(`secret:${name}`),
  };
  // { enabledAt, lastStep, recovery: [sha256 of unused codes] } while two-step sign-in is on.
  const twoStep = () => {
    const state = store.getKv("auth_2fa");
    return state && typeof state === "object" && box.get(TOTP_SECRET) ? state : null;
  };
  const local = (c) => fromThisMachine(c, { publicHost });
  const setupRequired = () => requireTwoStep && !twoStep();
  const tell = (event) => {
    try {
      onEvent?.(event);
    } catch {
      /* a notice never breaks sign-in */
    }
  };
  let codeMisses = [];
  const codeLocked = (now = Date.now()) => {
    codeMisses = codeMisses.filter((t) => now - t < FAILURE_WINDOW_MS);
    return codeMisses.length >= CODE_MISS_CAP ? Math.ceil((codeMisses[0] + FAILURE_WINDOW_MS - now) / 1000) : 0;
  };
  // "totp" | "recovery" | null. A step already used, or a recovery code already spent, never works again.
  function acceptCode(code) {
    const state = twoStep();
    if (!state) return null;
    const step = totpMatch(box.get(TOTP_SECRET), code);
    if (step !== null && step > Number(state.lastStep || 0)) {
      store.setKv("auth_2fa", { ...state, lastStep: step });
      return "totp";
    }
    const hash = recoveryHash(code);
    const left = Array.isArray(state.recovery) ? state.recovery : [];
    if (String(code || "").replace(/[^a-z0-9]/gi, "").length === 10 && left.includes(hash)) {
      store.setKv("auth_2fa", { ...state, recovery: left.filter((h) => h !== hash) });
      return "recovery";
    }
    return null;
  }
  const pendingSetups = new Map(); // session id -> { secret, expires }
  const sessionIdOf = (value) => String(value || "").split(".")[2] || "";

  const failures = new Map(); // ip -> { count, until }
  let globalFailures = []; // failure times across every address
  const clientIp = (c) => clientAddress(c.env?.incoming, trustedProxies);

  // Expired entries go on every check, so memory holds only the recent window even under a flood.
  function prune(now) {
    for (const [ip, entry] of failures) if (now >= entry.until) failures.delete(ip);
    globalFailures = globalFailures.filter((t) => now - t < GLOBAL_FAILURE_WINDOW_MS);
  }

  const MAX_TRIES = 5;
  // Seconds this address still has to wait, or 0.
  function limited(ip) {
    const now = Date.now();
    prune(now);
    const entry = failures.get(ip);
    return entry && entry.count >= MAX_TRIES && now < entry.until ? Math.ceil((entry.until - now) / 1000) : 0;
  }

  function recordFailure(ip) {
    const now = Date.now();
    const entry = failures.get(ip);
    const count = entry && now < entry.until ? entry.count + 1 : 1;
    failures.set(ip, { count, until: now + FAILURE_WINDOW_MS });
    globalFailures.push(now);
    return Math.max(0, MAX_TRIES - count);
  }

  // Revoked session ids: one kv map { id: revokedAt } (Karsara's format, so migrated logouts still
  // hold). An id older than the longest cookie lifetime can never come back and is pruned on write.
  function revokedMap() {
    const map = store.getKv("session_revoked");
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  }
  function revoke(sessionId) {
    const now = Date.now();
    const next = {};
    for (const [id, at] of Object.entries(revokedMap())) if (now - Number(at) <= SESSION_MS) next[id] = at;
    next[sessionId] = now;
    store.setKv("session_revoked", next);
  }
  // session_revoked:<id> is Karsara's older per-key format.
  const isRevoked = (sessionId) => Boolean(revokedMap()[sessionId] || store.getKv(`session_revoked:${sessionId}`));

  // Value = issued.version[.sessionId]. A Griffin cookie from before session ids has none; it is
  // still accepted (re-issued with an id on use) so existing devices are not logged out.
  function valueValid(value, needsId = false) {
    if (!value) return false;
    const [issued, version, sessionId] = String(value).split(".");
    if (needsId && !sessionId) return false;
    if (Date.now() - Number(issued) > SESSION_MS) return false;
    if (version !== String(store.getKv("session_version") || 1)) return false;
    return !sessionId || !isRevoked(sessionId);
  }

  // Secure over HTTPS: directly, on the public host, or when a trusted proxy (CIDR list) vouches
  // with x-forwarded-proto. Plain LAN HTTP still needs a cookie it can send back.
  function secure(c) {
    if (secureCookie || new URL(c.req.url).protocol === "https:") return true;
    if (publicHost && c.req.header("host") === publicHost) return true;
    const peer = normalizeIp(c.env?.incoming?.socket?.remoteAddress);
    return trusts(trustedProxies, peer) && c.req.header("x-forwarded-proto") === "https";
  }

  async function issue(c, sessionId = crypto.randomBytes(16).toString("base64url")) {
    const value = `${Date.now()}.${store.getKv("session_version") || 1}.${sessionId}`;
    await setSignedCookie(c, COOKIE, value, secret, {
      httpOnly: true,
      // Strict holds: every link Griffin sends (Telegram, push) opens the public SPA shell
      // (/#/c/<id>), and its /api fetches are same-site, so the cookie goes with them.
      sameSite: "Strict",
      secure: secure(c),
      path: "/",
      maxAge: SESSION_MS / 1000,
    });
    return value;
  }

  // The request's live session value, or null. A Karsara cookie or an id-less Griffin cookie is
  // re-issued as a current Griffin cookie (Karsara's session id kept, so its revocation follows).
  async function session(c) {
    const value = await getSignedCookie(c, secret, COOKIE);
    if (valueValid(value)) {
      if (String(value).split(".")[2]) return value;
      return issue(c);
    }
    const karsara = await getSignedCookie(c, secret, KARSARA_COOKIE);
    if (!valueValid(karsara, true)) return null;
    deleteCookie(c, KARSARA_COOKIE, { path: "/" });
    return issue(c, String(karsara).split(".")[2]);
  }

  // The public name moved (OLD_HOSTS, app.mjs): the browser's cookie belongs to the old name, so the
  // redirect carries the session over with a one-time code instead of asking for the token again
  // (owner 2026-10-24, karsara-* → griffin-*: «کسی به مشکل نخوره»). Single use, two minutes, in memory.
  const carries = new Map();
  async function carryCode(c) {
    const value = await session(c);
    if (!value) return null;
    const now = Date.now();
    for (const [code, item] of carries) if (item.expires < now) carries.delete(code);
    const code = crypto.randomBytes(24).toString("base64url");
    carries.set(code, { expires: now + 120_000 });
    return code;
  }
  const safeTarget = (to) => (typeof to === "string" && to.startsWith("/") && !to.startsWith("//") && !to.startsWith("/\\") ? to : "/");

  return {
    carryCode,
    routes(app) {
      app.get("/api/auth/carry", async (c) => {
        const code = String(c.req.query("c") || "");
        const item = carries.get(code);
        carries.delete(code);
        if (item && item.expires >= Date.now()) await issue(c);
        c.header("cache-control", "no-store");
        return c.redirect(safeTarget(c.req.query("to")), 302);
      });

      // Same-origin check for every state-changing request, JSON included
      // (the cookie is also SameSite=Strict).
      app.use("/api/*", async (c, next) => {
        if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
        const site = c.req.header("sec-fetch-site");
        if (site && !["same-origin", "none"].includes(site)) return c.json({ error: "cross-site request" }, 403);
        const origin = c.req.header("origin");
        if (origin && origin !== new URL(c.req.url).origin && origin !== publicOrigin) return c.json({ error: "cross-origin request" }, 403);
        return next();
      });

      app.post("/api/auth/login", async (c) => {
        const ip = clientIp(c);
        // retryAfter / remaining let the login page say exactly how long to wait or how many tries are left.
        const wait = limited(ip);
        if (wait) {
          c.header("retry-after", String(wait));
          return c.json({ error: "too many attempts", retryAfter: wait }, 429);
        }
        // A flood across many addresses never locks anyone out (the owner's own address must get
        // in); it only slows every attempt while it lasts.
        if (globalFailures.length >= globalFailureCap) await new Promise((resolve) => setTimeout(resolve, globalOverflowDelayMs));
        const body = await c.req.json().catch(() => ({}));
        if (!isOwnerToken(body.token)) {
          const remaining = recordFailure(ip);
          return c.json({ error: "invalid token", remaining, ...(remaining ? {} : { retryAfter: FAILURE_WINDOW_MS / 1000 }) }, 401);
        }
        const userAgent = String(c.req.header("user-agent") || "").slice(0, 160);
        let via = "token";
        if (twoStep() && local(c)) via = "local";
        else if (twoStep()) {
          const code = String(body.code || "").trim();
          if (!code) return c.json({ error: "code required", needCode: true }, 401);
          const locked = codeLocked();
          if (locked) {
            c.header("retry-after", String(locked));
            return c.json({ error: "too many wrong codes", needCode: true, retryAfter: locked }, 429);
          }
          via = acceptCode(code);
          if (!via) {
            // The token was right: whoever this is holds it. The owner hears at once.
            codeMisses.push(Date.now());
            const remaining = recordFailure(ip);
            tell({ kind: codeLocked() ? "code-locked" : "code-miss", ip, userAgent });
            return c.json({ error: "invalid code", needCode: true, remaining, ...(remaining ? {} : { retryAfter: FAILURE_WINDOW_MS / 1000 }) }, 401);
          }
        }
        failures.delete(ip);
        await issue(c);
        if (via !== "local" && !local(c)) tell({ kind: "login", ip, via, userAgent });
        return c.json({ ok: true });
      });

      // Passkeys (passkeys.mjs): a sign-in with the device itself; adding one needs fresh proof.
      passkeyRoutes(app, {
        store,
        issuer,
        session,
        issue,
        tell,
        limited,
        recordFailure,
        clearFailures: (ip) => failures.delete(ip),
        clientIp,
        proofOk: (body) => (twoStep() ? (acceptCode(body.code) ? true : "invalid code") : isOwnerToken(body.token) ? true : "invalid token"),
      });

      // Two-step sign-in. Under /api/auth/ (public in the middleware), so each route checks the page's
      // login cookie itself: a Bearer token never turns it on or off, except from this machine (off,
      // for a lost phone: `curl -X POST -H "Authorization: Bearer $(cat data/owner.token)" http://127.0.0.1:<port>/api/auth/2fa/disable`).
      app.get("/api/auth/2fa", async (c) => {
        if (!(await session(c))) return c.json({ error: "unauthorized" }, 401);
        const state = twoStep();
        return c.json({ enabled: Boolean(state), required: requireTwoStep, enabledAt: state?.enabledAt || null, recoveryLeft: state ? (state.recovery || []).length : 0 });
      });

      // A fresh app secret for this page to show (QR + text); it counts only once a code from it is confirmed.
      app.post("/api/auth/2fa/setup", async (c) => {
        const value = await session(c);
        if (!value) return c.json({ error: "unauthorized" }, 401);
        if (twoStep()) return c.json({ error: "already on" }, 409);
        const now = Date.now();
        for (const [id, item] of pendingSetups) if (item.expires < now) pendingSetups.delete(id);
        const secret = newTotpSecret();
        pendingSetups.set(sessionIdOf(value), { secret, expires: now + PENDING_SETUP_MS });
        const host = publicHost || c.req.header("host") || "server";
        const uri = otpauthUri(secret, { issuer, account: host });
        const { renderSVG } = await import("uqr");
        c.header("cache-control", "no-store");
        return c.json({ secret, uri, svg: renderSVG(uri, { border: 2 }) });
      });

      // Turns it on with a code from the new secret; every other device is signed out (whoever held the
      // token before now holds nothing), this page stays in, and the recovery codes are shown once.
      app.post("/api/auth/2fa/enable", async (c) => {
        const value = await session(c);
        if (!value) return c.json({ error: "unauthorized" }, 401);
        if (twoStep()) return c.json({ error: "already on" }, 409);
        const pending = pendingSetups.get(sessionIdOf(value));
        if (!pending || pending.expires < Date.now()) return c.json({ error: "setup expired" }, 410);
        const body = await c.req.json().catch(() => ({}));
        const step = totpMatch(pending.secret, body.code);
        if (step === null) return c.json({ error: "invalid code" }, 400);
        pendingSetups.delete(sessionIdOf(value));
        const codes = newRecoveryCodes();
        box.set(TOTP_SECRET, pending.secret, { note: "two-step sign-in (authenticator app)" });
        store.setKv("auth_2fa", { enabledAt: new Date().toISOString(), lastStep: step, recovery: codes.map(recoveryHash) });
        store.setKv("session_version", Number(store.getKv("session_version") || 1) + 1);
        deleteCookie(c, KARSARA_COOKIE, { path: "/" });
        await issue(c);
        tell({ kind: "2fa-on", ip: clientIp(c) });
        c.header("cache-control", "no-store");
        return c.json({ ok: true, recoveryCodes: codes });
      });

      // New recovery codes (the old ones stop working); needs a current code.
      app.post("/api/auth/2fa/recovery", async (c) => {
        if (!(await session(c))) return c.json({ error: "unauthorized" }, 401);
        if (!twoStep()) return c.json({ error: "not on" }, 409);
        const body = await c.req.json().catch(() => ({}));
        if (!acceptCode(body.code)) return c.json({ error: "invalid code" }, 400);
        const codes = newRecoveryCodes();
        store.setKv("auth_2fa", { ...twoStep(), recovery: codes.map(recoveryHash) });
        c.header("cache-control", "no-store");
        return c.json({ ok: true, recoveryCodes: codes });
      });

      // Off: the page's cookie and a current code — or the owner token from this machine itself.
      app.post("/api/auth/2fa/disable", async (c) => {
        if (!twoStep()) return c.json({ ok: true });
        const header = c.req.header("authorization") || "";
        const fromShell = local(c) && header.startsWith("Bearer ") && isOwnerToken(header.slice(7).trim());
        if (!fromShell) {
          if (!(await session(c))) return c.json({ error: "unauthorized" }, 401);
          // Required on this install: only the server's shell turns it off (a lost phone), and the next sign-in sets it up again.
          if (requireTwoStep) return c.json({ error: "two-step sign-in is required on this install" }, 409);
          const body = await c.req.json().catch(() => ({}));
          if (!acceptCode(body.code)) return c.json({ error: "invalid code" }, 400);
        }
        box.delete(TOTP_SECRET);
        store.deleteKv("auth_2fa");
        tell({ kind: "2fa-off", ip: clientIp(c), via: fromShell ? "local" : "code" });
        return c.json({ ok: true });
      });

      // Ends this session only (its id is revoked server-side, so a copied cookie dies too);
      // revoke-all is the every-device action.
      app.post("/api/auth/logout", async (c) => {
        for (const name of [COOKIE, KARSARA_COOKIE]) {
          const sessionId = String((await getSignedCookie(c, secret, name)) || "").split(".")[2];
          if (sessionId) revoke(sessionId);
          deleteCookie(c, name, { path: "/" });
        }
        return c.json({ ok: true });
      });

      // Ends every session on every device.
      app.post("/api/auth/revoke-all", async (c) => {
        if (!(await session(c))) return c.json({ error: "unauthorized" }, 401);
        store.setKv("session_version", Number(store.getKv("session_version") || 1) + 1);
        deleteCookie(c, COOKIE, { path: "/" });
        deleteCookie(c, KARSARA_COOKIE, { path: "/" });
        return c.json({ ok: true });
      });

      // Resets the owner token: the old one stops working at once (login, Bearer, the CLI) and every
      // other device is signed out; this page gets a fresh cookie and the new token, once. Only the
      // page's login cookie can do it — a Bearer holder (a script, a leaked token) cannot.
      app.post("/api/auth/rotate-token", async (c) => {
        if (!(await session(c))) return c.json({ error: "unauthorized" }, 401);
        const token = writeOwnerToken();
        store.setKv("session_version", Number(store.getKv("session_version") || 1) + 1);
        deleteCookie(c, KARSARA_COOKIE, { path: "/" });
        await issue(c);
        c.header("cache-control", "no-store");
        return c.json({ ok: true, token });
      });

      app.get("/api/auth/me", async (c) => {
        const value = await session(c);
        return c.json({ authenticated: Boolean(value), ...(value && setupRequired() ? { setupRequired: true } : {}) });
      });
    },

    // For long-lived responses (SSE): re-checks, later, what this request was authenticated with —
    // false once its session is revoked, expired or the version bumped (or the owner token changed).
    sessionChecker(c) {
      const value = c.get?.("session");
      if (value) return () => valueValid(value);
      const header = c.req.header("authorization") || "";
      const near = local(c);
      return () => header.startsWith("Bearer ") && isOwnerToken(header.slice(7).trim()) && (near || !twoStep());
    },

    async middleware(c, next) {
      // Sign-in routes are public; /api/auth/zai (the owner's Z.ai account, account-routes.mjs) is not.
      const signIn = c.req.path.startsWith("/api/auth/") && !/^\/api\/auth\/zai(\/|$)/.test(c.req.path);
      if (signIn || c.req.path.startsWith("/api/public/")) return next();
      // How the owner was recognised (jobs/routes.mjs: only the page's login cookie writes as "owner";
      // the token is what a script — or a job's Bash — would carry).
      const value = await session(c);
      if (value) {
        // Not set up yet: this page may only set it up (the /api/auth/ routes above), nothing else.
        if (setupRequired()) return c.json({ error: "two-step sign-in must be set up first", setupRequired: true }, 403);
        c.set?.("session", value);
        c.set?.("ownerVia", "cookie");
        return next();
      }
      // The owner token as a Bearer header is equivalent to the login cookie — it is the same
      // credential — so the CLI and scripts work without a browser session. With two-step sign-in on,
      // only from this machine: from the network the token alone is not enough any more.
      const header = c.req.header("authorization") || "";
      if (header.startsWith("Bearer ") && isOwnerToken(header.slice(7).trim())) {
        if (twoStep() && !local(c)) return c.json({ error: "two-step sign-in is on: the owner token works only from the server itself" }, 401);
        c.set?.("ownerVia", "token");
        return next();
      }
      return c.json({ error: "unauthorized" }, 401);
    },
  };
}
