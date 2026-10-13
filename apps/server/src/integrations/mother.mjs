// Mother chats: the assistant orchestrates the owner's Telegram like a watcher would. Every watched
// Telegram person (or team group) has one standing chat. Each of their messages lands there and the
// agent decides: answer, open a thread for real work (a delegated subtask), steer an open thread, or
// join another person's thread
// when it is the same issue. The chat never closes, and nothing it writes reaches the colleague by
// itself: only send_to_person does (Telegram v2 — the owner could not tell what had been sent).
//
// Next to them one owner chat, «🌐 <assistant> — همه» (the global chat): every mother's outcome lands
// there as a note, and the owner talks to the assistant about all of Telegram from it.
import { OWNER_NAME } from "../owner.mjs";
import { PERSONA } from "../persona.mjs";
import { DEFAULT_AGENT } from "../agents/registry.mjs";

const MOTHER_OF = "motherof:"; // motherof:<chatId> -> { integrationId, key, personId, name }
const MOTHER_AT = "mother:"; // mother:<integrationId>:<key> -> chatId
const SUBS = "threadsubs:"; // threadsubs:<childChatId> -> [mother chat ids that joined it]
const GLOBAL = "tg:global"; // -> chatId of the global chat

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
        return chat ? { thread: childId, title: chat.title, person: mother.name, personId: mother.personId || null, motherChat: d.parent, state: d.state } : null;
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

/** A mother chat (chatId, the person called `name`) joins another person's open thread on the same issue. */
export async function joinThread(store, runner, { thread, chatId, name, note = "" }) {
  const target = openThreads(store).find((t) => t.thread === thread);
  if (!target) return { error: "no such open thread; call team_threads" };
  const subs = new Set(store.getKv(`${SUBS}${thread}`) || []);
  subs.add(chatId);
  store.setKv(`${SUBS}${thread}`, [...subs]);
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
- send_to_person {text} is the ONLY way a message reaches «${name}». It goes out from ${OWNER_NAME}'s account,
  signed «— ${PERSONA.name}», as a reply to their latest message. «[NO_REPLY]» anywhere in your rules
  means here: do not call send_to_person. If it (or edit_sent / delete_sent) answers {held: true},
  nothing reached them: it waits for ${OWNER_NAME} as a draft (reason owner_replied: he wrote to them himself;
  paused / unwatched: he stopped the answers) — say so in your report and do not try again.
- Every colleague message gets either send_to_person or nothing. Small talk, thanks, a joke: one short
  send, or nothing.
- Real work (a fix, an access request, an investigation): open a thread — one \`delegate\` per issue,
  a short clear title as the first line of the request — and send one short line («دارم بررسی می‌کنم»).
- A follow-up about work already open: \`subtasks\` list, then \`steer\` that thread. Never a second
  thread for the same issue.
- Before opening a thread, \`team_threads\`: if someone else has an open thread on the very same issue,
  \`thread_join\` it (its result comes here too) and tell them it is being handled.
- A thread reports back: send_to_person with the result, as one message.
- You manage what you already sent. When some of your messages to «${name}» are still unanswered, the
  turn starts with «[پیام‌هایی که … فرستاده‌ای …]» listing them (#id, time, text). Before sending,
  look at it: one message per turn; an interim line («دارم بررسی می‌کنم») that is now stale → edit_sent
  it instead of a second interim line; a final result → a new send_to_person (an edit does not notify
  them), then delete_sent the interim line it replaced if it would confuse; a wrong message → edit_sent
  it with the correction, or delete_sent and say so. Never send the same thing twice.
- «${OWNER_NAME} از داخل گریفین …» is ${OWNER_NAME} writing to you privately: answer it in your final text; use
  send_to_person only if he asks you to tell «${name}» something.
- Your final text is NEVER sent to anyone. It is a one- or two-line Persian report for ${OWNER_NAME}, the way a
  watcher would put it: «علی پرسیده بود …؛ جواب دادم …» / «… منتظر شماست» / «پیام خودمانی بود، جواب ندادم».
- Several of their messages may arrive in one turn: handle them together.
`;
}

export function globalContext() {
  return `
This is ${PERSONA.name}'s Telegram desk («🌐 ${PERSONA.name} — همه»). ${PERSONA.name} answers ${OWNER_NAME}'s colleagues
on his Telegram account: each watched person has a mother chat where their messages land, and real work
becomes a thread beside it. Reports from those chats arrive here as notes (read them with feed_read).
What ${OWNER_NAME} writes here reaches only you, never a colleague. Answer in short Persian.
- Who is watched and how each conversation stands: telegram_people. Open threads: team_threads.
- To tell a colleague something: tell_person {person, text} — it goes to that person's mother chat as
  ${OWNER_NAME}'s note, and that chat decides what to send. A person whose watcher is off cannot be told; say so.
- The same issue from someone else: thread_join {thread, person}.
- Stop or resume all automatic answers: telegram_pause {paused}.
- «👁» notes are the desk's own supervisor (code, every 10 minutes): a person who got many messages, a
  conversation stuck with nothing running, drafts waiting for ${OWNER_NAME}, the same issue from two people.
  If ${OWNER_NAME} asks about one, look at that mother chat (feed_read, telegram_people) and say what to do.
`;
}

const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** send_to_person / edit_sent / delete_sent / team_threads / thread_join for one mother chat. */
export function createMotherTools({ store, runner, chatId, name, sendToPerson, editSent = async () => ({ error: "not available" }), deleteSent = async () => ({ error: "not available" }) }) {
  return {
    send_to_person: {
      description: `Send a message to «${name}» in Telegram, from ${OWNER_NAME}'s account (signed by ${PERSONA.name}). The only way anything you write reaches them. Plain Persian, short. Returns {sent:true}, or {held:true, reason} when ${OWNER_NAME} wrote to them himself meanwhile or stopped the answers (nothing was sent).`,
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", minLength: 1, maxLength: 3800 } },
        required: ["text"],
        additionalProperties: false,
      },
      async execute({ text }) {
        return ok(await sendToPerson(String(text || "")));
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
