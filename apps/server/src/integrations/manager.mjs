import { foldEvents } from "@griffin/timeline";
import crypto from "node:crypto";
import { autoTitle } from "../titles.mjs";
import { BOT_KINDS, createBotApi, createBotChannel, pairingCode } from "./bots.mjs";
import { DEFAULT_AGENT, resolveAgentId } from "../agents/registry.mjs";
import { COVERAGE_CALLER } from "./coverage.mjs";
import { isNoReply, peerAgentPrompt, takeRate, derivePeerUserId } from "./peer-agent.mjs";
import { answerStamp, deliverable, liveStatusLine } from "./format.mjs";
import { OWNER, REQUESTER } from "../asks.mjs";
import { createAccountChannel, createAccountLogin } from "./telegram-account.mjs";
import { chartMedia } from "../chart-image.mjs";
import { normalizeProvider } from "../providers/ids.mjs";

// Bridges messenger channels (Telegram/Bale bots; Telegram account) to Griffin chats: incoming
// messages become runs, finished runs and ask_owner questions go back to the linked messenger chat.
// Team coverage (caller=team): answers go to the teammate; ask_owner confirmations go to the Owner's
// Telegram bot so they are unmistakable — not buried in the owner's own Saved Messages.
export function createIntegrations({ store, runner, asks, peerAuth = null, publicUrl = "", fetchImpl = fetch, telegramProxy = null, channelFactories = {}, login = null, classifyThread = null, pendingWork = () => 0, log = console }) {
  const channels = new Map(); // integrationId -> channel
  const questions = new Map(); // chatId -> last ask_owner args (for button index → label)
  // Each ask_owner gets a short id embedded in Telegram callback_data so buttons cannot
  // answer a different chat's question (one bot → many concurrent coverage chats).
  const pendingAsks = new Map(); // askId -> { chatId, owner, at }
  // Where a chat's currently-open ask_owner question was delivered, so it can be deleted the
  // moment it stops being open (answered anywhere, held, or the run ended) — only open
  // questions should stay visible in Telegram.
  const askTargets = new Map(); // chatId -> [{ integrationId, externalChat }]
  const endAfterRun = new Map(); // chatId -> { integrationId, peer, note }
  const lastStatusAt = new Map(); // chatId -> ms of last status push (debounce)
  const webhookSecrets = new Map(); // integrationId -> secret_token for Telegram webhook

  function newAskId() {
    return crypto.randomBytes(4).toString("hex");
  }

  function registerAsk(chatId, question, { owner = false } = {}) {
    const askId = question.askId || newAskId();
    const tagged = { ...question, askId };
    questions.set(chatId, tagged);
    pendingAsks.set(askId, { chatId, owner: Boolean(owner), at: Date.now() });
    return tagged;
  }

  function clearAsksForChat(chatId) {
    questions.delete(chatId);
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

  function recordAskDelivery(chatId, integrationId, externalChat, { messageId = null, askId = null } = {}) {
    const list = askTargets.get(chatId) || [];
    list.push({ integrationId, externalChat: String(externalChat) });
    askTargets.set(chatId, list);
    if (messageId == null) return;
    // The question text is kept so closing the message can leave it readable (with the answer
    // under it) instead of replacing it with a bare "answered".
    const text = String(questions.get(chatId)?.question || "").slice(0, 3000);
    saveOpenAsks([
      ...openAsks().filter((row) => row.messageId !== messageId || row.externalChat !== String(externalChat)),
      { chatId, integrationId, externalChat: String(externalChat), messageId, askId, text, at: Date.now() },
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
  function clearQuestion(chatId, { answer = null, cancelled = false } = {}) {
    const note = answer
      ? `✅ پاسخ: ${String(answer).slice(0, 200)}`
      : cancelled
        ? "⏹ کار متوقف شد؛ این سؤال دیگر باز نیست."
        : "✅ پاسخ ثبت شد.";
    clearAsksForChat(chatId);
    const targets = askTargets.get(chatId);
    askTargets.delete(chatId);
    const rows = openAsks();
    const mine = rows.filter((row) => row.chatId === chatId);
    if (mine.length) {
      saveOpenAsks(rows.filter((row) => row.chatId !== chatId));
      for (const row of mine) closeDelivered(row, note);
      return;
    }
    // No recorded message id (older delivery): fall back to deleting the last one we remember.
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
      await closeDelivered(row, "⏹ این سؤال دیگر باز نیست (سرور از آن زمان ری‌استارت شده). اگر هنوز لازم است، در خود گریفین دوباره بپرس.");
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

  function botWebhookSecret(integrationId) {
    if (webhookSecrets.has(integrationId)) return webhookSecrets.get(integrationId);
    const secret = crypto.createHash("sha256").update(`griffin-bot-hook:${integrationId}`).digest("hex").slice(0, 32);
    webhookSecrets.set(integrationId, secret);
    return secret;
  }

  const factories = {
    ...Object.fromEntries(Object.keys(BOT_KINDS).map((kind) => [kind, (integration, bridge) => {
      const webhookUrl = botWebhookUrl(integration.id);
      return createBotChannel({
        integration,
        api: createBotApi({ kind, token: integration.secret, fetchImpl }),
        bridge,
        log,
        webhookUrl,
        webhookSecret: webhookUrl ? botWebhookSecret(integration.id) : null,
      });
    }])),
    telegram_account: (integration, bridge) => createAccountChannel({ integration, bridge, proxy: telegramProxy, log }),
    ...channelFactories,
  };

  function coverageMap(id) {
    return { ...(store.getIntegration(id)?.settings?.coverage || {}) };
  }

  function saveCoverage(id, coverage) {
    store.updateIntegration(id, { settings: { coverage } });
  }

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
      const label = store.getPeerUser?.(userId)?.label || userId;
      return `🔐 درخواست از ایجنتِ «${label}» (${userId}) — تأیید با توست:`;
    }
    return `🔐 از مسیر «${chat.caller}» — تأیید با توست:`;
  }

  function ownerTelegramId() {
    for (const integ of store.listIntegrations?.() || []) {
      const id = integ?.settings?.me?.id;
      if (integ.kind === "telegram_account" && id) return String(id);
    }
    // Fallback: any bot paired chat that is a numeric id (not the bogus "me").
    for (const integ of store.listIntegrations?.() || []) {
      if (!String(integ.kind || "").endsWith("_bot")) continue;
      for (const chat of integ.settings?.pairedChats || []) {
        if (/^\d+$/.test(String(chat))) return String(chat);
      }
    }
    return null;
  }

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

  async function answerChat(chatId, index, { by = OWNER } = {}) {
    const question = questions.get(chatId);
    const label = question?.options?.[index]?.label;
    if (!chatId || !label) return false;
    // In the owner's own chats the person tapping the button is the owner, whichever bot chat it
    // came from; only a teammate/peer chat answers as the requester.
    const answeredBy = store.getChat(chatId)?.caller === OWNER ? OWNER : by;
    clearAsksForChat(chatId);
    if (runner.isActive(chatId)) await asks?.waitForQuestion?.(chatId, { stillActive: () => runner.isActive(chatId) });
    if (asks?.answer(chatId, { answer: label, selected: [label], by: answeredBy })) return true;
    await runner.send(chatId, { text: `پاسخ به سؤالت «${question.question}»: ${label}`, images: [], intent: runner.isActive(chatId) ? "queue" : "send" });
    return true;
  }

  const bridge = {
    integration: (id) => store.getIntegration(id),
    // settings.teamRoster: display names of colleagues who have not written 1:1 yet (from the
    // platform-gitops owners/ and the team group). Their first DM marks them «team», so threads
    // work from the first message instead of waiting for someone to classify them by hand.
    upsertPerson: (id, externalId, person = {}) => {
      const saved = store.upsertPerson({ integrationId: id, externalId, ...person });
      const roster = store.getIntegration(id)?.settings?.teamRoster || [];
      // Entries are display names or @usernames.
      const keys = [saved?.display_name, saved?.username && `@${saved.username}`].filter(Boolean).map((k) => String(k).trim().toLowerCase());
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

    async stop(id, externalChat) {
      const chatId = store.linkedChat(id, externalChat);
      if (!chatId || !runner.isActive(chatId)) return false;
      await runner.cancel(chatId);
      return true;
    },

    isCovered(id, peer) {
      return Boolean(coverageMap(id)[String(peer)]);
    },

    coverageName(id, peer) {
      return coverageMap(id)[String(peer)]?.name || null;
    },

    // Does the newest message in a teammate DM open a thread? (see threads.mjs). No classifier
    // configured means no automatic threads.
    async classifyThread(args) {
      if (!classifyThread) return { start: false, reason: "no classifier" };
      return classifyThread(args);
    },

    // fresh: a new thread gets its own chat (reopening with «گریفین» continues the last one).
    async startCoverage(id, peer, { name, username = null, personId = null, fresh = false, title = null } = {}) {
      const key = String(peer);
      const coverage = coverageMap(id);
      const integration = store.getIntegration(id);
      const profile = personId
        ? store.getPerson(personId)
        : store.listPersons({ source: "telegram" }).find((p) => p.external_id === key) || null;
      const agent = coverageAgent(profile, store);
      let chatId = store.linkedChat(id, key);
      const existing = chatId ? store.getChat(chatId) : null;
      if (fresh || !existing || existing.caller !== COVERAGE_CALLER || existing.agent !== agent) {
        const chat = store.createChat({
          title: title || `/agent · ${name || key}`,
          mode: "agent",
          model: integration.settings.model || null,
          caller: COVERAGE_CALLER,
          agent,
          personId: profile?.id || personId || null,
        });
        chatId = chat.id;
        store.linkChat(id, key, chatId);
      }
      coverage[key] = { name: name || key, username: username || null, chatId, startedAt: new Date().toISOString() };
      saveCoverage(id, coverage);
      return coverage[key];
    },

    async endCoverage(id, peer) {
      const key = String(peer);
      const coverage = coverageMap(id);
      const ended = coverage[key];
      if (!ended) return null;
      delete coverage[key];
      saveCoverage(id, coverage);
      const chatId = ended.chatId || store.linkedChat(id, key);
      if (chatId && runner.isActive(chatId)) await runner.cancel(chatId).catch(() => {});
      return ended;
    },

    async receive(id, externalChat, { text, images = [], caller = null, title = null, person = null } = {}) {
      let chatId = store.linkedChat(id, externalChat);
      const existing = chatId ? store.getChat(chatId) : null;
      const profile = person ? store.upsertPerson({ externalId: externalChat, ...person, data: { platform: "telegram", source: "account" } }) : store.listPersons({ source: "telegram" }).find((p) => p.external_id === String(externalChat)) || (person ? store.upsertPerson({ externalId: externalChat, ...person }) : null);
      if (profile && text) store.addPersonMessage({ personId: profile.id, direction: "in", text, data: { chatId, caller: caller || "owner" } });
      if (profile?.access?.enabled === false) {
        await channels.get(id)?.deliver(externalChat, { text: "این پروفایل فعلاً دسترسی فعال ندارد." });
        return null;
      }
      if (!existing) {
        const integration = store.getIntegration(id);
        const chat = store.createChat({
          title: title || autoTitle(text),
          mode: "agent",
          model: integration.settings.model || null,
          caller: caller || "owner",
          agent: caller === COVERAGE_CALLER ? coverageAgent(profile, store) : undefined,
          personId: profile?.id || null,
        });
        chatId = chat.id;
        store.linkChat(id, externalChat, chatId);
      }
      try {
        return await runner.send(chatId, { text, images, intent: runner.isActive(chatId) ? "queue" : "send" });
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
    async receivePeerAgent(id, externalChat, { text, userId, label, personId = null } = {}) {
      const caller = `peer:${userId}`;
      label = store.getPeerUser?.(userId)?.label || label;
      if (!takeRate(store, `${id}:${externalChat}`)) {
        log.info?.(`[integrations] peer-agent rate limit ${externalChat} (${userId})`);
        return null;
      }
      let chatId = store.linkedChat(id, externalChat);
      const existing = chatId ? store.getChat(chatId) : null;
      if (!existing || existing.caller !== caller) {
        const profile = store.getAgentProfile("griffin");
        if (!profile?.meta?.callers?.[caller]) {
          log.error?.(`[integrations] peer-agent ${userId}: no griffin quota for ${caller}`);
          return null;
        }
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
        return await runner.send(chatId, { text: peerAgentPrompt({ label, userId, text }), images: [], intent: runner.isActive(chatId) ? "queue" : "send" });
      } catch (error) {
        log.error?.(`[integrations] peer-agent ${userId}: ${error.message}`);
        return null;
      }
    },

    // Returns true when the choice matched an open question on the linked chat.
    async answer(id, externalChat, index, askId = null) {
      if (askId) {
        const pending = pendingAsks.get(String(askId));
        if (!pending || pending.owner) return false;
        return answerChat(pending.chatId, index, { by: "requester" });
      }
      return answerChat(store.linkedChat(id, externalChat), index, { by: "requester" });
    },

    // Agent called end_agent: close coverage after this run's reply is delivered.
    scheduleEnd(chatId, { integrationId, peer, note = "" } = {}) {
      endAfterRun.set(chatId, { integrationId, peer: String(peer), note: String(note || "") });
    },

    // Owner answers a coverage ask_owner (bot buttons carry askId; bare 1–6 only if one ask is open).
    async answerOwnerAsk(_id, index, askId = null) {
      if (askId) {
        const pending = pendingAsks.get(String(askId));
        if (!pending?.owner) return false;
        return answerChat(pending.chatId, index);
      }
      const open = openOwnerAsks();
      if (open.length !== 1) return false;
      return answerChat(open[0][1].chatId, index);
    },

    openOwnerAskCount() {
      return openOwnerAsks().length;
    },
  };

  async function deliverRun(chatId, links, { heading = "" } = {}) {
    const { messages } = foldEvents(store.allEvents(chatId));
    const run = messages.findLast((m) => m.role === "assistant");
    if (!run) return [];
    const out = deliverable(run);
    if (out.status === "finished" && isNoReply(out.text) && !out.files.length && !out.charts.length) {
      for (const link of links) channels.get(link.integration_id)?.deliver(link.external_chat, { clearStatus: true }).catch(() => {});
      return [];
    }
    const chat = store.getChat(chatId);
    const toOwner = chat?.caller === OWNER;
    // A run woken by a subtask report that ends with subtasks still running has only "still working"
    // to say — the colleague already heard that once (one colleague got four such lines).
    const trigger = messages.findLast((m) => m.role === "user")?.text || "";
    if (chat?.caller === COVERAGE_CALLER && trigger.startsWith("[گزارش خودکار زیرکارها") && pendingWork(chatId) > 0 && !out.files.length && !out.charts.length) {
      for (const link of links) channels.get(link.integration_id)?.deliver(link.external_chat, { clearStatus: true }).catch(() => {});
      return [];
    }
    // A colleague must never receive an engine error in the owner's name (2026-09-23: a raw Cursor
    // "usage limit" reached a colleague). The owner sees it in the chat; the colleague gets nothing.
    if (out.status === "error" && !toOwner && !out.text && !out.files.length && !out.charts.length) {
      for (const link of links) channels.get(link.integration_id)?.deliver(link.external_chat, { clearStatus: true }).catch(() => {});
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
        await channel.deliver(link.external_chat, { text: text || "(جوابی نیامد)", files });
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
    const ownerId = ownerTelegramId();
    const bot = preferOwnerBot();
    const account = [...channels.entries()].find(([, ch]) => ch.kind === "telegram_account");
    const fail = (where) => (error) => log.error?.(`[integrations] owner-ask ${where}: ${error.message}`);
    if (bot && ownerId) {
      ensureBotPaired(bot.id, ownerId);
      bot.channel
        .deliver(ownerId, { question: tagged })
        .then((sent) => recordAskDelivery(chatId, bot.id, ownerId, { messageId: sent?.message_id ?? sent?.id ?? null, askId: tagged.askId }))
        .catch(fail("bot"));
    } else if (account) {
      account[1]
        .deliver("me", { question: tagged })
        .then((sent) => recordAskDelivery(chatId, account[0], "me", { messageId: sent?.message_id ?? sent?.id ?? null, askId: tagged.askId }))
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
      if (unattendedChat(chat)) return;
      const toLinks = () => {
        const tagged = registerAsk(chatId, question, { owner: false });
        for (const link of links) {
          const channel = channels.get(link.integration_id);
          const fail = (error) => log.error?.(`[integrations] ask deliver: ${error.message}`);
          channel.deliver(link.external_chat, { clearStatus: true }).catch(fail);
          channel
            .deliver(link.external_chat, { question: tagged })
            .then((sent) => recordAskDelivery(chatId, link.integration_id, link.external_chat, { messageId: sent?.message_id ?? sent?.id ?? null, askId: tagged.askId }))
            .catch(fail);
        }
      };
      // A question for whoever asked goes back where they asked (a colleague's Telegram chat);
      // over /mcp there is no link and peer-tasks surfaces it as input-required.
      if (question.audience === REQUESTER) {
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
  
          const ownerId = ownerTelegramId();
          const bot = preferOwnerBot();
          const account = [...channels.entries()].find(([, ch]) => ch.kind === "telegram_account");
  
          if (bot && ownerId) {
            ensureBotPaired(bot.id, ownerId);
            bot.channel
              .deliver(ownerId, { question: tagged })
              .then((sent) => recordAskDelivery(chatId, bot.id, ownerId, { messageId: sent?.message_id ?? sent?.id ?? null, askId: tagged.askId }))
              .catch(fail("bot-question"));
          } else if (account) {
            // Fallback only if no bot: Saved Messages (legacy).
            account[1].deliver("me", {
              text: `سؤال از /agent با «${peerName}» — گزینه‌ها در پیام بعد؛ عدد بفرست.`,
            }).catch(fail("me-alert"));
            account[1]
              .deliver("me", { question: tagged })
              .then((sent) => recordAskDelivery(chatId, account[0], "me", { messageId: sent?.message_id ?? sent?.id ?? null, askId: tagged.askId }))
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
    if (!links.length) return;

    // A colleague's chat gets only the answers — internal progress lines sent from Owner's account
    // read as spam there.
    const line = chat?.caller === COVERAGE_CALLER ? null : liveStatusLine(event);
    if (line && event.type !== "run.finished") {
      const now = Date.now();
      const prev = lastStatusAt.get(chatId) || 0;
      // Always push run.started / ask_owner wait; debounce rapid tool hops.
      const urgent = event.type === "run.started" || event.data?.name === "ask_owner";
      if (urgent || now - prev > 900) {
        lastStatusAt.set(chatId, now);
        for (const link of links) {
          channels.get(link.integration_id).deliver(link.external_chat, { status: line }).catch(() => {});
        }
      }
    }

    if (event.type === "run.finished") {
      lastStatusAt.delete(chatId);
      deliverRun(chatId, links)
        .then(async () => {
          const pending = endAfterRun.get(chatId);
          if (!pending) return;
          endAfterRun.delete(chatId);
          const ended = await bridge.endCoverage(pending.integrationId, pending.peer);
          if (!ended) return;
          const channel = channels.get(pending.integrationId);
          const note = pending.note ? ` — ${pending.note}` : "";
          await channel?.deliver("me", { text: `/agent برای «${ended.name || pending.peer}» تمام شد${note}` }).catch(() => {});
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
      const ownerId = ownerTelegramId();
      if (!bot || !ownerId) continue;
      ensureBotPaired(bot.id, ownerId);
      await bot.channel.deliver(ownerId, {
        text: `⚠️ اکانت تلگرامِ گریفین قطع است و هیچ پیامی از همکارها به گریفین نمی‌رسد.\nخطا: ${String(lastError || "نامعلوم").slice(0, 200)}\n` +
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
    bridge,
    channels,
    // Called (via asks.mjs's onSettled hook) the moment a question stops being open — deletes
    // the mirrored Telegram message so only open questions stay visible there.
    clearQuestion,
    login: login || createAccountLogin({ proxy: telegramProxy }),
    kinds: { ...Object.fromEntries(Object.entries(BOT_KINDS).map(([k, v]) => [k, v.label])), telegram_account: "اکانت تلگرام" },

    startAll() {
      for (const integration of store.listIntegrations()) startChannel(integration);
      // A dead account is silent by nature: every colleague goes unanswered and nothing says so
      // (a session killed with AUTH_KEY_DUPLICATED went unnoticed for hours while colleagues got
      // no reply). The bot is a separate path, so it tells the owner.
      setInterval(() => watchAccounts().catch((error) => log.error?.(`[integrations] account watch: ${error.message}`)), 60_000).unref?.();
      // Questions delivered before this restart have no run behind them any more.
      setTimeout(() => sweepStaleAsks().catch(() => {}), 5_000).unref?.();
    },

    sweepStaleAsks,

    list: () => store.listIntegrations().map(view),

    async addBot({ kind, name, token }) {
      if (!BOT_KINDS[kind]) throw new Error("unknown kind");
      const me = await createBotApi({ kind, token, fetchImpl }).getMe(); // rejects a wrong token before saving
      const integration = store.createIntegration({ kind, name: name || me.first_name || BOT_KINDS[kind].label, secret: token, settings: { username: me.username || null, pairingCode: pairingCode(), pairedChats: [] } });
      startChannel(integration);
      return view(store.getIntegration(integration.id));
    },

    add(kind, { name, secret, settings }) {
      const integration = store.createIntegration({ kind, name, secret, settings });
      startChannel(integration);
      return view(store.getIntegration(integration.id));
    },

    update(id, patch) {
      const integration = store.getIntegration(id);
      if (!integration) return null;
      const next = store.updateIntegration(id, {
        ...(typeof patch.name === "string" && patch.name.trim() ? { name: patch.name.trim().slice(0, 60) } : {}),
        ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(patch.newPairingCode ? { settings: { pairingCode: pairingCode() } } : {}),
        ...(typeof patch.unpair === "string" ? { settings: { pairedChats: (integration.settings.pairedChats || []).filter((c) => c !== patch.unpair) } } : {}),
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
      if (expected && secretHeader !== expected) return { ok: false, status: 401 };
      await channel.handleUpdate(update);
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
    accountClient() {
      for (const channel of channels.values()) if (channel.kind === "telegram_account" && channel.client && channel.status.state === "polling") return channel.client;
      return null;
    },

    stopAll() {
      for (const id of [...channels.keys()]) stopChannel(id);
      store.bus.off("event", onEvent);
    },
  };
}

// Tools that stop and wait for the owner, as a question a messenger can show.
export function questionFromEvent(event) {
  if (event.type !== "ask.pending") return null;
  const { question, options, multiSelect, audience } = event.data || {};
  return question ? { question, options, multiSelect, audience: audience === REQUESTER ? REQUESTER : OWNER } : null;
}

export function integrationRoutes(app, integrations) {
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
  app.patch("/api/telegram/persons/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const patch = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 120);
    if (typeof body.category === "string") patch.category = body.category.trim().slice(0, 60) || "unclassified";
    if (body.access && typeof body.access === "object" && !Array.isArray(body.access)) {
      const access = { ...body.access };
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
    return c.json({ person: integrations.bridge.updatePerson(c.req.param("id"), patch) });
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
  // Telegram account login: the owner types phone, code and (if set) 2FA password in the UI.
  app.post("/api/integrations/telegram-account/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!/^\d{3,10}$/.test(String(body.apiId || "")) || !/^[a-f0-9]{32}$/i.test(String(body.apiHash || "")) || !/^\+?\d{8,15}$/.test(String(body.phone || "").replace(/[\s-]/g, ""))) {
      return c.json({ error: "api_id، api_hash (از my.telegram.org) و شماره با کد کشور لازم است" }, 400);
    }
    try {
      return c.json(await integrations.login.start({ apiId: body.apiId, apiHash: body.apiHash, phone: String(body.phone).replace(/[\s-]/g, "") }));
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
      if (step.needPassword) return c.json({ needPassword: true });
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
