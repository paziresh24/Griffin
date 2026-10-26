import { foldEvents, lastRun } from "@griffin/timeline";
import crypto from "node:crypto";
import { autoTitle } from "../titles.mjs";
import { BOT_KINDS, botApiBase, createBotApi, createBotChannel, pairingCode } from "./bots.mjs";
import { DEFAULT_AGENT, resolveAgentId } from "../agents/registry.mjs";
import { COVERAGE_CALLER, isOwnerNote } from "./coverage.mjs";
import { chatHistoryBlock, isNoReply, peerAgentPrompt, takeRate, derivePeerUserId } from "./peer-agent.mjs";
import { answerStamp, deliverable, liveStatusLine, partOf } from "./format.mjs";
import { OWNER, REQUESTER } from "../asks.mjs";
import { ownerLabel } from "../guard.mjs";
import { createAccountChannel, createAccountLogin } from "./telegram-account.mjs";
import { shareSendIds } from "./share-sends.mjs";
import { normalizePhone, validTelegramApp } from "./telegram-app.mjs";
import { chartMedia } from "../chart-image.mjs";
import { normalizeProvider, splitModel } from "../providers/ids.mjs";
import { openWorkFor } from "../related.mjs";
import { markMessengerOrigin } from "../chat-origin.mjs";
import { ownMessengerChat } from "../db.mjs";
import { PERSONA } from "../persona.mjs";
import { ensureGlobal, ensureMother, isGlobalChat, joinThread, motherChatId, migrateTelegramV2, migrateWatchEnables, motherInfo, syncMotherNames, watching } from "./mother.mjs";
import { createDesk } from "./desk.mjs";

// Bridges messenger channels (Telegram/Bale bots; Telegram account) to Griffin chats: incoming
// messages become runs, finished runs and ask_owner questions go back to the linked messenger chat.
// Colleagues' chats (caller=team) go through the desk (desk.mjs): a mother chat never delivers its
// final text — only send_to_person reaches the colleague; ask_owner confirmations go to the Owner's
// Telegram bot so they are unmistakable — not buried in the owner's own Saved Messages.
const PARTS_TTL_MS = 10 * 60_000;
// /chats on the bot: buttons per page, and how much of the picked chat's last answer is shown.
const CHAT_MENU_SIZE = 8;
const CHAT_LAST_MAX = 1500;

export function createIntegrations({ store, runner, timelines = null, asks, network = null, peerAuth = null, publicUrl = "", fetchImpl = fetch, telegramProxy = null, channelFactories = {}, login = null, pendingWork = () => 0, burstMs = 0, telegramApp = () => null, ownerJobApprovals = () => false, telegramBotApi: telegramBotApiRaw = "", inbox = null, sendFiles = () => true, modelChoices = null, log = console }) {
  const channels = new Map(); // integrationId -> channel
  const partsHeld = new Map(); // `${integrationId}:${externalChat}` -> { total, parts, at, timer, args } (receivePeerAgent)
  // Each ask_owner gets a short id embedded in Telegram callback_data so buttons cannot
  // answer a different chat's question (one bot → many concurrent coverage chats).
  // Each entry keeps its own question: two open asks on one root chat (two sub-agents asking at
  // once) used to share one per-chat slot, so a tap on the first mapped onto the second's options.
  const pendingAsks = new Map(); // askId -> { chatId, owner, at, question, fromAsks }
  // Deliveries that came back without a message id (a channel that returns none): all we can do
  // is ask that channel to delete its last question once nothing of the chat is open any more.
  // Deliveries with an id are rows in ask:open below, closed one by one.
  const askTargets = new Map(); // chatId -> [{ integrationId, externalChat }]
  const endAfterRun = new Map(); // chatId -> { integrationId, peer, note }
  const lastStatusAt = new Map(); // chatId -> ms of last status push (debounce)
  const webhookSecrets = new Map(); // integrationId -> secret_token for Telegram webhook
  const chatMenus = new Map(); // pickId -> { id, externalChat, ids, page, query } of a /chats list

  // The owner's own private chat with a bot: proven (db.mjs ownMessengerChat), or a paired private
  // chat (a positive id is a person, not a group) on an install with no Telegram account to prove it
  // by — pairing took the code from his settings. Only the proven one leaves a chat it moves onto
  // unmarked (db.mjs linkChat); the other marks it as a Telegram chat, as before.
  function ownBotChat(id, externalChat) {
    if (ownMessengerChat(store, id, externalChat)) return true;
    const integ = store.getIntegration(id);
    return Boolean(BOT_KINDS[integ?.kind]) && /^\d+$/.test(String(externalChat)) && (integ.settings?.pairedChats || []).map(String).includes(String(externalChat));
  }

  function newAskId() {
    return crypto.randomBytes(4).toString("hex");
  }

  function registerAsk(chatId, question, { owner = false } = {}) {
    const askId = question.askId || newAskId();
    const tagged = { ...question, askId };
    pendingAsks.set(askId, { chatId, owner: Boolean(owner), at: Date.now(), question: tagged, fromAsks: Boolean(question.askId) });
    return tagged;
  }

  function clearAsksForChat(chatId) {
    for (const [askId, pending] of pendingAsks) {
      if (pending.chatId === chatId) pendingAsks.delete(askId);
    }
  }

  // Where each delivered question is sitting, in the database as well as in memory. In memory
  // alone it did not survive a restart: every question already sent to Telegram became an
  // untappable leftover, and after a few deploys the owner's bot chat was a wall of dead
  // questions with no way to tell which one was still live.
  const OPEN_ASKS_KEY = "ask:open";
  const MAX_OPEN_ASKS = 200;

  const openAsks = () => {
    const rows = store.getKv?.(OPEN_ASKS_KEY);
    return Array.isArray(rows) ? rows : [];
  };
  const saveOpenAsks = (rows) => store.setKv?.(OPEN_ASKS_KEY, rows.slice(-MAX_OPEN_ASKS));

  // `question` is the tagged question this delivery carried: its own text and id, not whatever the
  // chat asked last — two sends in flight at once used to save the second's text on the first row.
  function recordAskDelivery(chatId, integrationId, externalChat, sent, question) {
    const messageId = sent?.message_id ?? sent?.id ?? null;
    if (messageId == null) {
      // Kept apart from the rows: a stale entry here once made a later close of this chat delete
      // another chain's still-open question (the channel deletes its LAST question, not this one).
      const list = askTargets.get(chatId) || [];
      list.push({ integrationId, externalChat: String(externalChat) });
      askTargets.set(chatId, list);
      return;
    }
    // The question text is kept so closing the message can leave it readable (with the answer
    // under it) instead of replacing it with a bare "answered".
    const text = String(question?.question || "").slice(0, 3000);
    saveOpenAsks([
      ...openAsks().filter((row) => row.messageId !== messageId || row.externalChat !== String(externalChat)),
      { chatId, integrationId, externalChat: String(externalChat), messageId, askId: question?.askId ?? null, text, at: Date.now() },
    ]);
  }

  function closedText(row, note) {
    return row.text ? `❓ ${row.text}\n\n${note}` : note;
  }

  // Strip a delivered question of its buttons and say what became of it.
  async function closeDelivered(row, note) {
    const channel = channels.get(row.integrationId);
    if (!channel) return;
    await channel.deliver(row.externalChat, { closeQuestion: { messageId: row.messageId, note: closedText(row, note) } }).catch(() => {});
  }

  // A question stopped being open (answered from the UI, from Telegram, or the run ended):
  // delete the Telegram message so only genuinely open questions stay visible there.
  function clearQuestion(chatId, { answer = null, cancelled = false, askId = null } = {}) {
    const note = answer
      ? `✅ پاسخ: ${String(answer).slice(0, 200)}`
      : cancelled
        ? "⏹ کار متوقف شد؛ این سؤال دیگر باز نیست."
        : "✅ پاسخ ثبت شد.";
    // One question of the chain closed (asks says which): only its row goes, the others stay tappable.
    if (askId) pendingAsks.delete(String(askId));
    else clearAsksForChat(chatId);
    const rows = openAsks();
    const mine = rows.filter((row) => row.chatId === chatId && (!askId || row.askId === askId));
    if (mine.length) {
      saveOpenAsks(rows.filter((row) => !mine.includes(row)));
      for (const row of mine) closeDelivered(row, note);
    }
    if (askId) return;
    // Nothing of the chat is open any more: deliveries without a message id get the channel's
    // delete-your-last-question.
    const targets = askTargets.get(chatId);
    askTargets.delete(chatId);
    for (const t of targets || []) {
      channels.get(t.integrationId)?.deliver(t.externalChat, { clearQuestion: true }).catch(() => {});
    }
  }

  // On startup nothing is waiting any more: every question still sitting in Telegram belongs to a
  // run that is gone, so close them all instead of leaving tappable ghosts behind.
  async function sweepStaleAsks() {
    const rows = openAsks();
    if (!rows.length) return 0;
    saveOpenAsks([]);
    for (const row of rows) {
      await closeDelivered(row, "⏹ این سؤال دیگر باز نیست (سرور از آن زمان ری‌استارت شده). اگر هنوز لازم است، در خود برنامه دوباره بپرس.");
    }
    log.log?.(`[integrations] closed ${rows.length} stale question(s) left in Telegram`);
    return rows.length;
  }

  function openOwnerAsks() {
    return [...pendingAsks.entries()]
      .filter(([, p]) => p.owner)
      .sort((a, b) => b[1].at - a[1].at);
  }

  function botWebhookUrl(integrationId) {
    const base = String(publicUrl || "").replace(/\/$/, "");
    if (!/^https:\/\//i.test(base)) return null;
    return `${base}/api/public/integrations/${integrationId}/webhook`;
  }

  const sameSecret = (given, expected) => {
    const a = Buffer.from(String(given || ""));
    const b = Buffer.from(String(expected));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  function botWebhookSecret(integrationId) {
    if (webhookSecrets.has(integrationId)) return webhookSecrets.get(integrationId);
    // Random, kept in the store: the webhook URL carries the integration id, so a secret computed
    // from it alone let anyone post a forged update — one with the owner's user id as sender would
    // now reach the agent as his own text (ownerWroteIt). Registered anew with setWebhook at start.
    const key = `bot-hook-secret:${integrationId}`;
    let secret = store.getKv?.(key);
    if (typeof secret !== "string" || secret.length < 32) {
      secret = crypto.randomBytes(24).toString("hex");
      store.setKv?.(key, secret);
    }
    webhookSecrets.set(integrationId, secret);
    return secret;
  }

  // A mirror base that cannot be parsed is reported once and not used, so one typo does not stop
  // the server at boot (the bots then try api.telegram.org and show that error in Settings).
  let telegramBotApi = "";
  try {
    telegramBotApi = botApiBase(telegramBotApiRaw);
  } catch (error) {
    log.error?.(`[integrations] ${error.message}; Telegram bots use api.telegram.org`);
  }
  const factories = {
    ...Object.fromEntries(Object.keys(BOT_KINDS).map((kind) => [kind, (integration, bridge) => {
      const webhookUrl = botWebhookUrl(integration.id);
      return createBotChannel({
        integration,
        api: createBotApi({ kind, token: integration.secret, fetchImpl, apiBase: telegramBotApi }),
        bridge,
        log,
        webhookUrl,
        webhookSecret: webhookUrl ? botWebhookSecret(integration.id) : null,
      });
    }])),
    telegram_account: (integration, bridge) => createAccountChannel({ integration, bridge, proxy: telegramProxy, log }),
    ...channelFactories,
  };

  const personByExternal = (key) => store.findPerson(key);

  // The person's standing orchestrator chat (mother.mjs), made on their first watched message.
  async function motherChat(id, peer, { name, person = null } = {}) {
    const profile = person?.id ? store.getPerson(person.id) : personByExternal(peer);
    return ensureMother(store, {
      integrationId: id,
      key: String(peer),
      person: profile,
      name: name || profile?.display_name || String(peer),
      agent: coverageAgent(profile, store),
      model: store.getIntegration(id)?.settings?.model || null,
    });
  }
  const accountEntry = () => [...channels.entries()].find(([, ch]) => ch.kind === "telegram_account") || null;
  const desk = createDesk({
    store, runner, timelines, pendingWork, burstMs, log, motherChat, network,
    channelOf: (id) => channels.get(id),
    accountChannel: () => accountEntry()?.[1] || null,
  });
  // Telegram v2, once: legacy threads close unless something still runs in them (mother.mjs).
  migrateTelegramV2(store, {
    isActive: (id) => runner.isActive(id) || Boolean(store.getKv(`runq:${id}`)),
    isWaiting: (id) => Boolean(asks?.isWaiting?.(id)),
  });
  // Once: a watched person still blocked by the old «دسترسی» flag gets answered again.
  const unblocked = migrateWatchEnables(store);
  if (unblocked) log.info?.(`[telegram] ${unblocked} watched person(s) had the old access flag off — turned on`);

  /** Owner's personal Telegram user id (from the connected account). */
  // Nobody is watching a scheduler / ops-room / job chain: no owner question comes out of it.
  function unattendedChat(chat) {
    return Boolean(chat) && (chat.caller === "scheduler" || chat.caller === "ops" || Boolean(chat.job_id));
  }

  // "Whose request is this?" on top of a question from a chain the owner did not start.
  function requesterLine(chat) {
    if (!chat || chat.caller === OWNER) return "";
    if (String(chat.caller).startsWith("peer:")) {
      const userId = String(chat.caller).slice("peer:".length);
      const label = ownerLabel(store, userId);
      return `🔐 درخواست «${label}»:`;
    }
    if (chat.job_id) return `🔐 از جاب «${store.getJob?.(chat.job_id)?.name || chat.job_id}» — تأیید با توست:`;
    return `🔐 از مسیر «${chat.caller}» — تأیید با توست:`;
  }

  // The owner's own Telegram user id, as his connected account reports it (settings.me) — the
  // only proof of who he is on Telegram. Null without a connected account.
  function accountOwnerId() {
    for (const integ of store.listIntegrations?.() || []) {
      const id = integ?.settings?.me?.id;
      if (integ.kind === "telegram_account" && id) return String(id);
    }
    return null;
  }

  // The owner's chat on the bot that will reach him: on a Telegram bot his account's id first, else
  // that bot's own paired chat. A Bale bot's user ids are not Telegram's: there the account's id is
  // some other Bale user, so Bale uses its own paired chat.
  function ownerChatOn(bot) {
    if (!bot?.integ) return null;
    if (bot.integ.kind === "telegram_bot") {
      const own = accountOwnerId();
      if (own) return own;
    }
    // This bot's own paired chats first, then other bots of the same messenger (same id space).
    const sameKind = (store.listIntegrations?.() || []).filter((i) => i.kind === bot.integ.kind && i.id !== bot.integ.id);
    for (const integ of [bot.integ, ...sameKind]) {
      for (const chat of integ.settings?.pairedChats || []) {
        if (/^\d+$/.test(String(chat))) return String(chat);
      }
    }
    return null;
  }

  // In a bot's group (any chat that is not the sender's own private chat) only the owner answers
  // that chat's questions: a member's "1" or tap is an ordinary message. The owner is
  // the bot's owner chat (ownerChatOn); when it is unknown nobody's answer settles (fail closed).
  // Private chats, and the account's Saved Messages, are unchanged.
  function groupSenderMayAnswer(integrationId, externalChat, senderId, { quiet = false } = {}) {
    const integ = store.getIntegration?.(integrationId);
    if (!integ || !BOT_KINDS[integ.kind]) return true;
    const sender = senderId == null ? "" : String(senderId);
    if (sender && sender === String(externalChat)) return true;
    const ownerId = ownerChatOn({ integ });
    if (!ownerId) {
      if (!quiet) log.warn?.(`[integrations] group answer refused in ${externalChat}: no owner id for bot ${integrationId}`);
      return false;
    }
    return sender === ownerId;
  }

  // Where an owner question was sent (integration + chat) is the only place it may be answered
  // from, and only by that chat's own user: a bare "1" from an unpaired DM or any group member
  // could approve a gated call. The check follows the delivery (ownerChatOn), so
  // whoever can receive the question can answer it and nobody else.
  function markOwnerTarget(askId, integrationId, externalChat) {
    const pending = pendingAsks.get(String(askId));
    if (pending) pending.to = { integrationId, externalChat: String(externalChat) };
  }
  function senderOwns(pending, integrationId, senderId) {
    const to = pending?.to;
    const sender = senderId == null ? "" : String(senderId);
    if (!to || !sender) return false;
    const integ = store.getIntegration?.(integrationId);
    // The owner's own account (only Saved Messages calls this): he answers what went to his Saved
    // Messages, and what a Telegram bot sent to his account's id.
    if (integ?.kind === "telegram_account") {
      const me = integ.settings?.me?.id != null ? String(integ.settings.me.id) : null;
      if (to.integrationId === integrationId && to.externalChat === "me") return !me || sender === me;
      const toKind = store.getIntegration?.(to.integrationId)?.kind;
      return Boolean(me) && sender === me && toKind === "telegram_bot" && to.externalChat === me;
    }
    return to.integrationId === integrationId && sender === to.externalChat;
  }
  // The open owner questions this sender may answer here, newest first.
  const ownerAsksFor = (integrationId, senderId) => openOwnerAsks().filter(([, p]) => senderOwns(p, integrationId, senderId));

  /** Prefer the bot channel for Owner asks so the message is clearly from the bot, not the owner. */
  function preferOwnerBot() {
    const bots = [];
    for (const [id, channel] of channels) {
      const integ = store.getIntegration(id);
      if (!integ || !BOT_KINDS[integ.kind]) continue;
      bots.push({ id, channel, integ });
    }
    // Prefer a bot that carries the product name, so the owner recognises who is asking.
    bots.sort((a, b) => {
      const rank = (u) => (/griffin/i.test(u || "") ? 0 : 1);
      return rank(a.integ.settings?.username) - rank(b.integ.settings?.username);
    });
    return bots[0] || null;
  }

  function ensureBotPaired(botId, ownerId) {
    const integ = store.getIntegration(botId);
    if (!integ || !ownerId) return;
    const raw = (integ.settings.pairedChats || []).map(String);
    const paired = [...new Set(raw.filter((c) => c !== "me" && c))];
    if (!paired.includes(ownerId)) paired.push(ownerId);
    const names = { ...(integ.settings.pairedNames || {}) };
    delete names.me;
    names[ownerId] = names[ownerId] || "Owner";
    if (raw.includes("me") || !raw.includes(ownerId)) {
      store.updateIntegration(botId, { settings: { pairedChats: paired, pairedNames: names, pairingCode: null } });
    }
  }

  // In the owner's own chats the person tapping the button is the owner, whichever bot chat it
  // came from; only a teammate/peer chat answers as the requester.
  const answererIn = (chatId, by) => (store.getChat(chatId)?.caller === OWNER ? OWNER : by);

  // The answer to one delivered question (askId): its own options map the index to a label.
  // text: the owner's own words instead of an option (a Telegram reply to the question).
  async function answerChat(chatId, index, { by = OWNER, askId = null, text = null } = {}) {
    const entry = askId ? pendingAsks.get(String(askId)) : null;
    const question = entry?.question;
    const label = text != null ? String(text).trim() : question?.options?.[index]?.label;
    if (!chatId || !label) return false;
    const answeredBy = answererIn(chatId, by);
    // A question asks knows by id: settle exactly that one with its own options. ask.pending is
    // written only once the tool is waiting, so there is nothing to wait for; a false (answered
    // elsewhere) makes the bot say «این سؤال دیگر باز نیست» instead of sending a follow-up.
    if (entry.fromAsks) {
      pendingAsks.delete(String(askId));
      return Boolean(asks?.answer(chatId, { answer: label, selected: text != null ? [] : [label], by: answeredBy, askId }));
    }
    clearAsksForChat(chatId);
    if (runner.isActive(chatId)) await asks?.waitForQuestion?.(chatId, { stillActive: () => runner.isActive(chatId) });
    if (asks?.answer(chatId, { answer: label, selected: text != null ? [] : [label], by: answeredBy })) return true;
    await runner.send(chatId, { text: `پاسخ به سؤالت «${question?.question || ""}»: ${label}`, images: [], intent: runner.isActive(chatId) ? "queue" : "send" });
    return true;
  }

  // The owner typed this himself (so «/compact» from his Telegram works):
  // his account's Saved Messages (only he writes there; telegram-account.mjs calls receive "me" only
  // for his own outgoing message), or a Telegram bot's private chat whose sender is his account's
  // user id. Not a paired chat by itself (a colleague or a group can be paired), not a Bale bot (its
  // user ids are another namespace), not without a connected account to prove the id.
  function ownerWroteIt(integration, externalChat, senderId) {
    if (!integration) return false;
    if (integration.kind === "telegram_account") return externalChat === "me";
    if (integration.kind !== "telegram_bot") return false;
    const owner = accountOwnerId();
    return Boolean(owner) && senderId != null && String(senderId) === owner && String(externalChat) === owner;
  }

  // A held long message that will not be completed (receivePeerAgent): answered with what arrived,
  // each missing part said in its place.
  function flushParts(key) {
    const held = partsHeld.get(key);
    if (!held) return;
    clearTimeout(held.timer);
    partsHeld.delete(key);
    const arrived = held.parts.filter((p) => p != null).length;
    log.info?.(`[integrations] peer-agent ${held.args.userId}: ${arrived} of ${held.total} parts arrived; answering them`);
    const text = Array.from({ length: held.total }, (_, i) => held.parts[i] ?? `[بخش ${i + 1} از ${held.total} نرسید]`).join("\n\n");
    bridge.receivePeerAgent(held.id, held.externalChat, { ...held.args, text, joinedParts: arrived }).catch((error) => log.error?.(`[integrations] peer-agent parts: ${error.message}`));
  }

  const bridge = {
    integration: (id) => store.getIntegration(id),
    // Private-share invites and codes sent to this person (share-sends.mjs): never the owner's line.
    shareSendIds: (peerId) => shareSendIds(store, peerId),
    // Telegram inbox (telegram-inbox.mjs; config TELEGRAM_DM_MODE). True when inbox mode took the
    // DM: the caller hands it to nobody else. The person's history was already written; the
    // person's mother chat (if there is one) gets the message as a note, without a run, so its
    // record stays whole.
    // entityKnown false (the lookup failed): not eligible, fail closed — it may be a bot.
    inboxIncoming: (integrationId, key, { person = null, text = "", message = {}, entityKnown = true } = {}) => {
      if (!inbox) return false;
      const name = person?.display_name || person?.tg_name || String(key);
      const unrouted = () => desk.unwatched(person, name, text);
      const took = inbox.onIncoming({ peerId: String(key), name, isUser: true, isBot: !entityKnown, isSelf: false, unrouted }, message);
      if (took) {
        const mother = motherChatId(store, integrationId, key);
        if (mother) store.appendEvent(mother, null, "note", { text: `📥 ${String(name).slice(0, 60)} (صندوق تلگرام، بدون پاسخ ${PERSONA.name}): ${String(text).slice(0, 1500)}` });
      }
      return took;
    },
    inboxOutgoing: (key, messageId) => inbox?.onOutgoing(key, messageId),
    // settings.teamRoster: display names of colleagues who have not written 1:1 yet (from the
    // the GitOps repo owners/ and the team group). Their first DM marks them «team», so threads
    // work from the first message instead of waiting for someone to classify them by hand.
    upsertPerson: (id, externalId, person = {}) => {
      const saved = store.upsertPerson({ integrationId: id, externalId, ...person });
      const roster = store.getIntegration(id)?.settings?.teamRoster || [];
      // Entries are display names or @usernames.
      const keys = [saved?.tg_name, saved?.display_name, saved?.username && `@${saved.username}`].filter(Boolean).map((k) => String(k).trim().toLowerCase());
      if (saved && saved.category === "unclassified" && roster.some((n) => keys.includes(String(n).trim().toLowerCase()))) {
        return store.updatePerson(saved.id, { category: "team" });
      }
      return saved;
    },
    listPersons: (options) => store.listPersons(options),
    getPerson: (id) => store.getPerson(id),
    listPersonMessages: (id, limit) => store.listPersonMessages(id, limit),
    listPersonChats: (id, archived = false) => store.listChatsForPerson(id, { archived }),
    updatePerson: (id, patch) => store.updatePerson(id, patch),
    addPersonMessage: (personId, message) => store.addPersonMessage({ personId, ...message }),
    saveSettings: (id, settings) => store.updateIntegration(id, { settings }),

    pair(id, externalChat, chat = {}) {
      const current = store.getIntegration(id);
      const pairedChats = [...new Set([...(current.settings.pairedChats || []), String(externalChat)])];
      const names = { ...(current.settings.pairedNames || {}), [String(externalChat)]: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || String(externalChat) };
      store.updateIntegration(id, { settings: { pairedChats, pairedNames: names, pairingCode: null } });
    },

    newChat(id, externalChat) {
      store.linkChat(id, externalChat, null);
    },

    // /chats on the bot (bots.mjs): the owner's own chats as the web lists them («گفتگوهای اخیر»),
    // a tap moves this messenger chat onto one, so what he writes next goes there and its answers
    // come back here (owner 2026-10-25: «لیست چت‌ها رو به بات تلگرام هم اضافه کن که بتونیم از تلگرام
    // چتامون رو ببینیم و پاسخ بدیم»). Only in his proven own chat (db.mjs ownMessengerChat): a group
    // or a Bale bot could hand his chats to someone else's typing.
    chatMenu(id, externalChat, { page = 0, query = "" } = {}) {
      if (!ownBotChat(id, externalChat)) return { text: "فهرست گفتگوها فقط در گفتگوی خصوصی خودتان با ربات باز می‌شود." };
      const q = String(query || "").trim().toLowerCase();
      const all = store.listChatsBySource({ archived: false })
        .filter((c) => c.source === "manual" && (c.caller || "owner") === "owner" && !isGlobalChat(store, c.id))
        .filter((c) => !q || String(c.title || "").toLowerCase().includes(q));
      if (!all.length) return { text: q ? `گفتگویی با «${query}» پیدا نشد.` : "گفتگویی نیست؛ همین‌جا بنویسید تا یکی شروع شود." };
      const size = CHAT_MENU_SIZE;
      const pages = Math.ceil(all.length / size);
      const at = Math.min(Math.max(0, Number(page) || 0), pages - 1);
      const rows = all.slice(at * size, at * size + size);
      const current = store.linkedChat(id, externalChat);
      const pickId = newAskId();
      chatMenus.set(pickId, { id, externalChat: String(externalChat), ids: rows.map((c) => c.id), page: at, query: q, at: Date.now() });
      if (chatMenus.size > 50) chatMenus.delete(chatMenus.keys().next().value);
      const mark = (c) => (c.id === current ? "✔︎ " : asks?.isWaiting?.(c.id) ? "❓ " : runner.isActive(c.id) ? "⏳ " : "");
      const buttons = rows.map((c, index) => ({ index, text: `${mark(c)}${String(c.title || "بی‌نام").replace(/\s+/g, " ").trim()}` }));
      const head = q ? `گفتگوهای «${query}»` : "گفتگوهای اخیر";
      return {
        pickId,
        text: `${head}${pages > 1 ? ` (صفحهٔ ${(at + 1).toLocaleString("fa-IR")} از ${pages.toLocaleString("fa-IR")})` : ""}\nیکی را بزنید؛ پیام‌های بعدی‌تان به همان گفتگو می‌رود و جوابش همین‌جا می‌آید. ⏳ در حال کار · ❓ منتظر جواب شما · /new گفتگوی تازه`,
        buttons,
        more: at + 1 < pages,
        back: at > 0,
      };
    },

    // A tap on that list: this messenger chat now talks to that chat. Returns what to show: the
    // chat's title and its last answer, so he sees where it stands before he replies.
    async pickChat(id, externalChat, pickId, index) {
      const menu = chatMenus.get(String(pickId));
      if (!menu || menu.id !== id || menu.externalChat !== String(externalChat)) return null;
      if (!ownBotChat(id, externalChat)) return null;
      const chatId = menu.ids[Number(index)];
      const chat = chatId ? store.getChat(chatId) : null;
      if (!chat || chat.archived) return null;
      store.linkChat(id, externalChat, chat.id);
      let last = "";
      try {
        const { messages } = timelines ? (await timelines.get(chat.id)).timeline : foldEvents(store.allEvents(chat.id));
        const run = lastRun(messages);
        last = run ? String(deliverable(run).text || "").trim() : "";
      } catch (error) {
        log.error?.(`[integrations] pickChat ${chat.id}: ${error.message}`);
      }
      return {
        title: chat.title || "بی‌نام",
        last: last.length > CHAT_LAST_MAX ? `…${last.slice(-CHAT_LAST_MAX)}` : last,
        running: runner.isActive(chat.id),
        waiting: Boolean(asks?.isWaiting?.(chat.id)),
        url: publicUrl ? `${publicUrl}/#/c/${chat.id}` : null,
      };
    },

    // Another page of the same list (its «بعدی/قبلی» buttons).
    chatMenuPage(id, externalChat, pickId, step) {
      const menu = chatMenus.get(String(pickId));
      if (!menu || menu.id !== id || menu.externalChat !== String(externalChat)) return null;
      return bridge.chatMenu(id, externalChat, { page: menu.page + step, query: menu.query });
    },

    async stop(id, externalChat) {
      const chatId = store.linkedChat(id, externalChat);
      if (!chatId || !runner.isActive(chatId)) return false;
      await runner.cancel(chatId);
      return true;
    },

    // Telegram v2: what happens to a colleague's message is the desk's (desk.mjs); the mother chat.
    desk,
    motherChat,

    coverageName(_id, peer) {
      return personByExternal(peer)?.display_name || null;
    },

    // A legacy (pre-v2) thread is done (end_agent, or closed from the UI): closed for every member.
    // The person's pointer moves to their mother chat with their next message (desk.mjs).
    async closeThread(chatId, { cancel = false } = {}) {
      const members = store.threadMembers(chatId);
      store.closeThread(chatId);
      if (cancel && runner.isActive(chatId)) await runner.cancel(chatId).catch(() => {});
      return members;
    },

    personByExternal,
    // id and Telegram name only, for passes over many dialogs (findPerson parses the whole history).
    personLight: (key) => store.db.prepare("SELECT id, display_name AS tg_name FROM persons WHERE source = 'telegram' AND external_id = ?").get(String(key)) || null,
    // Profile photos (telegram-account.mjs): the stored Telegram photo id, so one photo downloads once.
    personPhotoVersion: (id) => store.personPhoto(id)?.photo_id ?? null,
    setPersonPhoto: (id, photoId, data) => store.setPersonPhoto(id, photoId, data),

    // /model from Telegram (bots.mjs): the models THIS conversation may run on, and the pick that
    // pins the chat's model. Only the owner chooses (a group member's /model shows his own menu at
    // most — a pinned model is never written on someone else's say-so). The list comes from
    // index.mjs modelChoices: usable accounts first, a limited account still listed (its own quota
    // note), exactly the candidates routing would try, in that order — no live engine call here.
    async modelMenu(id, externalChat) {
      const chatId = store.linkedChat(id, externalChat);
      const chat = chatId ? store.getChat(chatId) : null;
      if (!chat) return { text: "این گفتگو هنوز به ایجنت وصل نیست؛ اول یک پیام بفرست." };
      const allowed = (await modelChoices?.(chat)) || [];
      if (!allowed.length) return { text: "مدلی برای این گفتگو فعال نیست." };
      const pickId = newAskId();
      const buttons = allowed.map((choice, index) => ({ ...choice, index })).map((choice) => ({
        index: choice.index,
        text: `${choice.current ? "✔︎ " : ""}${choice.label}`,
      }));
      const lines = allowed.map((choice, i) => `${choice.current ? "✔︎" : i + 1 + "."} ${choice.label}${choice.note ? ` — ${choice.note}` : ""}`).join("\n");
      return {
        pickId,
        text: `مدل فعلی این گفتگو با علامت است. کدام را برای ادامه؟\n\n${lines}\n\nدکمه‌اش را بزن؛ ران جاری با مدل قبلی تمام می‌شود و نوبت بعد با مدل تازه می‌رود.`.trim(),
        buttons,
      };
    },

    // A tap on one of those buttons (bots.mjs parseModelCallback): pins the chat's model. Only the
    // owner's own tap (ownerWroteIt's rule, but a tap: sender is the owner in his own private chat
    // with the bot, or the group's owner id as groupSenderMayAnswer reads it) writes the pin.
    async pickModel(id, externalChat, index, { senderId = null } = {}) {
      const chatId = store.linkedChat(id, externalChat);
      const chat = chatId ? store.getChat(chatId) : null;
      if (!chat) return null;
      const integ = store.getIntegration(id);
      const sender = senderId == null ? "" : String(senderId);
      const privateOwn = String(externalChat) === sender;
      if (!privateOwn && !groupSenderMayAnswer(id, externalChat, senderId, { quiet: true })) return null;
      const allowed = (await modelChoices?.(chat)) || [];
      const choice = allowed[Number(index)];
      if (!choice || !choice.value) return null;
      // The menu's value is `account/model`; the chat stores `account:model` with the account in
      // its provider column, exactly as the web picker (app.mjs PATCH /api/chats/:id) — anything else
      // was refused by the NOT NULL provider and never read back as a pin.
      const slash = String(choice.value).indexOf("/");
      const split = splitModel(choice.value) || (slash > 0 ? { provider: choice.value.slice(0, slash), model: choice.value.slice(slash + 1) } : null);
      if (!split) return null;
      const provider = normalizeProvider(split.provider);
      // A run in flight keeps its model; the pin holds from the next turn. A
      // move to another account drops the session handle, so it waits for the run like the web.
      if (provider !== chat.provider && runner?.isActive?.(chat.id)) return { busy: true };
      store.updateChat(chat.id, { model: `${provider}:${split.model}`, ...(provider !== chat.provider ? { provider } : {}) });
      log.info?.(`[integrations] ${chat.id} model pinned to ${choice.value} from ${integ?.kind || id}`);
      return { value: choice.value, label: choice.label };
    },

    // Saved Messages and the bots: one owner chat per messenger chat.
    // senderId: who wrote it (a bot update's message.from.id); forwarded: it is someone else's
    // message passed on. Only the owner's own words reach the agent live (ownerWroteIt).
    async receive(id, externalChat, { text, images = [], title = null, person = null, senderId = null, forwarded = false } = {}) {
      let chatId = store.linkedChat(id, externalChat);
      const existing = chatId ? store.getChat(chatId) : null;
      const profile = person ? store.upsertPerson({ externalId: externalChat, ...person, data: { platform: "telegram", source: "account" } }) : personByExternal(externalChat);
      if (profile && text) store.addPersonMessage({ personId: profile.id, direction: "in", text, data: { chatId, caller: "owner" } });
      // A disabled profile is the owner's choice about this person; the person is never told so
      // (it used to reach the colleague as «این پروفایل فعلاً دسترسی فعال ندارد.»). Only the owner hears it.
      if (profile?.access?.enabled === false) {
        log.info?.(`[integrations] person ${profile.id} is disabled — not answering`);
        const channel = channels.get(id);
        if (channel?.kind === "telegram_account") {
          await channel.deliver("me", { text: `«${profile.display_name || externalChat}» غیرفعال است؛ ${PERSONA.name} جوابش را نداد. برای فعال کردن: صفحهٔ تلگرام → پروفایل او.` }).catch(() => {});
        }
        return null;
      }
      if (!existing) {
        const integration = store.getIntegration(id);
        const chat = store.createChat({
          title: title || autoTitle(text),
          mode: "agent",
          model: integration.settings.model || null,
          caller: "owner",
          personId: profile?.id || null,
        });
        chatId = chat.id;
        store.linkChat(id, externalChat, chatId);
        // How this chat was born (chat-origin.mjs): the owner's own Saved Messages / bot chat, or
        // someone else's message. Durable: /new later moves the link to another chat.
        markMessengerOrigin(store, chatId, id, externalChat, { forwarded, senderId });
      }
      const ownerText = !forwarded && ownerWroteIt(store.getIntegration(id), externalChat, senderId);
      // The owner himself typed an exact approval word while this chat's plan card is open (config
      // PLAN_APPROVAL): it approves the plan instead of waiting in the queue behind it, as in Karsara.
      if (ownerText && existing && (existing.caller || "owner") === "owner" && !images.length && asks?.approvePlanByText?.(chatId, text)) return { delivered: "tool" };
      try {
        // Someone else's words (a forward, a group member) carry who wrote them on the event, so the
        // trust checks that read events (knowledge-trust.mjs, owner-chat-tools.mjs) see them even in
        // one of his own chats he moved onto with /chats (db.mjs linkChat leaves that chat unmarked).
        const from = ownerText ? null : { kind: "telegram", name: forwarded ? "پیام بازارسال‌شده" : profile?.display_name || title || "تلگرام", ...(!forwarded && profile?.id && !ownMessengerChat(store, id, externalChat) ? { personId: profile.id } : {}) };
        return await runner.send(chatId, { text, images, intent: runner.isActive(chatId) ? "queue" : "send", ownerText, ...(from ? { from } : {}) });
      } catch (error) {
        await channels.get(id)?.deliver(externalChat, { text: `خطا: ${error.message}` });
        return null;
      }
    },

    // Auto-bind a Telegram person to a peer identity so their signed assistant messages get
    // answered (owner 2026-09-22: every assistant-signed message is answered automatically).
    // Derives the id from their Telegram identity, registers the peer user with the default
    // read-only quota when new, and persists the binding on the person profile. Idempotent.
    async bindPeerAgentPerson(person, externalChat) {
      if (!person?.id) return null;
      const userId = derivePeerUserId(person, externalChat);
      if (!userId) return null;
      let created = false;
      if (!store.getPeerUser(userId)) {
        try {
          peerAuth?.createUser?.({ id: userId, label: person.display_name || person.username || userId });
          created = true;
        } catch {
          /* lost a race or invalid id — fall through to the existence check */
        }
      }
      if (!store.getPeerUser(userId)) return null;
      if (person.access?.peerAgent?.user !== userId) {
        store.updatePerson(person.id, { access: { ...(person.access || {}), peerAgent: { user: userId } } });
      }
      return { user: userId, created };
    },

    // A colleague's signed automated assistant: answered by Griffin under that colleague's peer
    // quota, in a chat of its own (a coverage chat on the same Telegram peer is relinked).
    // joinedParts: how many parts a joined request was made of (their history rows are not history).
    async receivePeerAgent(id, externalChat, { text, userId, label, personId = null, joinedParts = 0 } = {}) {
      const caller = `peer:${userId}`;
      label = store.getPeerUser?.(userId)?.label || label;
      // A long message from another assistant arrives as «(بخش i از n)» parts, each signed: held until
      // all are in, then answered once as one request, on one rate token (format.mjs signedParts;
      // Karsara's manager.receivePeerAgent). Each part but the last loses its signature line, so the
      // request reads as one message. Part 1 starts a message (Telegram delivers a chat in order); a
      // part whose place is taken, or a different count, starts one too. Whatever was held then — or
      // ten minutes after its last part — is answered as it is, each missing part said, so a lost part
      // neither swallows the message nor leaks into the next one.
      const part = joinedParts ? null : partOf(text);
      if (part) {
        const key = `${id}:${externalChat}`;
        let held = partsHeld.get(key);
        if (held && (part.index === 1 || held.total !== part.total || held.parts[part.index - 1] != null)) {
          flushParts(key);
          held = null;
        }
        if (!held) held = { id, externalChat, total: part.total, parts: [], args: { userId, label, personId } };
        held.parts[part.index - 1] = part.index < part.total ? part.body.replace(/\n\n—[^\n]*\s*$/u, "") : part.body;
        clearTimeout(held.timer);
        partsHeld.set(key, held);
        const count = held.parts.filter((p) => p != null).length;
        if (count < held.total) {
          held.timer = setTimeout(() => flushParts(key), PARTS_TTL_MS);
          held.timer.unref?.();
          log.info?.(`[integrations] peer-agent ${userId}: part ${part.index} of ${part.total} held`);
          return null;
        }
        partsHeld.delete(key);
        text = held.parts.join("\n\n");
        joinedParts = held.total;
      }
      if (!takeRate(store, `${id}:${externalChat}`)) {
        log.info?.(`[integrations] peer-agent rate limit ${externalChat} (${userId})`);
        return null;
      }
      let chatId = store.linkedChat(id, externalChat);
      const existing = chatId ? store.getChat(chatId) : null;
      if (!existing || existing.caller !== caller) {
        // The same requester already has an open conversation in another channel (an MCP task
        // mid-run, or one waiting on a question): continue THAT instead of opening a second chat
        // (2026-10-12: a colleague's agent wrote in Telegram and a fresh chat opened). Link this Telegram
        // conversation to it so its reply comes back here, and feed the new message in.
        const elsewhere = openWorkFor(store, { caller, person_id: personId, id: chatId || "x" }, { isOpen: (cid) => runner.isActive(cid) || Boolean(asks?.isWaiting?.(cid)) }).filter((o) => o.id !== chatId);
        if (elsewhere.length) {
          const target = elsewhere[0].id;
          store.linkChat(id, externalChat, target);
          try {
            const framed = `[همان درخواست‌کننده «${label}» از مسیر تلگرام — پیام تازه دربارهٔ همین کار]\n\n${text}`;
            return await runner.send(target, { text: framed, images: [], intent: runner.isActive(target) ? "steer" : "send" });
          } catch (error) {
            log.error?.(`[integrations] peer-agent relink ${userId}: ${error.message}`);
          }
        }
        const profile = store.getAgentProfile("griffin");
        if (!profile) return null;
        const chat = store.createChat({
          title: `🤖 ${label}: ${autoTitle(text)}`,
          mode: "agent",
          model: profile.model || null,
          caller,
          agent: "griffin",
          personId,
          provider: normalizeProvider(profile.provider),
        });
        chatId = chat.id;
        store.linkChat(id, externalChat, chatId);
      }
      try {
        // A joined request's own parts are its message, not history (chatHistoryBlock drops the newest).
        const rows = store.listPersonMessages?.(personId, 13 + Math.max(0, joinedParts - 1)) || [];
        const history = personId ? chatHistoryBlock(joinedParts > 1 ? rows.slice(0, -(joinedParts - 1)) : rows, { label }) : "";
        return await runner.send(chatId, { text: peerAgentPrompt({ label, userId, text, history }), images: [], intent: runner.isActive(chatId) ? "queue" : "send" });
      } catch (error) {
        log.error?.(`[integrations] peer-agent ${userId}: ${error.message}`);
        return null;
      }
    },

    // Returns true when the choice matched an open question on the linked chat (or was refused
    // with a word to the sender: either way the digit is not a new message).
    // May this sender answer the questions of this bot chat? (Only the owner, in a group.)
    mayAnswerIn(id, externalChat, senderId) {
      return groupSenderMayAnswer(id, externalChat, senderId, { quiet: true });
    },

    async answer(id, externalChat, index, askId = null, { senderId = null, text = null } = {}) {
      if (!groupSenderMayAnswer(id, externalChat, senderId)) return false;
      if (askId) {
        const pending = pendingAsks.get(String(askId));
        if (!pending || pending.owner) return false;
        return answerChat(pending.chatId, index, { by: "requester", askId: String(askId), text });
      }
      // A bare number carries no ask: it is only an answer when exactly one question of this chat
      // is open (one the sender may answer). With two, «1» used to take the newest question's label
      // and settle the oldest — it could approve the wrong change. Never guess.
      const chatId = store.linkedChat(id, externalChat);
      const answeredBy = answererIn(chatId, "requester");
      const open = chatId ? [...pendingAsks].filter(([, p]) => p.chatId === chatId && (answeredBy === OWNER || !p.owner)) : [];
      if (open.length === 1) return answerChat(chatId, index, { by: "requester", askId: open[0][0] });
      if (!open.length) return false;
      const channel = channels.get(id);
      // Saved Messages has no buttons: there the board answers it.
      const how = channel?.kind === "telegram_account" ? "از «منتظر شما» در صفحهٔ اصلی جواب بدهید" : "دکمهٔ همان سؤال را بزنید";
      await channel?.deliver(externalChat, { text: `چند سؤال باز است؛ ${how}.`, done: false }).catch(() => {});
      return true;
    },

    // Agent called end_agent: close coverage after this run's reply is delivered.
    scheduleEnd(chatId, { integrationId, peer, note = "" } = {}) {
      endAfterRun.set(chatId, { integrationId, peer: String(peer), note: String(note || "") });
    },

    // Owner answers a coverage ask_owner (bot buttons carry askId; bare 1–6 only if one ask is open).
    // Only the owner may answer: anyone else's "1" or tap is not an answer (senderOwns).
    async answerOwnerAsk(id, index, askId = null, { senderId = null, text = null } = {}) {
      if (askId) {
        const pending = pendingAsks.get(String(askId));
        if (!pending?.owner || !senderOwns(pending, id, senderId)) return false;
        return answerChat(pending.chatId, index, { askId: String(askId), text });
      }
      const open = ownerAsksFor(id, senderId);
      if (open.length !== 1) return false;
      return answerChat(open[0][1].chatId, index, { askId: open[0][0] });
    },

    // How many open owner questions this sender could answer here (0 for anyone but the owner).
    ownerAskCountFor(id, senderId) {
      return ownerAsksFor(id, senderId).length;
    },

    openOwnerAskCount() {
      return openOwnerAsks().length;
    },
  };

  // A colleague's request whose run died (cancel / engine error) with nothing sent leaves the
  // colleague waiting and nobody aware: on 2026-10-10 a colleague's request was cancelled after
  // 15 minutes and sat silent for 26 hours. One line to the owner's bot closes that gap.
  async function tellOwnerUnanswered(chat, why) {
    if (!chat) return;
    await notifyOwner(`🔕 «${String(chat.title || "رشتهٔ همکار").slice(0, 80)}» بی‌جواب ماند (${String(why).slice(0, 120)}); به همکار چیزی نرفت.`, chat.id);
  }
  // One line from the bot to the owner, with a link to the chat when there is one.
  async function notifyOwner(text, chatId = null) {
    const bot = preferOwnerBot();
    const ownerId = ownerChatOn(bot);
    if (!bot || !ownerId) return false;
    ensureBotPaired(bot.id, ownerId);
    const link = publicUrl && chatId ? `\n${publicUrl}/#/c/${chatId}` : "";
    // The bot API drops a request now and then («fetch failed»: 4 of 33 ops-room tell_owner calls on
    // 2026-10-20/21); the agent then sent the same news again. One quiet retry covers it.
    try {
      await bot.channel.deliver(ownerId, { text: `${text}${link}` });
    } catch (error) {
      if (!/fetch failed|ECONNRESET|ETIMEDOUT|socket/i.test(String(error?.message || error))) throw error;
      await new Promise((r) => setTimeout(r, 3000));
      await bot.channel.deliver(ownerId, { text: `${text}${link}` });
    }
    return true;
  }

  async function deliverRun(chatId, links, { heading = "" } = {}) {
    // A mother chat never speaks by itself (R1): its final text is a report for the owner, and only
    // send_to_person reaches the colleague (desk.mjs).
    if (motherInfo(store, chatId)) return [];
    const { messages } = timelines ? (await timelines.get(chatId)).timeline : foldEvents(store.allEvents(chatId));
    const run = lastRun(messages); // a run split by an owner message mid-run, whole
    if (!run) return [];
    const out = deliverable(run);
    // The model sometimes wraps its whole reply in [ … ] (mimicking the [NO_REPLY] sentinel);
    // 2026-10-06 one reached a colleague that way.
    out.text = unwrapBrackets(out.text);
    // Per install (TELEGRAM_FILES, config.mjs): off = messengers get the answer's text only, as in
    // Karsara (a job's screenshot or an internal file must not land in a group unannounced). On (default) keeps Griffin's behaviour: files and charts are sent too.
    if (!sendFiles()) {
      // An answer that was only a file or a chart says so, instead of «(جوابی نیامد)».
      const kept = out.files.length + out.charts.length;
      if (kept && !String(out.text || "").trim()) out.text = `📎 ${kept.toLocaleString("fa-IR")} فایل در ${PERSONA.name} ماند`;
      out.files = [];
      out.charts = [];
    }
    if (out.status === "finished" && isNoReply(out.text) && !out.files.length && !out.charts.length) {
      for (const link of links) channels.get(link.integration_id)?.deliver(link.external_chat, { clearStatus: true, done: !pendingWork(chatId) }).catch(() => {});
      return [];
    }
    const chat = store.getChat(chatId);
    const toOwner = chat?.caller === OWNER;
    // A run woken by a subtask report that ends with subtasks still running has only "still working"
    // to say — the colleague already heard that once (one colleague got four such lines).
    const trigger = messages.findLast((m) => m.role === "user")?.text || "";
    // Same for a peer agent's chat (2026-10-06: «handed it to the specialist…» lines reached a colleague's bot).
    const toColleague = chat?.caller === COVERAGE_CALLER || String(chat?.caller || "").startsWith("peer:");
    // And a run woken by the owner's note from the web UI (status lines written for the owner
    // once reached the colleague).
    const internalWake = trigger.startsWith("[گزارش خودکار زیرکارها") || isOwnerNote(trigger);
    if (toColleague && internalWake && pendingWork(chatId) > 0 && !out.files.length && !out.charts.length) {
      for (const link of links) channels.get(link.integration_id)?.deliver(link.external_chat, { clearStatus: true }).catch(() => {});
      return [];
    }
    // A colleague must never receive an engine error in the owner's name (2026-09-23: a raw Cursor
    // "usage limit" reached a colleague). The owner sees it in the chat; the colleague gets nothing.
    if (out.status === "error" && !toOwner && !out.text && !out.files.length && !out.charts.length) {
      for (const link of links) channels.get(link.integration_id)?.deliver(link.external_chat, { clearStatus: true }).catch(() => {});
      tellOwnerUnanswered(chat, out.error || "خطای موتور").catch(() => {});
      return [];
    }
    // A cancelled run is the owner's call (takeover, a stale question); the colleague gets nothing,
    // not "⏹ stopped" or a half-written reply (2026-10-06: «⏹ متوقف شد» reached a colleague's bot).
    if (out.status === "cancelled" && !toOwner) {
      for (const link of links) channels.get(link.integration_id)?.deliver(link.external_chat, { clearStatus: true }).catch(() => {});
      tellOwnerUnanswered(chat, "لغو شد").catch(() => {});
      return [];
    }
    let text = out.text;
    // Sent as the owner to a colleague: no emoji (the owner's voice), enforced here, not asked for.
    if (chat?.caller === COVERAGE_CALLER) text = text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/[ \t]+\n/g, "\n").trim();
    if (out.status === "error" && toOwner) text = `${text ? `${text}\n\n` : ""}⚠️ خطا: ${out.error || "کار ناتمام ماند"}`;
    if (out.status === "cancelled") {
      const note = out.error || "متوقف شد";
      text = text ? `${text}\n\n⏹ ${note}` : `⏹ ${note}`;
    }
    if (heading) text = `${heading}\n\n${text}`;
    // Only on the owner's own answers: a stamp under a message sent to a colleague in the owner's
    // name would read as a bot (and Telegram shows the time there anyway).
    if (toOwner) {
      const stamp = answerStamp(run);
      if (stamp) text = text ? `${text}\n\n${stamp}` : stamp;
    }
    const files = out.files
      .map((f) => ({ ...f, media: store.getMedia(f.mediaId) }))
      .filter((f) => f.media)
      .map((f) => ({ name: f.name, caption: f.caption, mimeType: f.media.mime_type, data: Buffer.from(f.media.data) }));
    // Charts are rendered to PNG and sent as images, not just linked.
    for (const chart of out.charts) {
      try {
        const media = await chartMedia(store, store.getChart(chart.chartId));
        files.push({ name: `${(chart.title || "chart").slice(0, 40)}.png`, caption: chart.title || null, mimeType: "image/png", data: Buffer.from(media.data) });
      } catch (error) {
        log.error?.(`[integrations] chart ${chart.chartId}: ${error.message}`);
        if (publicUrl) text += `\n\n📊 ${chart.title || "نمودار"}: ${publicUrl}/#/c/${chatId}`;
      }
    }
    const results = [];
    for (const link of links) {
      const person = store.listPersons({ source: "telegram" }).find((p) => p.external_id === String(link.external_chat));
      if (person && text) store.addPersonMessage({ personId: person.id, direction: "out", text, data: { chatId } });
      const channel = channels.get(link.integration_id);
      if (!channel) {
        results.push({ integrationId: link.integration_id, chat: link.external_chat, ok: false, error: "اتصال فعال نیست" });
        continue;
      }
      try {
        await channel.deliver(link.external_chat, { text: text || "(جوابی نیامد)", files, done: !pendingWork(chatId) });
        results.push({ integrationId: link.integration_id, chat: link.external_chat, ok: true });
      } catch (error) {
        log.error?.(`[integrations] deliver ${link.integration_id}: ${error.message}`);
        results.push({ integrationId: link.integration_id, chat: link.external_chat, ok: false, error: error.message });
      }
    }
    return results;
  }

  // Owner-rooted ask_owner in a chat with no messenger link (i.e. the web UI): mirror the question
  // to the Owner's Telegram so approval reaches them even when no browser tab is open. Answering in
  // either place settles the one run (asks settles once by chatId).
  function deliverOwnerAsk(chatId, question, { from = "", sourceChatId = chatId } = {}) {
    // A link to the chat that asked: the owner decides with the whole context one tap away,
    // not from a two-line summary.
    const base = String(publicUrl || "").replace(/\/$/, "");
    const link = base ? `🔗 ${base}/#/c/${sourceChatId}` : "";
    const tagged = registerAsk(
      chatId,
      { ...question, question: [from, question.question, link].filter(Boolean).join("\n\n") },
      { owner: true },
    );
    const bot = preferOwnerBot();
    const ownerId = ownerChatOn(bot);
    const account = [...channels.entries()].find(([, ch]) => ch.kind === "telegram_account");
    const fail = (where) => (error) => log.error?.(`[integrations] owner-ask ${where}: ${error.message}`);
    if (bot && ownerId) {
      ensureBotPaired(bot.id, ownerId);
      markOwnerTarget(tagged.askId, bot.id, ownerId);
      bot.channel
        .deliver(ownerId, { question: tagged })
        .then((sent) => recordAskDelivery(chatId, bot.id, ownerId, sent, tagged))
        .catch(fail("bot"));
    } else if (account) {
      markOwnerTarget(tagged.askId, account[0], "me");
      account[1]
        .deliver("me", { question: tagged })
        .then((sent) => recordAskDelivery(chatId, account[0], "me", sent, tagged))
        .catch(fail("account"));
    } else {
      log.error?.("[integrations] owner-ask: no telegram channel to reach Owner");
    }
  }

  const onEvent = (chatId, event) => {
    if (!channels.size) return;
    const chat = store.getChat(chatId);
    const question = questionFromEvent(event);
    const links = store.linksForChat(chatId).filter((l) => channels.has(l.integration_id));
    if (question) {
      // An approval from a job the owner wrote (jobs/owner-jobs.mjs) does reach him: asks.mjs
      // lets only those out of a job chain, so an ask.pending here is one of them.
      if (unattendedChat(chat) && !(chat.job_id && ownerJobApprovals(chatId))) return;
      const toLinks = () => {
        const tagged = registerAsk(chatId, question, { owner: false });
        for (const link of links) {
          const channel = channels.get(link.integration_id);
          const fail = (error) => log.error?.(`[integrations] ask deliver: ${error.message}`);
          channel.deliver(link.external_chat, { clearStatus: true }).catch(fail);
          channel
            .deliver(link.external_chat, { question: tagged })
            .then((sent) => recordAskDelivery(chatId, link.integration_id, link.external_chat, sent, tagged))
            .catch(fail);
        }
      };
      // A question for whoever asked goes back where they asked (a colleague's Telegram chat);
      // over /mcp there is no link and peer-tasks surfaces it as input-required. A mother chat
      // never speaks to the colleague except by send_to_person (R1): its threads' questions go to
      // the owner like any other.
      if (question.audience === REQUESTER && !motherInfo(store, chatId)) {
        if (links.length) toLinks();
        return;
      }
      // The owner's own messenger chat: the question belongs right there.
      if (chat?.caller === OWNER && links.length) {
        toLinks();
        return;
      }
      // Team coverage: ask_owner → Owner's Telegram bot (clear), never to the teammate.
      if (chat?.caller === COVERAGE_CALLER && links.length) {
          const peerName = (() => {
            for (const link of links) {
              const n = bridge.coverageName(link.integration_id, link.external_chat);
              if (n) return n;
            }
            return "همکار";
          })();
          const tagged = registerAsk(chatId, {
            ...question,
            question: `از گفتگو با «${peerName}»:\n\n${question.question}`,
          }, { owner: true });
          const fail = (where) => (error) => log.error?.(`[integrations] ask_owner ${where}: ${error.message}`);
  
          // Nothing to the colleague: every ask used to post "یه لحظه، چک می‌کنم…" + an Owner-approval
          // status line into their PV, from Owner's own account (2026-09-24: 3 asks → 6 messages).
  
          const bot = preferOwnerBot();
          const ownerId = ownerChatOn(bot);
          const account = [...channels.entries()].find(([, ch]) => ch.kind === "telegram_account");
  
          if (bot && ownerId) {
            ensureBotPaired(bot.id, ownerId);
            markOwnerTarget(tagged.askId, bot.id, ownerId);
            bot.channel
              .deliver(ownerId, { question: tagged })
              .then((sent) => recordAskDelivery(chatId, bot.id, ownerId, sent, tagged))
              .catch(fail("bot-question"));
          } else if (account) {
            // Fallback only if no bot: Saved Messages (legacy).
            account[1].deliver("me", {
              text: `سؤال از /agent با «${peerName}» — گزینه‌ها در پیام بعد؛ عدد بفرست.`,
            }).catch(fail("me-alert"));
            markOwnerTarget(tagged.askId, account[0], "me");
            account[1]
              .deliver("me", { question: tagged })
              .then((sent) => recordAskDelivery(chatId, account[0], "me", sent, tagged))
              .catch(fail("me-question"));
          } else {
            log.error?.("[integrations] ask_owner: no bot or telegram account to reach Owner");
          }
        return;
      }
      // Everything else for the owner — a colleague's agent, a peer over /mcp, the web UI — goes to
      // the owner's Telegram, never into the colleague's chat.
      deliverOwnerAsk(chatId, question, { from: requesterLine(chat), sourceChatId: event.data?.fromChatId || chatId });
      return;
    }
    // One status line in the messenger chat, edited to whatever the work is doing now and deleted
    // when the final answer goes out (owner 2026-10-07). It follows the work down the delegation
    // tree: a subtask's steps show in the root chat's line — the /agent run itself ends in a minute
    // and the delegated work runs ~20 more. A colleague's agent (peer:*) gets none: it would read
    // the line as a message to answer. Nor does a mother chat: only send_to_person speaks there (R5).
    const rootId = links.length ? chatId : store.rootChatId?.(chatId) || chatId;
    const statusLinks = rootId === chatId ? links : store.linksForChat(rootId).filter((l) => channels.has(l.integration_id));
    const rootCaller = String((rootId === chatId ? chat : store.getChat(rootId))?.caller || "");
    const line = statusLinks.length && !rootCaller.startsWith("peer:") && !motherInfo(store, rootId) ? liveStatusLine(event) : null;
    if (line && event.type !== "run.finished") {
      const now = Date.now();
      const prev = lastStatusAt.get(rootId) || 0;
      // Always push run.started / ask_owner wait; debounce rapid tool hops (Telegram edit limits).
      const urgent = event.type === "run.started" || event.data?.name === "ask_owner";
      if (urgent || now - prev > 2000) {
        lastStatusAt.set(rootId, now);
        for (const link of statusLinks) {
          channels.get(link.integration_id).deliver(link.external_chat, { status: line }).catch(() => {});
        }
      }
    }
    if (!links.length) return;

    if (event.type === "run.finished") {
      lastStatusAt.delete(chatId);
      deliverRun(chatId, links)
        .then(async () => {
          const pending = endAfterRun.get(chatId);
          if (!pending) return;
          endAfterRun.delete(chatId);
          const members = await bridge.closeThread(chatId);
          if (!members.length) return;
          const channel = channels.get(pending.integrationId);
          const note = pending.note ? ` — ${pending.note}` : "";
          const who = members.map((m) => m.display_name).filter(Boolean).join("، ") || bridge.coverageName(pending.integrationId, pending.peer) || pending.peer;
          await channel?.deliver("me", { text: `رشتهٔ «${store.getChat(chatId)?.title || who}» با «${who}» تمام شد${note}` }).catch(() => {});
        })
        .catch((error) => log.error?.(`[integrations] ${error.message}`));
    }
  };
  store.bus.on("event", onEvent);

  const accountAlerted = new Map(); // integration id -> lastError already reported
  async function watchAccounts() {
    for (const [id, channel] of channels) {
      if (channel.kind !== "telegram_account") continue;
      const { state, lastError } = channel.status || {};
      if (state !== "error") {
        accountAlerted.delete(id);
        continue;
      }
      if (accountAlerted.get(id) === lastError) continue;
      const bot = preferOwnerBot();
      const ownerId = ownerChatOn(bot);
      if (!bot || !ownerId) continue;
      ensureBotPaired(bot.id, ownerId);
      await bot.channel.deliver(ownerId, {
        text: `⚠️ اکانت تلگرامِ ${PERSONA.name} قطع است و هیچ پیامی از همکارها به ${PERSONA.name} نمی‌رسد.\nخطا: ${String(lastError || "نامعلوم").slice(0, 200)}\n` +
          (/AUTH_KEY_DUPLICATED|AUTH_KEY_UNREGISTERED|SESSION_REVOKED/.test(String(lastError))
            ? "سشن باطل شده؛ باید دوباره وارد شوی: تنظیمات → اتصال‌ها."
            : "تنظیمات → اتصال‌ها را ببین."),
      });
      accountAlerted.set(id, lastError);
    }
  }

  function startChannel(integration) {
    stopChannel(integration.id);
    if (!integration.enabled) return;
    const factory = factories[integration.kind];
    if (!factory) return;
    const channel = factory(integration, bridge);
    channels.set(integration.id, channel);
    Promise.resolve(channel.start()).catch((error) => {
      channel.status.state = "error";
      channel.status.lastError = error.message;
    });
  }

  function stopChannel(id) {
    channels.get(id)?.stop();
    channels.delete(id);
  }

  function view(integration) {
    const channel = channels.get(integration.id);
    const { pairedChats = [], pairedNames = {}, pairingCode: code = null, username = null, ...rest } = integration.settings;
    return {
      id: integration.id,
      kind: integration.kind,
      name: integration.name,
      enabled: integration.enabled,
      createdAt: integration.created_at,
      username: channel?.status.username || username,
      pairingCode: code,
      paired: pairedChats.map((c) => ({ id: c, name: pairedNames[c] || c })),
      status: channel ? { ...channel.status } : { state: integration.enabled ? "stopped" : "disabled" },
      secretHint: integration.kind in BOT_KINDS && integration.secret ? `…${String(integration.secret).slice(-4)}` : null,
      settings: rest,
    };
  }

  return {
    store,
    runner,
    bridge,
    desk,
    notifyOwner,
    channels,
    // Called (via asks.mjs's onSettled hook) the moment a question stops being open — deletes
    // the mirrored Telegram message so only open questions stay visible there.
    clearQuestion,
    login: login || createAccountLogin({ proxy: telegramProxy }),
    // The host's default Telegram client app ({apiId, apiHash} or null); see telegram-app.mjs.
    telegramApp,
    kinds: { ...Object.fromEntries(Object.entries(BOT_KINDS).map(([k, v]) => [k, v.label])), telegram_account: "اکانت تلگرام" },

    startAll() {
      for (const integration of store.listIntegrations()) startChannel(integration);
      // A dead account is silent by nature: every colleague goes unanswered and nothing says so
      // (a session killed with AUTH_KEY_DUPLICATED went unnoticed for hours while colleagues got
      // no reply). The bot is a separate path, so it tells the owner.
      setInterval(() => watchAccounts().catch((error) => log.error?.(`[integrations] account watch: ${error.message}`)), 60_000).unref?.();
      // Questions delivered before this restart have no run behind them any more.
      setTimeout(() => sweepStaleAsks().catch(() => {}), 5_000).unref?.();
      desk.start();
    },

    sweepStaleAsks,

    list: () => store.listIntegrations().map(view),

    async addBot({ kind, name, token }) {
      if (!BOT_KINDS[kind]) throw new Error("unknown kind");
      const me = await createBotApi({ kind, token, fetchImpl, apiBase: telegramBotApi }).getMe(); // rejects a wrong token before saving
      const integration = store.createIntegration({ kind, name: name || me.first_name || BOT_KINDS[kind].label, secret: token, settings: { username: me.username || null, pairingCode: pairingCode(), pairedChats: [] } });
      startChannel(integration);
      return view(store.getIntegration(integration.id));
    },

    add(kind, { name, secret, settings }) {
      const integration = store.createIntegration({ kind, name, secret, settings });
      startChannel(integration);
      return view(store.getIntegration(integration.id));
    },

    find: (id) => store.getIntegration(id),
    // The newest Telegram account integration of this Telegram user, if one is here already.
    accountFor: (meId) =>
      store.listIntegrations().filter((i) => i.kind === "telegram_account" && String(i.settings?.me?.id || "") === String(meId)).at(-1) || null,

    // A fresh session for an existing Telegram account integration; links and settings stay
    // (Karsara). Two integrations of one user would run one account twice (AUTH_KEY_DUPLICATED).
    relogin(id, { secret, me }) {
      const next = store.updateIntegration(id, { secret, enabled: true, settings: { me, username: me.username } });
      startChannel(next);
      return view(next);
    },

    update(id, patch) {
      const integration = store.getIntegration(id);
      if (!integration) return null;
      const settings = {
        ...(patch.newPairingCode ? { pairingCode: pairingCode() } : {}),
        ...(typeof patch.unpair === "string" ? { pairedChats: (integration.settings.pairedChats || []).filter((c) => c !== patch.unpair) } : {}),
        // Switched off by the owner = nothing that arrived meanwhile is answered later: the
        // account's catch-up starts at the moment it is switched back on (2026-10-12, after the
        // repo-wipe pause — replaying a night of colleagues' DMs hours late is worse than silence).
        ...(patch.enabled === true && !integration.enabled ? { catchUpFloor: Date.now() } : {}),
      };
      const next = store.updateIntegration(id, {
        ...(typeof patch.name === "string" && patch.name.trim() ? { name: patch.name.trim().slice(0, 60) } : {}),
        ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(Object.keys(settings).length ? { settings } : {}),
      });
      if (typeof patch.enabled === "boolean") startChannel(next);
      return view(next);
    },

    remove(id) {
      stopChannel(id);
      return store.deleteIntegration(id) > 0;
    },

    get: (id) => channels.get(id),

    async handleBotWebhook(id, update, secretHeader = "") {
      const channel = channels.get(id);
      const integ = store.getIntegration(id);
      if (!channel?.handleUpdate || !integ || !(integ.kind in BOT_KINDS)) return { ok: false, status: 404 };
      const expected = botWebhookSecret(id);
      if (expected && !sameSecret(secretHeader, expected)) return { ok: false, status: 401 };
      // A failing update is logged and still acknowledged: a 5xx makes Telegram resend that same
      // update and hold every later message of the bot behind it.
      await channel.handleUpdate(update).catch((error) => log.error?.(`[${integ.kind}] update: ${error.stack || error.message}`));
      return { ok: true, status: 200 };
    },

    // Messenger chats a job can be delivered to: every paired chat of every connected integration.
    targets() {
      return store.listIntegrations().flatMap((integration) => {
        const { pairedChats = [], pairedNames = {} } = integration.settings;
        return pairedChats.map((chat) => ({
          integrationId: integration.id,
          integrationName: integration.name,
          kind: integration.kind,
          chat: String(chat),
          name: pairedNames[chat] || String(chat),
          enabled: integration.enabled,
        }));
      });
    },

    // Delivery for something other than an incoming message (jobs). Targets are explicit, so a job
    // never hijacks the link a messenger chat already has with a normal conversation.
    deliverChat(chatId, targets, { job = null, status = null } = {}) {
      const links = (targets || []).map((t) => ({ integration_id: t.integrationId, external_chat: t.chat }));
      const heading = job ? `🕒 ${job.name}${status && status !== "finished" ? " (ناتمام)" : ""}` : "";
      return deliverRun(chatId, links, { heading });
    },

    // gramjs client of the first connected Telegram account, for the agent tools.
    accountClient: () => runningAccount(channels.values())?.client || null,

    // Name and photo of that same account, for the foot of the sidebar (profile.mjs).
    accountProfile: () => accountProfileOf(channels.values()),

    markAccountSent(id) {
      for (const channel of channels.values()) if (channel.kind === "telegram_account") channel.markSent?.(id);
    },

    // Another session wrote to a colleague from the owner's account (/api/telegram/send): the
    // owner is in that conversation (R2/R3), like his own hand-typed line.
    // from: { chatId, title } when one of this install's own chats sent it (telegram_send).
    ownerWrote(peer, text, from = null) {
      const id = accountEntry()?.[0];
      if (id && peer) desk.ownerLine(id, String(peer), { text: String(text || ""), by: "session", from });
    },

    // One of the owner's own chats wrote to a colleague (telegram_send): one more thread their reply may belong to.
    askedBy(peer, chatId, text = "") {
      const id = accountEntry()?.[0];
      if (id && peer && chatId) desk.askedBy(id, String(peer), chatId, text);
    },

    // A session took a colleague's issue over without writing to them (POST …/persons/:id/session-note).
    sessionNote(personId, text) {
      const id = accountEntry()?.[0];
      const person = store.getPerson(personId);
      if (!id || !person) return false;
      desk.ownerLine(id, String(person.external_id), { text: String(text || ""), by: "session", person, sent: false, claim: true });
      return true;
    },

    stopAll() {
      for (const held of partsHeld.values()) clearTimeout(held.timer);
      partsHeld.clear();
      for (const id of [...channels.keys()]) stopChannel(id);
      store.bus.off("event", onEvent);
      desk.stop();
    },
  };
}

// The first connected Telegram account: its client goes to the agent tools, its profile to the sidebar.
function runningAccount(channels) {
  for (const channel of channels) if (channel.kind === "telegram_account" && channel.client && channel.status.state === "polling") return channel;
  return null;
}

export async function accountProfileOf(channels) {
  return (await runningAccount(channels)?.profileReady?.()) || null;
}

// Tools that stop and wait for the owner, as a question a messenger can show.
export function questionFromEvent(event) {
  if (event.type !== "ask.pending") return null;
  const { question, options, multiSelect, audience, askId } = event.data || {};
  return question ? { question, options, multiSelect, audience: audience === REQUESTER ? REQUESTER : OWNER, ...(askId ? { askId } : {}) } : null;
}

// fillNames(ids): fa-names.mjs for those persons, in the background (index.mjs).
export function integrationRoutes(app, integrations, { fillNames = null } = {}) {
  // Telegram posts here without a session cookie (public). Secret token is checked in the handler.
  app.post("/api/public/integrations/:id/webhook", async (c) => {
    const update = await c.req.json().catch(() => null);
    if (!update) return c.json({ ok: false }, 400);
    const result = await integrations.handleBotWebhook(c.req.param("id"), update, c.req.header("x-telegram-bot-api-secret-token") || "");
    return c.json({ ok: result.ok }, result.status);
  });
  app.get("/api/integrations", (c) => c.json({ integrations: integrations.list(), kinds: integrations.kinds }));
  // The list carries no message history: with it the response was ~8MB for 70 people and the
  // Telegram page came up empty behind the CDN (2026-09-24). History has its own endpoint.
  app.get("/api/telegram/persons", (c) => c.json({
    persons: integrations.bridge.listPersons({ query: c.req.query("q") || "", category: c.req.query("category") || null })
      .map(({ history, history_json, access_json, meta_json, ...person }) => person),
  }));
  // A person's Telegram profile photo. Only the current version's address is served (like the owner's
  // photo in profile.mjs), so a changed picture never sits in the browser cache under a stale address.
  app.get("/api/telegram/persons/:id/photo", (c) => {
    const row = integrations.store.personPhoto(c.req.param("id"));
    if (!row?.data || c.req.query("v") !== row.photo_id) return c.json({ error: "not found" }, 404);
    return c.body(row.data, 200, {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
  });
  app.get("/api/telegram/persons/:id/messages", (c) => c.json({ messages: integrations.bridge.listPersonMessages(c.req.param("id"), Math.min(Number(c.req.query("limit") || 200), 500)) }));
  app.get("/api/telegram/persons/:id/chats", (c) => {
    const chats = integrations.bridge.listPersonChats(c.req.param("id"), c.req.query("archived") === "1").map((chat) => ({
      id: chat.id,
      title: chat.title,
      runStatus: chat.run_status || null,
      updatedAt: chat.updated_at,
    }));
    return c.json({ chats });
  });
  // Telegram v2 (desk.mjs): who is watched and how each conversation stands — no message history.
  app.get("/api/telegram/people", (c) => c.json({ people: integrations.desk.people() }));
  // The global chat, what waits for the owner, and the open threads.
  app.get("/api/telegram/feed", (c) => c.json(integrations.desk.feed()));
  app.post("/api/telegram/global", (c) => c.json({ chatId: ensureGlobal(integrations.store) }));
  app.post("/api/telegram/pause", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json({ paused: integrations.desk.setPaused(body.paused === true) });
  });
  app.post("/api/telegram/waiting/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await integrations.desk.act(c.req.param("id"), body.action);
    return result.error ? c.json({ error: result.error }, result.status || 400) : c.json({ ok: true });
  });
  // The owner's Claude Code session, on every prompt (a UserPromptSubmit hook): colleagues it names
  // are told to the assistant; it gets back what the assistant is doing now, for its context.
  app.post("/api/sessions/activity", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(integrations.desk.sessionActivity({ session: String(body.session || ""), text: String(body.text || "") }));
  });
  // A Claude session tells one of the assistant's chats (a chat id from its context) that it is on that work.
  app.post("/api/sessions/note", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const text = String(body.text || "").trim();
    if (!text || !body.chatId) return c.json({ error: "chatId و text لازم است" }, 400);
    return (await integrations.desk.sessionNoteChat(String(body.chatId), text.slice(0, 2000))) ? c.json({ ok: true }) : c.json({ error: "چت پیدا نشد" }, 404);
  });
  // A Claude session took this colleague's issue: the assistant hears it now and steps back or keeps a part.
  app.post("/api/telegram/persons/:id/session-note", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const text = String(body.text || "").trim();
    if (!text) return c.json({ error: "text لازم است" }, 400);
    return integrations.sessionNote(c.req.param("id"), text.slice(0, 2000)) ? c.json({ ok: true }) : c.json({ error: "پیدا نشد یا اکانت وصل نیست" }, 404);
  });
  // A person's mother chat. Only for a watched person: the watcher is what makes one.
  app.post("/api/telegram/persons/:id/mother", async (c) => {
    const { store } = integrations;
    const person = store.getPerson(c.req.param("id"));
    if (!person) return c.json({ error: "پیدا نشد" }, 404);
    if (!watching(person)) return c.json({ error: "واچر این شخص خاموش است" }, 409);
    const chatId = await integrations.desk.setWatch(person.id, true);
    return chatId ? c.json({ chatId }) : c.json({ error: "اکانت تلگرام وصل نیست" }, 404);
  });
  app.get("/api/telegram/persons/:id/threads", (c) => c.json({
    threads: integrations.store.threadsForPerson(c.req.param("id")).map((t) => ({
      id: t.id, title: t.title, updatedAt: t.updated_at, runStatus: t.run_status || null, closed: t.closed,
      members: t.members.map((m) => ({ personId: m.person_id, name: m.display_name || m.external_chat, closed: Boolean(m.closed_at) })),
    })),
  }));
  app.post("/api/telegram/threads/:id/join", async (c) => {
    const { store, runner } = integrations;
    const body = await c.req.json().catch(() => ({}));
    const person = store.getPerson(String(body.person || ""));
    if (!person) return c.json({ error: "شخص پیدا نشد" }, 404);
    if (!watching(person)) return c.json({ error: "واچر این شخص خاموش است" }, 409);
    const chatId = await integrations.desk.setWatch(person.id, true);
    const result = await joinThread(store, runner, { thread: c.req.param("id"), chatId, name: person.display_name });
    return result.error ? c.json({ error: result.error }, 404) : c.json({ ok: true });
  });
  // A thread is closed: a v2 thread (a mother's delegated subtask) stops and owes no report; a legacy
  // thread closes for its members and is archived, so it is not listed as open again.
  app.post("/api/telegram/threads/:id/close", async (c) => {
    const { store, runner } = integrations;
    const id = c.req.param("id");
    const delegate = store.getKv(`delegate:${id}`);
    if (delegate && ["running", "done"].includes(delegate.state)) {
      store.setKv(`delegate:${id}`, { ...delegate, state: "reported", status: "cancelled" });
      if (runner.isActive(id)) await runner.cancel(id).catch(() => {});
    }
    await integrations.bridge.closeThread(id, { cancel: true });
    if (delegate?.parent) integrations.desk.threadClosed(delegate.parent);
    const chat = store.getChat(id);
    if (!delegate && chat && !chat.archived && !motherInfo(store, id) && !isGlobalChat(store, id)) store.updateChat(id, { archived: true });
    return c.json({ ok: true });
  });
  app.patch("/api/telegram/persons/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const patch = {};
    // The Persian name; an empty one hands it back to the automatic one (fa-names.mjs).
    if (typeof body.name === "string") patch.name = body.name.trim().slice(0, 120);
    if (typeof body.category === "string") patch.category = body.category.trim().slice(0, 60) || "unclassified";
    if (body.access && typeof body.access === "object" && !Array.isArray(body.access)) {
      const access = { ...body.access };
      if ("watch" in access && typeof access.watch !== "boolean") delete access.watch;
      if ("pickupEvery" in access) access.pickupEvery = Math.min(Math.max(Math.round(Number(access.pickupEvery) || 0), 0), 24 * 60);
      if (access.agent !== undefined) {
        const agent = resolveAgentId(access.agent);
        const profile = integrations.store?.getAgentProfile?.(agent) || null;
        if (!profile) return c.json({ error: `ایجنت «${access.agent}» را نمی‌شناسم` }, 400);
        if (!profile.meta?.callers?.team) {
          return c.json({ error: `ایجنت «${profile.label}» برای پوشش تلگرام سهمیه ندارد` }, 400);
        }
        access.agent = agent;
      }
      patch.access = access;
    }
    const before = integrations.store.getPerson(c.req.param("id"));
    const updated = integrations.bridge.updatePerson(c.req.param("id"), patch);
    if (!updated) return c.json({ error: "پیدا نشد" }, 404);
    if ("name" in patch) syncMotherNames(integrations.store);
    // Handed back to automatic: its Persian name now, not at the next half-hour pass.
    if ("name" in patch && !updated.fa_name) fillNames?.([updated.id]);
    // Watcher on makes the mother chat; off stops its run (desk.mjs). Only a real change is a watcher
    // decision: the page sends the whole access object, so changing the pickup time also carries watch.
    const changed = typeof patch.access?.watch === "boolean" && patch.access.watch !== watching(before);
    const chatId = typeof patch.access?.watch === "boolean" ? await integrations.desk.setWatch(updated.id, patch.access.watch, { decided: changed }) : null;
    const { history, history_json, ...person } = integrations.store.getPerson(updated.id);
    return c.json({ person, chatId: chatId || null });
  });
  app.post("/api/integrations", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!BOT_KINDS[body.kind]) return c.json({ error: "kind must be telegram_bot or bale_bot" }, 400);
    const token = String(body.token || "").trim();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) return c.json({ error: "توکن ربات معتبر نیست (مثل 123456:ABC…)" }, 400);
    try {
      return c.json({ integration: await integrations.addBot({ kind: body.kind, name: body.name, token }) }, 201);
    } catch (error) {
      return c.json({ error: `ربات جواب نداد: ${error.message}` }, 400);
    }
  });
  app.patch("/api/integrations/:id", async (c) => {
    const updated = integrations.update(c.req.param("id"), await c.req.json().catch(() => ({})));
    return updated ? c.json({ integration: updated }) : c.json({ error: "not found" }, 404);
  });
  // Whether this server has a default Telegram app, so the form can ask for the phone only. The ids
  // themselves never reach the browser.
  app.get("/api/integrations/telegram-account/app", (c) => c.json({ preset: Boolean(integrations.telegramApp?.()) }));
  // Telegram account login: the owner types phone, code and (if set) 2FA password in the UI. api_id
  // and api_hash come from the form when typed there, else from the server's default app.
  app.post("/api/integrations/telegram-account/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const typed = body.apiId || body.apiHash;
    const { apiId, apiHash } = typed ? body : integrations.telegramApp?.() || {};
    const phone = normalizePhone(body.phone);
    if (!/^\+?\d{8,15}$/.test(phone)) return c.json({ error: "شماره درست نیست؛ با کد کشور بنویس، مثل ‎+98912…" }, 400);
    if (!validTelegramApp(apiId, apiHash)) return c.json({ error: "api_id و api_hash (از my.telegram.org) لازم است" }, 400);
    try {
      return c.json(await integrations.login.start({ apiId: String(apiId), apiHash: String(apiHash), phone }));
    } catch (error) {
      return c.json({ error: error.errorMessage || error.message }, 400);
    }
  });
  app.post("/api/integrations/telegram-account/login/:loginId", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const step = body.password !== undefined
        ? await integrations.login.password(c.req.param("loginId"), body.password)
        : await integrations.login.code(c.req.param("loginId"), body.code);
      if (step.needPassword) return c.json({ needPassword: true, hint: step.hint || null });
      // Reconnecting a revoked account: the same Telegram user's new session goes into the same
      // integration (named by `replace`, else found by user id), so chat links, paired chats and job
      // deliveries stay. Anyone else is a new one.
      const named = body.replace ? integrations.find?.(String(body.replace)) : null;
      const old = named || integrations.accountFor?.(step.me.id) || null;
      if (old?.kind === "telegram_account" && old.settings?.me?.id && String(old.settings.me.id) === String(step.me.id)) {
        return c.json({ integration: integrations.relogin(old.id, { secret: step.secret, me: step.me }) }, 201);
      }
      const integration = integrations.add("telegram_account", {
        name: step.me.name || "Telegram",
        secret: step.secret,
        settings: { me: step.me, username: step.me.username, pairedChats: ["me"], pairedNames: { me: "Saved Messages" } },
      });
      return c.json({ integration }, 201);
    } catch (error) {
      return c.json({ error: error.errorMessage || error.message }, 400);
    }
  });

  app.delete("/api/integrations/:id", (c) => (integrations.remove(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));
}

/** Agent persona for /agent coverage: the person's access.agent when it may serve a colleague. */
function coverageAgent(profile, store) {
  const wanted = profile?.access?.agent;
  if (!wanted) return DEFAULT_AGENT;
  const id = resolveAgentId(wanted);
  const agentProfile = store?.getAgentProfile?.(id);
  return agentProfile?.meta?.callers?.team ? id : DEFAULT_AGENT;
}

/** "[whole reply]" → "whole reply"; anything with inner brackets or the sentinel is left alone. */
export function unwrapBrackets(text) {
  const s = String(text || "").trim();
  if (s.length < 3 || s[0] !== "[" || s.at(-1) !== "]" || isNoReply(s)) return text;
  const inner = s.slice(1, -1);
  return /[[\]]/.test(inner) ? text : inner.trim();
}
