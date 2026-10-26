import crypto from "node:crypto";
import net from "node:net";

// Passkeys (WebAuthn): sign in with the device itself — Windows Hello on a Surface, Touch ID, a phone —
// instead of the token (owner 2026-10-24: «سرفیس دارها خیلی راحت با windows hello لاگین میشن»).
// A passkey is a key pair that never leaves the device and unlocks only with the face, finger or PIN
// (user verification is required), so it is itself two factors: a sign-in with it needs no token and
// no code. It is bound to the name the page was opened on (its RP ID), so it works on the public name
// over HTTPS, never on a bare IP. Only public keys are kept (kv auth_passkeys).
// Adding one needs fresh proof besides the login cookie — the authenticator code while two-step
// sign-in is on, else the owner token — so a stolen cookie cannot plant a key that outlives
// «خروج از همهٔ دستگاه‌ها» and a token reset.
const CHALLENGE_MS = 2 * 60_000;
const MAX_CHALLENGES = 200;
const MAX_PASSKEYS = 20;

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64 = (text) => new Uint8Array(Buffer.from(String(text || ""), "base64url"));

export function passkeyRoutes(app, ctx) {
  const { store, issuer, session, issue, tell, limited, recordFailure, clearFailures, clientIp, proofOk } = ctx;
  const list = () => {
    const items = store.getKv("auth_passkeys");
    return Array.isArray(items) ? items : [];
  };
  const save = (items) => store.setKv("auth_passkeys", items);
  // One user handle for the owner, so every passkey of this Griffin is the same account on the device.
  function userId() {
    let id = store.getKv("auth_passkey_user");
    if (!id) {
      id = b64(crypto.randomBytes(16));
      store.setKv("auth_passkey_user", id);
    }
    return unb64(id);
  }

  // The page's own origin and name, from the browser's Origin header (the same-origin guard in
  // auth.mjs has already refused any other). A passkey needs a name: an IP is refused.
  function where(c) {
    const origin = c.req.header("origin") || "";
    let rpID = "";
    try {
      rpID = new URL(origin).hostname;
    } catch {
      return null;
    }
    if (!rpID || net.isIP(rpID.replace(/^\[|\]$/g, ""))) return null;
    return { origin, rpID };
  }

  const challenges = new Map(); // id -> { challenge, kind, rpID, origin, sessionId, expires }
  function remember(entry) {
    const now = Date.now();
    for (const [id, item] of challenges) if (item.expires < now) challenges.delete(id);
    if (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
    const id = b64(crypto.randomBytes(16));
    challenges.set(id, { ...entry, expires: now + CHALLENGE_MS });
    return id;
  }
  function take(id, kind) {
    const item = challenges.get(String(id || ""));
    challenges.delete(String(id || ""));
    return item && item.kind === kind && item.expires >= Date.now() ? item : null;
  }
  const view = (p) => ({ id: p.id, name: p.name, rpID: p.rpID, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt || null });
  const sessionIdOf = (value) => String(value || "").split(".")[2] || "";
  const noPlace = (c) => c.json({ error: "passkeys need the page opened on its name over HTTPS, not an IP" }, 400);

  // Sign-in, step 1. `probe` only says whether this name has any passkey (the login page's button).
  app.post("/api/auth/passkey/options", async (c) => {
    const place = where(c);
    const mine = place ? list().filter((p) => p.rpID === place.rpID) : [];
    const body = await c.req.json().catch(() => ({}));
    if (body.probe || !mine.length) return c.json({ available: mine.length > 0 });
    const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
    const options = await generateAuthenticationOptions({
      rpID: place.rpID,
      userVerification: "required",
      allowCredentials: mine.map((p) => ({ id: p.id, transports: p.transports })),
    });
    c.header("cache-control", "no-store");
    return c.json({ available: true, challengeId: remember({ challenge: options.challenge, kind: "login", ...place }), options });
  });

  // Sign-in, step 2: the device's signature. A failure counts like a wrong token.
  app.post("/api/auth/passkey/login", async (c) => {
    const ip = clientIp(c);
    const wait = limited(ip);
    if (wait) {
      c.header("retry-after", String(wait));
      return c.json({ error: "too many attempts", retryAfter: wait }, 429);
    }
    const body = await c.req.json().catch(() => ({}));
    const pending = take(body.challengeId, "login");
    const items = list();
    const found = pending && items.find((p) => p.id === body.response?.id && p.rpID === pending.rpID);
    let verified = false;
    let info = null;
    if (found) {
      try {
        const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
        ({ verified, authenticationInfo: info } = await verifyAuthenticationResponse({
          response: body.response,
          expectedChallenge: pending.challenge,
          expectedOrigin: pending.origin,
          expectedRPID: pending.rpID,
          credential: { id: found.id, publicKey: unb64(found.publicKey), counter: found.counter || 0, transports: found.transports },
          requireUserVerification: true,
        }));
      } catch {
        verified = false;
      }
    }
    if (!verified) {
      const remaining = recordFailure(ip);
      return c.json({ error: pending ? "passkey not accepted" : "expired, try again", remaining }, 401);
    }
    clearFailures(ip);
    save(items.map((p) => (p.id === found.id ? { ...p, counter: info.newCounter, lastUsedAt: new Date().toISOString() } : p)));
    await issue(c);
    tell({ kind: "login", ip, via: "passkey", name: found.name, userAgent: String(c.req.header("user-agent") || "").slice(0, 160) });
    return c.json({ ok: true });
  });

  // Settings: this Griffin's passkeys (the page's login cookie only).
  app.get("/api/auth/passkeys", async (c) => {
    if (!(await session(c))) return c.json({ error: "unauthorized" }, 401);
    return c.json({ passkeys: list().map(view), max: MAX_PASSKEYS });
  });

  // Adding, step 1: fresh proof (code or token), then the options for navigator.credentials.create.
  app.post("/api/auth/passkeys/options", async (c) => {
    const value = await session(c);
    if (!value) return c.json({ error: "unauthorized" }, 401);
    const place = where(c);
    if (!place) return noPlace(c);
    const body = await c.req.json().catch(() => ({}));
    const proof = proofOk(body);
    if (proof !== true) return c.json({ error: proof }, 400);
    const items = list();
    if (items.length >= MAX_PASSKEYS) return c.json({ error: "too many passkeys" }, 409);
    const { generateRegistrationOptions } = await import("@simplewebauthn/server");
    const options = await generateRegistrationOptions({
      rpName: issuer,
      rpID: place.rpID,
      userID: userId(),
      userName: "owner",
      userDisplayName: `${issuer} owner`,
      attestationType: "none",
      excludeCredentials: items.filter((p) => p.rpID === place.rpID).map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    c.header("cache-control", "no-store");
    return c.json({ challengeId: remember({ challenge: options.challenge, kind: "add", ...place, sessionId: sessionIdOf(value) }), options });
  });

  // Adding, step 2: the new key's public half.
  app.post("/api/auth/passkeys", async (c) => {
    const value = await session(c);
    if (!value) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const pending = take(body.challengeId, "add");
    if (!pending || pending.sessionId !== sessionIdOf(value)) return c.json({ error: "expired, try again" }, 410);
    let result = { verified: false };
    try {
      const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
      result = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpID,
        requireUserVerification: true,
      });
    } catch {
      result = { verified: false };
    }
    if (!result.verified) return c.json({ error: "passkey not accepted" }, 400);
    const { credential } = result.registrationInfo;
    const items = list().filter((p) => p.id !== credential.id);
    const name = String(body.name || "").trim().slice(0, 60) || "Passkey";
    const item = {
      id: credential.id,
      publicKey: b64(credential.publicKey),
      counter: credential.counter || 0,
      transports: credential.transports || body.response?.response?.transports || [],
      rpID: pending.rpID,
      name,
      createdAt: new Date().toISOString(),
    };
    save([...items, item]);
    tell({ kind: "passkey-added", ip: clientIp(c), name });
    return c.json({ ok: true, passkey: view(item) });
  });

  app.delete("/api/auth/passkeys/:id", async (c) => {
    if (!(await session(c))) return c.json({ error: "unauthorized" }, 401);
    const items = list();
    const gone = items.find((p) => p.id === c.req.param("id"));
    if (!gone) return c.json({ error: "not found" }, 404);
    save(items.filter((p) => p !== gone));
    tell({ kind: "passkey-removed", ip: clientIp(c), name: gone.name });
    return c.json({ ok: true });
  });
}
