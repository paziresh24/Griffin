import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { clientAddress, DEFAULT_TRUSTED_PROXIES, normalizeIp, trusts } from "./listen.mjs";

const COOKIE = "griffin_session";
const SESSION_DAYS = 30;
// A Karsara install moved onto Griffin keeps its kv (session_secret, session_version,
// session_revoked), so its devices still hold a valid karsara_session: accepted for its own
// lifetime and re-issued as Griffin's cookie on first use.
const KARSARA_COOKIE = "karsara_session";
const KARSARA_DAYS = 14;
const SESSION_MS = SESSION_DAYS * 86_400_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
const GLOBAL_FAILURE_WINDOW_MS = 10 * 60_000;

// Local owner auth with no external identity provider, so it keeps working when a shared
// SSO is down. The owner token lives in the data volume (0600).
export function createAuth({
  dataDir,
  store,
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
  function valueValid(value, days = SESSION_DAYS, needsId = false) {
    if (!value) return false;
    const [issued, version, sessionId] = String(value).split(".");
    if (needsId && !sessionId) return false;
    if (Date.now() - Number(issued) > days * 86_400_000) return false;
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
      maxAge: SESSION_DAYS * 86_400,
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
    if (!valueValid(karsara, KARSARA_DAYS, true)) return null;
    deleteCookie(c, KARSARA_COOKIE, { path: "/" });
    return issue(c, String(karsara).split(".")[2]);
  }

  return {
    routes(app) {
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
        failures.delete(ip);
        await issue(c);
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

      app.get("/api/auth/me", async (c) => c.json({ authenticated: Boolean(await session(c)) }));
    },

    // For long-lived responses (SSE): re-checks, later, what this request was authenticated with —
    // false once its session is revoked, expired or the version bumped (or the owner token changed).
    sessionChecker(c) {
      const value = c.get?.("session");
      if (value) return () => valueValid(value);
      const header = c.req.header("authorization") || "";
      return () => header.startsWith("Bearer ") && isOwnerToken(header.slice(7).trim());
    },

    async middleware(c, next) {
      // Sign-in routes are public; /api/auth/zai (the owner's Z.ai account, account-routes.mjs) is not.
      const signIn = c.req.path.startsWith("/api/auth/") && !/^\/api\/auth\/zai(\/|$)/.test(c.req.path);
      if (signIn || c.req.path.startsWith("/api/public/")) return next();
      // How the owner was recognised (jobs/routes.mjs: only the page's login cookie writes as "owner";
      // the token is what a script — or a job's Bash — would carry).
      const value = await session(c);
      if (value) {
        c.set?.("session", value);
        c.set?.("ownerVia", "cookie");
        return next();
      }
      // The owner token as a Bearer header is equivalent to the login cookie — it is the same
      // credential — so the CLI and scripts work without a browser session.
      const header = c.req.header("authorization") || "";
      if (header.startsWith("Bearer ") && isOwnerToken(header.slice(7).trim())) {
        c.set?.("ownerVia", "token");
        return next();
      }
      return c.json({ error: "unauthorized" }, 401);
    },
  };
}
