// The assistant's Telegram desk (Telegram v2: what happens in Telegram, made understandable).
// What happens to every colleague message, decided here and recorded — never dropped in silence:
//   - a watched person's message runs their mother chat (mother.mjs), unless the owner was just in
//     that conversation himself (R3), a timed pickup batches it, or the hourly brake holds it;
//   - only send_to_person reaches the colleague, and it holds a draft if the owner wrote to them since
//     the turn's input was handed over (R2), or answers are paused, or their watcher is off;
//   - every outcome is a state per person (tgstate:<personId>), a ring entry (tgfeed) and a note in
//     the global chat;
//   - the assistant manages what it sent itself (no cap — a cap could stop the result; it notices and
//     manages its own messages): every turn starts with its unanswered messages to that person
//     (annotate), and edit_sent / delete_sent change them; nothing is blocked by a count;
//   - a burst of messages becomes one turn (burstMs), and a supervisor (sweep) notes in the global chat
//     what needs the owner's eye: a flood, a stuck conversation, drafts waiting, the same issue twice.
import { randomBytes } from "node:crypto";
import { OWNER_NAME } from "../owner.mjs";
import { PERSONA } from "../persona.mjs";
import { finalText, foldEvents, lastRun } from "@griffin/timeline";
import { coverageOwnerNote } from "./coverage.mjs";
import { ensureGlobal, joinThread, joinedNames, motherChatId, motherInfo, openThreads, allMothers, watching } from "./mother.mjs";
import { isNoReply } from "./peer-agent.mjs";
import { markdownToPlain } from "./format.mjs";
import { keptIds } from "../runner.mjs";
import { threadInboundPrompt, threadOwnerPrompt, wantsGriffin } from "./threads.mjs";

const OWNER_QUIET_MS = 10 * 60_000; // the owner wrote: his colleague's next messages wait this long
const RUNS_PER_HOUR = 20; // ping-pong brake between two agents, per person
const BRAKE_MS = 15 * 60_000;
const NOTE_EVERY_MS = 60 * 60_000; // an «unwatched» / «paused» note at most once an hour per person
const BURST_CAP = 4; // a burst waits at most this many burst windows after its first message
const SENT_KEEP = 40; // the assistant's sends remembered per person (tgsent:<personId>)
const UNANSWERED_MS = 24 * 3_600_000; // older sends are not «unanswered» any more
const SWEEP_MS = 10 * 60_000; // the supervisor
const FLOOD = { count: 4, ms: 30 * 60_000 }; // this many sends to one person within ms = a flood
const STALE_MS = 20 * 60_000; // working/queued this long with nothing running = stuck
const SAME_ISSUE_MS = 30 * 60_000;
const MAX_TEXT = 3800; // one Telegram message with the signature
const CATCH_UP_GRACE_MS = 5 * 60_000; // at boot, queued batches wait for the account's catch-up at most this long
// Telegram's answer to a change that cannot be made now or ever — not worth keeping a draft for.
const PERMANENT = /MESSAGE_NOT_MODIFIED|EDIT_TIME_EXPIRED|MESSAGE_ID_INVALID|no longer in the chat/i;
const SEEN_MS = 2 * 3_600_000; // one supervisor note per finding in this window
const FEED = "tgfeed";
const FEED_MAX = 300;
const WAITING = "tgwaiting";
const ownerKey = (integrationId, key) => `tgowner:${integrationId}:${key}`;
const PICKUP = (integrationId) => `pickup:${integrationId}`;
const fa = (n) => Number(n).toLocaleString("fa-IR");
const clock = (ms) => new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const isGroup = (p) => String(p.external_id).startsWith("-") || ["group", "channel"].includes(p.meta?.chatType);
// Sent as the owner to a colleague: no emoji (his voice), enforced here, not asked for.
const plain = (text) => String(text || "").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/[ \t]+\n/g, "\n").trim();

export function createDesk({ store, runner, channelOf, accountChannel = () => null, motherChat, timelines = null, pendingWork = () => 0, burstMs = 0, log = console, now = Date.now }) {
  const runs = new Map(); // peer key -> run timestamps of the last hour (the brake)
  const turns = new Map(); // mother chatId -> { sent: [texts], changed: [lines], held } for the turn in flight
  let recentIn = []; // watched people's messages of the last SAME_ISSUE_MS (the supervisor's same-issue check)
  // R3 at boot: what the owner answered while the app was down is recorded by the account's
  // catch-up; until it reports (caughtUp), that account's queued batches do not run.
  const bootAt = now();
  const catchingUp = new Set();
  const held = (integrationId) => catchingUp.has(integrationId) && now() - bootAt < CATCH_UP_GRACE_MS;
  const noted = new Map(); // `${kind}:${personId}` -> ms of the last such note
  const iso = () => new Date(now()).toISOString();

  // ---- state, feed, waiting ----
  function setState(personId, state, line) {
    if (personId) store.setKv(`tgstate:${personId}`, { state, line, at: iso() });
  }
  function note(data) {
    const chatId = ensureGlobal(store);
    store.appendEvent(chatId, null, "tg.note", data);
    store.setKv(FEED, [...(store.getKv(FEED) || []), { ...data, at: iso() }].slice(-FEED_MAX));
  }
  function outcome(who, state, line, extra = {}) {
    setState(who.personId, state, line);
    note({ kind: "report", personId: who.personId || null, name: who.name, chatId: who.chatId || null, state, text: line, ...extra });
  }
  const once = (kind, personId) => {
    const at = noted.get(`${kind}:${personId}`) || 0;
    if (now() - at < NOTE_EVERY_MS) return false;
    noted.set(`${kind}:${personId}`, now());
    return true;
  };
  const waitingList = () => store.getKv(WAITING) || [];
  function addWaiting(item) {
    const full = { id: randomBytes(6).toString("hex"), at: iso(), ...item };
    store.setKv(WAITING, [...waitingList(), full].slice(-200));
    return full;
  }
  function takeWaiting(id) {
    const list = waitingList();
    const item = list.find((w) => w.id === id) || null;
    if (item) store.setKv(WAITING, list.filter((w) => w.id !== id));
    return item;
  }
  // A chat's «ارسال نشد» card: one per chat, gone once that chat gets through again.
  const dropFailed = (chatId) => store.setKv(WAITING, waitingList().filter((w) => !(w.kind === "failed" && w.chatId === chatId)));
  const publicWaiting = ({ id, kind, op = null, msgId = null, reason = null, personId, name, chatId, text, at }) => ({ id, kind, op, msgId, reason, personId, name, chatId, text, at });

  const paused = (integrationId) => store.getIntegration(integrationId)?.settings?.autoThreads === false;
  const accountId = () => store.listIntegrations().find((i) => i.kind === "telegram_account")?.id || null;
  function pausedNote(person, name) {
    setState(person.id, "paused", "پاسخ خودکار کلاً خاموش است");
    if (once("paused", person.id)) note({ kind: "paused", personId: person.id, name, chatId: null, text: "پاسخ خودکار خاموش است؛ پیامش بی‌جواب ماند" });
    return "paused";
  }

  // ---- owner presence (R2/R3): the owner's own lines in a colleague's chat ----
  // `at`: when he wrote it (a line caught up after a restart is older than now).
  function ownerLine(integrationId, key, { text, by = "owner", person = null, at = now() }) {
    const current = store.getKv(ownerKey(integrationId, key)) || {};
    store.setKv(ownerKey(integrationId, key), { at: Math.max(current.at || 0, at), lines: [...(current.lines || []), { text, by, at }].slice(-10) });
    person = person || store.findPerson(key);
    // A line another session sent is marked ours, so the account never records it; the history should.
    if (by === "session" && person) store.addPersonMessage({ personId: person.id, direction: "out", text, data: { chatId: key, by } });
    const chatId = motherChatId(store, integrationId, key);
    if (chatId) store.appendEvent(chatId, null, "tg.note", { kind: "owner_line", name: by === "owner" ? "شما" : "جلسهٔ دیگر", text, by, personId: person?.id || null });
  }
  // A mother turn's text: the owner's lines since the mother last heard (then cleared; their time
  // stays) and the colleague's messages, in the order they were written.
  function transcript(integrationId, key, name, items, extra = []) {
    const current = store.getKv(ownerKey(integrationId, key));
    const lines = current?.lines || [];
    if (lines.length) store.setKv(ownerKey(integrationId, key), { ...current, lines: [] });
    return [
      ...lines.map((l) => ({ at: l.at, text: threadOwnerPrompt({ name, text: l.text }) })),
      ...items.map((i) => ({ at: i.at ?? now(), text: threadInboundPrompt({ name, text: i.text }) })),
      ...extra,
    ]
      .sort((a, b) => a.at - b.at)
      .map((x) => x.text)
      .join("\n");
  }
  function takeBatch(integrationId, key) {
    const all = store.getKv(PICKUP(integrationId)) || {};
    const batch = all[key] || null;
    if (batch) {
      delete all[key];
      store.setKv(PICKUP(integrationId), all);
    }
    return batch;
  }

  // ---- routing ----
  function brakeOk(key) {
    const recent = (runs.get(key) || []).filter((t) => now() - t < 3_600_000);
    if (recent.length >= RUNS_PER_HOUR) return false;
    runs.set(key, [...recent, now()]);
    return true;
  }

  // ponytail: a batch carries text only; photos sent while it waits are not attached.
  function queue(integrationId, key, person, name, items, due, why) {
    const all = store.getKv(PICKUP(integrationId)) || {};
    const batch = all[key] || { due, items: [], opened: now() };
    batch.due = Math.max(batch.due || 0, due);
    batch.items.push(...items.map((i) => ({ id: i.id ?? null, text: i.text, at: i.at ?? now() })));
    all[key] = batch;
    store.setKv(PICKUP(integrationId), all);
    setState(person.id, "queued", `${why} — در صف تا ${clock(batch.due)}`);
    log.info?.(`[desk] queued peer=${key} items=${batch.items.length} due=${new Date(batch.due).toISOString()} (${why})`);
    armWake();
    return "queued";
  }

  /** A watched person's message (or a group mention). byOwner: the owner's /agent, past every gate.
   *  at: when it was written, for a message caught up after a restart (else now). */
  async function colleague(integrationId, key, { person, name, text, images = [], messageId = null, called = false, byOwner = false, at = null }) {
    if (!person) return null;
    name = name || person.display_name || String(key);
    if (paused(integrationId) && !byOwner) return pausedNote(person, name);
    const item = { id: messageId, text, at: at ?? now() };
    // The supervisor's same-issue check: what reached the desk, with when it was written.
    if (String(text || "").trim().length >= 15 && now() - item.at < SAME_ISSUE_MS) {
      recentIn = recentIn.filter((m) => now() - m.at < SAME_ISSUE_MS);
      recentIn.push({ personId: person.id, name, text: String(text), at: item.at });
    }
    const owner = store.getKv(ownerKey(integrationId, key));
    // Caught up: the owner answered it by hand while the account was down (R3).
    if (!byOwner && owner?.at > item.at) return answered(integrationId, key, person, name);
    if (!byOwner && !wantsGriffin(text)) {
      if (owner?.at && now() - owner.at < OWNER_QUIET_MS) return queue(integrationId, key, person, name, [item], owner.at + OWNER_QUIET_MS, "شما همین الان در گفتگو بودید");
      const every = Number(person.access?.pickupEvery) || 0;
      if (every > 0 && !called) return queue(integrationId, key, person, name, [item], now() + every * 60_000, "برداشت زمان‌بندی‌شده");
      // A burst («سلام» «یه سوال» «پایپ‌لاین فیل شده») is one turn: wait burstMs after the latest
      // message, but no longer than BURST_CAP windows after the first. A photo runs now (a batch
      // carries text only), taking what waited before it along.
      if (burstMs > 0 && !called && !images.length) {
        const first = (store.getKv(PICKUP(integrationId)) || {})[key]?.opened ?? now();
        return queue(integrationId, key, person, name, [item], Math.min(now() + burstMs, first + BURST_CAP * burstMs), "جمع کردن پیام‌های پشت‌سرهم");
      }
    }
    // Running now (a call word, a mention, a photo, the owner's /agent): what was waiting before it
    // goes in the same turn, in order — not as a later turn, nor twice when /agent picks a waiting one.
    const taken = takeBatch(integrationId, key)?.items || [];
    const same = taken.find((w) => w.id != null && messageId != null && String(w.id) === String(messageId));
    if (same) item.at = same.at; // /agent on a waiting message: it keeps its place in the order
    if (taken.length) store.setKv(WAITING, waitingList().filter((w) => !(w.kind === "brake" && w.personId === person.id)));
    return run(integrationId, key, person, name, [...taken.filter((w) => w !== same), item], images, { force: byOwner });
  }

  async function run(integrationId, key, person, name, items, images = [], { force = false } = {}) {
    if (!force && !brakeOk(key)) {
      queue(integrationId, key, person, name, items, now() + BRAKE_MS, "بیش از ۲۰ بار در ساعت");
      if (!waitingList().some((w) => w.kind === "brake" && w.personId === person.id)) {
        addWaiting({ kind: "brake", personId: person.id, name, chatId: motherChatId(store, integrationId, key), text: `پیام‌های «${name}» به‌خاطر ترمز (۲۰ اجرا در ساعت) صبر می‌کنند`, integrationId, key });
      }
      return "brake";
    }
    const chatId = await motherChat(integrationId, key, { name, person });
    store.linkChat(integrationId, key, chatId); // the pointer: an owner question from it names this person
    const text = transcript(integrationId, key, name, items);
    store.setKv(`tglastin:${chatId}`, now()); // his lines written before this are in the transcript
    try {
      await runner.send(chatId, { text, images, from: { kind: "colleague", name, personId: person.id, ...(force ? { forced: true } : {}) }, intent: runner.isActive(chatId) ? "queue" : "send" });
    } catch (error) {
      outcome({ personId: person.id, name, chatId }, "failed", `اجرا نشد: ${error.message}`);
      return "failed";
    }
    setState(person.id, "working", "در حال بررسی");
    const last = items.findLast((i) => i.id != null)?.id;
    if (last != null) channelOf(integrationId)?.picked?.(key, last);
    return "run";
  }

  /** The owner hands work over in Telegram («<assistant> کمکتون می‌کنه»): his line runs the mother now,
   *  with what the colleague wrote that was waiting behind him. */
  async function handOff(integrationId, key, { person, name, text }) {
    name = name || person.display_name || String(key);
    const chatId = await motherChat(integrationId, key, { name, person });
    store.linkChat(integrationId, key, chatId);
    const waiting = takeBatch(integrationId, key)?.items || [];
    const lines = transcript(integrationId, key, name, waiting, [{ at: now(), text: threadOwnerPrompt({ name, text }) }]);
    store.setKv(`tglastin:${chatId}`, now());
    // The colleague's words and a line that already reached them: not a private note to edit.
    await runner.send(chatId, { text: lines, images: [], from: { kind: "colleague", name, personId: person.id, forced: true }, intent: runner.isActive(chatId) ? "queue" : "send" });
    setState(person.id, "working", "شما سپردید");
  }

  function unwatched(person, name, text) {
    if (!person || !once("unwatched", person.id)) return;
    note({ kind: "unwatched", personId: person.id, name: name || person.display_name, chatId: null, text: String(text || "").slice(0, 120) });
  }

  function answered(integrationId, key, person, name) {
    outcome({ personId: person.id, name, chatId: motherChatId(store, integrationId, key) }, "owner", "🔇 خودتان جواب دادید");
    return "owner";
  }

  // Due batches (pickup windows, owner presence, the brake) run now — unless the owner answered after
  // the colleague's last message, which is his answer (R3).
  async function drainBatch(integrationId, key, batch, { force = false } = {}) {
    const person = store.findPerson(key);
    const name = person?.display_name || key;
    if (person) store.setKv(WAITING, waitingList().filter((w) => !(w.kind === "brake" && w.personId === person.id)));
    if (!person || !watching(person)) {
      const said = batch.items.map((i) => `«${String(i.text || "").slice(0, 60)}»`).join("، ");
      outcome({ personId: person?.id || null, name, chatId: null }, "paused", `واچر خاموش شد؛ پیام‌های در صف بی‌جواب ماند: ${said}`);
      return "unwatched";
    }
    if (paused(integrationId) && !force) return pausedNote(person, name);
    const owner = store.getKv(ownerKey(integrationId, key));
    const lastAt = Math.max(0, ...batch.items.map((i) => i.at || 0));
    if (owner?.at > lastAt) return answered(integrationId, key, person, name);
    return run(integrationId, key, person, name, batch.items, [], { force });
  }
  async function drain(t = now()) {
    for (const { key: kvKey } of store.db.prepare("SELECT key FROM kv WHERE key LIKE 'pickup:%'").all()) {
      const integrationId = kvKey.slice("pickup:".length);
      if (held(integrationId)) continue;
      const all = store.getKv(kvKey) || {};
      const due = Object.entries(all).filter(([, b]) => b.due <= t);
      if (!due.length) continue;
      for (const [key] of due) delete all[key];
      store.setKv(kvKey, all);
      for (const [key, batch] of due) await drainBatch(integrationId, key, batch).catch((error) => log.error?.(`[desk] drain ${key}: ${error.message}`));
    }
    armWake();
  }
  // The 30 s interval is coarse for a 45 s burst: one timer at the earliest due batch.
  let wake = null;
  function armWake() {
    if (!timer) return; // not started (tests drive drain() themselves)
    let next = Infinity;
    for (const { key: kvKey, value } of store.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'pickup:%'").all()) {
      if (held(kvKey.slice("pickup:".length))) continue;
      for (const batch of Object.values(JSON.parse(value))) next = Math.min(next, batch.due);
    }
    clearTimeout(wake);
    wake = null;
    if (!Number.isFinite(next) || next - now() > 30_000) return; // the interval catches it
    wake = setTimeout(() => drain().catch((error) => log.error?.(`[desk] drain: ${error.message}`)), Math.max(0, next - now()) + 50);
    wake.unref?.();
  }

  // ---- what reaches the colleague (R1/R2) ----
  async function deliver(mother, text, chatId) {
    const channel = channelOf(mother.integrationId);
    if (!channel) return { error: "اکانت تلگرام وصل نیست" };
    let id = null;
    try {
      id = (await channel.deliver(mother.key, { text })) ?? null;
    } catch (error) {
      return { error: error.message };
    }
    if (mother.personId) {
      store.addPersonMessage({ personId: mother.personId, direction: "out", text, data: { chatId, by: "assistant", msgId: id } });
      if (id != null) store.setKv(SENT(mother.personId), [...sentList(mother.personId), { id, at: now(), text, chatId }].slice(-SENT_KEEP));
    }
    return { sent: true, ...(id != null ? { id } : {}) };
  }

  // ---- what the assistant sent (it manages that itself) ----
  const SENT = (personId) => `tgsent:${personId}`;
  const sentList = (personId) => store.getKv(SENT(personId)) || [];
  // Its sends after the person's last message, newest last (deleted ones are gone).
  function unanswered(personId) {
    const lastIn = Date.parse(store.listPersonMessages(personId, 600).findLast((m) => m.direction === "in")?.at || "") || 0;
    return sentList(personId).filter((m) => !m.deleted && m.at > lastIn && now() - m.at < UNANSWERED_MS);
  }
  /** The first line of every mother turn (runner annotate hook): what it already said and they have
   *  not answered — so a thread report or a second interim line becomes an edit, not a new message. */
  function annotate(chatId) {
    const mother = motherInfo(store, chatId);
    if (!mother?.personId) return null;
    const list = unanswered(mother.personId);
    if (!list.length) return null;
    const lines = list.map((m) => `#${m.id} (${clock(m.at)}${m.edited ? "، ویرایش‌شده" : ""}) «${String(m.text).slice(0, 160)}»`).join("\n");
    return `[پیام‌هایی که برای «${mother.name}» فرستاده‌ای و هنوز جوابی نداده (${fa(list.length)}):\n${lines}\nپیش از پیام تازه ببین کدام کهنه شده: خط موقت را با edit_sent به‌روز کن؛ نتیجهٔ نهایی را پیام تازه بفرست (ویرایش اعلان نمی‌دهد) و خط موقتی که جایش را گرفته با delete_sent بردار؛ پیام غلط را با edit_sent درست کن.]`;
  }
  // Mark one of its sends after a change, on the list as it is now (a send may have landed meanwhile).
  function markSent(personId, id, patch) {
    const list = sentList(personId);
    const entry = list.find((m) => String(m.id) === String(id));
    if (entry) Object.assign(entry, patch);
    store.setKv(SENT(personId), list);
  }
  // The Telegram call itself; a message gone on Telegram (deleted by hand) is marked so.
  async function applyChange(mother, id, { remove, body }) {
    const channel = channelOf(mother.integrationId);
    if (!channel?.edit) return { error: "اکانت تلگرام وصل نیست" };
    try {
      if (remove) await channel.remove(mother.key, Number(id));
      else await channel.edit(mother.key, Number(id), body);
    } catch (error) {
      if (!remove && /MESSAGE_NOT_MODIFIED/i.test(error.message)) {
        markSent(mother.personId, id, { text: body });
        return { edited: true, id: Number(id), unchanged: true };
      }
      if (/MESSAGE_ID_INVALID|message to edit not found/i.test(error.message)) {
        markSent(mother.personId, id, { deleted: true });
        return { error: `#${id} is no longer in the chat (deleted on Telegram)` };
      }
      return { error: error.message };
    }
    markSent(mother.personId, id, remove ? { deleted: true } : { text: body, edited: true });
    return remove ? { deleted: true, id: Number(id) } : { edited: true, id: Number(id) };
  }
  const changeLine = (id, { remove, body }) => (remove ? `پیام #${id} را برداشت` : `پیام #${id} را به «${body.slice(0, 60)}» تغییر داد`);
  async function changeSent(chatId, rawId, text, { remove = false } = {}) {
    const mother = motherInfo(store, chatId);
    if (!mother?.personId) return { error: "this is not a colleague's mother chat" };
    const id = String(rawId ?? "").replace(/^#/, "").trim();
    const list = sentList(mother.personId);
    const entry = list.find((m) => String(m.id) === id);
    if (!entry || entry.deleted) return { error: `#${id} is not a message you sent to «${mother.name}» (or it was deleted)`, yours: list.filter((m) => !m.deleted).map((m) => m.id) };
    const body = remove ? "" : plain(text);
    if (!remove && !body) return { error: "text is empty" };
    if (markdownToPlain(body).length > MAX_TEXT) return { error: `too long (max ${MAX_TEXT} chars)` };
    if (!remove && body === entry.text) return { edited: true, id: Number(entry.id), unchanged: true };
    const reason = holdReason(chatId, mother);
    if (reason) {
      // Like a held send: the change waits for the owner as a draft he can apply.
      turnOf(chatId).held = true;
      const item = addWaiting({ kind: "draft", op: remove ? "delete" : "edit", msgId: entry.id, reason, personId: mother.personId, name: mother.name, chatId, text: remove ? `برداشتن پیام #${entry.id}: «${String(entry.text).slice(0, 120)}»` : body, integrationId: mother.integrationId, key: mother.key });
      return { held: true, reason, waiting: item.id };
    }
    const result = await applyChange(mother, entry.id, { remove, body });
    if (!result.error) turnOf(chatId).changed.push(changeLine(entry.id, { remove, body }));
    return result;
  }
  /** The owner closed a thread by hand: if that left the mother's person «working» with nothing going
   *  on, say so — the supervisor would otherwise call it stuck. */
  function threadClosed(parentChatId) {
    const mother = parentChatId ? motherInfo(store, parentChatId) : null;
    if (!mother?.personId || pendingWork(parentChatId) > 0 || runner.isActive(parentChatId)) return;
    if (store.getKv(`tgstate:${mother.personId}`)?.state === "working") setState(mother.personId, "no_reply", "رشته را بستید");
  }
  /** The account's catch-up after (re)connecting finished: its queued batches may run now. */
  function caughtUp(integrationId) {
    catchingUp.delete(integrationId);
    armWake();
    drain().catch((error) => log.error?.(`[desk] drain: ${error.message}`));
  }
  const editSent = (chatId, id, text) => changeSent(chatId, id, text);
  const deleteSent = (chatId, id) => changeSent(chatId, id, "", { remove: true });
  const turnStart = (chatId) => Date.parse(store.db.prepare("SELECT started_at FROM runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1").get(chatId)?.started_at || "") || null;
  const turnOf = (chatId) => turns.get(chatId) || turns.set(chatId, { sent: [], changed: [], held: false }).get(chatId);

  // Held as a draft for the owner instead of sent: he wrote to them after the colleague's input this
  // turn answers was handed over (lines not yet passed to the mother) or during the turn (R2); all
  // answers are paused; or their watcher is off (a thread that ends later must not speak for him).
  // The owner asked for this turn himself (a web note, tell_person, /agent, «اجرا کن», a hand-over):
  // his own request is never held back from him. Read from the input that started the turn (the
  // last user event before it that this turn carries; a message queued during the turn is the next
  // turn's, and one removed, dropped or still waiting behind it is no turn's).
  function ownerTurn(chatId) {
    const started = store.db.prepare("SELECT started_at FROM runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1").get(chatId)?.started_at;
    const users = store.db.prepare("SELECT id, data FROM events WHERE chat_id = ? AND type = 'user' AND at <= ? AND id < ? ORDER BY id DESC LIMIT 1");
    for (let before = Number.MAX_SAFE_INTEGER; ; ) {
      const row = users.get(chatId, started || "9", before);
      if (!row) return false;
      before = row.id;
      let data = {};
      try {
        data = JSON.parse(row.data);
      } catch {
        return false;
      }
      if (data.tracked && queueStateOf(chatId, row.id) !== "started") continue;
      if (data.from) return data.from.kind === "owner_web" || Boolean(data.from.forced);
      return !/^\s*\[/.test(String(data.text || "")); // «[گزارش خودکار زیرکارها …» is a thread report
    }
  }
  // A tracked «در صف» message's latest label (started | dropped | removed), null while it waits.
  // Forward from its own event id only (events_chat), never over the chat's older events.
  const queueStateOf = (chatId, userEventId) =>
    store.db
      .prepare("SELECT json_extract(data, '$.state') AS state FROM events WHERE chat_id = ? AND id > ? AND type = 'user.queue' AND json_extract(data, '$.userEventId') = ? ORDER BY id DESC LIMIT 1")
      .get(chatId, userEventId, userEventId)?.state || null;
  function holdReason(chatId, mother) {
    if (ownerTurn(chatId)) return null;
    const owner = store.getKv(ownerKey(mother.integrationId, mother.key));
    // He wrote after the colleague input this turn answers reached the assistant (or during the turn).
    const handed = store.getKv(`tglastin:${chatId}`) || turnStart(chatId);
    if (owner?.at && handed && owner.at >= handed) return "owner_replied"; // same ms: hold (a draft he can still send)
    if (paused(mother.integrationId)) return "paused";
    const person = mother.personId ? store.getPerson(mother.personId) : null;
    if (person && !watching(person)) return "unwatched";
    return null;
  }

  async function sendToPerson(chatId, text) {
    const mother = motherInfo(store, chatId);
    if (!mother) return { error: "this is not a colleague's mother chat" };
    const body = plain(text);
    if (!body || isNoReply(body)) return { skipped: true };
    // One Telegram message (4000 with the signature): its id is the whole message, so edit_sent and
    // delete_sent act on all of it.
    const length = markdownToPlain(body).length; // what Telegram gets (tables grow a little)
    if (length > MAX_TEXT) return { error: `too long (${length} chars, max ${MAX_TEXT}): split it into two send_to_person calls` };
    const turn = turnOf(chatId);
    const reason = holdReason(chatId, mother);
    if (reason) {
      turn.held = true;
      const item = addWaiting({ kind: "draft", reason, personId: mother.personId, name: mother.name, chatId, text: body, integrationId: mother.integrationId, key: mother.key });
      return { held: true, reason, waiting: item.id };
    }
    const result = await deliver(mother, body, chatId);
    if (result.sent) turn.sent.push(body);
    // After the fact too: what else of its own is still unanswered there, so a stale line can go.
    const earlier = result.sent && mother.personId ? unanswered(mother.personId).filter((m) => String(m.id) !== String(result.id)) : [];
    return earlier.length ? { ...result, unansweredBefore: earlier.map((m) => ({ id: m.id, text: String(m.text).slice(0, 120) })) } : result;
  }

  // prompt: the last message a turn took — not one taken back, dropped, or still «در صف».
  async function finalTextOf(chatId) {
    const { messages } = timelines ? (await timelines.get(chatId)).timeline : foldEvents(store.allEvents(chatId));
    const input = messages.findLast((m) => m.role === "user" && !["removed", "dropped"].includes(m.queueState) && !(m.intent === "queue" && !m.queueState));
    return { text: finalText(lastRun(messages)), prompt: input?.text || "", from: input?.from || null };
  }

  // A mother turn ended: what happened becomes the person's state and a note in the global chat.
  async function finish(chatId, mother, { status, error }) {
    const turn = turns.get(chatId) || { sent: [], changed: [], held: false };
    turns.delete(chatId);
    const { text, prompt, from } = await finalTextOf(chatId);
    const who = { personId: mother.personId, name: mother.name, chatId };
    let state = "no_reply";
    let line = "پیامی نفرستاد";
    // A later turn went through: the earlier failure is answered, its card would only replay it.
    if (status === "finished" || turn.sent.length) dropFailed(chatId);
    if (turn.sent.length) {
      // What went out went out, even if the turn broke after it: no retry to send it twice.
      state = "sent";
      line = `فرستاد: «${turn.sent.at(-1).slice(0, 80)}»${turn.sent.length > 1 ? ` (${fa(turn.sent.length)} پیام)` : ""}${turn.changed.length ? `؛ ${turn.changed.join("، ")}` : ""}${status === "error" ? ` — بعدش خطا: ${String(error || "").slice(0, 120)}` : ""}`;
    } else if (status === "error") {
      state = "failed";
      line = `خطا: ${String(error || "کار ناتمام ماند").slice(0, 200)}${turn.changed.length ? ` (قبلش: ${turn.changed.join("، ")})` : ""}`;
      // One failed item per chat: an engine that stays down does not pile them up.
      dropFailed(chatId);
      addWaiting({ kind: "failed", ...who, text: line, prompt, ...(from ? { from } : {}), integrationId: mother.integrationId, key: mother.key });
    } else if (turn.held) {
      state = "waiting";
      line = `پیش‌نویسی منتظر شماست${turn.changed.length ? ` (${turn.changed.join("، ")})` : ""}`;
    } else if (pendingWork(chatId) > 0) {
      state = "working";
      line = `رشته در کار است${turn.changed.length ? ` (${turn.changed.join("، ")})` : ""}`;
    } else if (turn.changed.length) {
      // An edit does not notify them: not «جواب رفت».
      state = "edited";
      line = turn.changed.join("، ");
    } else if (status === "cancelled") {
      line = "متوقف شد";
    } else if (pendingWork(chatId) > 0) {
      state = "working";
      line = "رشته در کار است";
    }
    outcome(who, state, line, { text: String(text || line).trim().slice(0, 600), sent: turn.sent });
  }
  const onEvent = (chatId, event) => {
    if (event?.type !== "run.started" && event?.type !== "run.finished") return;
    // A thread stopped from its own chat (its stop button, subtasks cancel): its mother may be left
    // «working» with nothing going on; after childDone has marked the thread (next tick).
    if (event.type === "run.finished" && event.data?.status === "cancelled") {
      const parent = store.getKv(`delegate:${chatId}`)?.parent;
      if (parent) setTimeout(() => threadClosed(parent), 100).unref?.();
    }
    const mother = motherInfo(store, chatId);
    if (!mother) return;
    if (event.type === "run.started") turns.set(chatId, { sent: [], changed: [], held: false });
    else finish(chatId, mother, event.data || {}).catch((error) => log.error?.(`[desk] finish ${chatId}: ${error.message}`));
  };
  store.bus.on("event", onEvent);

  // ---- the owner's switches ----
  /** Watcher on/off for one person. On makes their mother chat; off stops its run and its threads,
   *  and what was queued for them is recorded as unanswered. decided: the owner's own switch (the web
   *  page or /agent, whose Telegram message id is msgId) — a caught-up /agent older than it is stale. */
  async function setWatch(personId, on, { integrationId = accountId(), decided = false, msgId = null } = {}) {
    const person = store.getPerson(personId);
    if (!person) return null;
    // The watcher is the one switch: turning it on also lifts the old «دسترسی» flag (access.enabled),
    // which still blocked every message of a watched person.
    if (person.access?.watch !== on || (on && person.access?.enabled === false)) {
      store.updatePerson(personId, { access: { ...(person.access || {}), watch: on, ...(on ? { enabled: true } : {}) } });
    }
    if (decided) store.setKv(`tgwatch:${personId}`, { on, at: now(), msgId });
    const key = String(person.external_id);
    if (on) return integrationId ? motherChat(integrationId, key, { name: person.display_name, person: store.getPerson(personId) }) : null;
    const chatId = integrationId ? motherChatId(store, integrationId, key) : null;
    // Also when its own turn ended: a delegated thread still running would report back later.
    if (chatId) await runner.cancel(chatId).catch(() => {});
    const batch = integrationId ? takeBatch(integrationId, key) : null;
    if (batch) await drainBatch(integrationId, key, batch);
    return chatId;
  }
  const watchDecision = (personId) => store.getKv(`tgwatch:${personId}`);
  function setPaused(value) {
    for (const i of store.listIntegrations().filter((x) => x.kind === "telegram_account")) store.updateIntegration(i.id, { settings: { autoThreads: !value } });
    return Boolean(value);
  }

  async function act(id, action) {
    if (!["send", "dismiss"].includes(action)) return { error: "action must be send or dismiss", status: 400 };
    const item = takeWaiting(id);
    if (!item) return { error: "پیدا نشد", status: 404 };
    if (action === "dismiss") {
      // The chip said «waiting» / «failed» for this item; nothing waits any more.
      const shown = { draft: "waiting", failed: "failed" }[item.kind];
      if (shown && store.getKv(`tgstate:${item.personId}`)?.state === shown) setState(item.personId, "no_reply", "کنار گذاشته شد");
      // The runner kept the same turn (kept:<chat>): let go of it too, or it comes back as
      // «پیام نرسید» on the board and is retried later.
      if (item.kind === "failed") {
        for (const keptId of keptIds(store, item.chatId)) runner.dropKept?.(item.chatId, keptId);
        // Let go of = resolved: the chat stops reading as an error until its next run (app.mjs runStatus).
        store.setKv(`resolved:${item.chatId}`, new Date().toISOString());
        store.bus.emit("chats", { type: "updated", chatId: item.chatId });
      }
      return { ok: true };
    }
    if (item.kind === "draft") {
      const mother = motherInfo(store, item.chatId);
      const who = { personId: item.personId, name: item.name, chatId: item.chatId };
      if (item.op) {
        // A held edit / delete of one of its messages, applied now by the owner.
        const change = { remove: item.op === "delete", body: item.text };
        const result = mother ? await applyChange(mother, item.msgId, change) : { error: "چت مادر پیدا نشد" };
        if (result.error) {
          if (!PERMANENT.test(result.error)) addWaiting(item);
          return { error: result.error, status: 502 };
        }
        outcome(who, "edited", changeLine(item.msgId, change));
        return { ok: true };
      }
      const result = mother ? await deliver(mother, item.text, item.chatId) : { error: "چت مادر پیدا نشد" };
      if (result.error) {
        addWaiting(item);
        return { error: result.error, status: 502 };
      }
      outcome(who, "sent", `فرستاد: «${item.text.slice(0, 80)}»`, { sent: [item.text] });
      return { ok: true };
    }
    if (item.kind === "brake") {
      const batch = takeBatch(item.integrationId, item.key);
      if (batch) {
        runs.delete(item.key);
        await drainBatch(item.integrationId, item.key, batch, { force: true });
      }
      return { ok: true };
    }
    // failed: the kept message again, or the same prompt — unless a later turn of that chat already
    // went through (it answered that message; the prompt again would message them twice).
    try {
      const retried = runner.retry?.(item.chatId);
      if (retried && retried.status !== "nothing-kept") return { ok: true };
      if (store.db.prepare("SELECT 1 FROM runs WHERE chat_id = ? AND status = 'finished' AND ended_at > ? LIMIT 1").get(item.chatId, item.at)) return { ok: true };
      // Still the colleague's words (forced: the owner's «اجرا کن» asked for this turn, never held).
      const from = item.from && (item.from.kind === "owner_web" ? item.from : { ...item.from, forced: true });
      await runner.send(item.chatId, { text: item.prompt || item.text, ...(from ? { from } : {}), intent: runner.isActive(item.chatId) ? "queue" : "send" });
    } catch (error) {
      addWaiting(item);
      return { error: error.message, status: 409 };
    }
    return { ok: true };
  }

  // ---- views ----
  function people() {
    const mothers = new Map(allMothers(store).map((m) => [String(m.key), m.chatId]));
    const threads = openThreads(store);
    const states = new Map(store.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'tgstate:%'").all().map((r) => [r.key.slice(8), JSON.parse(r.value)]));
    const queued = {};
    for (const { value } of store.db.prepare("SELECT value FROM kv WHERE key LIKE 'pickup:%'").all()) Object.assign(queued, JSON.parse(value));
    const photos = store.personPhotoIds();
    return store.listPersonsLight({ source: "telegram" })
      .map((p) => {
        const chatId = mothers.get(String(p.external_id)) || null;
        const batch = queued[p.external_id];
        return {
          id: p.id,
          name: p.display_name,
          tgName: p.tg_name || null,
          photo: photos.has(p.id) ? `/api/telegram/persons/${p.id}/photo?v=${encodeURIComponent(photos.get(p.id))}` : null,
          username: p.username || null,
          group: isGroup(p),
          watch: watching(p),
          state: states.get(p.id) || null,
          chatId,
          openThreads: chatId ? threads.filter((t) => t.motherChat === chatId).length : 0,
          running: chatId ? runner.isActive(chatId) : false,
          pickupEvery: Number(p.access?.pickupEvery) || 0,
          queued: batch?.items?.length ? { count: batch.items.length, due: new Date(batch.due).toISOString() } : null,
          lastAt: p.last_seen_at || null,
        };
      })
      .sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));
  }
  const threadsView = () => openThreads(store).map((t) => ({ ...t, joined: joinedNames(store, t.thread) }));
  function feed() {
    const account = accountChannel();
    const id = accountId();
    return {
      // Made on first look where a Telegram account is connected; an install without one gets no chat.
      globalChatId: id ? ensureGlobal(store) : store.getKv("tg:global") || null,
      account: account ? { state: account.status?.state || "unknown", lastError: account.status?.lastError || null } : null,
      paused: id ? paused(id) : false,
      waiting: waitingList().map(publicWaiting),
      threads: threadsView(),
    };
  }

  // A person by id, @username or the exact name; else the one (watched first) whose name contains
  // it. Several such: { ambiguous: names } — a note to the wrong colleague is worse than a question.
  function findByName(query) {
    const q = String(query || "").trim().replace(/^@/, "").toLowerCase();
    if (!q) return null;
    const all = store.listPersonsLight({ source: "telegram" });
    // The Persian name or Telegram's own.
    const names = (p) => [p.display_name, p.tg_name].map((n) => String(n || "").toLowerCase());
    const exact = all.find((p) => p.id === q || String(p.external_id) === q || String(p.username || "").toLowerCase() === q || names(p).includes(q));
    if (exact) return exact;
    const hits = all.filter((p) => names(p).some((n) => n && n.includes(q)));
    const pool = hits.filter(watching).length ? hits.filter(watching) : hits;
    return pool.length > 1 ? { ambiguous: pool.map((p) => p.display_name) } : pool[0] || null;
  }
  // The mother chat of a watched person, made if needed; an error string otherwise.
  async function motherOf(query) {
    const light = findByName(query);
    if (!light) return { error: `«${query}» را در تلگرام پیدا نکردم` };
    if (light.ambiguous) return { error: `چند نفر با «${query}» جورند: ${light.ambiguous.join("، ")}؛ نام کامل یا @username را بدهید` };
    if (!watching(light)) return { error: `واچر «${light.display_name}» خاموش است؛ اول از صفحهٔ تلگرام روشنش کنید` };
    const integrationId = accountId();
    if (!integrationId) return { error: "اکانت تلگرام وصل نیست" };
    const person = store.getPerson(light.id);
    return { person, chatId: await motherChat(integrationId, String(person.external_id), { name: person.display_name, person }) };
  }

  const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const obj = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
  function globalTools() {
    return {
      telegram_people: {
        description: "Watched colleagues and groups: how each conversation stands (state), their mother chat, open threads, running, queued messages.",
        inputSchema: obj(),
        async execute() {
          return ok({ people: people().filter((p) => p.watch) });
        },
      },
      team_threads: {
        description: "Every open thread (a delegated subtask of a mother chat): id, title, whose, who joined.",
        inputSchema: obj(),
        async execute() {
          return ok({ threads: threadsView() });
        },
      },
      tell_person: {
        description: `Tell a watched colleague something: your text goes to their mother chat as ${OWNER_NAME}'s note, and that chat sends them the message. person = name, @username or id.`,
        inputSchema: obj({ person: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 4000 } }, ["person", "text"]),
        async execute({ person, text }) {
          const target = await motherOf(person);
          if (target.error) return ok({ error: target.error });
          const name = target.person.display_name;
          await runner.send(target.chatId, { text: coverageOwnerNote(name, text), from: { kind: "owner_web" }, intent: runner.isActive(target.chatId) ? "steer" : "queue" });
          return ok({ told: name, chatId: target.chatId });
        },
      },
      thread_join: {
        description: "A watched colleague has the same issue as an open thread: join them to it (the result reaches them too).",
        inputSchema: obj({ thread: { type: "string" }, person: { type: "string" } }, ["thread", "person"]),
        async execute({ thread, person }) {
          const target = await motherOf(person);
          if (target.error) return ok({ error: target.error });
          return ok(await joinThread(store, runner, { thread, chatId: target.chatId, name: target.person.display_name }));
        },
      },
      feed_read: {
        description: `The latest reports from the mother chats (newest last) and what is waiting for ${OWNER_NAME}.`,
        inputSchema: obj({ limit: { type: "integer", minimum: 1, maximum: 300 } }),
        async execute({ limit = 30 } = {}) {
          return ok({ reports: (store.getKv(FEED) || []).slice(-limit), waiting: waitingList().map(publicWaiting) });
        },
      },
      telegram_pause: {
        description: "Pause (true) or resume (false) every automatic answer in Telegram. Paused: colleagues' messages are recorded, no mother chat runs.",
        inputSchema: obj({ paused: { type: "boolean" } }, ["paused"]),
        async execute({ paused: value }) {
          return ok({ paused: setPaused(value) });
        },
      },
    };
  }

  // ---- the supervisor (code, no model): what needs the owner's eye, as notes in the global chat ----
  // A finding is noted once per window; stuck states and drafts once for good (their key changes
  // when they do), so an ignored one does not come back every two hours.
  const SEEN = "tgwatchseen";
  function firstTime(key, ttl = SEEN_MS) {
    const map = store.getKv(SEEN) || {};
    for (const [k, v] of Object.entries(map)) if (now() - v.at > v.ttl) delete map[k];
    const fresh = !map[key];
    if (fresh) map[key] = { at: now(), ttl };
    store.setKv(SEEN, map);
    return fresh;
  }
  const FOR_GOOD = 7 * 24 * 3_600_000;
  // Mother chats already in one thread (its parent and who joined it): their same issue is handled.
  function together() {
    const pairs = new Set();
    for (const t of openThreads(store)) {
      const members = [t.motherChat, ...(store.getKv(`threadsubs:${t.thread}`) || [])];
      for (const a of members) for (const b of members) if (a !== b) pairs.add(`${a}|${b}`);
    }
    return pairs;
  }
  function sweep() {
    const found = [];
    const t = now();
    const watched = people().filter((p) => p.watch);
    for (const p of watched) {
      // Still visible and unanswered: an interim line it took back, or a reply in between, is not a flood.
      const sends = unanswered(p.id).filter((m) => t - m.at < FLOOD.ms);
      if (sends.length >= FLOOD.count && firstTime(`flood:${p.id}`)) {
        found.push({ kind: "flood", personId: p.id, name: p.name, chatId: p.chatId, text: `«${p.name}» در ۳۰ دقیقهٔ اخیر ${fa(sends.length)} پیام از ${PERSONA.name} گرفت — چت مادرش را ببینید` });
      }
      const st = p.state;
      const since = Date.parse(st?.at || "") || t;
      const quiet = !p.running && !p.queued && !(p.chatId && pendingWork(p.chatId) > 0);
      if (["working", "queued"].includes(st?.state) && t - since > STALE_MS && quiet && firstTime(`stale:${p.id}:${st.at}`, FOR_GOOD)) {
        found.push({ kind: "stale", personId: p.id, name: p.name, chatId: p.chatId, text: `کار «${p.name}» از ${clock(since)} بی‌خبر مانده («${st.line || st.state}») و چیزی در جریان نیست` });
      }
    }
    const drafts = waitingList().filter((w) => w.kind === "draft" && t - Date.parse(w.at) > STALE_MS && firstTime(`draft:${w.id}`, FOR_GOOD));
    if (drafts.length) found.push({ kind: "drafts", text: `${fa(drafts.length)} پیش‌نویس بیش از ۲۰ دقیقه منتظر شماست: ${[...new Set(drafts.map((d) => `«${d.name}»`))].join("، ")}` });
    recentIn = recentIn.filter((m) => t - m.at < SAME_ISSUE_MS);
    const mothers = new Map(watched.map((p) => [p.id, p.chatId]));
    const joined = together();
    for (let i = 0; i < recentIn.length; i += 1) {
      for (let j = i + 1; j < recentIn.length; j += 1) {
        const [a, b] = [recentIn[i], recentIn[j]];
        if (a.personId === b.personId || !sameIssue(a.text, b.text)) continue;
        if (joined.has(`${mothers.get(a.personId)}|${mothers.get(b.personId)}`)) continue;
        if (!firstTime(`same:${[a.personId, b.personId].sort().join(":")}`)) continue;
        found.push({ kind: "same_issue", personId: a.personId, name: a.name, chatId: mothers.get(a.personId) || null, text: `«${a.name}» و «${b.name}» احتمالاً یک مسئله را گفته‌اند: «${a.text.slice(0, 70)}» / «${b.text.slice(0, 70)}» — اگر یکی است، در پنل رشته‌های یکی «همان مسئلهٔ…» را بزنید` });
      }
    }
    for (const f of found) note({ ...f, kind: "watch", finding: f.kind });
    if (found.length) log.info?.(`[desk] supervisor: ${found.map((f) => f.kind).join(",")}`);
    return found;
  }

  let timer = null;
  let sweeper = null;
  return {
    colleague, ownerLine, handOff, unwatched, drain, sendToPerson, setWatch, watchDecision, setPaused, act,
    people, feed, globalTools, annotate, editSent, deleteSent, sweep, threadClosed, caughtUp,
    start() {
      for (const i of store.listIntegrations().filter((x) => x.kind === "telegram_account")) catchingUp.add(i.id);
      timer = setInterval(() => drain().catch((error) => log.error?.(`[desk] drain: ${error.message}`)), 30_000);
      timer.unref?.();
      sweeper = setInterval(() => {
        try {
          sweep();
        } catch (error) {
          log.error?.(`[desk] supervisor: ${error.message}`);
        }
      }, SWEEP_MS);
      sweeper.unref?.();
      // No armWake() here: a batch overdue at boot waits for the interval, after the account's
      // catch-up has recorded what the owner answered while the app was down (R3).
    },
    stop() {
      clearInterval(timer);
      clearInterval(sweeper);
      clearTimeout(wake);
      timer = null;
      store.bus.off("event", onEvent);
    },
  };
}

// Two colleagues' messages about the same thing (the supervisor's same-issue hint): enough shared
// content words. ponytail: word overlap, not meaning — a hint for the owner, never an action.
const STOP = new Set("سلام وقت بخیر ممنون مرسی لطفا لطفاً خیلی این اون آن که چه چرا کجا کی برای روی توی داخل بعد قبل الان هنوز دیگه دیگر میشه می‌شه نمیشه نمی‌شه هست نیست است بود داره دارم داریم دارید کنم کنید کنه کرد شده شد باید میخوام می‌خوام یه یک دو همه هم ولی اما اگر چون تا با از به در را رو و یا من ما شما تو او ایشون آقای خانم".split(" "));
function words(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[\u200c\u200f]/g, " ")
      .replace(/ي/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}
export function sameIssue(a, b) {
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared >= 3 && shared / (x.size + y.size - shared) >= 0.35;
}
