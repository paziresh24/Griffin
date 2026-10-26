import crypto from "node:crypto";
import { markdownToPlain, markdownToTelegramHtml, splitMarkdown, withAgentFooter } from "./format.mjs";
import { PERSONA } from "../persona.mjs";
import { withoutInertMarks, withoutInertMarksIn } from "../redact.mjs";

// Telegram and Bale speak the same Bot API; only the base URL and formatting differ.
export const BOT_KINDS = {
  telegram_bot: { label: "ربات تلگرام", base: "https://api.telegram.org", html: true, fileBase: "https://api.telegram.org/file" },
  bale_bot: { label: "ربات بله", base: "https://tapi.bale.ai", html: false, fileBase: "https://tapi.bale.ai/file" },
};

export class BotApiError extends Error {
  constructor(message, { conflict = false } = {}) {
    super(message);
    this.conflict = conflict;
  }
}

// apiBase: a Bot API mirror for Telegram (env GRIFFIN_TELEGRAM_BOT_API, from Karsara's
// KARSARA_TELEGRAM_BOT_API) for a host that cannot reach api.telegram.org directly. Unset (the
// default) = api.telegram.org as before. Telegram only — Bale keeps its own host.
export const TELEGRAM_BOT_API_CONFIG = "TELEGRAM_BOT_API";
const BAD_BASE = "GRIFFIN_TELEGRAM_BOT_API must be an http(s) URL with a host and no query";
/** The mirror base without trailing slashes, "" when unset; throws (no token anywhere) when fetch could not parse it. */
export function botApiBase(value) {
  const base = String(value || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  // Parsed here, where no token is in the string: a base fetch cannot parse would put the whole
  // URL, token included, into the error the Settings page and the log show.
  let url;
  try {
    url = new URL(`${base}/botX/getMe`);
  } catch {
    throw new Error(BAD_BASE);
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.search || url.hash || /\s/.test(base)) throw new Error(BAD_BASE);
  return base;
}
export function createBotApi({ kind, token, fetchImpl = fetch, apiBase = "" }) {
  const known = BOT_KINDS[kind];
  if (!known) throw new Error(`unknown bot kind ${kind}`);
  const mirror = kind === "telegram_bot" ? botApiBase(apiBase) : "";
  const spec = mirror ? { ...known, base: mirror, fileBase: `${mirror}/file` } : known;
  async function call(method, params = {}, { timeoutMs = 40_000, signal, form } = {}) {
    const init = { method: "POST", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) };
    // A redirecting mirror would turn the POST into a GET without its body (getUpdates loses its offset).
    if (mirror) init.redirect = "error";
    if (form) init.body = form;
    else {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(params);
    }
    const response = await fetchImpl(`${spec.base}/bot${token}/${method}`, init);
    const body = await response.json().catch(() => ({}));
    if (!body.ok) {
      const description = body.description || `http ${response.status}`;
      const conflict = /terminated by other getUpdates|Conflict:.*getUpdates/i.test(description);
      throw new BotApiError(`${method}: ${description}`, { conflict });
    }
    return body.result;
  }
  return {
    kind,
    spec,
    call,
    getMe: () => call("getMe", {}, { timeoutMs: 15_000 }),
    async downloadFile(fileId) {
      const file = await call("getFile", { file_id: fileId }, { timeoutMs: 20_000 });
      const response = await fetchImpl(`${spec.fileBase}/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000), ...(mirror ? { redirect: "error" } : {}) });
      if (!response.ok) throw new BotApiError(`download http ${response.status}`);
      return { data: Buffer.from(await response.arrayBuffer()), path: file.file_path };
    },
  };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes (0/O, 1/I)

export function pairingCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** callback_data: `a:<askId>:<index>` (bound) or legacy `ask:<index>`. */
export function parseAskCallback(data) {
  const s = String(data || "");
  let m = s.match(/^a:([a-f0-9]{6,16}):(\d+)$/i);
  if (m) return { askId: m[1].toLowerCase(), index: Number(m[2]) };
  m = s.match(/^ask:(\d+)$/);
  if (m) return { askId: null, index: Number(m[1]) };
  return null;
}

/** callback_data for the model menu: `m:<pick-id>:<i>` — a tap picks the i-th offered choice. */
export function parseModelCallback(data) {
  const m = String(data || "").match(/^m:([a-f0-9]{6,16}):(\d+)$/i);
  return m ? { pickId: m[1].toLowerCase(), index: Number(m[2]) } : null;
}

/** callback_data for the /chats list: `c:<pick-id>:<i>` opens the i-th chat, `c:<pick-id>:n|p` turns the page. */
export function parseChatCallback(data) {
  const m = String(data || "").match(/^c:([a-f0-9]{6,16}):(\d+|n|p)$/i);
  if (!m) return null;
  const pickId = m[1].toLowerCase();
  return /^\d+$/.test(m[2]) ? { pickId, index: Number(m[2]) } : { pickId, step: m[2].toLowerCase() === "n" ? 1 : -1 };
}

/** The /chats list as an inline keyboard: one chat per row, then the page buttons. */
export function chatMenuKeyboard(menu) {
  const rows = (menu.buttons || []).map((b) => [{ text: String(b.text).slice(0, 60), callback_data: `c:${menu.pickId}:${b.index}` }]);
  const turn = [];
  if (menu.back) turn.push({ text: "→ قبلی", callback_data: `c:${menu.pickId}:p` });
  if (menu.more) turn.push({ text: "بعدی ←", callback_data: `c:${menu.pickId}:n` });
  if (turn.length) rows.push(turn);
  return { inline_keyboard: rows };
}

// One running bot: receives via webhook (preferred) or getUpdates long-poll; only talks to paired chats.
export function createBotChannel({ integration, api, bridge, log = console, webhookUrl = null, webhookSecret = null }) {
  const { id } = integration;
  let stopped = false;
  let controller = null;
  const status = {
    state: "starting",
    lastError: null,
    lastPollAt: null,
    username: integration.settings.username || null,
    // Persian, safe to show in UI when receive is disrupted (e.g. getUpdates Conflict).
    userMessage: null,
  };


  const paired = () => new Set((bridge.integration?.(id)?.settings.pairedChats || []).map(String));

  // Text over Telegram's 4096-character limit goes out as several messages in order, split on
  // paragraph/line boundaries and never inside a code block (splitMarkdown), each part converted to
  // HTML on its own (cutting the HTML could split a tag). `extra` (a question's buttons) rides on
  // the last part only. If Telegram rejects one part's HTML, only THAT part is resent as plain text.
  // A chat that is not paired (a stranger who found the bot) is signed with the assistant's name
  // only, never a SIGNATURE that names the owner. (Ported from Karsara bots.mjs.)
  async function sendText(chatId, markdown, extra = {}) {
    const html = api.spec.html;
    const footer = paired().has(String(chatId)) ? null : `— ${PERSONA.name}`;
    const parts = splitMarkdown(withAgentFooter(withoutInertMarks(markdown), footer), html ? 3500 : 3900);
    let last;
    for (let i = 0; i < parts.length; i++) {
      const more = i === parts.length - 1 ? extra : {};
      const plain = { chat_id: chatId, text: markdownToPlain(parts[i]) || parts[i], ...more };
      if (!html) {
        last = await api.call("sendMessage", plain);
        continue;
      }
      const body = markdownToTelegramHtml(parts[i]);
      try {
        if (body.length > 4096) throw new BotApiError("sendMessage: Bad Request: part too long as HTML");
        last = await api.call("sendMessage", { chat_id: chatId, text: body, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...more });
      } catch (error) {
        // Bad HTML from an unusual answer: this part only, as plain text. A network failure is not
        // a formatting problem — rethrow it.
        if (!(error instanceof BotApiError) || !/Bad Request/i.test(error.message)) throw error;
        last = await api.call("sendMessage", plain);
      }
    }
    return last;
  }

  async function sendFile(chatId, file) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    const caption = withAgentFooter(withoutInertMarks(file.caption || file.name || ""));
    if (caption) form.set("caption", caption.slice(0, 1000));
    const isPhoto = /^image\/(png|jpeg|webp)$/.test(file.mimeType) && file.data.length < 10 * 1024 * 1024;
    const field = isPhoto ? "photo" : file.mimeType?.startsWith("video/") ? "video" : "document";
    form.set(field, new Blob([file.data], { type: file.mimeType }), file.name);
    const method = { photo: "sendPhoto", video: "sendVideo", document: "sendDocument" }[field];
    return api.call(method, {}, { form, timeoutMs: 120_000 });
  }

  const statusByChat = new Map(); // chatId -> { messageId, text }
  const questionByChat = new Map(); // chatId -> messageId of the currently-open ask_owner question
  const modelMenuByChat = new Map(); // chatId -> { messageId, pickId } of the last /model menu
  const askByMessage = new Map(); // question messageId -> askId: a reply to it answers that ask in words

  async function setStatus(chatId, line) {
    const body = `⏳ ${withoutInertMarks(line || "در حال کار…").slice(0, 180)}`;
    const prev = statusByChat.get(String(chatId));
    if (prev?.messageId && prev.text === body) return;
    if (prev?.messageId) {
      try {
        await api.call("editMessageText", { chat_id: chatId, message_id: prev.messageId, text: body });
        statusByChat.set(String(chatId), { messageId: prev.messageId, text: body });
        return;
      } catch {
        /* send fresh */
      }
    }
    const sent = await api.call("sendMessage", { chat_id: chatId, text: body });
    statusByChat.set(String(chatId), { messageId: sent.message_id ?? sent.id, text: body });
  }

  async function clearStatus(chatId) {
    const key = String(chatId);
    const prev = statusByChat.get(key);
    statusByChat.delete(key);
    if (!prev?.messageId) return;
    try {
      await api.call("deleteMessage", { chat_id: chatId, message_id: prev.messageId });
    } catch {
      /* ignore */
    }
  }

  const channel = {
    id,
    kind: integration.kind,
    status,

    // Called by the bridge when a linked chat has something to deliver.
    async deliver(externalChat, raw) {
      const message = withoutInertMarksIn(raw);
      if (message.clearStatus) return message.done === false ? undefined : clearStatus(externalChat);
      if (message.status) return setStatus(externalChat, message.status);
      if (message.question) {
        await clearStatus(externalChat);
        const options = (message.question.options || []).slice(0, 6);
        const askId = message.question.askId ? String(message.question.askId) : null;
        // Buttons hold 60 characters and no description: when that loses meaning, spell the
        // options out in the message so the owner sees what each choice actually does.
        const spelled = options.some((o) => o.description || String(o.label).length > 30)
          ? `\n\n${options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")}`
          : "";
        const hint = askId
          ? `${spelled}\n\n${options.length ? "دکمه را بزن، عدد گزینه را بفرست، یا" : ""} روی همین پیام ریپلای کن و جواب خودت را بنویس.`.replace("\n\n ", "\n\n")
          : options.length ? `${spelled}\n\nدکمه را بزن یا عدد گزینه را بفرست.` : "";
        const sent = await sendText(externalChat, `❓ ${message.question.question}${hint}`, options.length
          ? {
            reply_markup: {
              inline_keyboard: options.map((o, i) => [{
                text: o.label.slice(0, 60),
                // Bound to this ask so concurrent coverage chats cannot steal the answer.
                callback_data: askId ? `a:${askId}:${i}` : `ask:${i}`,
              }]),
            },
          }
          : {});
        const messageId = sent?.message_id ?? sent?.id;
        if (messageId != null) questionByChat.set(String(externalChat), messageId);
        if (messageId != null && askId) {
          askByMessage.set(Number(messageId), askId);
          if (askByMessage.size > 500) askByMessage.delete(askByMessage.keys().next().value);
        }
        return sent;
      }
      // A question that is no longer open: leave the message in place but strip its buttons and
      // say what happened. Deleting it (the old behaviour) left the owner with no sign that their
      // tap landed, and any question delivered before a restart stayed tappable forever.
      if (message.closeQuestion) {
        const { messageId, note } = message.closeQuestion;
        if (messageId == null) return null;
        try {
          await api.call("editMessageText", {
            chat_id: externalChat,
            message_id: messageId,
            text: String(note || "این سؤال دیگر باز نیست.").slice(0, 3500),
            reply_markup: { inline_keyboard: [] },
          });
        } catch {
          /* message too old to edit, or already changed — nothing to do */
        }
        if (questionByChat.get(String(externalChat)) === messageId) questionByChat.delete(String(externalChat));
        return null;
      }
      // The question was answered elsewhere (UI or Telegram) or the run ended: remove it so only
      // open questions stay visible here.
      if (message.clearQuestion) {
        const key = String(externalChat);
        const messageId = questionByChat.get(key);
        questionByChat.delete(key);
        if (messageId == null) return null;
        try {
          await api.call("deleteMessage", { chat_id: externalChat, message_id: messageId });
        } catch {
          /* too old to delete / already gone — ignore */
        }
        return null;
      }
      if (message.typing) return api.call("sendChatAction", { chat_id: externalChat, action: "typing" }).catch(() => {});
      if (message.text) {
        await clearStatus(externalChat);
        await sendText(externalChat, message.text);
      }
      for (const file of message.files || []) await sendFile(externalChat, file).catch((error) => sendText(externalChat, `(ارسال فایل ${file.name} نشد: ${error.message})`));
      return null;
    },

    async handleUpdate(update) {
      // The model menu's own buttons (parseModelCallback), before the question buttons below, which
      // ack and drop every callback they do not parse (or model taps would do nothing). The owner picks a model for
      // THIS conversation; the run in flight keeps its model, the next turn runs on the new one.
      const chatTap = update.callback_query ? parseChatCallback(update.callback_query.data) : null;
      if (chatTap) {
        const query = update.callback_query;
        const from = String(query.message?.chat?.id ?? query.from?.id);
        const ack = (text) => api.call("answerCallbackQuery", { callback_query_id: query.id, ...(text ? { text, show_alert: false } : {}) }).catch(() => {});
        const messageId = query.message?.message_id;
        if (!paired().has(from) || String(query.from?.id ?? "") !== from) {
          await ack();
          return;
        }
        if (chatTap.step) {
          const menu = bridge.chatMenuPage?.(id, from, chatTap.pickId, chatTap.step);
          if (!menu?.buttons) {
            await ack("این فهرست دیگر باز نیست؛ /chats را دوباره بفرستید.");
            return;
          }
          await ack();
          await api.call("editMessageText", { chat_id: from, message_id: messageId, text: menu.text, reply_markup: chatMenuKeyboard(menu) }).catch(() => {});
          return;
        }
        const picked = await bridge.pickChat?.(id, from, chatTap.pickId, chatTap.index);
        if (!picked) {
          await ack("این فهرست دیگر باز نیست؛ /chats را دوباره بفرستید.");
          return;
        }
        await ack("✅ وصل شد");
        if (messageId != null) {
          await api.call("editMessageText", { chat_id: from, message_id: messageId, text: `✅ گفتگوی فعلی: ${picked.title}`, reply_markup: { inline_keyboard: [] } }).catch(() => {});
        }
        const state = picked.waiting ? "❓ منتظر جواب شماست." : picked.running ? "⏳ الان در حال کار است؛ جوابش همین‌جا می‌آید." : "";
        const tail = "از این به بعد هر چه بنویسید به همین گفتگو می‌رود. /chats برای عوض کردن، /new برای گفتگوی تازه.";
        await sendText(from, [`💬 ${picked.title}`, picked.last ? `آخرین جواب:\n${picked.last}` : "هنوز جوابی در این گفتگو نیست.", state, tail].filter(Boolean).join("\n\n")).catch(() => {});
        return;
      }

      const modelTap = update.callback_query ? parseModelCallback(update.callback_query.data) : null;
      if (modelTap) {
        const query = update.callback_query;
        const from = String(query.message?.chat?.id ?? query.from?.id);
        const ack = (text) => api.call("answerCallbackQuery", { callback_query_id: query.id, ...(text ? { text, show_alert: false } : {}) }).catch(() => {});
        const senderId = query.from?.id ?? null;
        if (!paired().has(from)) {
          await ack();
          return;
        }
        const saved = modelMenuByChat.get(String(from));
        if (!saved || saved.pickId !== modelTap.pickId) {
          await ack("این منو دیگر باز نیست؛ /model را دوباره بفرست.");
          return;
        }
        const picked = await bridge.pickModel?.(id, from, modelTap.index, { senderId });
        if (!picked) {
          await ack("این سؤال دیگر باز نیست");
          return;
        }
        if (picked.busy) {
          await ack("یک کار در جریان است؛ وقتی تمام شد دوباره بزن.");
          return;
        }
        modelMenuByChat.delete(String(from));
        try {
          await api.call("editMessageText", {
            chat_id: from,
            message_id: saved.messageId,
            text: `✅ مدل این گفتگو: ${picked.label}`,
            reply_markup: { inline_keyboard: [] },
          });
        } catch {
          /* too old to edit — the ack already said it */
        }
        await ack("✅ ثبت شد");
        return;
      }

      if (update.callback_query) {
        const query = update.callback_query;
        const from = String(query.message?.chat?.id ?? query.from?.id);
        const ack = (text) => api.call("answerCallbackQuery", { callback_query_id: query.id, ...(text ? { text, show_alert: false } : {}) }).catch(() => {});
        const parsed = parseAskCallback(query.data);
        if (!parsed) {
          await ack();
          return;
        }
        // Coverage ask_owner may target this bot even if the Owner chat isn't the linked team chat.
        // The tapper (from.id), not the chat: in a group the chat is everyone's.
        const delivered =
          (await bridge.answerOwnerAsk?.(id, parsed.index, parsed.askId, { senderId: query.from?.id ?? null })) ||
          (paired().has(from) ? await bridge.answer(id, from, parsed.index, parsed.askId, { senderId: query.from?.id ?? null }) : false);
        if (delivered) {
          await ack("✅ ثبت شد");
          return;
        }
        // A member's tap in a group: only the owner answers there. The question stays open, so its
        // buttons stay for him.
        if (paired().has(from) && bridge.mayAnswerIn && !bridge.mayAnswerIn(id, from, query.from?.id ?? null)) {
          await ack("فقط صاحبِ ربات می‌تواند به این سؤال جواب بدهد");
          return;
        }
        // A tap on a question whose run is long gone (most often: the server restarted after it
        // was sent). Say so and take the buttons away instead of silently doing nothing.
        await ack("این سؤال دیگر باز نیست");
        const messageId = query.message?.message_id;
        if (messageId != null) {
          await api.call("editMessageText", {
            chat_id: from,
            message_id: messageId,
            text: `${String(query.message.text || "").slice(0, 3000)}\n\n⏹ این سؤال دیگر باز نیست.`,
            reply_markup: { inline_keyboard: [] },
          }).catch(() => {});
        }
        return;
      }
      const message = update.message || update.edited_message;
      if (!message) return;
      const from = String(message.chat.id);
      const text = String(message.text || message.caption || "").trim();
      // The bot answers in the sender's Telegram language: Persian for fa, English otherwise.
      const say = (fa, en) => (String(message.from?.language_code || "").startsWith("fa") ? fa : en);

      const start = text.match(/^\/start(?:@\w+)?\s*(\S+)?$/);
      if (start) {
        const code = bridge.integration(id)?.settings.pairingCode;
        if (code && start[1] && start[1].toUpperCase() === code) {
          bridge.pair(id, from, message.chat);
          await sendText(from, say(`✅ این گفتگو به ${PERSONA.name} وصل شد. هر چه بنویسی به ایجنت می‌رسد.\n/new گفتگوی تازه · /chats گفتگوهای قبلی · /model انتخاب مدل · /stop توقف کار فعلی`, `✅ This chat is connected to ${PERSONA.latin}. Everything you write here reaches the agent.\n/new new chat · /model choose the model · /stop stop the current work`));
        } else if (!paired().has(from)) {
          await sendText(from, say("این ربات خصوصی است. کد اتصال را از تنظیمات بگیر و بفرست: /start CODE", "This bot is private. Get the pairing code from the settings and send: /start CODE"));
        }
        return;
      }

      // Numbered answer to a pending /agent ask_owner (before the private-chat gate), from the
      // owner only (manager.mjs senderOwns): anyone else's number is an ordinary message.
      const choice = text.match(/^([1-6])$/);
      const senderId = message.from?.id ?? null;
      // A reply to a question message, in the owner's (or requester's) own words.
      const repliedAsk = message.reply_to_message ? askByMessage.get(Number(message.reply_to_message.message_id)) : null;
      if (repliedAsk && text && !choice) {
        const done =
          (await bridge.answerOwnerAsk?.(id, null, repliedAsk, { senderId, text })) ||
          (paired().has(from) ? await bridge.answer(id, from, null, repliedAsk, { senderId, text }) : false);
        await sendText(from, done ? say("✅ گرفتم.", "✅ Got it.") : say("این سؤال دیگر باز نیست.", "This question is no longer open.")).catch(() => {});
        return;
      }
      if (choice && (bridge.ownerAskCountFor?.(id, senderId) || 0) > 0) {
        if (await bridge.answerOwnerAsk?.(id, Number(choice[1]) - 1, null, { senderId })) {
          await sendText(from, say("✅ گرفتم.", "✅ Got it.")).catch(() => {});
          return;
        }
        if (bridge.ownerAskCountFor(id, senderId) > 1) {
          await sendText(from, say("چند سؤال باز است؛ دکمهٔ همان پیام را بزن تا به چت درست برود.", "Several questions are open; tap the button on the one you mean so the answer reaches the right chat.")).catch(() => {});
          return;
        }
      }

      if (!paired().has(from)) return; // strangers get nothing after the /start hint

      // /model and /models both show the models this conversation may run on as buttons with the
      // current one ticked. The pick pins the chat's model column, so it survives a restart and
      // holds until the next /model.
      if (/^\/(?:model|models)(?:@\w+)?\s*$/.test(text)) {
        const menu = await bridge.modelMenu?.(id, from, {});
        if (!menu) return;
        if (!menu.buttons?.length) {
          await sendText(from, menu.text || "مدلی برای انتخاب نیست.");
          return;
        }
        const prev = modelMenuByChat.get(String(from));
        modelMenuByChat.set(String(from), { pickId: menu.pickId, messageId: null });
        const sent = await sendText(from, menu.text, {
          // manager.mjs modelMenu gives a flat list, one model per row; a row of buttons is taken too.
          reply_markup: { inline_keyboard: menu.buttons.map((row) => (Array.isArray(row) ? row : [row]).map((b) => ({ text: String(b.text).slice(0, 60), callback_data: `m:${menu.pickId}:${b.index}` }))) },
        });
        const entry = modelMenuByChat.get(String(from));
        if (entry?.pickId === menu.pickId) entry.messageId = sent?.message_id ?? sent?.id ?? null;
        // Only the latest menu stays live; an older one edits to a closed note when it is tapped.
        if (prev?.messageId != null && prev.messageId !== entry?.messageId) {
          try {
            await api.call("editMessageReplyMarkup", { chat_id: from, message_id: prev.messageId, reply_markup: { inline_keyboard: [] } });
          } catch {
            /* already gone */
          }
        }
        return;
      }
      // /chats [متن]: his chats as buttons (manager.mjs chatMenu); a tap moves this conversation onto one.
      const chats = text.match(/^\/chats(?:@\w+)?(?:\s+([\s\S]+))?$/);
      if (chats) {
        const menu = bridge.chatMenu?.(id, from, { query: chats[1] || "" });
        if (!menu) return;
        await sendText(from, menu.text, menu.buttons?.length ? { reply_markup: chatMenuKeyboard(menu) } : {});
        return;
      }
      if (/^\/new(?:@\w+)?$/.test(text)) {
        bridge.newChat(id, from);
        await sendText(from, say("🆕 گفتگوی تازه شروع شد. سؤالت را بفرست.", "🆕 New chat started. Send your question."));
        return;
      }
      if (/^\/stop(?:@\w+)?$/.test(text)) {
        const outcome = await bridge.stop(id, from);
        await sendText(from, outcome ? say("⏹ متوقف شد.", "⏹ Stopped.") : say("کاری در جریان نیست.", "Nothing is running."));
        return;
      }

      if (choice && (await bridge.answer(id, from, Number(choice[1]) - 1, null, { senderId }))) return;

      const images = [];
      const photo = message.photo?.at(-1);
      if (photo) {
        const file = await api.downloadFile(photo.file_id).catch(() => null);
        if (file) images.push({ mimeType: "image/jpeg", data: file.data.toString("base64") });
      }
      if (!text && !images.length) return;
      await api.call("sendChatAction", { chat_id: from, action: "typing" }).catch(() => {});
      await bridge.receive(id, from, {
        text: text || "این تصویر را ببین.", images, title: message.chat.title || message.chat.first_name,
        // Who wrote it, and whether it is someone else's message passed on (manager.mjs ownerWroteIt).
        senderId: message.from?.id ?? null,
        // An inline bot's result (via_bot) was written by that bot, not by the sender.
        forwarded: Boolean(message.forward_origin || message.forward_from || message.forward_from_chat || message.forward_sender_name || message.forward_date || message.via_bot),
        person: { name: [message.chat.first_name, message.chat.last_name].filter(Boolean).join(" ") || message.chat.title || from, username: message.from?.username || null, data: { platform: "telegram", chatType: message.chat.type || null } },
      });
    },

    async start() {
      let offset = 0;
      let delay = 1000;
      try {
        const me = await api.getMe();
        status.username = me.username || me.first_name;
        bridge.saveSettings(id, { username: status.username });
        // The bot's own «/» menu (/new /stop /model /models) — the
        // exact commands handleUpdate answers to, so the button never offers something dead.
        try {
          await api.call("setMyCommands", {
            commands: [
              { command: "new", description: "گفتگوی تازه" },
              { command: "chats", description: "گفتگوهای من (رفتن به یکی و جواب دادن)" },
              { command: "model", description: "مدل این گفتگو (انتخاب با دکمه)" },
              { command: "models", description: "مدل‌های قابل انتخاب" },
              { command: "stop", description: "توقف کار فعلی" },
            ],
          });
        } catch (error) {
          log.warn?.(`[${integration.kind}] setMyCommands failed: ${error.message}`);
        }
      } catch (error) {
        status.lastError = error.message;
      }

      // Prefer webhook when we have a public HTTPS URL — avoids getUpdates Conflict with other pollers.
      if (webhookUrl) {
        try {
          await api.call("setWebhook", {
            url: webhookUrl,
            allowed_updates: ["message", "edited_message", "callback_query"],
            drop_pending_updates: true,
            ...(webhookSecret ? { secret_token: webhookSecret } : {}),
          });
          status.state = "webhook";
          status.lastError = null;
          status.userMessage = null;
          status.lastPollAt = new Date().toISOString();
          log.info?.(`[${integration.kind}] webhook ${status.username || id} → ${webhookUrl}`);
          return;
        } catch (error) {
          status.lastError = error.message;
          log.error?.(`[${integration.kind}] setWebhook failed: ${error.message}; falling back to getUpdates`);
        }
      }

      try {
        await api.call("deleteWebhook", { drop_pending_updates: true });
      } catch {
        /* ignore */
      }

      while (!stopped) {
        controller = new AbortController();
        try {
          status.state = "polling";
          const updates = await api.call("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "edited_message", "callback_query"] }, { timeoutMs: 40_000, signal: controller.signal });
          status.lastPollAt = new Date().toISOString();
          status.lastError = null;
          status.userMessage = null;
          delay = 1000;
          for (const update of updates) {
            offset = update.update_id + 1;
            await channel.handleUpdate(update).catch((error) => log.error?.(`[${integration.kind}] update: ${error.message}`));
          }
        } catch (error) {
          if (stopped) break;
          // Another process is already long-polling this bot token — receiving here cannot work.
          // Adapt: mark inbound unavailable, keep trying slowly, never surface a raw stack to the UI.
          if (error?.conflict || /terminated by other getUpdates|Conflict:.*getUpdates/i.test(String(error?.message || ""))) {
            status.state = "unavailable";
            status.lastError = error.message;
            status.userMessage =
              "دریافت پیام این ربات موقتاً در دسترس نیست: توکن هم‌زمان جای دیگری getUpdates می‌شود. ارسال از سوکان‌بان ممکن است هنوز کار کند؛ برای دریافت، long-poll موازی را قطع کن یا ربات جدا بگذار.";
            log.error?.(`[${integration.kind}] getUpdates conflict — inbound unavailable`);
            for (let i = 0; i < 60 && !stopped; i += 1) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            continue;
          }
          status.state = "error";
          status.lastError = error.message;
          status.userMessage = null;
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 60_000);
        }
      }
      status.state = "stopped";
    },

    stop() {
      stopped = true;
      controller?.abort();
      if (webhookUrl) {
        api.call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
      }
    },
  };
  return channel;
}
