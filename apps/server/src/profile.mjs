// The owner's name and photo at the foot of the sidebar. The connected Telegram
// account gives both; a name typed in Settings («نام شما») wins over Telegram's; with neither, name
// and photo are null and the page keeps its default. This is the owner, not the assistant (persona.mjs).
// The photo is served from memory (the Telegram channel downloads it), never stored.
import crypto from "node:crypto";

const MAX_NAME = 60;
// One plain line: controls, bidi marks/overrides/isolates and invisible joiners other than ZWNJ/ZWJ
// (U+200C/D are part of Persian spelling and emoji) become spaces. Cut between whole characters.
const STRIP = /[\p{Cc}\u2028\u2029\u061c\u200b\u200e\u200f\u2060-\u2064\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// A raw cap first, so a huge paste is cheap; then at most MAX_NAME whole characters and at most
// MAX_CODE_POINTS in all (one "character" can carry endless combining marks).
const MAX_RAW = 4_000;
const MAX_CODE_POINTS = 160;
function nameOf(value) {
  const flat = String(value ?? "").slice(0, MAX_RAW).replace(STRIP, " ").replace(/\s+/g, " ").trim();
  let out = "";
  let count = 0;
  for (const { segment } of graphemes.segment(flat)) {
    if (++count > MAX_NAME) break;
    out += segment;
  }
  return [...out].slice(0, MAX_CODE_POINTS).join("").trim() || null;
}
// Telegram profile photos are JPEG; anything else is not shown.
const isJpeg = (bytes) => Buffer.isBuffer(bytes) && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const versionOf = (photo) => crypto.createHash("sha1").update(photo).digest("hex").slice(0, 12);

export function profileRoutes(app, { store, telegramProfile = () => null }) {
  const telegram = async () => {
    const profile = (await telegramProfile()) || {};
    return { name: nameOf(profile.name), photo: isJpeg(profile.photo) ? profile.photo : null };
  };
  const view = async () => {
    const typedName = nameOf(store.getKv("profile")?.name);
    const { name: telegramName, photo } = await telegram();
    return { name: typedName || telegramName, photo: photo ? `/api/profile/photo?v=${versionOf(photo)}` : null, typedName, telegramName };
  };

  app.get("/api/profile", async (c) => c.json(await view()));
  app.put("/api/profile", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.name !== "string") return c.json({ error: "name must be a string" }, 400);
    store.setKv("profile", { ...(store.getKv("profile") || {}), name: nameOf(body.name) });
    return c.json(await view());
  });
  // Only the current version's address is served (and kept by the browser); an old one is gone, so
  // a picture changed in Telegram never sits in the cache under a stale address.
  app.get("/api/profile/photo", async (c) => {
    const { photo } = await telegram();
    if (!photo || c.req.query("v") !== versionOf(photo)) return c.json({ error: "not found" }, 404);
    return c.body(photo, 200, {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
  });
}
