// Mother chats: the assistant orchestrates the owner's Telegram like a watcher would. Every watched
// Telegram person (or team group) has one standing chat. Each of their messages lands there and the
// agent decides: answer, open a thread for real work (a delegated subtask), steer an open thread, or
// join another person's thread
// when it is the same issue. The chat never closes, and nothing it writes reaches the colleague by
// itself: only send_to_person does (Telegram v2 — the owner could not tell what had been sent).
//
// Next to them one owner chat, «🌐 <assistant> — همه» (the global chat): every mother's outcome lands
// there as a note, and the owner talks to the assistant about all of Telegram from it.
import { OWNER, outgoingSignature, PERSONA } from "../persona.mjs";
import { DEFAULT_AGENT } from "../agents/registry.mjs";

const MOTHER_OF = "motherof:"; // motherof:<chatId> -> { integrationId, key, personId, name }
const MOTHER_AT = "mother:"; // mother:<integrationId>:<key> -> chatId
const SUBS = "threadsubs:"; // threadsubs:<childChatId> -> [mother chat ids that joined it]
const GLOBAL = "tg:global"; // -> chatId of the global chat
// A thread about a general issue (an outage, CI, slowness — not one person's own thing): it is listed
// in the main sidebar, every mother may hand it messages, and its result reaches every mother that
// did.
export const SHARED = "sharedthread:"; // sharedthread:<childChatId> -> { by: name, motherChat, at }
export const isSharedThread = (store, chatId) => Boolean(chatId) && Boolean(store.getKv(`${SHARED}${chatId}`));

// Who the assistant watches: the owner's per-person switch (person.access.watch), else everyone
// marked «team».
export const watching = (person) => (typeof person?.access?.watch === "boolean" ? person.access.watch : person?.category === "team");

export function motherInfo(store, chatId) {
  return chatId ? store.getKv(`${MOTHER_OF}${chatId}`) : null;
}

export function motherChatId(store, integrationId, key) {
  const id = store.getKv(`${MOTHER_AT}${integrationId}:${key}`);
  return id && store.getChat(id) ? id : null;
}

/** The person's mother chat: reused (unarchived if needed) or created. */
export function ensureMother(store, { integrationId, key, person = null, name, agent, model = null }) {
  const existing = motherChatId(store, integrationId, key);
  if (existing) {
    if (store.getChat(existing).archived) store.updateChat(existing, { archived: false });
    return existing;
  }
  const chat = store.createChat({
    title: `👤 ${name || key}`,
    mode: "agent",
    model,
    caller: "team",
    agent,
    personId: person?.id || null,
  });
  store.setKv(`${MOTHER_AT}${integrationId}:${key}`, chat.id);
  store.setKv(`${MOTHER_OF}${chat.id}`, { integrationId, key: String(key), personId: person?.id || null, name: name || key });
  return chat.id;
}

export const isGlobalChat = (store, chatId) => Boolean(chatId) && store.getKv(GLOBAL) === chatId;

/** The global chat, made once. An ordinary owner chat, linked to no Telegram chat. */
export function ensureGlobal(store) {
  const id = store.getKv(GLOBAL);
  const chat = id ? store.getChat(id) : null;
  if (chat) {
    if (chat.archived) store.updateChat(id, { archived: false });
    return id;
  }
  const made = store.createChat({ title: `🌐 ${PERSONA.name} — همه`, mode: "agent", caller: "owner", agent: DEFAULT_AGENT });
  store.setKv(GLOBAL, made.id);
  return made.id;
}

export function allMothers(store) {
  return store.db
    .prepare("SELECT key, value FROM kv WHERE key LIKE ?")
    .all(`${MOTHER_OF}%`)
    .map((row) => {
      try {
        return { chatId: row.key.slice(MOTHER_OF.length), ...JSON.parse(row.value) };
      } catch {
        return null;
      }
    })
    .filter((m) => m && store.getChat(m.chatId));
}

// Threads = delegated subtasks of mother chats that are still running or owe a report.
export function openThreads(store) {
  const mothers = new Map(allMothers(store).map((m) => [m.chatId, m]));
  return store.db
    .prepare("SELECT key, value FROM kv WHERE key LIKE 'delegate:%'")
    .all()
    .map((row) => {
      try {
        const d = JSON.parse(row.value);
        const childId = row.key.slice("delegate:".length);
        const mother = mothers.get(d.parent);
        if (!mother || !["running", "done"].includes(d.state)) return null;
        const chat = store.getChat(childId);
        if (!chat) return null;
        const shared = isSharedThread(store, childId);
        return { thread: childId, title: chat.title, person: mother.name, personId: mother.personId || null, motherChat: d.parent, state: d.state, ...(shared ? { shared: true, waiting: joinedNames(store, childId) } : {}) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Mother names follow the person's (Persian) name: the kv entry, and the chat title while it is
 *  still the one ensureMother gave it. Returns how many mothers changed. */
export function syncMotherNames(store) {
  // One light read of every name: getPerson per mother parsed each person's whole history.
  const names = new Map(store.listPersonsLight().map((p) => [p.id, p.display_name]));
  let changed = 0;
  for (const m of allMothers(store)) {
    const name = m.personId && names.get(m.personId);
    if (!name || name === m.name) continue;
    const { chatId, ...value } = m;
    store.setKv(MOTHER_OF + chatId, { ...value, name });
    if (store.getChat(chatId)?.title === `👤 ${m.name}`) store.updateChat(chatId, { title: `👤 ${name}` });
    changed++;
  }
  return changed;
}

/** Mother chats that joined a thread besides its own parent, by name. */
export const joinedNames = (store, thread) => (store.getKv(`${SUBS}${thread}`) || []).map((id) => motherInfo(store, id)?.name).filter(Boolean);

/** A mother chat starts waiting on a thread: its result is reported there too (watchJoinedThreads). */
export function subscribe(store, thread, motherChat) {
  const subs = new Set(store.getKv(`${SUBS}${thread}`) || []);
  if (subs.has(motherChat)) return false;
  subs.add(motherChat);
  store.setKv(`${SUBS}${thread}`, [...subs]);
  return true;
}

/** A mother chat (chatId, the person called `name`) joins another person's open thread on the same issue. */
export async function joinThread(store, runner, { thread, chatId, name, note = "" }) {
  const target = openThreads(store).find((t) => t.thread === thread);
  if (!target) return { error: "no such open thread; call team_threads" };
  subscribe(store, thread, chatId);
  const text = `[«${name}» هم همین مسئله را دارد${note ? `: ${String(note).slice(0, 400)}` : ""} — نتیجه به او هم می‌رسد]`;
  await runner.send(thread, { text, images: [], intent: runner.isActive(thread) ? "steer" : "queue" }).catch(() => {});
  return { joined: thread, title: target.title, owner: target.person };
}

// The delivery rules of a mother chat. They replace teamContext's «your final text is what the
// colleague receives» bullets (prompt.mjs, buildRules({ mother: true })), so one prompt never says both.
export function motherContext(name) {
  return `
This is the standing chat with «${name}» — every message they send reaches you here, and this chat never
closes (there is no end_agent). Nothing you write here reaches them by itself:
- send_to_person {text} is the ONLY way a message reaches «${name}». It goes out from ${OWNER.name}'s account,
  signed «${outgoingSignature()}», as a reply to their latest message; replyTo:"#id" replies to an earlier
  one (their lines carry (#id)). react {emoji, id?} puts a reaction on a message instead of writing:
  an «اوکی», a «حل شد», a done → 👍 / 🙏 / ❤ is often the whole answer. (A greeting or a thanks on its
  own never reaches you: it waits for their next real message.) «[NO_REPLY]» anywhere in your rules
  means here: do not call send_to_person. If it (or edit_sent / delete_sent) answers {held: true},
  nothing reached them: it waits for ${OWNER.name} as a draft (reason owner_replied: he wrote to them himself;
  paused / unwatched: he stopped the answers) — say so in your report and do not try again.
- Agents talk to agents on the agents' network, not in Telegram (owner 2026-10-20). If «${name}» is a
  colleague's own assistant (it signs its messages, or it is a bot) its install is on the network
  (network_agents; the colleague's name is its owner): send_to_person to it is carried there for you —
  queued and delivered by itself while that agent is updating or offline, its answer waking this chat —
  so an update is never a reason to wait or to look for another way. To start a talk with a colleague's
  agent yourself, use network_ask. A «not on the network» answer means: network_agents, network_connect
  {url}, and only after that telegram_because. Telegram is for people.
- Every colleague message gets send_to_person, a reaction, or nothing. Small talk, thanks, a joke: a
  reaction or one short send, or nothing.
- A message marked «… دقیقه پیش وقتی در حال آپدیت بودی رسید» waited while you were restarting: when you
  write to them about it, start with half a line saying the delay was your update («ببخشید، در حال
  آپدیت بودم»), so they know you were updating, not dead.
- Real work (a fix, an access request, an investigation): open a thread — one \`delegate\` per issue,
  a short clear title as the first line of the request — and send one short line («دارم بررسی می‌کنم»).
- A follow-up about work already open: \`subtasks\` list, then \`steer\` that thread. Never a second
  thread for the same issue. Their review or follow-up on work ${OWNER.name} or one of his sessions started
  (an MR, a fix) is work too: a thread for you, never a chore for ${OWNER.name}.
- ${OWNER.name}'s own chats are threads too. The turn starts with «[کارهای خودِ …]»: his recent working chats
  (and any that wrote to «${name}»), each with its title and the last things he asked in it. Judge every
  message of theirs against those tasks: forward_to_chat {chat, why} only when it plainly continues
  one — that chat wrote to them or asked for exactly this, or the message is about the very thing that
  chat is doing (the same system and the same problem in its title or asks). The same product, the
  same servers or a nearby topic is not enough: a message about an install being down does not belong
  to a chat that updates installs. Then send nothing to them yourself; the chat's agent carries it on.
  Anything else is yours as usual. Decide per message, not per person; when in doubt, keep it — a
  wrong hand-over lands in the middle of ${OWNER.name}'s own work. The same list carries open shared threads
  («رشتهٔ عمومی»): the same general issue from «${name}» → forward_to_chat to it (its result comes
  back here), and tell them in one short line that it is being handled. A «[حادثه‌های باز اتاق
  عملیات]» line lists alerts firing right now: «${name}» reporting that very problem (the site or a
  service down, slow, erroring) → forward_to_chat {chat: "incident:…"} (the ops room takes it as the
  human evidence) and tell them yourself in one short line that it is known and being looked at — no
  thread of yours for it.
- Before opening a thread, \`team_threads\`: if someone else has an open thread on the very same issue,
  \`thread_join\` it (its result comes here too) and tell them it is being handled.
- A general issue — not «${name}»'s own thing but something others hit or will hit too (a site or
  service down or slow, CI/runners broken, a shared tool, an alert-like report) — gets a shared
  thread: \`delegate\` with shared:true. It is listed in ${OWNER.name}'s main list, others' messages on it
  join it, and its result comes back here (and to everyone who joined). Their own app, their own
  access, their own question stay an ordinary thread.
- A thread reports back: send_to_person with the result, as one message.
- You manage what you already sent. When some of your messages to «${name}» are still unanswered, the
  turn starts with «[پیام‌هایی که … فرستاده‌ای …]» listing them (#id, time, text). Before sending,
  look at it: one message per turn; an interim line («دارم بررسی می‌کنم») that is now stale → edit_sent
  it instead of a second interim line; a final result → a new send_to_person (an edit does not notify
  them), then delete_sent the interim line it replaced if it would confuse; a wrong message → edit_sent
  it with the correction, or delete_sent and say so. Never send the same thing twice.
- «${OWNER.nameFa} در تلگرام به ${name}» / «جلسهٔ Claude ${OWNER.nameFa} …» while you are working means he, or one of his
  Claude sessions, is on this same issue now. Do not duplicate it: \`subtasks\` list, then either step
  back (cancel the threads he now covers, send nothing) or keep only a part he is not doing. Your final
  text says which, and what you already did or changed, so he and his session know.
  Such a line covers only the issue it names, and only while it is fresh: a new request of theirs (an
  access request, another finding) that came more than 30 minutes after the last «${OWNER.nameFa} …» /
  «جلسهٔ Claude …» line, or on a different issue, is yours — handle it as usual.
- «${OWNER.nameFa} از داخل اپ …» is ${OWNER.name} writing to you privately: answer it in your final text; use
  send_to_person only if he asks you to tell «${name}» something.
- Your final text is NEVER sent to anyone. It is a one- or two-line Persian report for ${OWNER.name}, the way a
  watcher would put it: «علی پرسیده بود …؛ جواب دادم …» / «… منتظر شماست» / «پیام خودمانی بود، جواب ندادم».
- Several of their messages may arrive in one turn: handle them together.
`;
}

export function globalContext() {
  return `
This is ${PERSONA.name}'s Telegram desk («🌐 ${PERSONA.name} — همه»). ${PERSONA.name} answers ${OWNER.name}'s colleagues
on his Telegram account: each watched person has a mother chat where their messages land, and real work
becomes a thread beside it. Reports from those chats arrive here as notes (read them with feed_read).
What ${OWNER.name} writes here reaches only you, never a colleague. Answer in short Persian.
- Who is watched and how each conversation stands: telegram_people. Open threads: team_threads.
- To tell a colleague something: tell_person {person, text} — it goes to that person's mother chat as
  ${OWNER.name}'s note, and that chat decides what to send. A person whose watcher is off cannot be told; say so.
- The same issue from someone else: thread_join {thread, person}.
- Stop or resume all automatic answers: telegram_pause {paused}.
- «👁» notes are the desk's own supervisor (code, every 10 minutes): a person who got many messages, a
  conversation stuck with nothing running, drafts waiting for ${OWNER.name}, the same issue from two people.
  If ${OWNER.name} asks about one, look at that mother chat (feed_read, telegram_people) and say what to do.
`;
}

const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** send_to_person / edit_sent / delete_sent / team_threads / thread_join for one mother chat. */
export function createMotherTools({ store, runner, chatId, name, sendToPerson, editSent = async () => ({ error: "not available" }), deleteSent = async () => ({ error: "not available" }), react = async () => ({ error: "not available" }), forwardToChat = async () => ({ error: "not available" }) }) {
  return {
    send_to_person: {
      description: `Send a message to «${name}» in Telegram, from ${OWNER.name}'s account (signed by ${PERSONA.name}). The only way anything you write reaches them. Plain Persian, short. Returns {sent:true}, or {held:true, reason} when ${OWNER.name} wrote to them himself meanwhile or stopped the answers (nothing was sent).`,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 3800 },
          replyTo: { type: "string", description: "reply to this message of theirs instead of the latest, e.g. \"812\" (the (#812) on their line)" },
          telegram_because: { type: "string", description: "only for a colleague's AGENT with no path on the agents' network: one line on what you tried (network_agents, network_connect). Never for a human." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      async execute({ text, replyTo = null, telegram_because: because = "" }) {
        return ok(await sendToPerson(String(text || ""), { ...(replyTo ? { replyTo } : {}), ...(because ? { telegramBecause: because } : {}) }));
      },
    },
    react: {
      description: `React on a message in the chat with «${name}» instead of writing (a thanks, an «اوکی», a done): 👍 ❤ 🙏 👌 🔥 👏 🤝 👀 ✍ 🫡 💯 😁 🎉 🤔. Without id: the message this turn answers. emoji "" takes your reaction back.`,
      inputSchema: {
        type: "object",
        properties: {
          emoji: { type: "string", description: "one of the reactions above, or \"\" to take yours back" },
          id: { type: "string", description: "a message id, e.g. \"812\" (default: the message this turn answers)" },
        },
        required: ["emoji"],
        additionalProperties: false,
      },
      async execute({ emoji, id = null }) {
        return ok(await react(id, emoji));
      },
    },
    edit_sent: {
      description: `Change a message you already sent to «${name}» (id from send_to_person or the «[پیام‌هایی که … فرستاده‌ای]» line): an interim line now out of date, or a correction. An edit does not notify them — a new result is a new send_to_person.`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "the message id, e.g. \"812\" (a leading # is fine)" }, text: { type: "string", minLength: 1, maxLength: 3800 } },
        required: ["id", "text"],
        additionalProperties: false,
      },
      async execute({ id, text }) {
        return ok(await editSent(id, String(text || "")));
      },
    },
    delete_sent: {
      description: `Take back a message you sent to «${name}» (deleted for both sides): an interim line a newer message replaced, or one sent by mistake.`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "the message id, e.g. \"812\" (a leading # is fine)" } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute({ id }) {
        return ok(await deleteSent(id));
      },
    },
    forward_to_chat: {
      description: `Hand «${name}»'s message(s) of this turn to one of ${OWNER.name}'s own chats (the «[کارهای خودِ …]» line lists them: chat id, title, what he asked in it), when the message belongs to what that chat is doing, or to an open shared thread on the same general issue. That chat's agent then carries the conversation (a chat at work gets it at once, mid-turn); you send nothing to «${name}» about it — except, for a shared thread or an incident, one short line that it is being handled. chat "incident:<id>" (from the «[حادثه‌های باز اتاق عملیات]» line) hands it to the ops room for that incident. note: one optional line for that chat.`,
      inputSchema: {
        type: "object",
        properties: { chat: { type: "string", description: "the chat id from the «[کارهای خودِ …]» line, or incident:<id> from the «[حادثه‌های باز اتاق عملیات]» line" }, why: { type: "string", description: "one line: what in that chat's own work (its title or what it asked) this message continues — the same system and problem, not just a nearby topic" }, note: { type: "string" } },
        required: ["chat", "why"],
        additionalProperties: false,
      },
      async execute({ chat, why = "", note = "" }) {
        return ok(await forwardToChat(chat, note, why));
      },
    },
    team_threads: {
      description: "Open threads (delegated subtasks) across all colleagues' mother chats: thread id, title, whose it is. Use before opening a new thread to spot the same issue reported by someone else.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return ok({ threads: openThreads(store).filter((t) => t.motherChat !== chatId) });
      },
    },
    thread_join: {
      description: "Join another colleague's open thread on the same issue: its result is reported here too, and the thread learns that this person is waiting on it as well.",
      inputSchema: {
        type: "object",
        properties: {
          thread: { type: "string", description: "thread id from team_threads" },
          note: { type: "string", description: "what this person reported, one line" },
        },
        required: ["thread"],
        additionalProperties: false,
      },
      async execute({ thread, note = "" }) {
        return ok(await joinThread(store, runner, { thread, chatId, name, note }));
      },
    },
  };
}

/** A joined thread's result reaches every mother that joined it (its own parent hears it anyway). */
export function watchJoinedThreads({ store, runner, finalTextOf, log = console }) {
  store.bus.on("event", (chatId, event) => {
    if (event?.type !== "run.finished") return;
    const subs = store.getKv(`${SUBS}${chatId}`);
    if (!Array.isArray(subs) || !subs.length) return;
    Promise.resolve(finalTextOf(chatId))
      .then((text) => {
        const title = store.getChat(chatId)?.title || "رشته";
        for (const mother of subs) {
          if (!store.getChat(mother)) continue;
          const body = `[گزارش رشتهٔ مشترک «${title}» (${event.data?.status || "finished"})]\n${String(text || "(بی‌متن)").slice(0, 4000)}`;
          runner.send(mother, { text: body, images: [], intent: runner.isActive(mother) ? "queue" : "send" }).catch((error) => log.error?.(`[mother] joined report: ${error.message}`));
        }
      })
      .catch((error) => log.error?.(`[mother] joined report: ${error.message}`));
  });
}

// Telegram v2, once: the per-message threads of before (thread_links) close unless something is
// still going on in them; mother chats keep only their pointer; empty mothers go; the global chat
// is made (where a Telegram account is connected; elsewhere on its first note). A kv flag makes a
// second run a no-op.
/** Once: a watched person whose old «دسترسی» flag is still off (access.enabled false, from before
 *  Telegram v2) got no answer at all — the watcher is the one switch now. */
export function migrateWatchEnables(store) {
  if (store.getKv("migr:watch-enables")) return 0;
  let fixed = 0;
  for (const p of store.listPersons({ source: "telegram" }) || []) {
    if (p.access?.watch === true && p.access?.enabled === false) {
      store.updatePerson(p.id, { access: { ...p.access, enabled: true } });
      fixed += 1;
    }
  }
  store.setKv("migr:watch-enables", { at: new Date().toISOString(), fixed });
  return fixed;
}

export function migrateTelegramV2(store, { isActive = () => false, isWaiting = () => false } = {}) {
  if (store.getKv("migr:telegram-v2")) return false;
  const mothers = new Set(allMothers(store).map((m) => m.chatId));
  const liveDelegate = (parent) =>
    store.db.prepare("SELECT value FROM kv WHERE key LIKE 'delegate:%'").all().some((row) => {
      try {
        const d = JSON.parse(row.value);
        return d.parent === parent && ["running", "done"].includes(d.state);
      } catch {
        return false;
      }
    });
  for (const { chat_id: id } of store.db.prepare("SELECT DISTINCT chat_id FROM thread_links WHERE closed_at IS NULL").all()) {
    if (mothers.has(id) || isActive(id) || isWaiting(id) || liveDelegate(id)) continue;
    store.closeThread(id);
    if (store.getChat(id) && !store.getChat(id).archived) store.updateChat(id, { archived: true });
  }
  for (const id of mothers) store.db.prepare("DELETE FROM thread_links WHERE chat_id = ?").run(id);
  const said = store.db.prepare("SELECT 1 FROM events WHERE chat_id = ? AND type = 'user' LIMIT 1");
  for (const m of allMothers(store)) {
    if (said.get(m.chatId)) continue;
    store.deleteChat(m.chatId);
    store.deleteKv(`${MOTHER_OF}${m.chatId}`);
    store.deleteKv(`${MOTHER_AT}${m.integrationId}:${m.key}`);
  }
  if (store.listIntegrations().some((i) => i.kind === "telegram_account")) ensureGlobal(store);
  store.setKv("migr:telegram-v2", 1);
  return true;
}
