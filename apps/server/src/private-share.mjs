import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import { cleanLabel } from "./related.mjs";
import { PERSONA } from "./persona.mjs";
import { sendQuiet } from "./integrations/telegram-account.mjs";
import { rememberShareSend } from "./integrations/share-sends.mjs";

// Private share: the owner gives ONE chat to ONE named person (config
// PRIVATE_SHARE, default off). The invite link
// and a one-time code go to that person's Telegram from the owner's own account; typing the code
// binds the link to that device (a later code, again to that person, moves it to a new device and the
// old one is out). The guest reads the chat live and may leave notes — a note is
// third-party content in the chat and never starts a run (the agent works with the owner's access,
// so a guest must never drive it). Revoking is checked on every request.

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_COOLDOWN_MS = 60_000;
export const MAX_CODES = 10; // per share per CODE_WINDOW_MS; past it, wait for the window to roll over
export const CODE_WINDOW_MS = 24 * 3600_000;
export const MAX_ATTEMPTS = 5; // wrong tries per code
export const NOTE_MAX = 2000;
export const NOTES_PER_HOUR = 20;
const DEVICE_DAYS = 180;
const TELEGRAM_TIMEOUT_MS = 20_000;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

const sha = (text) => createHash("sha256").update(text).digest("hex");
const codeHash = (token, code) => sha(`${token}:${code}`);
const cookieName = (token) => `kg_${sha(token).slice(0, 16)}`;
// guestTelegram is { resolve(to) -> { peerId, title }, send(peerId, text) }, or a function returning it
// (null while the owner's Telegram account is not connected).
const telegramOf = (guestTelegram) => (typeof guestTelegram === "function" ? guestTelegram() : guestTelegram) || null;
const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), ms)))]).finally(() => clearTimeout(timer));
};
const sameHash = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The owner's Telegram account as the share routes use it. The recipient must be ONE PERSON: a
 * group or channel would hand the chat to everyone in it. A name must match a person's dialog title
 * exactly (Persian names often contain other names: «رضا» is inside «علیرضا»); a partial match is
 * refused with the candidates, for the owner to pick — the invite goes out at once, so never guess.
 */
// searchRequest(q) builds Telegram's own people search (contacts.Search); injectable for tests.
async function defaultSearchRequest(q) {
  const { Api } = await import("telegram");
  return new Api.contacts.Search({ q, limit: 10 });
}

// Per account client (it outlives the per-request object below): the recent chats, reused for a
// short while, and a pause on Telegram's people search after it was slow (GramJS waits out a flood
// limit of up to a minute instead of failing, and searching as the owner types is what hits it).
const accountState = new WeakMap(); // client -> { dialogs, dialogsAt, globalPausedUntil }
const DIALOGS_TTL_MS = 30_000;
const GLOBAL_SEARCH_MS = 3_000;
const GLOBAL_PAUSE_MS = 60_000;

// store: where the sent ids are kept (share-sends.mjs); markSent(id): the live echo of this send is ours.
export function telegramForShares(client, { searchRequest = defaultSearchRequest, now = Date.now, store = null, markSent = null } = {}) {
  // Known = a Telegram contact of the owner. Being in the recent chats is not enough: anyone can
  // write first and land there.
  const isContact = (e) => Boolean(e?.contact || e?.mutualContact);
  if (!accountState.has(client)) accountState.set(client, { dialogs: null, dialogsAt: 0, globalPausedUntil: 0 });
  const state = accountState.get(client);
  const recentDialogs = async () => {
    if (!state.dialogs || now() - state.dialogsAt > DIALOGS_TTL_MS) {
      state.dialogs = await client.getDialogs({ limit: 300 });
      state.dialogsAt = now();
    }
    return state.dialogs;
  };
  const isPerson = (e) => e?.className === "User" && !e.bot && !e.deleted;
  const personTitle = (e) => [e.firstName, e.lastName].filter(Boolean).join(" ") || e.username || "";
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  // A cold cache (after a restart) resolves a bare id only for contacts: warm it from the dialogs,
  // then fall back to the @username (someone found through Telegram's search has no dialog).
  const byId = async (id, username = null) => {
    try {
      return await client.getEntity(BigInt(id));
    } catch {
      const hit = (await client.getDialogs({ limit: 300 })).find((d) => String(d.entity?.id) === String(id));
      if (hit?.entity) return hit.entity;
      if (username) {
        const entity = await client.getEntity(`@${username}`);
        if (String(entity?.id) === String(id)) return entity;
      }
      throw new Error(`cannot resolve Telegram peer ${id}`);
    }
  };
  return {
    // People the owner can pick, as Telegram's search box finds them: recent chats first (title or
    // username), then Telegram's own search (contacts and public usernames). People only.
    async search(q) {
      const want = norm(q).replace(/^@/, "");
      if (!want) return [];
      const out = new Map();
      // source: "contact" = one of the owner's Telegram contacts; "chat" = in the recent chats but not
      // a contact; "telegram" = found by Telegram's search. Only a contact is invited without the
      // owner confirming the exact @username.
      const add = (entity, title, source) => {
        if (!isPerson(entity) || out.has(String(entity.id)) || out.size >= 8) return;
        out.set(String(entity.id), { peerId: String(entity.id), title: cleanLabel(title || personTitle(entity), 60), username: entity.username || null, source });
      };
      const dialogs = await recentDialogs();
      for (const d of dialogs) if (d.isUser && (norm(d.title).includes(want) || norm(d.entity?.username).includes(want))) add(d.entity, d.title, isContact(d.entity) ? "contact" : "chat");
      if (want.length >= 2 && now() >= state.globalPausedUntil) {
        // Telegram's search is a bonus: bounded, and the recent chats answer whatever it does.
        let timer;
        const slow = new Promise((resolve) => (timer = setTimeout(() => resolve("slow"), GLOBAL_SEARCH_MS)));
        const found = await Promise.race([Promise.resolve().then(async () => client.invoke(await searchRequest(want))).catch(() => "failed"), slow]).finally(() => clearTimeout(timer));
        // Slow (a flood wait GramJS sits out) or refused (a longer one it reports at once): pause it.
        if (found === "slow" || found === "failed") state.globalPausedUntil = now() + GLOBAL_PAUSE_MS;
        else
          for (const u of found?.users || []) {
            const dialog = dialogs.find((d) => String(d.entity?.id) === String(u.id));
            add(u, dialog?.title, isContact(u) || isContact(dialog?.entity) ? "contact" : dialog ? "chat" : "telegram");
          }
      }
      return [...out.values()];
    },
    async resolve(to) {
      const value = String(to || "").trim();
      let entity = null;
      if (/^\d+$/.test(value)) entity = await byId(value);
      else if (value.startsWith("@")) entity = await client.getEntity(value);
      else {
        const lower = value.toLowerCase();
        const people = (await client.getDialogs({ limit: 300 })).filter((d) => d.isUser && isPerson(d.entity));
        const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
        const exact = people.filter((d) => norm(d.title) === norm(lower));
        if (exact.length !== 1) {
          const candidates = (exact.length ? exact : people.filter((d) => norm(d.title).includes(norm(lower)))).map((d) => d.entity.username ? `@${d.entity.username}` : String(d.title || "")).slice(0, 5);
          throw Object.assign(new Error(exact.length ? "more than one person has this name" : "no exact match"), { candidates });
        }
        entity = exact[0].entity;
      }
      if (!isPerson(entity)) throw new Error("not a person");
      return { peerId: String(entity.id), title: personTitle(entity) || value, username: entity.username || null, known: isContact(entity) };
    },
    // The account's entity cache lives in memory: after a restart a bare id resolves only for
    // contacts, so warm it from the dialogs (as resolveTarget does). Plain text, ignored by the inbox.
    async send(peerId, text, { username = null } = {}) {
      const sent = await sendQuiet(client, await byId(peerId, username), String(peerId), text);
      if (sent?.id != null) {
        markSent?.(sent.id);
        rememberShareSend(store, peerId, sent.id);
      }
    },
  };
}

/** What the owner's share dialog sees: never the Telegram id, the code or the device. */
export function ownerView(row) {
  return {
    token: row.token,
    grantee: row.grantee,
    state: row.device_hash ? "active" : "invited",
    createdAt: row.created_at,
    claimedAt: row.claimed_at || null,
    lastSeenAt: row.last_seen_at || null,
    views: row.views || 0,
  };
}

export function inviteText({ title, link }) {
  return `گفتگوی «${title}» را در ${PERSONA.name} با شما به اشتراک گذاشتم (خواندن و یادداشت):\n${link}\nبرای باز کردن، کدی را که بعد از زدنِ «ارسال کد» همین‌جا برایتان می‌آید وارد کنید.`;
}

export function codeText({ title, code }) {
  return `کد ورود به گفتگوی «${title}» در ${PERSONA.name}: ${code}\nده دقیقه اعتبار دارد. آن را به کسی ندهید.`;
}

// Guest routes: registered before auth; each one is scoped to the share its token names.
// onGuestActivity(chat, { kind: "note" | "moved", from, text? }) tells the owner (index.mjs).
// enabled() is the PRIVATE_SHARE switch, read on every request: off, every route here answers 404 —
// a share made while it was on opens nothing.
export function registerGuestRoutes(app, { store, timelines, sendMedia, guestTelegram, publicUrl = "", onGuestActivity = null, enabled = () => true, now = Date.now }) {
  const notesByShare = new Map(); // token -> recent note times (ms)
  let publicOrigin = null;
  try {
    if (publicUrl) publicOrigin = new URL(publicUrl).origin;
  } catch {
    /* ignore */
  }

  const share = (c) => {
    if (!enabled()) return null;
    const token = c.req.param("token");
    return TOKEN.test(token || "") ? store.getPrivateShare(token) : null;
  };
  const deviceOk = (c, row) => Boolean(row.device_hash) && sameHash(sha(getCookie(c, cookieName(row.token)) || ""), row.device_hash);
  // A browser POST carries Origin; one from another site is refused (the guest cookie is SameSite=Strict too).
  const originOk = (c) => {
    const o = c.req.header("origin");
    if (!o) return false;
    return o === publicOrigin || o === new URL(c.req.url).origin;
  };
  const secure = (c) => publicOrigin?.startsWith("https:") || new URL(c.req.url).protocol === "https:";
  const tell = (row, detail) => {
    try {
      onGuestActivity?.(store.getChat(row.chat_id), { from: row.grantee, ...detail });
    } catch {
      /* a failed ring never fails the request */
    }
  };
  const gone = (c) => c.json({ error: "not found" }, 404);
  const otherDevice = (c, row) => c.json({ state: "other_device", grantee: row?.grantee, error: "این لینک روی دستگاه دیگری فعال شده است." }, 403);

  app.get("/api/guest/:token", async (c) => {
    const row = share(c);
    if (!row) return gone(c);
    c.header("x-robots-tag", "noindex");
    if (!row.device_hash) return c.json({ state: "needs_code", grantee: row.grantee });
    if (!deviceOk(c, row)) return otherDevice(c, row);
    const chat = store.getChat(row.chat_id);
    if (!chat) return gone(c);
    store.touchPrivateShare(row.token);
    // The cached fold (timeline-cache.mjs); a poll that already holds this revision gets one line.
    const { timeline, rev } = await timelines.get(chat.id);
    if (rev && c.req.query("rev") === rev && Number(c.req.query("have")) === timeline.lastEventId) return c.json({ state: "open", unchanged: true, rev });
    return c.json({ state: "open", grantee: row.grantee, chat: { title: chat.title, createdAt: chat.created_at }, timeline, rev });
  });

  app.get("/api/guest/:token/media/:id", (c) => {
    const row = share(c);
    if (!row) return gone(c);
    if (!deviceOk(c, row)) return c.json({ error: "forbidden" }, 403);
    const media = store.getMedia?.(c.req.param("id"));
    if (!media || media.chat_id !== row.chat_id) return gone(c);
    return sendMedia(c, media);
  });

  app.get("/api/guest/:token/charts/:id", (c) => {
    const row = share(c);
    if (!row) return gone(c);
    if (!deviceOk(c, row)) return c.json({ error: "forbidden" }, 403);
    const chart = store.getChart(c.req.param("id"));
    if (!chart || chart.chat_id !== row.chat_id) return gone(c);
    return c.json({ chart });
  });

  app.post("/api/guest/:token/code", async (c) => {
    const row = share(c);
    if (!row) return gone(c);
    if (!originOk(c)) return c.json({ error: "forbidden" }, 403);
    // A claimed share may get a code too: it goes to the same person, and typing it moves the share
    // to this device (a lost cookie or a new phone must not lock them out for good).
    const telegram = telegramOf(guestTelegram);
    if (!telegram) return c.json({ error: "تلگرامِ صاحب گفتگو وصل نیست." }, 503);
    const chat = store.getChat(row.chat_id);
    if (!chat) return gone(c);
    const windowStart = new Date(now() - CODE_WINDOW_MS).toISOString();
    const sentAt = store.reserveShareCode(row.token, { notBefore: new Date(now() - CODE_COOLDOWN_MS).toISOString(), maxCodes: MAX_CODES, windowStart });
    if (!sentAt) {
      const fresh = store.getPrivateShare(row.token);
      if ((fresh?.codes_sent || 0) >= MAX_CODES && fresh?.codes_window_start > windowStart) return c.json({ error: "تعداد کدهای امروز تمام شد؛ فردا دوباره بزنید یا از صاحب گفتگو لینک تازه بخواهید." }, 429);
      return c.json({ error: "یک دقیقه صبر کنید و دوباره بزنید." }, 429);
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    // The code is saved only once Telegram took the message. A slow send (Telegram can hold it for a
    // minute under a flood wait, then deliver) is not a failure: the answer goes back now and the
    // code is saved when the send completes. Only a send that failed outright gives its count back.
    const save = () => store.setShareCode(row.token, { codeHash: codeHash(row.token, code), expiresAt: new Date(now() + CODE_TTL_MS).toISOString(), sentAt });
    const sending = Promise.resolve().then(() => telegram.send(row.grantee_peer, codeText({ title: chat.title, code }), { username: row.grantee_username }));
    const outcome = await Promise.race([sending.then(() => "sent", () => "failed"), new Promise((resolve) => setTimeout(() => resolve("slow"), TELEGRAM_TIMEOUT_MS).unref?.())]);
    if (outcome === "sent") {
      save();
      return c.json({ sent: true });
    }
    if (outcome === "failed") {
      store.refundShareCode(row.token);
      return c.json({ error: "ارسال کد به تلگرام ممکن نشد؛ یک دقیقه بعد دوباره بزنید." }, 502);
    }
    sending.then(save, () => store.refundShareCode(row.token)).catch(() => {}); // a closed DB at shutdown must not crash the process
    return c.json({ sent: "pending" }, 202);
  });

  app.post("/api/guest/:token/claim", async (c) => {
    const row = share(c);
    if (!row) return gone(c);
    if (!originOk(c)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => ({}));
    const code = String(body?.code ?? "").replace(/\s/g, "");
    // Every try is spent before it is checked, and the share is read again after the body arrived:
    // guesses sent together cannot share one count.
    if (!store.takeShareCodeAttempt(row.token, MAX_ATTEMPTS)) return c.json({ error: "کد منقضی شده؛ کد تازه بگیرید." }, 400);
    const live = store.getPrivateShare(row.token);
    if (!live) return gone(c);
    if (!live.code_hash || !live.code_expires_at || Date.parse(live.code_expires_at) <= now()) return c.json({ error: "کد منقضی شده؛ کد تازه بگیرید." }, 400);
    if (!/^\d{6}$/.test(code) || !sameHash(codeHash(row.token, code), live.code_hash)) return c.json({ error: "کد درست نیست." }, 400);
    const device = randomBytes(32).toString("base64url");
    // The code is spent by the claim itself: of two claims with it, exactly one wins.
    if (!store.claimPrivateShare(row.token, live.code_hash, sha(device))) return c.json({ error: "کد منقضی شده؛ کد تازه بگیرید." }, 400);
    if (live.device_hash) tell(live, { kind: "moved" });
    setCookie(c, cookieName(row.token), device, {
      path: `/api/guest/${row.token}`,
      httpOnly: true,
      sameSite: "Strict",
      secure: secure(c),
      maxAge: DEVICE_DAYS * 24 * 3600,
    });
    return c.json({ claimed: true });
  });

  app.post("/api/guest/:token/notes", async (c) => {
    const row = share(c);
    if (!row) return gone(c);
    if (!originOk(c)) return c.json({ error: "forbidden" }, 403);
    if (!deviceOk(c, row)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => ({}));
    // Read again once the body arrived: a revoke (or a move to a new device) during the upload wins.
    const live = share(c);
    if (!live) return gone(c);
    if (!deviceOk(c, live)) return c.json({ error: "forbidden" }, 403);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "یادداشت خالی است." }, 400);
    if (text.length > NOTE_MAX) return c.json({ error: `یادداشت حداکثر ${NOTE_MAX} نویسه است.` }, 400);
    const t = now();
    const recent = (notesByShare.get(row.token) || []).filter((at) => t - at < 3600_000);
    if (recent.length >= NOTES_PER_HOUR) return c.json({ error: "در این ساعت یادداشتِ زیادی فرستاده‌اید؛ کمی بعد." }, 429);
    notesByShare.set(row.token, [...recent, t]);
    const event = store.appendEvent(row.chat_id, null, "guest.note", { text, from: row.grantee });
    tell(row, { kind: "note", text });
    return c.json({ note: { id: `g${event.id}` } }, 201);
  });
}

// Owner routes: registered after auth.
export function registerOwnerShareRoutes(app, { store, guestTelegram, publicUrl = "", enabled = () => true }) {
  const linkFor = (c, token) => {
    let base = publicUrl;
    if (!base) base = new URL(c.req.url).origin;
    return `${String(base).replace(/\/+$/, "")}/#/p/${token}`;
  };
  // Off (PRIVATE_SHARE): nothing new is searched, made or sent (the chat is "not found" to those
  // routes); listing and revoking stay, so the owner can still close a share made while it was on.
  const chatOf = (c) => (enabled() ? store.getChat(c.req.param("id")) : null);
  const anyChat = (c) => store.getChat(c.req.param("id"));

  app.get("/api/chats/:id/private-shares", (c) => {
    const chat = anyChat(c);
    if (!chat) return c.json({ error: "not found" }, 404);
    // An invite that went pending and then failed was removed then; the owner hears about it once here.
    const failedInvites = store.takeFailedInvites(chat.id).map((row) => ({ grantee: row.grantee, at: row.invite_failed_at }));
    return c.json({ shares: store.listPrivateShares(chat.id).map(ownerView), telegram: Boolean(telegramOf(guestTelegram)), failedInvites });
  });

  // The share menu's search box: people from the owner's Telegram to pick from.
  app.get("/api/chats/:id/private-shares/people", async (c) => {
    const chat = chatOf(c);
    if (!chat) return c.json({ error: "not found" }, 404);
    const telegram = telegramOf(guestTelegram);
    if (!telegram?.search) return c.json({ error: `تلگرامِ شما به ${PERSONA.name} وصل نیست؛ اول از تنظیمات وصلش کنید.` }, 409);
    const q = String(c.req.query("q") || "").trim().slice(0, 64);
    if (!q) return c.json({ people: [] });
    try {
      const people = await withTimeout(telegram.search(q), TELEGRAM_TIMEOUT_MS);
      return c.json({ people: people.map(({ peerId, title, username, source }) => ({ peerId, title, username: username || null, source: ["contact", "chat"].includes(source) ? source : "telegram" })) });
    } catch {
      return c.json({ error: "جستجو در تلگرام ممکن نشد؛ دوباره امتحان کنید." }, 502);
    }
  });

  app.post("/api/chats/:id/private-shares", async (c) => {
    const chat = chatOf(c);
    if (!chat) return c.json({ error: "not found" }, 404);
    const telegram = telegramOf(guestTelegram);
    if (!telegram) return c.json({ error: `تلگرامِ شما به ${PERSONA.name} وصل نیست؛ اول از تنظیمات وصلش کنید.` }, 409);
    const body = await c.req.json().catch(() => ({}));
    const to = typeof body?.to === "string" ? body.to.trim() : "";
    if (!to || to.length > 200) return c.json({ error: "گیرنده را بنویسید (‎@username یا نامِ گفتگو در تلگرام)." }, 400);
    let peer;
    try {
      peer = await withTimeout(telegram.resolve(to), TELEGRAM_TIMEOUT_MS);
    } catch (error) {
      const candidates = Array.isArray(error?.candidates) ? error.candidates : [];
      if (candidates.length) return c.json({ error: `دقیقاً یک نفر را بنویسید؛ مثلاً یکی از: ${candidates.join("، ")}`, candidates }, 400);
      return c.json({ error: "این گیرنده در تلگرامِ شما پیدا نشد؛ ‎@username یا نامِ کاملِ گفتگو را بنویسید." }, 400);
    }
    if (!peer?.peerId) return c.json({ error: "این گیرنده در تلگرامِ شما پیدا نشد." }, 400);
    // Someone outside the owner's contacts: a similar name is not enough — the owner confirms the
    // exact @username, and without one it cannot be confirmed.
    if (peer.known !== true) {
      if (!peer.username) return c.json({ error: "این شخص در مخاطبان شما نیست و نامِ کاربری ندارد؛ اول او را در تلگرام به مخاطبان اضافه کنید." }, 400);
      const typed = String(body?.confirmUsername ?? "").trim().replace(/^@/, "").toLowerCase();
      if (typed !== String(peer.username).toLowerCase()) {
        return c.json({ error: `این شخص در مخاطبان شما نیست؛ نامِ کاربریِ دقیقش (‎@${peer.username}) را تأیید کنید.`, confirm: { username: peer.username, title: cleanLabel(peer.title || "", 60) } }, 409);
      }
    }
    const row = store.createPrivateShare(chat.id, { grantee: cleanLabel(peer.title || to, 60) || "مهمان", peerId: peer.peerId, username: peer.username || null });
    // Like a code send: a slow send (a flood wait Telegram sits out, then delivers) is pending, not a
    // failure — revoking it would leave the person a dead link. Only a definite failure revokes.
    const sending = Promise.resolve().then(() => telegram.send(row.grantee_peer, inviteText({ title: chat.title, link: linkFor(c, row.token) }), { username: row.grantee_username }));
    const outcome = await Promise.race([sending.then(() => "sent", () => "failed"), new Promise((resolve) => setTimeout(() => resolve("slow"), TELEGRAM_TIMEOUT_MS).unref?.())]);
    if (outcome === "failed") {
      store.revokePrivateShare(chat.id, row.token);
      return c.json({ error: "ارسال دعوت در تلگرام ممکن نشد؛ دوباره امتحان کنید." }, 502);
    }
    const view = { share: { ...ownerView(row), link: linkFor(c, row.token) } };
    if (outcome === "sent") return c.json(view, 201);
    sending.catch(() => {
      try {
        store.failPrivateShareInvite(chat.id, row.token);
      } catch {
        /* a closed DB at shutdown must not crash the process */
      }
    });
    return c.json({ ...view, sent: "pending" }, 202);
  });

  app.delete("/api/chats/:id/private-shares/:token", (c) => {
    const chat = anyChat(c);
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json({ revoked: store.revokePrivateShare(chat.id, c.req.param("token")) });
  });
}
