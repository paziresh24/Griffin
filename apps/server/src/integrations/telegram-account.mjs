import crypto from "node:crypto";
import { markdownToPlain, chunk, withAgentFooter } from "./format.mjs";
import {
  COVERAGE_CALLER,
  coverageCommand,
  coverageContextPrompt,
  coverageIntroPrompt,
  coverageReplyPrompt,
} from "./coverage.mjs";
import { isAgentSigned, looksAssistantSigned, peerAgentConfig } from "./peer-agent.mjs";
import { threadInboundPrompt, threadOwnerPrompt, threadStartPrompt, wantsGriffin } from "./threads.mjs";

// The owner's own Telegram account (MTProto, gramjs). Uses:
//   1. chat with Platform-Ban in Saved Messages (call word),
//   2. stand-in for a teammate's DM (owner: /agent ; agent greets and later end_agent),
//   3. agent tools telegram_dialogs / telegram_read / telegram_send.
// The login code and 2FA password are typed by the owner in the UI and only passed to Telegram.

export const ACCOUNT_KIND = "telegram_account";
const MARK = "🤖 ";

// In Saved Messages, only act on a message that calls the product/agent by name, so the owner's own notes,
// passwords and forwards are left untouched. The call word is stripped before the request goes to the agent.
// Matches: "گریفین"/"گریف"/"griffin", "@…", or a leading "/" or "." — optionally followed by : or ،.
const TRIGGER = /^\s*(?:@?\s*(?:گریف(?:ین)?|griffin)|\/(?:ask|griffin|گریفین)?|\.)\s*[:：،-]?\s*/iu;

export function callToGriffin(text) {
  const s = String(text || "");
  const m = s.match(TRIGGER);
  if (!m) return null;
  const rest = s.slice(m[0].length).trim();
  return rest || null; // call word alone with no request → ignore
}

async function gram() {
  const [{ TelegramClient, Api }, { StringSession }, { NewMessage }, { CustomFile }] = await Promise.all([
    import("telegram"),
    import("telegram/sessions/index.js"),
    import("telegram/events/index.js"),
    import("telegram/client/uploads.js"),
  ]);
  return { TelegramClient, Api, StringSession, NewMessage, CustomFile };
}

function clientOptions(proxy) {
  return {
    connectionRetries: 5,
    autoReconnect: true,
    ...(proxy ? { proxy: { ip: proxy.host, port: proxy.port, socksType: 5 } } : {}),
    baseLogger: { levels: [], log() {}, warn() {}, info() {}, debug() {}, error() {}, canSend: () => false, setLevel() {}, getLevel: () => "none", _log() {} },
  };
}

export function parseProxy(value) {
  const match = String(value || "").match(/^(?:socks5?:\/\/)?([\w.-]+):(\d+)$/);
  return match ? { host: match[1], port: Number(match[2]) } : null;
}

function peerKey(message, meId) {
  const chatId = message?.chatId != null ? String(message.chatId) : null;
  if (chatId && chatId !== meId) return chatId;
  const userId = message?.peerId?.userId != null ? String(message.peerId.userId) : null;
  if (userId && userId !== meId) return userId;
  return null;
}

async function peerLabel(client, key) {
  try {
    const entity = await client.getEntity(/^-?\d+$/.test(key) ? BigInt(key) : key);
    return entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || key;
  } catch {
    return key;
  }
}

// Interactive login: phone → code → (password). Pending logins live in memory for 10 minutes.
export function createAccountLogin({ proxy, load = gram, now = Date.now }) {
  const pending = new Map();

  function sweep() {
    for (const [id, login] of pending) {
      if (now() - login.at > 10 * 60_000) {
        login.client.disconnect().catch(() => {});
        pending.delete(id);
      }
    }
  }

  async function finish(login) {
    const me = await login.client.getMe();
    const session = login.client.session.save();
    await login.client.disconnect().catch(() => {});
    return {
      secret: JSON.stringify({ session, apiId: login.apiId, apiHash: login.apiHash }),
      me: { id: String(me.id), name: [me.firstName, me.lastName].filter(Boolean).join(" "), username: me.username || null, phone: me.phone ? `…${String(me.phone).slice(-4)}` : null },
    };
  }

  return {
    async start({ apiId, apiHash, phone }) {
      sweep();
      const { TelegramClient, StringSession } = await load();
      const client = new TelegramClient(new StringSession(""), Number(apiId), String(apiHash), clientOptions(proxy));
      await client.connect();
      const sent = await client.sendCode({ apiId: Number(apiId), apiHash: String(apiHash) }, String(phone));
      const loginId = crypto.randomBytes(16).toString("hex");
      pending.set(loginId, { client, apiId: Number(apiId), apiHash: String(apiHash), phone: String(phone), phoneCodeHash: sent.phoneCodeHash, at: now() });
      return { loginId, viaApp: Boolean(sent.isCodeViaApp) };
    },

    async code(loginId, code) {
      const login = pending.get(loginId);
      if (!login) throw new Error("login expired; start again");
      const { Api } = await load();
      try {
        await login.client.invoke(new Api.auth.SignIn({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash, phoneCode: String(code).trim() }));
      } catch (error) {
        if (String(error.errorMessage || error.message).includes("SESSION_PASSWORD_NEEDED")) return { needPassword: true };
        throw new Error(error.errorMessage || error.message);
      }
      pending.delete(loginId);
      return finish(login);
    },

    async password(loginId, password) {
      const login = pending.get(loginId);
      if (!login) throw new Error("login expired; start again");
      await login.client.signInWithPassword({ apiId: login.apiId, apiHash: login.apiHash }, {
        password: async () => String(password),
        onError: async (error) => {
          throw error;
        },
      });
      pending.delete(loginId);
      return finish(login);
    },
  };
}

// Running account: Saved Messages ⇄ Platform-Ban, teammate coverage, and a client for agent tools.
export function createAccountChannel({ integration, bridge, proxy, load = gram, log = console }) {
  const { session, apiId, apiHash } = JSON.parse(integration.secret);
  const status = { state: "starting", lastError: null, username: integration.settings.me?.username || null };
  let client = null;
  let meId = null;
  const sentByUs = new Set(); // ids of messages we sent (Saved Messages or coverage)
  const statusByChat = new Map(); // externalChat -> { id, text, at }
  const questionByChat = new Map(); // externalChat -> message id of the currently-open ask_owner question
  const pendingReplyTo = new Map(); // peer key -> Telegram message id to reply to on next text deliver

  async function resolveTarget(target) {
    if (target === "me") return "me";
    const key = String(target);
    // Username / @handle
    if (!/^-?\d+$/.test(key)) {
      return client.getEntity(key.startsWith("@") ? key : key);
    }
    // Numeric id: must be a cached entity — warm from dialogs if needed.
    try {
      return await client.getEntity(BigInt(key));
    } catch {
      const dialogs = await client.getDialogs({ limit: 300 });
      const hit = dialogs.find((d) => String(d.id) === key || String(d.entity?.id) === key);
      if (hit?.entity) return hit.entity;
      throw new Error(`cannot resolve Telegram peer ${key}`);
    }
  }

  async function sendPlain(target, text, { replyTo = null } = {}) {
    const dest = await resolveTarget(target);
    const pieces = chunk(text, 4000);
    let lastId = null;
    for (let i = 0; i < pieces.length; i += 1) {
      const sent = await client.sendMessage(dest, {
        message: pieces[i],
        linkPreview: false,
        ...(replyTo && i === 0 ? { replyTo: Number(replyTo) } : {}),
      });
      sentByUs.add(sent.id);
      lastId = sent.id;
    }
    return lastId;
  }

  // Resolve the message Owner replied to (for /agent-on-reply).
  async function focusFromReply(message) {
    const id = message?.replyTo?.replyToMsgId;
    if (!id) return null;
    try {
      let replied = null;
      if (typeof message.getReplyMessage === "function") {
        replied = await message.getReplyMessage();
      }
      if (!replied) {
        const key = peerKey(message, meId);
        if (!key) return null;
        const dest = await resolveTarget(key);
        const got = await client.getMessages(dest, { ids: [Number(id)] });
        replied = Array.isArray(got) ? got[0] : got;
      }
      const text = String(replied?.message || "").trim();
      if (!text) return null;
      return { id: Number(id), text };
    } catch {
      return null;
    }
  }

  // One editable status line: create or edit; deleted before the final answer.
  async function setStatus(target, line) {
    if (!client) return;
    const key = String(target);
    const body = `⏳ ${String(line || "در حال کار…").slice(0, 180)}`;
    const dest = await resolveTarget(target);
    const prev = statusByChat.get(key);
    if (prev?.id && prev.text === body) return;
    if (prev?.id) {
      try {
        await client.editMessage(dest, { message: prev.id, text: body });
        statusByChat.set(key, { id: prev.id, text: body, at: Date.now() });
        return;
      } catch {
        // Message gone / not editable — send a fresh one.
      }
    }
    const sent = await client.sendMessage(dest, { message: body, linkPreview: false });
    sentByUs.add(sent.id);
    statusByChat.set(key, { id: sent.id, text: body, at: Date.now() });
  }

  async function clearStatus(target) {
    if (!client) return;
    const key = String(target);
    const prev = statusByChat.get(key);
    statusByChat.delete(key);
    if (!prev?.id) return;
    try {
      const dest = await resolveTarget(target);
      await client.deleteMessages(dest, [prev.id], { revoke: true });
    } catch {
      /* ignore */
    }
  }

  const channel = {
    id: integration.id,
    kind: ACCOUNT_KIND,
    status,
    get client() {
      return client;
    },

    async start() {
      const { TelegramClient, StringSession, NewMessage } = await load();
      client = new TelegramClient(new StringSession(session), Number(apiId), String(apiHash), clientOptions(proxy));
      await client.connect();
      if (!(await client.checkAuthorization())) {
        status.state = "error";
        status.lastError = "session revoked in Telegram; log in again";
        return;
      }
      const me = await client.getMe();
      meId = String(me.id);
      status.username = me.username || null;
      status.state = "polling";

      const recentHistory = async (key) => {
        try {
          const dest = await resolveTarget(key);
          const msgs = await client.getMessages(dest, { limit: 30 });
          // getMessages returns newest first
          return [...msgs].reverse().map((m) => {
            // Griffin's own replies go out from the owner's account too; they carry its footer.
            const who = !m.out ? "همکار" : /—\s*(ایجنت\s*)?(سکان[‌\s]*بان|گریفین)\s*$/u.test(String(m.message || "")) ? "گریفین (ایجنت)" : "Owner";
            const body = String(m.message || "").replace(/\s+/g, " ").trim().slice(0, 240);
            if (!body || body.startsWith(MARK.trim())) return null;
            if (coverageCommand(body)) return `${who}: ${body}`;
            return `${who}: ${body}`;
          }).filter(Boolean);
        } catch (error) {
          log.error?.(`[telegram-account] history ${key}: ${error.message}`);
          return [];
        }
      };

      const beginAgent = async (key, { reason = "event", focus = null } = {}) => {
        if (!key) return false;
        const already = bridge.isCovered(integration.id, key);
        const name = await peerLabel(client, key);
        let username = null;
        try {
          const ent = await client.getEntity(/^-?\d+$/.test(key) ? BigInt(key) : key);
          username = ent.username || null;
        } catch { /* ignore */ }
        if (!already) {
          log.info?.(`[telegram-account] /agent start peer=${key} name=${name} via=${reason}`);
          const person = await bridge.upsertPerson?.(integration.id, key, { name, username, data: { platform: "telegram", source: "account" } });
          await bridge.startCoverage(integration.id, key, { name, username, personId: person?.id || null });
          await sendPlain("me", `${MARK}/agent برای «${name}» — Owner-only؛ ایجنت تاریخچه را می‌بیند.`);
        }
        if (focus?.text) {
          if (focus.id) pendingReplyTo.set(String(key), Number(focus.id));
          log.info?.(`[telegram-account] /agent reply-focus peer=${key} msg=${focus.id} via=${reason}`);
          const history = await recentHistory(key);
          await bridge.receive(integration.id, key, {
            text: coverageReplyPrompt(name, focus.text, history),
            caller: COVERAGE_CALLER,
            title: `/agent · ${name}`,
            person: { name, username, data: { platform: "telegram", source: "account" } },
            person: { name, username, data: { platform: "telegram", source: "account" } },
          });
        } else {
          // Plain /agent: load recent messages so the agent sees pending requests (not just an intro).
          const history = await recentHistory(key);
          log.info?.(`[telegram-account] /agent context peer=${key} lines=${history.length} via=${reason}`);
          await bridge.receive(integration.id, key, {
            text: history.length ? coverageContextPrompt(name, history) : coverageIntroPrompt(name),
            caller: COVERAGE_CALLER,
            title: `/agent · ${name}`,
            person: { name, username, data: { platform: "telegram", source: "account" } },
            person: { name, username, data: { platform: "telegram", source: "account" } },
          });
        }
        return true;
      };

      const endAgent = async (key) => {
        const ended = await bridge.endCoverage(integration.id, key);
        if (ended) await sendPlain("me", `${MARK}/agent برای «${ended.name || key}» خاموش شد.`);
        return ended;
      };

      // ——— Threads in teammate DMs (threads.mjs) ———
      const threadBusy = new Set(); // peer keys with a classification in flight
      const threadQueued = new Map(); // peer key -> latest message that arrived during that classification
      const threadRuns = new Map(); // peer key -> run timestamps (ping-pong brake between two agents)
      const THREAD_RUNS_PER_HOUR = 20;
      // The owner typing by hand in a teammate chat means the owner is in that conversation. Griffin
      // steps back: an open thread closes, and the teammate's messages do not open a new one while
      // the owner was there recently (2026-09-26: Griffin kept answering a colleague who was talking
      // to the owner live — a thread had opened on the owner's own «بزنم؟»).
      // ponytail: in-memory, a restart forgets presence for up to OWNER_PRESENT_MS.
      const OWNER_PRESENT_MS = 30 * 60_000;
      const ownerSeen = new Map(); // peer key -> last hand-typed owner message (ms)
      const ownerPresent = (key) => Date.now() - (ownerSeen.get(String(key)) || 0) < OWNER_PRESENT_MS;
      const threadBrake = (key) => {
        const now = Date.now();
        const recent = (threadRuns.get(key) || []).filter((t) => now - t < 3_600_000);
        if (recent.length >= THREAD_RUNS_PER_HOUR) return false;
        recent.push(now);
        threadRuns.set(key, recent);
        return true;
      };
      const handleThreadMessage = async (key, person, text, message, from) => {
        const name = person?.display_name || (await peerLabel(client, key));
        if (bridge.isCovered(integration.id, key)) {
          // Locked: every message in the chat, either side, feeds the open thread.
          if (!threadBrake(key)) {
            log.info?.(`[telegram-account] thread brake peer=${key}`);
            return;
          }
          if (from === "teammate" && message.id) pendingReplyTo.set(String(key), Number(message.id));
          await bridge.receive(integration.id, key, {
            text: from === "owner" ? threadOwnerPrompt({ name, text }) : threadInboundPrompt({ name, text }),
            caller: COVERAGE_CALLER,
          });
          return;
        }
        // The owner is in this conversation: leave it to them unless the teammate calls Griffin.
        if (from === "teammate" && ownerPresent(key) && !wantsGriffin(text)) {
          log.info?.(`[telegram-account] thread skip peer=${key} — owner is in the conversation`);
          return;
        }
        // A second message while the first is being classified («سلام» then the real request) used
        // to be dropped; keep the latest and look at it once the first is done.
        if (threadBusy.has(key)) {
          threadQueued.set(key, { person, text, message, from });
          return;
        }
        threadBusy.add(key);
        try {
          const history = await recentHistory(key);
          const reopen = from === "teammate" && wantsGriffin(text);
          const decision = reopen
            ? { start: true, topic: "", reason: "reopened with «گریفین»" }
            : await bridge.classifyThread({ history: history.slice(0, -1), message: text, from, name });
          log.info?.(`[telegram-account] thread ${decision.start ? "OPEN" : "skip"} peer=${key} from=${from} — ${decision.reason || ""}`);
          // The classifier fails closed; a colleague's request must not vanish with it.
          if (!decision.start && /^jev (error|http)/.test(decision.reason || "") && from === "teammate") {
            await sendPlain("me", `${MARK}پیام «${name}» را نتوانستم بسنجم (${decision.reason}). اگر کار است، روی همان پیام ریپلای کن و /agent بزن.\n«${String(text).slice(0, 200)}»`);
          }
          if (!decision.start) return;
          await bridge.startCoverage(integration.id, key, {
            name,
            username: person?.username || null,
            personId: person?.id || null,
            fresh: !reopen,
            title: `🧵 ${name}: ${decision.topic || String(text).replace(/\s+/g, " ").slice(0, 40)}`,
          });
          threadRuns.set(key, [Date.now()]);
          if (message.id && from === "teammate") pendingReplyTo.set(String(key), Number(message.id));
          await sendPlain("me", `${MARK}رشته با «${name}» باز شد${decision.topic ? `: ${decision.topic}` : ""} — ${decision.reason || ""}\nبستن: در همان چت /agent off`);
          await bridge.receive(integration.id, key, {
            text: threadStartPrompt({ name, history, message: text, from, topic: decision.topic }),
            caller: COVERAGE_CALLER,
          });
        } finally {
          threadBusy.delete(key);
          const queued = threadQueued.get(key);
          if (queued) {
            threadQueued.delete(key);
            await handleThreadMessage(key, queued.person, queued.text, queued.message, queued.from);
          }
        }
      };

      // If updates were missed (session blip / competing client), pick up recent /agent.
      const catchUpAgents = async () => {
        try {
          const cutoff = Math.floor(Date.now() / 1000) - 30 * 60;
          const dialogs = await client.getDialogs({ limit: 40 });
          for (const d of dialogs) {
            if (!d.isUser || d.isSelf) continue;
            const key = String(d.id ?? d.entity?.id ?? "");
            if (!key) continue;
            const msgs = await client.getMessages(d.entity || d.id, { limit: 8 });
            let pending = null; // { key, message }
            for (const m of msgs) {
              if (!m.out || (m.date || 0) < cutoff) continue;
              const cmd = coverageCommand(m.message);
              if (cmd === "end") {
                pending = null;
                break;
              }
              if (cmd === "start") {
                pending = { key, message: m };
                break; // newest first from getMessages
              }
            }
            if (!pending) continue;
            // Already covered + plain /agent → skip; covered + reply focus → still answer.
            const focus = await focusFromReply(pending.message);
            if (bridge.isCovered(integration.id, key) && !focus?.text) continue;
            await beginAgent(pending.key, { reason: "catchup", focus });
          }
        } catch (error) {
          log.error?.(`[telegram-account] catchup: ${error.message}`);
        }
      };

      const onMessage = async (message) => {
        if (!message || sentByUs.has(message.id)) return;
        const text = String(message.message || "").trim();
        if (!text || text.startsWith(MARK.trim())) return;

        const inSaved = message.out && (String(message.chatId) === meId || String(message.peerId?.userId) === meId);
        const key = peerKey(message, meId);

        try {
          // Persist every incoming Telegram message under its stable person profile before routing/filtering.
          let person = null;
          let entity = null;
          if (!inSaved && key) {
            entity = await client.getEntity(/^-?\d+$/.test(key) ? BigInt(key) : key).catch(() => null);
            person = await bridge.upsertPerson?.(integration.id, key, {
              name: entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") || entity?.username || key,
              username: entity?.username || null,
              data: { platform: "telegram", source: "account", chatType: message.isGroup ? "group" : message.isChannel ? "channel" : "user" },
            });
            if (person) bridge.addPersonMessage?.(person.id, { externalMessageId: message.id, direction: message.out ? "out" : "in", text, data: { chatId: key } });
          }
          // ——— Saved Messages: call word + answers to Owner asks from coverage ———
          if (inSaved) {
            const choice = text.match(/^([1-6])$/);
            if (choice && (await bridge.answerOwnerAsk(integration.id, Number(choice[1]) - 1))) return;
            if (choice && (bridge.openOwnerAskCount?.() || 0) > 1) {
              await client.sendMessage("me", { message: `${MARK}چند سؤال باز است؛ دکمهٔ همان پیام ربات را بزن.`, linkPreview: false }).then((s) => sentByUs.add(s.id)).catch(() => {});
              return;
            }
            if (choice && (await bridge.answer(integration.id, "me", Number(choice[1]) - 1))) return;
            const request = callToGriffin(text);
            if (!request) return;
            await client.sendMessage("me", { message: `${MARK}چشم، دارم انجام می‌دهم…`, linkPreview: false }).then((s) => sentByUs.add(s.id)).catch(() => {});
            await bridge.receive(integration.id, "me", { text: request });
            return;
          }

          // Threads run only in 1:1 chats with people marked «team», never groups/channels/bots, and
          // can be switched off with settings.threads = false (then the older paths below apply).
          const threadDm = Boolean(
            key && person && !message.isGroup && !message.isChannel && !entity?.bot &&
            person.category === "team" && person.access?.enabled !== false &&
            bridge.integration?.(integration.id)?.settings?.threads !== false,
          );

          // ——— Owner outgoing in a teammate chat: /agent start (agent greets); /agent off kill-switch ———
          if (message.out && key) {
            const cmd = coverageCommand(text);
            if (cmd === "start") {
              const focus = await focusFromReply(message);
              await beginAgent(key, { reason: "live", focus });
              return;
            }
            if (cmd === "end") {
              await endAgent(key);
              return;
            }
            // The owner writing by hand to a teammate: the owner has the conversation. Never open a
            // thread on it, and hand back an open one.
            if (threadDm) {
              ownerSeen.set(String(key), Date.now());
              if (bridge.isCovered(integration.id, key)) {
                log.info?.(`[telegram-account] thread closed peer=${key} — owner took over`);
                await endAgent(key);
              }
            }
            return;
          }

          // A teammate (or their assistant) in a 1:1 chat: threads decide, signature or not.
          if (threadDm) {
            await handleThreadMessage(key, person, text, message, "teammate");
            return;
          }

          // ——— A colleague's signed automated assistant: Griffin answers it agent-to-agent ———
          // Off unless the owner turns it on (settings.autoReplyAgents): replies go out from the
          // owner's own account, and the owner switched them off 2026-09-23 («پیام خودکار رو
          // خاموش کن»). The message stays in the chat for the owner, like any other DM.
          const autoReply = bridge.integration?.(integration.id)?.settings?.autoReplyAgents === true;
          const dm = autoReply && !message.out && key && !message.isGroup && !message.isChannel;
          const agentCfg = dm ? peerAgentConfig(person) : null;
          if (agentCfg && isAgentSigned(text, agentCfg.signature)) {
            if (message.id) pendingReplyTo.set(String(key), Number(message.id));
            await bridge.receivePeerAgent?.(integration.id, key, {
              text,
              userId: agentCfg.user,
              label: person?.display_name || key,
              personId: person?.id || null,
            });
            return;
          }
          // Any other assistant-signed DM: bind the sender to a peer identity (default read-only
          // quota) and answer it too — no assistant should wait for the owner to forward it.
          if (dm && person && looksAssistantSigned(text)) {
            const bound = await bridge.bindPeerAgentPerson?.(person, key);
            if (bound) {
              if (bound.created) {
                await client
                  .sendMessage("me", { message: `${MARK}همتای خودکار: «${person.display_name || bound.user}» از روی امضای دستیارش متصل شد (سهمیهٔ فقط-خواندن پیش‌فرض).`, linkPreview: false })
                  .then((s) => sentByUs.add(s.id))
                  .catch(() => {});
              }
              if (message.id) pendingReplyTo.set(String(key), Number(message.id));
              await bridge.receivePeerAgent?.(integration.id, key, {
                text,
                userId: bound.user,
                label: person.display_name || key,
                personId: person.id || null,
              });
            }
            return;
          }

          // ——— Incoming from peer: Owner-only for now — peer cannot drive the agent ———
          if (!message.out && key && bridge.isCovered(integration.id, key)) {
            log.info?.(`[telegram-account] ignore peer inbound (owner-only /agent) peer=${key}`);
            return;
          }
        } catch (error) {
          log.error?.(`[telegram-account] ${error.message}`);
        }
      };
      client.addEventHandler((event) => onMessage(event.message), new NewMessage({}));

      // A teammate's DM that arrived while the account was down (dead session, restart, network)
      // never produced an update. After reconnecting, pass the unrecorded ones from the last day
      // through the same handler — oldest first, incoming only (Griffin's own replies carry no
      // record id here and must not be replayed as the owner typing).
      const catchUpTeam = async () => {
        const since = Math.floor(Date.now() / 1000) - 24 * 3600;
        const team = (bridge.listPersons?.({ source: "telegram" }) || []).filter((p) => p.category === "team" && /^\d+$/.test(String(p.external_id || "")));
        for (const person of team) {
          try {
            const known = new Set((person.history || []).map((h) => String(h.id)));
            const msgs = await client.getMessages(await resolveTarget(String(person.external_id)), { limit: 15 });
            const missed = [...msgs].reverse().filter((m) => !m.out && (m.date || 0) >= since && m.message && !known.has(String(m.id)));
            for (const m of missed) {
              log.info?.(`[telegram-account] catch-up ${person.display_name || person.external_id} #${m.id}`);
              await onMessage(m);
            }
          } catch (error) {
            log.error?.(`[telegram-account] catch-up ${person.external_id}: ${error.message}`);
          }
        }
      };

      // Catch up after the handler is armed (missed /agent while session was contested).
      catchUpAgents().catch((error) => log.error?.(`[telegram-account] catchup: ${error.message}`));
      catchUpTeam().catch((error) => log.error?.(`[telegram-account] catch-up: ${error.message}`));
    },

    async deliver(externalChat, message) {
      if (!client) return;
      const target = externalChat === "me" ? "me" : externalChat;
      if (message.clearStatus) {
        await clearStatus(target);
        return;
      }
      if (message.status) {
        await setStatus(target, message.status);
        return;
      }
      if (message.typing) return;
      const send = async (body, extra = {}) => {
        const prefix = target === "me" ? MARK : "";
        return sendPlain(target, withAgentFooter(`${prefix}${body}`), extra);
      };
      if (message.question) {
        await clearStatus(target);
        const options = message.question.options || [];
        const messageId = await send(`❓ ${message.question.question}${options.length ? `\n\n${options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")}\n\nعدد گزینه را بفرست.` : ""}`);
        if (messageId != null) questionByChat.set(String(target), messageId);
        return;
      }
      // The question was answered elsewhere (UI or a Telegram bot) or the run ended: remove it
      // so only open questions stay visible here.
      if (message.clearQuestion) {
        const key = String(target);
        const messageId = questionByChat.get(key);
        questionByChat.delete(key);
        if (messageId == null) return;
        try {
          const dest = await resolveTarget(target);
          await client.deleteMessages(dest, [messageId], { revoke: true });
        } catch {
          /* ignore */
        }
        return;
      }
      if (message.text) {
        await clearStatus(target);
        const body = target === "me" ? `✅ پلتفرم‌بان:\n\n${markdownToPlain(message.text)}` : markdownToPlain(message.text);
        const replyTo = message.replyTo || pendingReplyTo.get(String(target)) || null;
        pendingReplyTo.delete(String(target));
        await send(body, { replyTo });
      }
      const { CustomFile } = await load();
      for (const file of message.files || []) {
        const dest = await resolveTarget(target);
        const caption = withAgentFooter(`${target === "me" ? MARK : ""}${file.caption || file.name}`);
        const sent = await client.sendFile(dest, {
          file: new CustomFile(file.name, file.data.length, "", file.data),
          caption,
          forceDocument: !/^image\/(png|jpeg|webp)$/.test(file.mimeType),
        });
        sentByUs.add(sent.id);
      }
    },

    stop() {
      client?.disconnect().catch(() => {});
      client = null;
      status.state = "stopped";
    },
  };
  return channel;
}

// Agent tools over the connected account.
export function createAccountTools({ getClient }) {
  const need = () => {
    const client = getClient();
    if (!client) throw new Error("no Telegram account is connected (Settings → اتصال‌ها)");
    return client;
  };

  async function resolveChat(client, chat) {
    const value = String(chat || "").trim();
    if (!value) throw new Error("chat is required");
    if (/^-?\d+$/.test(value) || value.startsWith("@")) {
      const entity = await client.getEntity(value.startsWith("@") ? value : BigInt(value));
      return { entity, title: entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || value };
    }
    const dialogs = await client.getDialogs({ limit: 300 });
    const lower = value.toLowerCase();
    const match = dialogs.find((d) => String(d.title || "").toLowerCase() === lower) || dialogs.find((d) => String(d.title || "").toLowerCase().includes(lower));
    if (!match) throw new Error(`no chat named "${value}" in the account's dialogs`);
    return { entity: match.entity, title: match.title };
  }

  const tehran = (seconds) => new Date(seconds * 1000).toLocaleString("sv-SE", { timeZone: "Asia/Tehran" });
  const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const fail = (error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] });

  return {
    telegram_dialogs: {
      description: "List the owner's Telegram chats (groups, channels, people) from their own account, newest first. Filter with query.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 300 } }, additionalProperties: false },
      async execute(args) {
        try {
          const client = need();
          const dialogs = await client.getDialogs({ limit: 300 });
          const q = String(args?.query || "").toLowerCase();
          const rows = dialogs
            .filter((d) => !q || String(d.title || "").toLowerCase().includes(q))
            .slice(0, Math.min(Number(args?.limit) || 50, 300))
            .map((d) => ({ id: String(d.id), title: d.title, type: d.isChannel ? (d.isGroup ? "supergroup" : "channel") : d.isGroup ? "group" : "user", username: d.entity?.username || null, unread: d.unreadCount || 0, lastAt: d.date ? tehran(d.date) : null }));
          return text({ dialogs: rows, source: "telegram account" });
        } catch (error) {
          return fail(error);
        }
      },
    },

    telegram_read: {
      description: "Read recent messages of one Telegram chat (group, channel or person) from the owner's account. chat = id, @username or title. Optional search text.",
      inputSchema: {
        type: "object",
        properties: { chat: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 }, search: { type: "string" } },
        required: ["chat"],
        additionalProperties: false,
      },
      async execute(args) {
        try {
          const client = need();
          const { entity, title } = await resolveChat(client, args.chat);
          const messages = await client.getMessages(entity, { limit: Math.min(Number(args.limit) || 30, 200), ...(args.search ? { search: String(args.search) } : {}) });
          const rows = [];
          for (const m of messages) {
            const sender = m.sender ? [m.sender.firstName, m.sender.lastName].filter(Boolean).join(" ") || m.sender.title || m.sender.username : null;
            rows.push({ id: m.id, at: tehran(m.date), from: sender, text: m.message || "", media: m.media ? m.media.className.replace(/^MessageMedia/, "") : null, replyTo: m.replyTo?.replyToMsgId || null });
          }
          return text({ chat: title, messages: rows.reverse(), source: "telegram account" });
        } catch (error) {
          return fail(error);
        }
      },
    },

    telegram_send: {
      description: "Send a message from the owner's own Telegram account to a chat (id, @username or title). Sends immediately. Only send to who the owner named.",
      inputSchema: {
        type: "object",
        properties: { chat: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 4000 }, replyTo: { type: "integer" } },
        required: ["chat", "text"],
        additionalProperties: false,
      },
      async execute(args) {
        try {
          const client = need();
          const { entity, title } = await resolveChat(client, args.chat);
          const sent = await client.sendMessage(entity, { message: String(args.text), ...(args.replyTo ? { replyTo: Number(args.replyTo) } : {}) });
          return text({ sent: true, chat: title, messageId: sent.id, source: "telegram account" });
        } catch (error) {
          return fail(error);
        }
      },
    },
  };
}
