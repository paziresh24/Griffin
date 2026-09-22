import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { clientAddress } from "./listen.mjs";

const COOKIE = "griffin_session";
const SESSION_DAYS = 30;

// Local owner auth with no external identity provider, so it keeps working when the shared SSO is
// down. The owner token lives in the data volume (0600) and opens two doors:
//   - the browser: POST /api/auth/login exchanges it for a signed, HttpOnly session cookie;
//   - everything else: `Authorization: Bearer <owner token>` on /api/*, so the terminal client,
//     a script or a cron job is as first-class as the web UI.
export function createAuth({ dataDir, store, secureCookie = false }) {
  const tokenFile = path.join(dataDir, "owner.token");
  if (!fs.existsSync(tokenFile)) {
    fs.writeFileSync(tokenFile, `${crypto.randomBytes(24).toString("base64url")}\n`, { mode: 0o600 });
  }
  const ownerToken = () => fs.readFileSync(tokenFile, "utf8").trim();

  let secret = store.getKv("session_secret");
  if (!secret) {
    secret = crypto.randomBytes(32).toString("base64url");
    store.setKv("session_secret", secret);
  }

  const failures = new Map(); // ip -> { count, until }
  const clientIp = (c) => clientAddress(c.env?.incoming);

  function limited(ip) {
    const entry = failures.get(ip);
    return entry && entry.count >= 5 && Date.now() < entry.until;
  }

  function recordFailure(ip) {
    const entry = failures.get(ip);
    const count = entry && Date.now() < entry.until ? entry.count + 1 : 1;
    failures.set(ip, { count, until: Date.now() + 15 * 60_000 });
  }

  /** The owner token presented directly — how the CLI and scripts authenticate. */
  function bearerValid(c) {
    const header = c.req.header("authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return false;
    const given = Buffer.from(match[1].trim());
    const expected = Buffer.from(ownerToken());
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  async function sessionValid(c) {
    const value = await getSignedCookie(c, secret, COOKIE);
    if (!value) return false;
    const [issued, version] = String(value).split(".");
    const expired = Date.now() - Number(issued) > SESSION_DAYS * 86_400_000;
    return !expired && version === String(store.getKv("session_version") || 1);
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
        if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "cross-origin request" }, 403);
        return next();
      });

      app.post("/api/auth/login", async (c) => {
        const ip = clientIp(c);
        if (limited(ip)) return c.json({ error: "too many attempts" }, 429);
        const body = await c.req.json().catch(() => ({}));
        const given = Buffer.from(String(body.token || ""));
        const expected = Buffer.from(ownerToken());
        const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
        if (!ok) {
          recordFailure(ip);
          return c.json({ error: "invalid token" }, 401);
        }
        failures.delete(ip);
        await setSignedCookie(c, COOKIE, `${Date.now()}.${store.getKv("session_version") || 1}`, secret, {
          httpOnly: true,
          sameSite: "Strict",
          // Secure over HTTPS (NSIN); plain LAN HTTP still needs a cookie it can send back.
          secure: secureCookie || new URL(c.req.url).protocol === "https:",
          path: "/",
          maxAge: SESSION_DAYS * 86_400,
        });
        return c.json({ ok: true });
      });

      app.post("/api/auth/logout", (c) => {
        deleteCookie(c, COOKIE, { path: "/" });
        return c.json({ ok: true });
      });

      // Ends every session on every device.
      app.post("/api/auth/revoke-all", async (c) => {
        if (!(await sessionValid(c))) return c.json({ error: "unauthorized" }, 401);
        store.setKv("session_version", Number(store.getKv("session_version") || 1) + 1);
        deleteCookie(c, COOKIE, { path: "/" });
        return c.json({ ok: true });
      });

      app.get("/api/auth/me", async (c) => c.json({ authenticated: bearerValid(c) || (await sessionValid(c)) }));
    },

    async middleware(c, next) {
      if (c.req.path.startsWith("/api/auth/") || c.req.path.startsWith("/api/public/")) return next();
      if (bearerValid(c)) return next();
      if (!(await sessionValid(c))) return c.json({ error: "unauthorized" }, 401);
      return next();
    },
  };
}
