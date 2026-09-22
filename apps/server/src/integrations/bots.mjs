import crypto from "node:crypto";
import { chunk, markdownToPlain, markdownToTelegramHtml, withAgentFooter } from "./format.mjs";

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

export function createBotApi({ kind, token, fetchImpl = fetch }) {
  const spec = BOT_KINDS[kind];
  if (!spec) throw new Error(`unknown bot kind ${kind}`);
  async function call(method, params = {}, { timeoutMs = 40_000, signal, form } = {}) {
    const init = { method: "POST", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) };
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
      const response = await fetchImpl(`${spec.fileBase}/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
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


  const paired = () => new Set((bridge.integration(id)?.settings.pairedChats || []).map(String));

  async function sendText(chatId, markdown, extra = {}) {
    const html = api.spec.html;
    const signed = withAgentFooter(markdown);
    const body = html ? markdownToTelegramHtml(signed) : markdownToPlain(signed);
    let last;
    for (const piece of chunk(body)) {
      try {
        last = await api.call("sendMessage", { chat_id: chatId, text: piece, ...(html ? { parse_mode: "HTML", link_preview_options: { is_disabled: true } } : {}), ...extra });
      } catch (error) {
        // Bad HTML from an unusual answer: fall back to plain text instead of losing the message.
        if (!html) throw error;
        last = await api.call("sendMessage", { chat_id: chatId, text: markdownToPlain(signed).slice(0, 4000), ...extra });
      }
    }
    return last;
  }

  async function sendFile(chatId, file) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    const caption = withAgentFooter(file.caption || file.name || "");
    if (caption) form.set("caption", caption.slice(0, 1000));
    const isPhoto = /^image\/(png|jpeg|webp)$/.test(file.mimeType) && file.data.length < 10 * 1024 * 1024;
    const field = isPhoto ? "photo" : file.mimeType?.startsWith("video/") ? "video" : "document";
    form.set(field, new Blob([file.data], { type: file.mimeType }), file.name);
    const method = { photo: "sendPhoto", video: "sendVideo", document: "sendDocument" }[field];
    return api.call(method, {}, { form, timeoutMs: 120_000 });
  }

  const statusByChat = new Map(); // chatId -> { messageId, text }
  const questionByChat = new Map(); // chatId -> messageId of the currently-open ask_owner question

  async function setStatus(chatId, line) {
    const body = `⏳ ${String(line || "در حال کار…").slice(0, 180)}`;
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

    // Called by the bridge when a linked Platform-Ban chat has something to deliver.
    async deliver(externalChat, message) {
      if (message.clearStatus) return clearStatus(externalChat);
      if (message.status) return setStatus(externalChat, message.status);
      if (message.question) {
        await clearStatus(externalChat);
        const options = (message.question.options || []).slice(0, 6);
        const askId = message.question.askId ? String(message.question.askId) : null;
        const hint = options.length ? "\n\nدکمه را بزن یا عدد گزینه را بفرست." : "";
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
        return sent;
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
      if (update.callback_query) {
        const query = update.callback_query;
        const from = String(query.message?.chat?.id ?? query.from?.id);
        await api.call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
        const parsed = parseAskCallback(query.data);
        if (!parsed) return;
        // Coverage ask_owner may target this bot even if the Owner chat isn't the linked team chat.
        if (await bridge.answerOwnerAsk?.(id, parsed.index, parsed.askId)) return;
        if (!paired().has(from)) return;
        await bridge.answer(id, from, parsed.index, parsed.askId);
        return;
      }
      const message = update.message || update.edited_message;
      if (!message) return;
      const from = String(message.chat.id);
      const text = String(message.text || message.caption || "").trim();

      const start = text.match(/^\/start(?:@\w+)?\s*(\S+)?$/);
      if (start) {
        const code = bridge.integration(id)?.settings.pairingCode;
        if (code && start[1] && start[1].toUpperCase() === code) {
          bridge.pair(id, from, message.chat);
          await sendText(from, "✅ این گفتگو به گریفین وصل شد. هر چه بنویسی به ایجنت می‌رسد.\n/new گفتگوی تازه · /stop توقف کار فعلی");
        } else if (!paired().has(from)) {
          await sendText(from, "این ربات خصوصی است. کد اتصال را از تنظیمات گریفین بگیر و بفرست: /start CODE");
        }
        return;
      }

      // Numbered answer to a pending /agent ask_owner (before the private-chat gate).
      const choice = text.match(/^([1-6])$/);
      if (choice) {
        if (await bridge.answerOwnerAsk?.(id, Number(choice[1]) - 1)) {
          await sendText(from, "✅ گرفتم.").catch(() => {});
          return;
        }
        if ((bridge.openOwnerAskCount?.() || 0) > 1) {
          await sendText(from, "چند سؤال باز است؛ دکمهٔ همان پیام را بزن تا به چت درست برود.").catch(() => {});
          return;
        }
      }

      if (!paired().has(from)) return; // strangers get nothing after the /start hint

      if (/^\/new(?:@\w+)?$/.test(text)) {
        bridge.newChat(id, from);
        await sendText(from, "🆕 گفتگوی تازه شروع شد. سؤالت را بفرست.");
        return;
      }
      if (/^\/stop(?:@\w+)?$/.test(text)) {
        const outcome = await bridge.stop(id, from);
        await sendText(from, outcome ? "⏹ متوقف شد." : "کاری در جریان نیست.");
        return;
      }

      if (choice && (await bridge.answer(id, from, Number(choice[1]) - 1))) return;

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
