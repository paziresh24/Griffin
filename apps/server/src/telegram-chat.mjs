// A colleague's conversation as a Telegram client draws it (web TelegramChat.jsx): read live from the
// owner's own account, so edits, deletes, reactions, media and read ticks are Telegram's own; each line
// keeps who sent it here (the person's history: the assistant, one of the owner's chats, him) when it
// can be matched. Owner-only routes: react, edit, delete, mark read, and a message's picture or file.

const MAX_FILE = 20 * 1024 * 1024;
const SAME_LINE_MS = 5 * 60_000;

const nameOf = (entity) => (entity ? [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.title || entity.username || "" : "");

export function mediaOf(m) {
  if (!m?.media) return null;
  const doc = m.document;
  const attr = (cls) => doc?.attributes?.find((a) => a?.className === cls);
  const kind = m.photo ? "photo" : m.sticker ? "sticker" : m.gif ? "gif" : m.videoNote || m.video ? "video" : m.voice ? "voice" : m.audio ? "audio" : doc ? "file" : m.media.className === "MessageMediaWebPage" ? null : "other";
  if (!kind) return null;
  return {
    kind,
    name: attr("DocumentAttributeFilename")?.fileName || null,
    size: doc?.size != null ? Number(doc.size) : null,
    mime: doc?.mimeType || (m.photo ? "image/jpeg" : null),
    seconds: attr("DocumentAttributeAudio")?.duration ?? attr("DocumentAttributeVideo")?.duration ?? null,
    emoji: attr("DocumentAttributeSticker")?.alt || null,
  };
}

// The person's own history (db persons.history): what this install knows about each line it sent.
function historyIndex(history) {
  const byId = new Map();
  const outs = [];
  for (const h of history || []) {
    if (h.direction !== "out") continue;
    if (h.data?.msgId != null) byId.set(String(h.data.msgId), h);
    else if (/^\d{1,10}$/.test(String(h.id))) byId.set(String(h.id), h);
    outs.push(h);
  }
  return { byId, outs };
}

function sourceOf(m, index) {
  if (!m.out) return null;
  let h = index.byId.get(String(m.id));
  if (!h) {
    // A line one of the owner's chats sent (telegram_send) is kept by its text, not its Telegram id.
    const at = m.date * 1000;
    const text = String(m.message || "").trim();
    h = index.outs.find((o) => String(o.text || "").trim() === text && Math.abs(Date.parse(o.at) - at) < SAME_LINE_MS);
  }
  const data = h?.data || {};
  if (data.by === "assistant") return { by: "assistant", chatId: data.chatId || null };
  if (data.by === "chat") return { by: "chat", fromChat: data.fromChat || null, fromTitle: data.fromTitle || "" };
  return { by: "owner" };
}

/** One gramjs message as the page reads it (the shape of a history line, with Telegram's extras). */
export function rowOf(m, { index = historyIndex([]), readOutboxMaxId = 0, group = false } = {}) {
  const media = mediaOf(m);
  const reactions = (m.reactions?.results || [])
    .map((r) => ({ emoji: r.reaction?.emoticon || null, count: Number(r.count) || 0, mine: r.chosenOrder != null }))
    .filter((r) => r.emoji && r.count);
  const fwd = m.fwdFrom ? m.fwdFrom.fromName || nameOf(m.forward?.sender) || m.forward?.chat?.title || "" : null;
  return {
    id: String(m.id),
    direction: m.out ? "out" : "in",
    text: String(m.message || ""),
    at: new Date(m.date * 1000).toISOString(),
    data: {
      msgId: m.id,
      ...(group && !m.out ? { from: nameOf(m.sender) } : {}),
      ...(m.replyTo?.replyToMsgId ? { replyTo: m.replyTo.replyToMsgId } : {}),
      ...(sourceOf(m, index) || {}),
    },
    ...(media ? { media } : {}),
    ...(reactions.length ? { reactions } : {}),
    ...(m.editDate && !m.editHide ? { edited: true } : {}),
    ...(fwd != null ? { fwd: fwd || "یک نفر" } : {}),
    ...(m.out ? { read: m.id <= readOutboxMaxId } : {}),
  };
}

export function telegramChatRoutes(api, { integrations, store }) {
  const person = (c) => store.getPerson(c.req.param("id"));
  async function peer(c) {
    const client = integrations.accountClient();
    if (!client) throw Object.assign(new Error("اکانت تلگرام وصل نیست"), { status: 503 });
    const p = person(c);
    if (!p) throw Object.assign(new Error("پیدا نشد"), { status: 404 });
    const key = String(p.external_id);
    const entity = await client.getInputEntity(/^-?\d+$/.test(key) ? BigInt(key) : key).catch(() => (p.username ? client.getInputEntity(p.username) : null));
    if (!entity) throw Object.assign(new Error("این گفتگو در تلگرام پیدا نشد"), { status: 404 });
    return { client, entity, p };
  }
  const run = (fn) => async (c) => {
    try {
      return await fn(c);
    } catch (error) {
      return c.json({ error: String(error?.errorMessage || error?.message || error) }, error.status || 400);
    }
  };
  const messageId = (value) => (Number.isInteger(value) && value > 0 ? value : null);

  // The conversation, newest `limit` before `before`; without an account, the history this install kept.
  api.get("/api/telegram/chat/:id", run(async (c) => {
    const p = person(c);
    if (!p) return c.json({ error: "پیدا نشد" }, 404);
    const group = p.meta?.chatType === "group" || p.meta?.chatType === "channel" || String(p.external_id).startsWith("-");
    if (!integrations.accountClient()) return c.json({ live: false, messages: (p.history || []).slice(-200) });
    const { client, entity } = await peer(c);
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 80, 1), 200);
    const before = Number(c.req.query("before")) || 0;
    const { Api } = await import("telegram");
    const [list, dialogs] = await Promise.all([
      client.getMessages(entity, { limit, ...(before ? { offsetId: before } : {}) }),
      client.invoke(new Api.messages.GetPeerDialogs({ peers: [new Api.InputDialogPeer({ peer: entity })] })).catch(() => null),
    ]);
    const dialog = dialogs?.dialogs?.[0];
    const index = historyIndex(p.history);
    const readOutboxMaxId = Number(dialog?.readOutboxMaxId) || 0;
    const messages = [...list].reverse().filter((m) => m.className === "Message").map((m) => rowOf(m, { index, readOutboxMaxId, group }));
    return c.json({ live: true, messages, readInboxMaxId: Number(dialog?.readInboxMaxId) || 0, unread: Number(dialog?.unreadCount) || 0, more: list.length === limit });
  }));

  api.post("/api/telegram/chat/:id/react", run(async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = messageId(body.messageId);
    if (!id) return c.json({ error: "messageId لازم است" }, 400);
    const emoji = typeof body.emoji === "string" && body.emoji.length <= 8 ? body.emoji : null;
    const { client, entity } = await peer(c);
    const { Api } = await import("telegram");
    await client.invoke(new Api.messages.SendReaction({ peer: entity, msgId: id, reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [] }));
    return c.json({ ok: true });
  }));

  api.post("/api/telegram/chat/:id/edit", run(async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = messageId(body.messageId);
    const text = String(body.text || "");
    if (!id || !text.trim() || text.length > 4000) return c.json({ error: "messageId و متن (۱ تا ۴۰۰۰) لازم است" }, 400);
    const { client, entity } = await peer(c);
    await client.editMessage(entity, { message: id, text, linkPreview: false });
    return c.json({ ok: true });
  }));

  // For everyone (Telegram's «Also delete for …»); Telegram refuses what the account may not delete.
  api.post("/api/telegram/chat/:id/delete", run(async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = messageId(body.messageId);
    if (!id) return c.json({ error: "messageId لازم است" }, 400);
    const { client, entity } = await peer(c);
    await client.deleteMessages(entity, [id], { revoke: true });
    return c.json({ ok: true });
  }));

  api.post("/api/telegram/chat/:id/read", run(async (c) => {
    const { client, entity } = await peer(c);
    await client.markAsRead(entity);
    return c.json({ ok: true });
  }));

  // A message's picture (?thumb=1: Telegram's preview) or its file, as Telegram has it.
  api.get("/api/telegram/chat/:id/media/:msg", run(async (c) => {
    const id = messageId(Number(c.req.param("msg")));
    if (!id) return c.json({ error: "پیدا نشد" }, 404);
    const { client, entity } = await peer(c);
    const [m] = await client.getMessages(entity, { ids: [id] });
    const media = m && mediaOf(m);
    if (!media) return c.json({ error: "پیدا نشد" }, 404);
    const thumb = c.req.query("thumb") === "1";
    if (!thumb && media.size > MAX_FILE) return c.json({ error: "فایل بزرگ‌تر از ۲۰ مگابایت است؛ از خود تلگرام بگیرید" }, 413);
    const thumbs = m.document?.thumbs || m.photo?.sizes || [];
    const buf = thumb && !m.photo ? (thumbs.length ? await client.downloadMedia(m, { thumb: thumbs.length - 1 }) : null) : await client.downloadMedia(m, {});
    if (!buf?.length) return c.json({ error: "پیدا نشد" }, 404);
    const type = thumb || m.photo ? "image/jpeg" : /^[\w.+-]+\/[\w.+-]+$/.test(media.mime || "") ? media.mime : "application/octet-stream";
    const name = media.name || `telegram-${id}`;
    return c.body(Buffer.from(buf), 200, {
      "content-type": type,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      ...(thumb || /^image\/(jpeg|png|gif|webp)$/.test(type) ? {} : { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }),
    });
  }));
}
