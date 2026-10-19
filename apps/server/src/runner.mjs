import { randomUUID } from "node:crypto";
import { genv } from "./env.mjs";
import { eventsFromUpdate } from "./updates.mjs";
import { inertText, maskText } from "./redact.mjs";
import { fileMeta, forEngine, mergeMessages, toSdkMessage } from "./attachments.mjs";
import { ASK_TOOL } from "./asks.mjs";
import { accountMoveNote, doneTools, droppedNote, ENGINE_UNAVAILABLE, resetFromText, FALLBACK_KEY, FALLBACK_OFFERS_KEY, fallbackNote, fallbackQuestion, saidWait, saidYes, storableMessage, withLeadNote } from "./plan-fallback.mjs";

// Kept messages: the owner's message whose run ended in an error before anything
// reached them (no text, no tool) is kept in the store's kv, oldest first, until a retry gets
// through or the owner deletes it. A newer message joins the end of that FIFO, never jumps it.
// After MAX_KEPT_RETRIES failed retries a kept message is no longer retried on its own and stops
// holding newer ones back; «دوباره», «حل شد» and «بستن» still work.
export const MAX_KEPT_RETRIES = 3;
const keptKey = (chatId) => `kept:${chatId}`;
export function keptList(store, chatId) {
  const value = store.getKv?.(keptKey(chatId));
  return Array.isArray(value) ? value : [];
}
// What the thread shows: ids only, oldest first (a delete names one by id, never by position).
export const keptIds = (store, chatId) => keptList(store, chatId).map((k) => k.id);

// Restart resume: what a chat was doing survives the process. runq:<chat> holds the
// turn in flight (its own message text and the «در صف» events it carries) and the messages queued
// behind it; resume:pending lists, oldest first, the chats to pick up after the next boot — the
// ones our own graceful stop cut (a deploy) and the ones a crash left `running`.
const runqKey = (chatId) => `runq:${chatId}`;
const RESUME_KEY = "resume:pending";
const resumesKey = (chatId) => `resumes:${chatId}`;
// Config CLAUDE_BACKGROUND_TASKS: { chatId: [task] } of the background tasks running now.
export const BG_TASKS_KEY = "background-tasks";
// ponytail: continues per chat per hour, so a turn that kills the process cannot restart-loop it;
// any new message to the chat resets the count.
const MAX_RESUMES = 3;
const RESUME_GAP_MS = 15_000;

// Continue after the plan limit resets: a run the limit stopped, with no other engine to move to, continues by itself a minute
// after the reset time — at most MAX_LIMIT_RESUMES tries in a row. Kept in the store's kv so a
// restart does not forget the wait; any message of the owner or a Stop ends it.
export const MAX_LIMIT_RESUMES = 3;
const LIMIT_RESUME_SLACK_MS = 60_000;
// A reset further away than this (a weekly limit) is not waited for: days later is a surprise.
const LIMIT_RESUME_MAX_WAIT_MS = 6 * 60 * 60_000;
const LIMIT_RESUME_KEY = "limit-resume";
export const LIMIT_RESUME_TEXT = "(خودکار) سقف مصرف باز شد. از همان‌جا که کار ماند ادامه بده.";
const clock = (ms) => new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));

// The composer's «/» list (Claude Code's commands and skills): name, description, argument hint.
export const COMMANDS_KEY = "slash-commands";
export function publicCommands(list) {
  if (!Array.isArray(list)) return null;
  return list
    .filter((c) => c && typeof c.name === "string" && c.name)
    .slice(0, 500)
    .map((c) => ({
      name: c.name.slice(0, 100),
      description: String(c.description || "").replace(/\s+/g, " ").trim().slice(0, 300),
      argumentHint: String(c.argumentHint || "").slice(0, 100),
      ...(Array.isArray(c.aliases) && c.aliases.length ? { aliases: c.aliases.filter((a) => typeof a === "string").slice(0, 10) } : {}),
    }));
}

// The suggested next message shown in the composer (Claude's prompt suggestions): one short line.
export const MAX_SUGGESTION_CHARS = 300;
const FAST_KEY = (chatId) => `fast:${chatId}`;
export const fastWanted = (store, chatId) => store.getKv?.(FAST_KEY(chatId)) === true;
export const setFastWanted = (store, chatId, on) => (on ? store.setKv(FAST_KEY(chatId), true) : store.deleteKv(FAST_KEY(chatId)));

// A chat the owner types into in the app: not a job's, a delegated subtask, a side chat, a
// colleague's thread or a chat linked to a messenger.
export function ownerTyped(store, chat) {
  if (!chat || (chat.caller || "owner") !== "owner" || chat.job_id || chat.parent_chat_id || chat.side_of || chat.person_id) return false;
  // A chat that does not exist yet (GET /api/agents asks which engine a new chat of an agent would
  // run on) has no links; binding an undefined id made the whole agents page answer «internal error».
  if (!chat.id) return true;
  return !store.linksForChat?.(chat.id)?.length;
}

export class BusyError extends Error {
  constructor() {
    super("run already active for this chat");
    this.code = "busy";
  }
}

const RETRYABLE = /network request failed|fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR|socket hang up/i;
const AGENT_BUSY = /already has active run|AgentBusyError/i;
const AGENT_GONE = /agent_not_found|AgentNotFoundError|not found/i;

// A run producing no event for this long is treated as stuck — most commonly a native SDK
// subagent tool call (e.g. `task`) that gives us zero progress signal for as long as it runs and
// can simply hang. sweepStale() cancels it. If even that gets no reply within FORCE_MS (the SDK
// connection itself is wedged), the run is finalized locally anyway: we cannot un-stick a promise
// we are awaiting, but the rest of the system (healthz activeRuns, the UI, queued messages) must
// not stay blocked on it forever.
const DEFAULT_STALE_MS = 15 * 60_000;
const DEFAULT_FORCE_MS = 3 * 60_000;

// Runs agents for chats (Cursor or Claude). Every SDK update comes from exactly one source
// (onDelta) and is appended to the store; the UI and the final answer are derived from those events.
export function createRunner({
  store,
  // providerFor(chat) -> { create, resume, clearStuck? }. Falls back to legacy `sdk`.
  providerFor = null,
  sdk = null,
  agentOptions,
  // runLabel(chat) -> { provider, model } actually used, for the run.started event.
  runLabel = (chat) => ({ provider: chat.provider || "cursor", model: chat.model || "auto" }),
  onCancel = () => {},
  // Only for an explicit cancel (user / API), not for every run end.
  onUserCancel = () => {},
  onFinished = () => {},
  // onPlanLimit(chat, error, provider) -> true when the chat should be retried once on another provider.
  onPlanLimit = () => false,
  // PLAN_FALLBACK=ask (plan-fallback.mjs): askFallback(chat) -> true when a plan limit in this chat
  // asks the owner on a card instead of moving the run; fallbackFor(chat) -> the engine it would go
  // on with ({ provider, model, name, fromName }) or null. Default: never ask (auto-fallback).
  askFallback = () => false,
  fallbackFor = () => null,
  // accountHop(chat) -> { from, account } when the chat runs on another account of the same model
  // because its own is at the plan limit: automatic even in ask mode (answer quality is the same),
  // but labelled so the owner sees which account answered. null otherwise.
  accountHop = () => null,
  // limitResetAt(chat, error) -> ms when the chat can run again after a plan limit, or null.
  limitResetAt = (chat, error) => error?.resetsAt || null,
  // Settings switches (config.mjs): continue after the limit resets; Claude's next-message suggestions.
  autoContinue = () => true,
  promptSuggestions = () => true,
  // When true, a plain "send" while busy is downgraded to queue (used while ask_agent blocks).
  isSoftBusy = () => false,
  // When true, the run is deliberately parked (waiting for an answer to an open question), so
  // silence is expected and sweepStale must leave it alone.
  isBlocked = () => false,
  // Pause between two chats resumed after a boot (one at a time, not a burst on the engines).
  resumeGapMs = RESUME_GAP_MS,
  // annotate(chatId) -> a line the model reads before this message (not shown as the message):
  // in a Telegram mother chat, what the assistant already sent that person and is unanswered (desk.mjs).
  annotate = () => null,
  // notResumable(chat) -> true for a chat nobody waits on after a restart (a consult: the call
  // that waited for its answer is gone), so a cut or crashed run there is not continued.
  notResumable = () => false,
  log = console,
}) {
  const active = new Map(); // chatId -> { runId, run, cancelRequested, cancelRequestedAt, forcedDone, queue, lastEventAt }
  // Keyed by provider + agentId: a chat whose routing moved engines (GLM → Claude for a colleague
  // thread) kept its old agent_id and got the cached GLM agent — Z.ai then 404'd "opus" (2026-10-11).
  const agents = new Map(); // `${provider.id}:${agentId}` -> SDKAgent
  // The provider instance that made each cached agent. Saving an account's key or settings rebuilds
  // its provider, and an agent made by the old one keeps the old key: a new Claude key went on
  // failing with «Invalid API key» in every chat that had run once (2026-10-13). Such an agent is
  // dropped and the session resumed with the new provider.
  const madeBy = new WeakMap();
  // Config CLAUDE_BACKGROUND_TASKS: chats whose kept Claude Code process runs background tasks. The
  // live list is saved (kv BG_TASKS_KEY), so a restart, which ends those processes, says which ones
  // it stopped.
  const bgAgents = new Map(); // chatId -> agent
  const taskOutputs = new Map(); // chatId -> Map(taskId -> output file of an ended task)
  const usedAt = new Map(); // chatId -> when its agent was last taken (Settings' MCP view)
  const bgSaved = () => store.getKv?.(BG_TASKS_KEY) || {};
  const saveBg = (chatId, tasks) => {
    const all = bgSaved();
    if (tasks.length) all[chatId] = tasks;
    else delete all[chatId];
    if (Object.keys(all).length) store.setKv?.(BG_TASKS_KEY, all);
    else store.deleteKv?.(BG_TASKS_KEY);
  };
  const BG_STATUS = { completed: "تمام شد", failed: "شکست خورد", stopped: "متوقف شد", killed: "متوقف شد" };
  const taskName = (task) => task.description || task.id;
  function wireBackground(chatId, agent) {
    if (typeof agent?.setBackgroundListener !== "function") return;
    agent.setBackgroundListener((event) => {
      if (event.type === "tasks") {
        if (event.tasks.length) bgAgents.set(chatId, agent);
        else if (bgAgents.get(chatId) === agent) bgAgents.delete(chatId);
        if (!stopping) saveBg(chatId, event.tasks);
        store.bus?.emit?.("chats", { type: "live", chatId });
      } else if (event.type === "ended") {
        const summary = event.summary ? `: ${event.summary.slice(0, 500)}` : "";
        // Its output file (a background shell's log) stays readable by task id, never by path.
        if (event.outputFile) {
          const files = taskOutputs.get(chatId) || new Map();
          files.set(event.task.id, { file: event.outputFile, description: event.task.description || "", type: event.task.type || null, status: event.status || "completed", endedAt: Date.now() });
          while (files.size > 30) files.delete(files.keys().next().value);
          taskOutputs.set(chatId, files);
        }
        store.appendEvent(chatId, null, "note", { text: `کار پس‌زمینه ${BG_STATUS[event.status] || event.status} (${taskName(event.task)})${summary}`, ...(event.outputFile ? { taskId: event.task.id } : {}) });
      } else if (event.type === "lost" && !stopping) {
        store.appendEvent(chatId, null, "note", { text: `این کارهای پس‌زمینه با بسته شدن Claude Code متوقف شدند: ${event.tasks.map(taskName).join("، ")}` });
      }
    });
  }
  // Boot: what the last process stopped is said in its chat, once.
  for (const [chatId, tasks] of Object.entries(bgSaved())) {
    if (store.getChat(chatId) && Array.isArray(tasks) && tasks.length) {
      store.appendEvent(chatId, null, "note", { text: `این کارهای پس‌زمینه با راه‌اندازی دوبارهٔ برنامه متوقف شدند: ${tasks.map(taskName).join("، ")}` });
    }
  }
  store.deleteKv?.(BG_TASKS_KEY);
  // An archived or deleted chat's background tasks stop with it.
  store.bus?.on?.("chats", (change) => {
    const agent = bgAgents.get(change?.chatId);
    if (!agent) return;
    if (change.type === "deleted" || (change.type === "updated" && store.getChat(change.chatId)?.archived)) {
      bgAgents.delete(change.chatId);
      saveBg(change.chatId, []);
      try {
        agent.close?.();
      } catch {
        /* already closed */
      }
    }
  });
  let stopping = false; // shutdown() began: nothing new starts, cut turns are recorded for the next boot

  // A «در صف» message reached the agent (started) or will never run (dropped): its label follows
  // it, live and after a reload (the timeline folds user.queue onto that message).
  const markQueued = (chatId, ids, state) => {
    for (const userEventId of ids || []) store.appendEvent(chatId, null, "user.queue", { userEventId, state });
  };
  const messagesOf = (items) => items.map((item) => item.message);
  const idsOf = (items) => items.flatMap((item) => [...(item.id ? [item.id] : []), ...(Array.isArray(item.ids) ? item.ids : [])]);

  const runq = {
    get: (chatId) => store.getKv?.(runqKey(chatId)) || { turn: null, queue: [] },
    save: (chatId, turn, queue) => (turn || queue.length ? store.setKv?.(runqKey(chatId), { turn, queue }) : store.deleteKv?.(runqKey(chatId))),
  };
  const persist = (chatId, entry) => runq.save(chatId, entry.turn, entry.queue);
  const pending = {
    list: () => store.getKv?.(RESUME_KEY) || [],
    write: (list) => (list.length ? store.setKv?.(RESUME_KEY, list) : store.deleteKv?.(RESUME_KEY)),
    has: (chatId) => pending.list().some((item) => item.chatId === chatId),
    // cont: the cut turn itself continues (else only its queue is delivered); a later cut keeps it.
    add: (chatId, cont) => {
      const list = pending.list();
      const item = list.find((i) => i.chatId === chatId);
      if (item) item.cont ||= cont;
      else list.push({ chatId, cont });
      pending.write(list);
    },
    remove: (chatId) => {
      const list = pending.list();
      const rest = list.filter((item) => item.chatId !== chatId);
      if (rest.length !== list.length) pending.write(rest);
      return rest.length !== list.length;
    },
  };
  // A new message moves a chat on: a continue still waiting after a restart is stale, and the
  // messages that were queued behind the cut turn are handed back to go first, in order.
  const takeWaiting = (chatId) => {
    pending.remove(chatId);
    const { queue } = runq.get(chatId);
    runq.save(chatId, null, []);
    return queue;
  };
  const suggestions = new Map(); // chatId -> Claude's guess at the owner's next message, until the next run
  const fastStates = new Map(); // chatId -> { state, reason }: fast mode as Claude Code last reported it
  const limitTries = new Map(); // chatId -> automatic continues in a row, while one of them runs
  const autoSending = new Set(); // chats whose run in the making is the automatic continue

  const kept = {
    list: (chatId) => keptList(store, chatId),
    save: (chatId, list) => (list.length ? store.setKv(keptKey(chatId), list) : store.deleteKv(keptKey(chatId))),
    // ids: the «در صف» events this message carries, so their labels follow it.
    // raw: the message without a system lead note, when it has one.
    push: (chatId, message, ids = [], raw = null) =>
      kept.save(chatId, [...kept.list(chatId), { id: `k${randomUUID().replace(/-/g, "").slice(0, 12)}`, message, fails: 0, ...(ids.length ? { ids } : {}), ...(raw != null ? { raw } : {}) }]),
    // The oldest kept message still retried on its own, or -1.
    next: (chatId) => kept.list(chatId).findIndex((k) => k.fails < MAX_KEPT_RETRIES),
    update: (chatId, id, fn) => kept.save(chatId, kept.list(chatId).flatMap((k) => (k.id === id ? fn(k) : [k]))),
  };
  const startKept = (chatId, index) => {
    const item = kept.list(chatId)[index];
    return item ? startRun(chatId, item.message, [], { keptId: item.id, ids: item.ids || [], raw: item.raw ?? null }) : null;
  };

  const live = (chatId) => store.bus?.emit("chats", { type: "live", chatId });

  // Open «go on with X?» cards (PLAN_FALLBACK=ask). The store is the source of truth, so a card
  // survives a restart and a click on any other card (stale, withdrawn) is refused by the answer
  // route. Only the stopped message's pictures and files live in memory (askId -> message).
  const offers = () => store.getKv?.(FALLBACK_OFFERS_KEY) || {};
  const liveMessages = new Map();
  function forgetOffer(chatId) {
    const all = offers();
    const offer = all[chatId];
    if (!offer) return null;
    delete all[chatId];
    if (Object.keys(all).length) store.setKv(FALLBACK_OFFERS_KEY, all);
    else store.deleteKv(FALLBACK_OFFERS_KEY);
    liveMessages.delete(offer.askId);
    return offer;
  }
  const closeCard = (chatId, offer, result) =>
    store.appendEvent(chatId, offer.runId ?? null, "tool.done", { callId: offer.callId, name: ASK_TOOL, args: { ...offer.args, askId: offer.askId }, result });
  // Anything new in the chat (a message, a continue after the reset, an archive) answers the card:
  // it is closed as withdrawn and is never clickable again.
  function withdrawFallback(chatId) {
    const offer = forgetOffer(chatId);
    if (offer) closeCard(chatId, offer, { answered: false, reason: "withdrawn" });
    return Boolean(offer);
  }
  // After a yes, the note the new engine reads before the first message it runs (an older kept
  // message, the stopped one, or the boot queue's): { note, provider }. Kept messages store the
  // owner's text only, so a retry elsewhere (back on the old engine) never carries a stale note.
  const NOTE_KEY = (chatId) => `plan-fallback-note:${chatId}`;
  // The label a run gets while the chat is on the engine the owner moved it to.
  function fallbackLabel(chatId, provider) {
    const moved = store.getKv?.(FALLBACK_KEY(chatId));
    return moved && moved.provider === provider ? { movedFrom: { from: String(moved.from || "") } } : {};
  }

  function offerFallback(chatId, runId, provider, message, resetsAt, keptId) {
    const chat = store.getChat(chatId);
    if (!chat || chat.archived || !askFallback(chat)) return;
    const picked = fallbackFor(chat);
    if (!picked?.provider || picked.provider === provider) return;
    // A second hop back to where the chat came from: its own session waits there.
    const moved = store.getKv(FALLBACK_KEY(chatId));
    const back = Boolean(moved && moved.provider === provider && moved.fromProvider === picked.provider && moved.fromAgentId);
    const to = { ...picked, ...(back ? { back: true } : {}) };
    const done = doneTools(store, runId);
    const askId = randomUUID().replace(/-/g, "").slice(0, 8);
    const callId = `plan-fallback-${askId}`;
    const args = { ...fallbackQuestion(to, resetsAt, Date.now(), done.count), askId, ...(done.list.length ? { done: done.list.slice(0, 10).map((t) => `${t.name} ${t.args}`), doneMore: done.count - Math.min(10, done.list.length) } : {}) };
    withdrawFallback(chatId);
    liveMessages.set(askId, message);
    store.setKv(FALLBACK_OFFERS_KEY, { ...offers(), [chatId]: { askId, callId, runId, message: storableMessage(message), to, done, from: provider, keptId: keptId || null, args } });
    // On the run that hit the limit, so the card shows under its answer.
    store.appendEvent(chatId, runId, "tool.started", { callId, name: ASK_TOOL, args });
  }

  // The owner clicked an option on a plan-limit card. false: not this chat's open card (stale,
  // answered, withdrawn) — the route refuses it, so a stale click never becomes a message.
  function answerFallback(chatId, askId, selected = []) {
    const offer = offers()[chatId];
    if (!offer || !askId || offer.askId !== askId) return false;
    // Only the card's two options answer it; anything else leaves it open (the route says 409).
    if (!saidWait(selected) && !saidYes(selected, offer.to)) return false;
    const message = liveMessages.get(askId);
    forgetOffer(chatId);
    const answer = String(selected[0] || "");
    closeCard(chatId, offer, { answered: true, answer, selected: answer ? [answer] : [] });
    const { to } = offer;
    if (saidWait(selected)) return true;
    const note = (text) => store.appendEvent(chatId, null, "note", { text });
    const now = store.getChat(chatId);
    if (!now) return true;
    if (now.archived) {
      note(`گفتگو بایگانی شده بود؛ به ${to.name} نرفت. اگر هنوز لازم است، از بایگانی درش بیاورید و پیام بدهید.`);
      return true;
    }
    if (active.has(chatId)) {
      note(`گفتگو همین حالا مشغول است؛ به ${to.name} نرفت. اگر هنوز لازم است، مدل را از انتخاب‌گر عوض کنید.`);
      return true;
    }
    clearLimitResume(chatId);
    // The kept copy of the stopped message (nothing had reached the owner) is this rerun now: run
    // as that kept item, so a success delivers it and the messages queued behind it follow.
    const keptId = offer.keptId && kept.list(chatId).some((k) => k.id === offer.keptId) ? offer.keptId : null;
    let text = message ?? offer.message;
    if (message == null && text && typeof text === "object") text = text.dropped ? withLeadNote(text.text, droppedNote(text.dropped)) : text.text;
    const moved = store.getKv(FALLBACK_KEY(chatId));
    if (to.back && moved?.fromAgentId) {
      // Back where it started: that engine's own session resumes, no label any more.
      store.updateChat(chatId, { model: moved.fromModel ?? null, provider: moved.fromProvider });
      store.deleteKv(FALLBACK_KEY(chatId));
      store.setAgentId(chatId, moved.fromAgentId);
    } else {
      // The way back: the first engine, its model and session are kept through any later hop.
      const first = moved && moved.provider === offer.from ? moved : { from: to.fromName || offer.from, fromProvider: offer.from, fromModel: now.model ?? null, fromAgentId: now.agent_id || null };
      store.setKv(FALLBACK_KEY(chatId), { ...first, provider: to.provider, model: to.model });
      store.updateChat(chatId, { model: `${to.provider}:${to.model}`, provider: to.provider });
      store.setAgentId(chatId, null);
    }
    // The model is told what it does not see and what the stopped run did, so it is not redone:
    // on the first message it runs, whichever that is (startRun).
    store.setKv(NOTE_KEY(chatId), { note: fallbackNote(to, offer.done), provider: to.provider });
    const noted = text;
    if (stopping) {
      // Shutting down: nothing starts now. The rerun waits in runq for the next boot (behind the
      // kept FIFO if one is waiting), never as a second copy next to the kept one.
      const ids = keptId ? kept.list(chatId).find((k) => k.id === keptId)?.ids || [] : [];
      if (keptId) kept.update(chatId, keptId, () => []);
      const waiting = runq.get(chatId);
      runq.save(chatId, waiting.turn, [...waiting.queue, { message: noted, id: null, ...(ids.length ? { ids } : {}) }]);
      pending.add(chatId, false);
      return true;
    }
    // The kept FIFO keeps its order: an older kept message goes first, this one in its own place.
    if (keptId) kept.update(chatId, keptId, (k) => [{ ...k, message: text, fails: 0 }]);
    else if (kept.next(chatId) >= 0) kept.push(chatId, text, []);
    if (kept.next(chatId) >= 0) startKept(chatId, kept.next(chatId));
    else startRun(chatId, text, [], { turnText: typeof text === "string" ? text : text?.text || "" });
    return true;
  }

  // Archived by any path (the page, the idle sweep, Telegram's mother/manager): the card closes now.
  store.bus?.on?.("chats", (change) => {
    if (change?.type !== "updated" || !change.chatId || !offers()[change.chatId]) return;
    if (store.getChat(change.chatId)?.archived) withdrawFallback(change.chatId);
  });

  // Boot: a card whose chat is gone, archived or no longer asks is closed; the others stay open.
  for (const [chatId, offer] of Object.entries(offers())) {
    const chat = store.getChat(chatId);
    if (chat && !chat.archived && askFallback(chat)) continue;
    forgetOffer(chatId);
    if (chat) closeCard(chatId, offer, { answered: false, reason: "withdrawn" });
  }
  const limitResumes = () => store.getKv?.(LIMIT_RESUME_KEY) || {};
  function clearLimitResume(chatId) {
    const all = limitResumes();
    if (!(chatId in all)) return;
    delete all[chatId];
    if (Object.keys(all).length) store.setKv(LIMIT_RESUME_KEY, all);
    else store.deleteKv(LIMIT_RESUME_KEY);
    live(chatId);
  }

  // A run ended on the plan limit and no other engine took it over: wait for the reset, if known.
  function planLimitResume(chatId, error, emit) {
    const tries = limitTries.get(chatId) || 0;
    limitTries.delete(chatId);
    const chat = store.getChat(chatId);
    if (!ownerTyped(store, chat) || chat.archived || !autoContinue()) return;
    const resetsAt = Math.max(Number(limitResetAt(chat, error)) || 0, Date.now());
    if (!limitResetAt(chat, error) || resetsAt - Date.now() > LIMIT_RESUME_MAX_WAIT_MS) return;
    if (tries >= MAX_LIMIT_RESUMES) {
      emit("note", { text: `سقف مصرف ${MAX_LIMIT_RESUMES} بار پشت هم دوباره پر شد؛ دیگر خودکار ادامه نمی‌دهد. هر وقت خواستید پیام بدهید.` });
      return;
    }
    const at = resetsAt + LIMIT_RESUME_SLACK_MS;
    store.setKv(LIMIT_RESUME_KEY, { ...limitResumes(), [chatId]: { at, tries } });
    emit("note", { text: `سقف مصرف پر شد. حدود ساعت ${clock(at)} خودکار ادامه می‌دهد؛ برای لغو، هر پیامی بفرستید.` });
    live(chatId);
  }

  async function sweepLimitResumes(now = Date.now()) {
    const resumed = [];
    for (const [chatId, item] of Object.entries(limitResumes())) {
      if (!(Number(item?.at) <= now) || active.has(chatId)) continue;
      clearLimitResume(chatId);
      const chat = store.getChat(chatId);
      if (!ownerTyped(store, chat) || chat.archived || !autoContinue()) continue;
      limitTries.set(chatId, (Number(item.tries) || 0) + 1);
      autoSending.add(chatId);
      try {
        // A message that never reached the agent goes again as itself; otherwise «continue».
        if (kept.next(chatId) >= 0) startKept(chatId, kept.next(chatId));
        else await api.send(chatId, { text: LIMIT_RESUME_TEXT });
        resumed.push(chatId);
        log.info?.(`[runner] chat ${chatId}: continued after the plan limit reset`);
      } catch (error) {
        limitTries.delete(chatId);
        log.error?.(`[runner] chat ${chatId}: continue after limit reset failed: ${error?.message || error}`);
      } finally {
        autoSending.delete(chatId);
      }
    }
    return resumed;
  }

  // Kept in memory only (never in the timeline): a guess about the owner, not something anyone said.
  // One that arrives while a run is going belongs to an older turn and is dropped.
  function noteSuggestion(chatId, raw) {
    if (active.has(chatId) || !promptSuggestions()) return;
    const text = maskText(String(raw || "")).replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_SUGGESTION_CHARS) return;
    suggestions.set(chatId, text);
    live(chatId);
  }

  // Claude-only extras for a chat the owner types into: the «/» list, the suggestion, fast mode.
  function ownerExtras(chat) {
    if (!ownerTyped(store, chat)) return {};
    return {
      // The «/» list follows the repo (project skills differ); the repo-less key is the latest one.
      onCommands: (list) => {
        const next = publicCommands(list);
        if (!next) return;
        for (const key of [`${COMMANDS_KEY}:${chat.repo || ""}`, COMMANDS_KEY]) {
          if (JSON.stringify(next) !== JSON.stringify(store.getKv(key) || null)) store.setKv(key, next);
        }
      },
      ...(promptSuggestions() ? { onSuggestion: (text) => noteSuggestion(chat.id, text) } : {}),
      ...(fastWanted(store, chat.id) ? { fast: true } : {}),
    };
  }

  const sdkFor = (chat) => (providerFor ? providerFor(chat) : sdk);
  const agentKey = (chat, id) => `${sdkFor(chat)?.id || ""}:${id}`;

  for (const run of store.runningRuns()) {
    const chat = store.getChat(run.chat_id);
    store.appendEvent(run.chat_id, run.id, "run.finished", {
      status: "cancelled",
      error: "به‌خاطر ری‌استارت سرور قطع شد — در حال ازسرگیری",
    });
    store.finishRun(run.chat_id, run.id, "cancelled", "به‌خاطر ری‌استارت سرور قطع شد — در حال ازسرگیری");
    // A crash left it running: it continues after this boot like a turn our own stop cut.
    if (chat) pending.add(chat.id, true);
  }

  async function withRetry(fn) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= 3 || !RETRYABLE.test(String(error?.message || error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
    }
  }

  function errorText(error) {
    return String(error?.message || error?.name || error || "");
  }

  function isAgentBusy(error) {
    return error?.name === "AgentBusyError" || error?.code === "agent_busy" || AGENT_BUSY.test(errorText(error));
  }

  function isAgentGone(error) {
    return error?.name === "AgentNotFoundError" || error?.code === "agent_not_found" || AGENT_GONE.test(errorText(error));
  }

  // A replaced agent's kept process (config CLAUDE_BACKGROUND_TASKS) ends with it, so it never holds
  // the session or tasks nobody can stop any more.
  const placedAs = new WeakMap(); // agent -> placement(chat) when it was made
  const placement = (chat) => `${chat.runs_on || ""}|${genv("CLAUDE_HOST", "off")}|${(chat.mode || "agent") === "agent"}`;
  const liveAgent = (chatId) => {
    const chat = store.getChat(chatId);
    return bgAgents.get(chatId) || (chat?.agent_id ? agents.get(agentKey(chat, chat.agent_id)) : null) || null;
  };
  const evict = (chat, agentId) => {
    const old = agents.get(agentKey(chat, agentId));
    agents.delete(agentKey(chat, agentId));
    try {
      old?.close?.();
    } catch {
      /* already closed */
    }
  };

  async function createFresh(chat) {
    if (chat.agent_id) evict(chat, chat.agent_id);
    store.setAgentId(chat.id, null);
    const options = await agentOptions({ ...chat, agent_id: null });
    const provider = sdkFor(chat);
    const agent = await withRetry(() => provider.create(options));
    madeBy.set(agent, provider);
    placedAs.set(agent, placement(chat));
    agents.set(agentKey(chat, agent.agentId), agent);
    wireBackground(chat.id, agent);
    store.setAgentId(chat.id, agent.agentId);
    return agent;
  }

  async function agentFor(chat, { forceFresh = false } = {}) {
    usedAt.set(chat.id, Date.now());
    if (forceFresh) return createFresh(chat);
    const cached = chat.agent_id ? agents.get(agentKey(chat, chat.agent_id)) : null;
    // An agent keeps the options it was made with: one made for the other side (host / container,
    // the chat's menu or config CLAUDE_HOST) is replaced, the session resumes on the new side.
    if (cached && madeBy.get(cached) === sdkFor(chat) && placedAs.get(cached) === placement(chat)) return cached;
    if (cached) evict(chat, chat.agent_id);
    const options = await agentOptions(chat);
    const provider = sdkFor(chat);
    try {
      const agent = chat.agent_id
        ? await withRetry(() => provider.resume(chat.agent_id, options))
        : await withRetry(() => provider.create(options));
      madeBy.set(agent, provider);
      placedAs.set(agent, placement(chat));
      agents.set(agentKey(chat, agent.agentId), agent);
      wireBackground(chat.id, agent);
      if (agent.agentId !== chat.agent_id) store.setAgentId(chat.id, agent.agentId);
      return agent;
    } catch (error) {
      if (chat.agent_id && isAgentGone(error)) {
        log.error?.(`[runner] resume ${chat.agent_id} gone — creating fresh agent`);
        return createFresh(chat);
      }
      throw error;
    }
  }

  async function startSdkRun(chat, message, sendOpts) {
    let agent = await agentFor(chat);
    const provider = sdkFor(chat);
    try {
      // A PDF reaches only an engine that reads one; the others are told it is there.
      message = forEngine(message, provider?.kind);
      return await withRetry(() => agent.send(message, sendOpts));
    } catch (error) {
      if (!isAgentBusy(error) && !isAgentGone(error)) throw error;

      // Stuck provider run after a hard kill / restart: cancel then retry once on same agent.
      if (isAgentBusy(error) && chat.agent_id && typeof provider.clearStuck === "function") {
        try {
          await provider.clearStuck(chat.agent_id, await agentOptions(chat));
          agent = await agentFor(store.getChat(chat.id) || chat);
          return await agent.send(message, sendOpts);
        } catch (retryError) {
          error = retryError;
          if (!isAgentBusy(error) && !isAgentGone(error)) throw error;
        }
      }

      log.error?.(`[runner] agent ${chat.agent_id || "new"} busy/gone — minting fresh (${errorText(error)})`);
      agent = await createFresh(store.getChat(chat.id) || chat);
      return await agent.send(message, sendOpts);
    }
  }

  // The annotate line goes on when the turn starts (not when a message is queued, kept or resumed):
  // what it says — the assistant's unanswered sends — may change while a message waits behind a turn.
  function withNote(chatId, message) {
    let note = null;
    try {
      note = annotate(chatId);
    } catch (error) {
      log.error?.(`[runner] annotate ${chatId}: ${error.message}`);
    }
    if (!note) return message;
    // The note quotes what the agent sent a colleague, which that colleague may have steered: inert.
    note = inertText(note);
    return typeof message === "string" ? `${note}\n\n${message}` : { ...message, text: `${note}\n\n${message?.text || ""}` };
  }

  async function execute(chatId, entry, message) {
    const { runId } = entry;
    // Only what goes to the engine carries the note: a kept or fallback copy of this message is
    // the plain one, and gets a fresh note when it runs again.
    const sdkMessage = withNote(chatId, message);
    const emit = (type, data) => {
      entry.lastEventAt = Date.now();
      store.appendEvent(chatId, runId, type, data);
    };
    let status = "error";
    let error = null;
    let cont = false;
    try {
      const chat = store.getChat(chatId);
      emit("run.phase", { phase: "connecting" });
      const label = runLabel(chat);
      // The account this run is on: a plan limit marks this one, not whatever the chat routes to
      // when the error comes back (the owner may have moved the agent meanwhile — 2026-10-18 the
      // API-key account got marked with the subscription's weekly limit and every chat stalled).
      entry.provider = label.provider;
      const run = await startSdkRun(chat, sdkMessage, {
        ...(label.model && label.model !== "auto" ? { model: { id: label.model } } : chat.model ? { model: { id: chat.model } } : {}),
        ...(label.effort ? { effort: label.effort } : {}),
        // A permission mode (auto/ask/edits) is Claude's; other engines read only «plan».
        mode: chat.mode || "agent",
        // Claude only: other engines' SDKs get no options they do not know.
        // userMessageId: the turn's file checkpoint, used where Claude keeps one (run.checkpoint).
        ...(sdkFor(chat)?.kind === "claude" ? { ...ownerExtras(chat), userMessageId: randomUUID() } : {}),
        onDelta: ({ update }) => {
          if (update?.type === "fast-mode") {
            const before = fastStates.get(chatId);
            fastStates.set(chatId, { state: update.state, reason: update.reason || null });
            if (before?.state !== update.state || before?.reason !== (update.reason || null)) live(chatId);
          }
          for (const event of eventsFromUpdate(update)) {
            if (!QUIET_EVENTS.has(event.type) && !entry.produced) {
              entry.produced = true;
              reached(chatId, entry);
            }
            emit(event.type, event.data);
          }
        },
      });
      entry.run = run;
      store.setSdkRunId(runId, run.id);
      // A rewind to this turn's message puts the files it edits back (rewindFiles below).
      if (run.checkpoint) emit("run.checkpoint", run.checkpoint);
      // The engine has the turn: its «در صف» messages leave the waiting list now, not at the first
      // text — a long think kept them «در صف» above the box while the agent worked on them.
      reached(chatId, entry);
      if (entry.cancelRequested) await cancelSdkRun(run);
      const result = await run.wait();
      status = normalizeStatus(result.status, entry.cancelRequested);
      if (status === "error") error = result.error?.message || "run failed";
      const limitCode = result.error?.code;
      const asking = status === "error" && askFallback(store.getChat(chatId));
      // Auto mode moves exactly where it did before (autoFallback; engines that do not say: both
      // codes). Ask mode acts only on a spent plan.
      const autoMoves = result.error?.autoFallback ?? (limitCode === "plan_limit" || limitCode === ENGINE_UNAVAILABLE);
      if (status === "error" && (asking ? limitCode === "plan_limit" : autoMoves)) {
        entry.limitMove = true;
        // Marks this account limited even on the fallback's own retry; moves once at most.
        const limitedChat = store.getChat(chatId);
        const moves = onPlanLimit(limitedChat, result.error, entry.provider);
        // PLAN_FALLBACK=ask: never moves by itself; the owner is asked once the run has ended.
        if (askFallback(limitedChat)) {
          // Same model on another account: no card, the run moves (labelled); else ask.
          const hop = moves && !entry.retried ? accountHop(limitedChat) : null;
          if (hop) {
            entry.retryOnFallback = true;
            entry.hop = hop;
          }
          else {
            entry.limitError = result.error;
            entry.offerFallback = { provider: entry.provider || runLabel(limitedChat).provider };
          }
        } else if (moves && !entry.retried) entry.retryOnFallback = true;
        else entry.limitError = result.error;
      }
      // A session the provider only discovers is gone at send time: retry once on a fresh one.
      if (status === "error" && result.error?.code === "agent_not_found" && !entry.retried) entry.retryOnFallback = true;
    } catch (caught) {
      status = entry.cancelRequested ? "cancelled" : "error";
      error = status === "error" ? String(caught?.message || caught) : null;
      if (status === "error") log.error?.(`[runner] chat ${chatId}: ${error}`);
    } finally {
      // sweepStale() may already have finalized this run locally (the SDK never confirmed the
      // cancel) — do not double-write run state if the stuck promise eventually settles anyway.
      if (!entry.forcedDone) {
        onCancel(chatId); // releases a question still waiting when the run ends for any reason
        // Nothing reached the owner: keep the message for «ارسال دوباره» (a fallback retry handles itself).
        const keep = status === "error" && !entry.produced && !entry.retryOnFallback;
        // Cut by our own stop (a deploy), not by the owner: the turn continues after the next boot.
        cont = Boolean(entry.cut) && status === "cancelled";
        if (cont) error = "به‌خاطر ری‌استارت سرور قطع شد — بعد از بالا آمدن ادامه می‌دهد";
        // The queued messages this turn carries and the engine never got: a cancel dropped them.
        // Kept, retried elsewhere, or continued later, they are still waiting.
        if (!keep && !cont && !entry.retryOnFallback && !entry.run) markQueued(chatId, entry.turn.ids, "dropped");
        runq.save(chatId, cont ? entry.turn : null, entry.queue);
        // entry.carried, not turn.ids: reached() emptied those when the engine accepted the turn.
        if (keep && !entry.keptId) kept.push(chatId, entry.raw ?? message, entry.carried);
        if (keep && entry.leadNote && !store.getKv(NOTE_KEY(chatId))) store.setKv(NOTE_KEY(chatId), entry.leadNote);
        if (keep && entry.offerFallback) entry.offerFallback.keptId = entry.keptId || kept.list(chatId).at(-1)?.id || null;
        if (keep && entry.keptId) {
          kept.update(chatId, entry.keptId, (k) => [{ ...k, fails: k.fails + 1 }]);
          if (kept.list(chatId).find((k) => k.id === entry.keptId)?.fails === MAX_KEPT_RETRIES) {
            entry.keptGaveUp = true;
            emit("note", { text: `این پیام ${MAX_KEPT_RETRIES} بار به ایجنت نرسید؛ دیگر خودکار فرستاده نمی‌شود و پیام‌های تازه‌تر منتظرش نمی‌مانند. «دوباره» یا «حل شد» (یا «بستن») را بزنید.` });
          }
        }
        // A retry that got an answer out: the kept message is delivered.
        if (entry.keptId && !keep) {
          kept.update(chatId, entry.keptId, () => []);
          entry.keptDelivered = true;
        }
        if (entry.limitError) planLimitResume(chatId, entry.limitError, emit);
        else if (!entry.retryOnFallback) limitTries.delete(chatId);
        // The chat got through: nothing is left to continue.
        if (status === "finished") clearLimitResume(chatId);
        emit("run.finished", { status, ...(error ? { error } : {}), ...(keep ? { undelivered: true } : {}) });
        store.finishRun(chatId, runId, status, error);
        active.delete(chatId);
      }
    }
    if (entry.forcedDone) return;
    // Stopping: nothing starts now. A cut turn and what queued behind it wait in runq for the boot.
    if (stopping) {
      if (cont || entry.queue.length) pending.add(chatId, cont);
      return;
    }
    // No card when a queued message is about to start (it would be withdrawn at once) or on a Stop.
    const keptFollows = kept.next(chatId) >= 0 && (entry.keptDelivered || entry.keptGaveUp || entry.drainKept);
    if (entry.offerFallback && status === "error" && !entry.cancelRequested && !entry.queue.length && !keptFollows) {
      // The reset time as the engine said it; never a guess shown as «تا ساعت X».
      const resetsAt = entry.limitError?.resetsAt || resetFromText(entry.limitError?.message);
      offerFallback(chatId, runId, entry.offerFallback.provider, entry.raw ?? message, resetsAt, entry.offerFallback.keptId);
    }
    if (entry.retryOnFallback) {
      // A same-model move between Claude accounts (ask mode) keeps the session: both accounts share
      // one Claude Code config folder, only the token differs. Without a session to keep, the
      // rerun is told what it does not see and what the stopped run already did.
      const keepSession = Boolean(entry.hop && store.getChat(chatId)?.agent_id);
      if (entry.hop && !keepSession) {
        const raw = entry.raw ?? message;
        entry.rerunMessage = withLeadNote(raw, accountMoveNote(entry.hop, doneTools(store, runId)));
      }
      // The session handle belongs to the limited provider; the next run starts fresh elsewhere.
      if (!keepSession) store.setAgentId(chatId, null);
      // An automatic continue that moved engines is still that continue (its try count stays).
      const carry = limitTries.has(chatId);
      if (carry) autoSending.add(chatId);
      const retryId = startRun(chatId, entry.rerunMessage ?? message, entry.queue.splice(0), { ids: entry.carried, turnText: entry.turn.text, fallback: true, limitMove: Boolean(entry.limitMove), ...(entry.hop ? { raw: entry.raw ?? message } : {}) });
      if (carry) autoSending.delete(chatId);
      const next = active.get(chatId);
      if (next?.runId === retryId) next.retried = true;
      return;
    }
    if (status === "finished") Promise.resolve().then(() => onFinished(chatId)).catch(() => {});
    // Everything that queued up during the run goes in as ONE turn: separate turns answered each
    // stale message on its own (a colleague got three replies in a minute, 2026-09-25).
    const queued = entry.queue.splice(0);
    // While kept messages wait, what queued joins the end of that FIFO instead of jumping it.
    if (kept.next(chatId) >= 0 && queued.length) {
      kept.push(chatId, mergeQueued(messagesOf(queued)), idsOf(queued));
      runq.save(chatId, null, []);
      entry.drainKept = true;
    } else if (queued.length) {
      startRun(chatId, mergeQueued(messagesOf(queued)), [], { ids: idsOf(queued) });
      return;
    }
    // The next kept message goes when this run was a retry that got through (or gave up), or the
    // owner sent something during it; a first failure waits for «ارسال دوباره».
    if (!entry.cancelRequested && kept.next(chatId) >= 0 && (entry.keptDelivered || entry.keptGaveUp || entry.drainKept)) {
      startKept(chatId, kept.next(chatId));
    }
  }

  // Several queued messages as one turn: their texts, pictures and PDFs together (attachments.mjs).
  const mergeQueued = mergeMessages;

  // The turn's queued messages reached the agent: their labels say so now, once.
  function reached(chatId, entry) {
    if (!entry.turn.ids.length) return;
    markQueued(chatId, entry.turn.ids, "started");
    entry.turn.ids = [];
    if (active.get(chatId) === entry) persist(chatId, entry);
  }

  // queue: { message, id } each (id: its «در صف» user event). ids: the «در صف» events this turn
  // carries. turnText: what a continue after a restart quotes (a continue's own message is the
  // resume prompt, not the request it continues).
  // raw: the message without a system lead note (a plan-limit rerun), for a later card or kept copy.
  function startRun(chatId, message, queue = [], { keptId = null, ids = [], turnText = null, fallback = false, raw = null, limitMove = false } = {}) {
    const runId = store.startRun(chatId);
    const chat = store.getChat(chatId);
    const text = turnText ?? (typeof message === "string" ? message : message?.text || "");
    // carried: the «در صف» ids this turn holds, kept after reached() empties turn.ids, so a kept or
    // fallback copy of the turn still carries them.
    const entry = { runId, run: null, cancelRequested: false, cancelRequestedAt: null, forcedDone: false, queue, lastEventAt: Date.now(), keptId, turn: { text, ids }, carried: [...ids], raw };
    active.set(chatId, entry);
    persist(chatId, entry);
    if (suggestions.delete(chatId)) live(chatId);
    if (!autoSending.has(chatId)) limitTries.delete(chatId);
    withdrawFallback(chatId);
    const label = runLabel(chat);
    const lead = store.getKv?.(NOTE_KEY(chatId));
    if (lead) {
      store.deleteKv(NOTE_KEY(chatId));
      // Only on the engine it was written for: back on the old one, the note is stale and dropped.
      if (lead.provider === label.provider) {
        entry.raw = entry.raw ?? message;
        entry.leadNote = lead;
        message = withLeadNote(message, lead.note);
      }
    }
    const moved = store.getKv?.(FALLBACK_KEY(chatId));
    const hopNow = askFallback(chat) ? accountHop(chat) : null;
    if (moved && moved.provider !== label.provider && !hopNow) {
      // Moved off the fallback engine (the picker, a profile change): back on the engine that hit
      // the limit, its own session (with the conversation) resumes.
      if (label.provider === moved.fromProvider && moved.fromAgentId && !store.getChat(chatId)?.agent_id) store.setAgentId(chatId, moved.fromAgentId);
      store.deleteKv(FALLBACK_KEY(chatId));
    }
    store.appendEvent(chatId, runId, "run.started", {
      model: label.model,
      mode: chat.mode,
      provider: label.provider,
      ...(label.effort ? { effort: label.effort } : {}),
      ...(keptId ? { retry: true } : {}),
      // «چرا؟»: this run is the same message again on another engine after a plan limit.
      ...(fallback ? { fallback: true } : {}),
      // This rerun moved because of a plan limit (not a lost session): read by peers' envelope.
      ...(limitMove ? { limitMove: true } : {}),
      ...(hopNow ? { movedFrom: { from: String(hopNow.from || ""), account: String(hopNow.account || "") } } : fallbackLabel(chatId, label.provider)),
    });
    execute(chatId, entry, message);
    return runId;
  }


  // Best effort: a picture that cannot be stored must not stop the message.
  function keepAttachments(chatId, images, files) {
    const keep = (name, mimeType, data) => {
      try {
        return store.saveMedia({ chatId, mimeType, data: Buffer.from(String(data), "base64"), meta: { name, source: "attachment" } });
      } catch {
        return null;
      }
    };
    const imageIds = images.map((image, i) => keep(`image-${i + 1}`, image.mimeType || "image/png", image.data)).filter(Boolean);
    const fileIds = files.map((file) => keep(file.name, file.mimeType, file.data));
    return { imageIds, fileIds };
  }

  const api = {
    // intent: "send" (fails when busy), "queue" (after current run), "steer" (inject into current run)
    // clientId: the page's own id for this message (app.mjs de-duplicates resends by it).
    // from: who wrote it when it is not the owner ({ kind, name, personId }; a colleague's Telegram
    // message in a mother chat) — kept on the user event so the page can say so.
    // ownerText: the owner wrote this text (the composer, a new or side chat, an edit, a note). Any
    // other text — a peer agent, a colleague, a job, chat_send, a suggestion — reaches the agent
    // inert (redact.mjs inertText): no live "@path" and no leading "/" command. The event keeps
    // the text as written.
    // files: PDFs and text files the owner attached (attachments.mjs); a text file goes inside the text.
    async send(chatId, { text, images = [], files = [], intent = "send", clientId = null, from = null, ownerText = false }) {
      const current = active.get(chatId);
      let effective = intent;
      if (current && effective === "send" && isSoftBusy(chatId)) effective = "queue";
      const message = toSdkMessage({ text: ownerText ? text : inertText(text), images, files });
      if (current && stopping) effective = "queue";
      // The pictures and files stay in the chat's media (the event holds only their ids), so the thread
      // can show them later — not just say that the message «has a picture».
      const stored = keepAttachments(chatId, images, files);
      const userData = { text, images: images.length, ...(stored.imageIds.length ? { imageIds: stored.imageIds } : {}), ...(files.length ? { files: fileMeta(files).map((meta, i) => (stored.fileIds[i] ? { ...meta, mediaId: stored.fileIds[i] } : meta)) } : {}), ...(current ? { intent: effective } : {}), ...(clientId ? { clientId } : {}), ...(from ? { from } : {}), ...(ownerText ? { ownerText: true } : {}) };
      // tracked: user.queue events settle this «در صف» label (older ones the timeline settles).
      const queueEvent = () => store.appendEvent(chatId, null, "user", { ...userData, intent: "queue", tracked: true }).id;
      store.deleteKv?.(resumesKey(chatId));
      // Stopping with no turn to wait behind: the message waits for the next boot.
      if (stopping && !current) {
        const { turn, queue } = runq.get(chatId);
        runq.save(chatId, turn, [...queue, { message, id: queueEvent() }]);
        pending.add(chatId, false);
        return { runId: null, delivered: "queued" };
      }
      const carried = current ? [] : takeWaiting(chatId);
      // Kept messages wait for a retry: a new one joins the end of that FIFO, delivered after them.
      if (kept.next(chatId) >= 0) {
        if (carried.length) kept.push(chatId, mergeQueued(messagesOf(carried)), idsOf(carried));
        kept.push(chatId, message, [queueEvent()]);
        if (!current) return { runId: startKept(chatId, kept.next(chatId)), delivered: "queued" };
        current.drainKept = true;
        return { runId: current.runId, delivered: "queued" };
      }
      if (!current) {
        store.appendEvent(chatId, null, "user", userData);
        if (!carried.length) return { runId: startRun(chatId, message), delivered: "run" };
        return { runId: startRun(chatId, mergeQueued([...messagesOf(carried), message]), [], { ids: idsOf(carried) }), delivered: "run" };
      }
      if (effective === "send") throw new BusyError();
      if ((effective === "steer" || effective === "force") && current.run?.steer) {
        const outcome = await current.run.steer(forEngine(message, sdkFor(store.getChat(chatId))?.kind)).catch(() => "revert_to_followup");
        if (outcome === "complete_delivered") {
          store.appendEvent(chatId, current.runId, "user", { ...userData, ...(effective === "force" ? { intent: "steer" } : {}) });
          return { runId: current.runId, delivered: "steered" };
        }
      }
      current.queue.push({ message, id: queueEvent() });
      persist(chatId, current);
      // «فوری» (force): the owner wants this message in now. An engine that can take it mid-turn
      // already did (steer above); otherwise the current turn is interrupted — not the owner's Stop:
      // delegated work and what queued stay — and the queue (this message with it) starts at once
      // as the next turn of the same session.
      if (effective === "force" && !current.cancelRequested) {
        current.forced = true;
        current.cancelRequested = true;
        current.cancelRequestedAt = Date.now();
        store.appendEvent(chatId, current.runId, "note", { text: "کار قبلی برای پیام فوری قطع شد؛ ایجنت با همین پیام ادامه می‌دهد." });
        if (current.run) await cancelSdkRun(current.run);
        return { runId: current.runId, delivered: "forced" };
      }
      return { runId: current.runId, delivered: "queued" };
    },

    // user=false is the process shutting down: stop the runs, keep delegated work on record.
    async cancel(chatId, { user = true } = {}) {
      if (user) onUserCancel(chatId); // also when the parent's own turn already ended
      if (user) clearLimitResume(chatId);
      const entry = active.get(chatId);
      if (!entry) {
        // The owner's Stop on a chat still waiting to resume after a restart: nothing of it runs.
        if (user && (pending.has(chatId) || runq.get(chatId).queue.length)) {
          const { turn } = runq.get(chatId);
          markQueued(chatId, [...(turn?.ids || []), ...idsOf(takeWaiting(chatId))], "dropped");
          return { status: "cancelled" };
        }
        return { status: "not-active" };
      }
      // Our own stop cuts the turn to continue after the boot; the owner's Stop — even one during
      // the stop — ends it for good, with what queued behind it.
      if (!user && !entry.cancelRequested) entry.cut = true;
      if (user) {
        entry.cut = false;
        pending.remove(chatId);
        markQueued(chatId, idsOf(entry.queue.splice(0)), "dropped");
        persist(chatId, entry);
      }
      entry.cancelRequested = true;
      entry.cancelRequestedAt = Date.now();
      onCancel(chatId);
      if (entry.run) await cancelSdkRun(entry.run);
      return { status: "cancelling" };
    },

    // Cancels runs that produced no event for staleMs (probably stuck on an opaque native tool
    // call, e.g. `task`), and finalizes locally — without waiting on the SDK — any run whose
    // cancel was requested more than forceMs ago and still has not ended. Call this periodically
    // (index.mjs does, every few minutes); it is cheap and a no-op when nothing is stale.
    async sweepStale({ staleMs = DEFAULT_STALE_MS, forceMs = DEFAULT_FORCE_MS } = {}) {
      const now = Date.now();
      const acted = [];
      for (const chatId of await sweepLimitResumes(now)) acted.push({ chatId, action: "continued-after-limit" });
      for (const [chatId, entry] of [...active]) {
        if (entry.cancelRequested) {
          if (entry.forcedDone || now - entry.cancelRequestedAt <= forceMs) continue;
          entry.forcedDone = true;
          const note = "لغو درخواست شد ولی SDK جواب نداد — محلی بسته شد";
          store.appendEvent(chatId, entry.runId, "run.finished", { status: "cancelled", error: note });
          store.finishRun(chatId, entry.runId, "cancelled", note);
          // As the normal end does: the engine never took the turn, so what it carries is dropped
          // (a kept retry's messages stay in the kept FIFO, still waiting).
          if (!entry.run && !entry.keptId) markQueued(chatId, entry.turn.ids, "dropped");
          runq.save(chatId, null, entry.queue);
          active.delete(chatId);
          onCancel(chatId);
          log.error?.(`[runner] chat ${chatId}: forced local finalize — cancel unconfirmed for ${Math.round((now - entry.cancelRequestedAt) / 1000)}s`);
          acted.push({ chatId, action: "forced" });
          continue;
        }
        if (now - entry.lastEventAt <= staleMs) continue;
        // A run waiting on an open question is not stuck: the owner may be asleep, and killing it
        // throws away work they are about to approve (seen live 2026-09-21 — an approval question
        // reached Telegram, the sweeper cancelled the run 15 minutes later).
        if (isBlocked(chatId)) continue;
        // Before killing: providers that support it (openai) get one in-band nudge — abort the
        // silent round and inject a "report your state and continue" note. Killing a silent run
        // threw away its whole transcript-in-progress, and the task retried from scratch
        // (2026-09-27: five "stale: no activity" tasks, each retry re-asking the owner).
        if (!entry.nudged && typeof entry.run?.nudge === "function") {
          entry.nudged = true;
          const silentMinutes = Math.round((now - entry.lastEventAt) / 60_000);
          entry.lastEventAt = Date.now();
          store.appendEvent(chatId, entry.runId, "run.phase", {
            phase: "nudge",
            note: `${silentMinutes} دقیقه سکوت — قبل از لغو، تذکر ادامه تزریق شد`,
          });
          log.error?.(`[runner] chat ${chatId}: silent ${silentMinutes}m — nudging before stale-cancel`);
          try {
            entry.run.nudge(
              "[تذکر بعد از سکوت] مدت‌ها هیچ رویدادی ثبت نشده. همین‌جا وضعیت بده: چه کردی، چه چیزی مانده؛ " +
                "همین کار را بدون تکرار مراحل انجام‌شده به پایان برسان و نتیجه را بده.",
            );
          } catch {
            /* fall through to cancel on the next sweep */
          }
          acted.push({ chatId, action: "nudged" });
          continue;
        }
        const minutes = Math.round((now - entry.lastEventAt) / 60_000);
        store.appendEvent(chatId, entry.runId, "run.phase", { phase: "stale", note: `${minutes} دقیقه بدون رویداد — گیرکرده فرض و لغو شد` });
        log.error?.(`[runner] chat ${chatId}: no event for ${minutes}m — cancelling as stuck`);
        await this.cancel(chatId).catch((cancelError) => log.error?.(`[runner] stale cancel ${chatId}: ${cancelError.message}`));
        acted.push({ chatId, action: "cancelled", minutes });
      }
      return acted;
    },

    /** Cancel every in-memory run so Cursor does not keep an "active run" after SIGTERM/recreate. */
    async shutdown({ timeoutMs = 8_000 } = {}) {
      stopping = true;
      const ids = [...active.keys()];
      await Promise.all(ids.map((id) => this.cancel(id, { user: false }).catch(() => {})));
      const end = Date.now() + timeoutMs;
      while (active.size && Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      for (const agent of agents.values()) {
        try {
          agent.close?.();
        } catch {
          /* ignore */
        }
      }
      agents.clear();
      return { cancelled: ids.length, stillActive: active.size };
    },

    isActive(chatId) {
      return active.has(chatId);
    },

    // Config CLAUDE_BACKGROUND_TASKS: the chat's live background tasks and a stop for each.
    backgroundTasks(chatId) {
      return bgAgents.get(chatId)?.backgroundTasks?.() || [];
    },
    async stopTask(chatId, taskId) {
      const agent = bgAgents.get(chatId);
      if (typeof agent?.stopTask !== "function") return false;
      return agent.stopTask(String(taskId));
    },

    // The output file Claude Code named for one of the chat's ended tasks, never a path from outside.
    taskOutputFile(chatId, taskId) {
      return taskOutputs.get(chatId)?.get(String(taskId))?.file || null;
    },
    // The chat's ended tasks that left an output file, newest first (never the path).
    endedTasks(chatId) {
      return [...(taskOutputs.get(chatId)?.entries() || [])].map(([id, t]) => ({ id, description: t.description, type: t.type, status: t.status, endedAt: t.endedAt })).reverse();
    },

    // The open Claude Code process's MCP servers for a chat (null without one) and their controls.
    async mcpStatus(chatId) {
      const agent = liveAgent(chatId);
      return typeof agent?.mcpStatus === "function" ? agent.mcpStatus() : null;
    },
    async mcpControl(chatId, action, name, enabled) {
      const agent = liveAgent(chatId);
      return typeof agent?.mcpControl === "function" ? agent.mcpControl(action, name, enabled) : false;
    },
    // The owner chat whose open process was used last, or null.
    latestSessionChat() {
      const ids = [...usedAt.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      return ids.find((id) => (store.getChat(id)?.caller || "owner") === "owner" && liveAgent(id)?.hasOpenProcess?.()) || null;
    },

    // The cached agent's own context reading (Claude: SDK getContextUsage at the last result), or
    // null — never creates or resumes an agent to measure.
    contextUsage(chatId) {
      const chat = store.getChat(chatId);
      const agent = chat?.agent_id ? agents.get(agentKey(chat, chat.agent_id)) : null;
      return agent?.contextUsage?.() ?? null;
    },

    runIdOf(chatId) {
      return active.get(chatId)?.runId ?? null;
    },

    // «ارسال دوباره»: the oldest kept message (even one given up on) goes again now.
    retry(chatId) {
      if (active.has(chatId)) throw new BusyError();
      if (!kept.list(chatId).length) return { status: "nothing-kept" };
      // Messages still waiting from before a restart join the end of the kept FIFO.
      const carried = takeWaiting(chatId);
      if (carried.length) kept.push(chatId, mergeQueued(messagesOf(carried)), idsOf(carried));
      return { runId: startKept(chatId, 0), delivered: "retry" };
    },

    // Drops one kept message by id without sending it («حل شد» drops them all).
    // state "removed": the owner took it out of the queue peek (unqueue), so it leaves the thread too.
    dropKept(chatId, id, state = "dropped") {
      const before = kept.list(chatId).length;
      const item = kept.list(chatId).find((k) => k.id === id);
      kept.update(chatId, id, () => []);
      if (item) markQueued(chatId, item.ids, state);
      return kept.list(chatId).length < before;
    },

    // «حذف»/«ویرایش» on a «در صف» message in the queue peek (by its user event id): it leaves the
    // queue it waits in — the run's (and its runq copy), the one waiting for the next boot, or the
    // kept FIFO — and never runs. Marked «removed», not «dropped»: the owner took it back, so the
    // thread does not show it either (a Stop's «dropped» stays visible as «اجرا نشد»). False when
    // it is not waiting: already started, dropped or removed, or carried by the turn in flight.
    // Throws code "merged" for one merged with others into a kept item: it cannot leave alone.
    // onRemoved(message): a message from the live queue that will now never reach the engine (its
    // PDFs leave the budget). Not for a kept message: its run had already handed it to the engine.
    unqueue(chatId, userEventId, onRemoved = null) {
      const id = Number(userEventId);
      const entry = active.get(chatId);
      const waiting = entry ? null : runq.get(chatId);
      const queue = entry ? entry.queue : waiting.queue;
      const at = queue.findIndex((item) => item.id === id);
      if (at >= 0) {
        const [removed] = queue.splice(at, 1);
        onRemoved?.(removed.message);
        if (entry) persist(chatId, entry);
        else runq.save(chatId, waiting.turn, queue);
        markQueued(chatId, [id], "removed");
        return true;
      }
      // ponytail: only a kept item that is this one message and not the retry running now; one
      // merged from several has no parts left to split, and stays (its own «حذف» drops it whole).
      const item = kept.list(chatId).find((k) => k.ids?.includes(id) && k.id !== entry?.keptId);
      if (!item) return false;
      if (item.ids.length > 1) throw Object.assign(new Error("merged with other queued messages into one kept message"), { code: "merged" });
      return api.dropKept(chatId, item.id, "removed");
    },

    // In-band note to a live run (providers that support nudge: the model must answer it before
    // continuing). Used for the peer-task checkpoint. Returns false when there is nothing to note.
    async note(chatId, text) {
      const entry = active.get(chatId);
      if (!entry?.run || typeof entry.run.nudge !== "function") return false;
      try {
        await entry.run.nudge(text);
        return true;
      } catch {
        return false;
      }
    },

    // Runs doing work right now — not the ones parked on a question to a person. A deploy may
    // restart over parked runs (they resume and ask again); waiting hours for an answer blocked
    // every deploy (2026-09-26).
    workingCount() {
      return [...active.keys()].filter((chatId) => !isBlocked(chatId)).length;
    },

    activeCount() {
      return active.size;
    },

    activeChatIds() {
      return [...active.keys()];
    },

    // When the chat will continue by itself after the plan limit resets (ms), or null.
    limitResumeAt(chatId) {
      return Number(limitResumes()[chatId]?.at) || null;
    },
    // The owner's «لغو» or a message of theirs: the chat no longer continues by itself.
    cancelLimitResume(chatId) {
      clearLimitResume(chatId);
      limitTries.delete(chatId);
    },
    sweepLimitResumes,

    // PLAN_FALLBACK=ask: the owner's click on a plan-limit card (true when it was the open one),
    // the open card's id, and withdrawing it (an archive).
    answerFallback,
    openFallbackCard(chatId) {
      return offers()[chatId]?.askId || null;
    },
    withdrawFallback,

    // The suggested next message for the chat's composer, or null.
    suggestion(chatId) {
      return promptSuggestions() ? suggestions.get(chatId) ?? null : null;
    },

    // Fast mode as Claude Code last reported it for the chat ({ state, reason }), or null.
    fastState(chatId) {
      return fastStates.get(chatId) || null;
    },

    // The engine kind (claude | openai | cursor) the chat's next run goes to.
    engineOf(chat) {
      return sdkFor(chat)?.kind || null;
    },

    // The «/» list for a chat: its repo's, or the latest one known.
    commandsFor(chat) {
      return store.getKv(`${COMMANDS_KEY}:${chat?.repo || ""}`) || store.getKv(COMMANDS_KEY) || [];
    },

    // Rewind: the files Claude edited from this user event on, back as they were before it — from the
    // first checkpointed turn at or after it. null when there is none or the engine cannot (then the
    // rewind only cuts the conversation); { restored } or { error } otherwise. Never throws.
    // ponytail: a turn already running when the event was queued is not rewound (only later turns).
    // dryRun: a preview { canRewind, changed, insertions, deletions } for the rewind dialog.
    async rewindFiles(chat, fromEventId, { dryRun = false } = {}) {
      let mark = null;
      for (const event of store.allEvents(chat.id, Number(fromEventId) - 1)) {
        if (event.type === "run.checkpoint") {
          mark = event.data;
          break;
        }
      }
      const provider = sdkFor(chat);
      if (!mark?.userMessageId || typeof provider?.rewindFiles !== "function") return null;
      try {
        const result = await provider.rewindFiles(mark.sessionId, mark.userMessageId, { cwd: mark.cwd, dryRun });
        if (dryRun) return { canRewind: Boolean(result?.canRewind), changed: result?.filesChanged?.length || 0, insertions: Number(result?.insertions) || 0, deletions: Number(result?.deletions) || 0 };
        return result?.canRewind ? { restored: result.filesChanged?.length || 0 } : { error: result?.error || "checkpoint not found" };
      } catch (error) {
        log.error?.(`[runner] rewind files ${chat.id}: ${error?.message || error}`);
        return { error: String(error?.message || error) };
      }
    },

    // A copy of a Claude session up to one entry, for a fork; null when the chat's engine cannot.
    async forkSession(chat, { sessionId, upToMessageId }) {
      const provider = sdkFor(chat);
      if (typeof provider?.forkSession !== "function") return null;
      return provider.forkSession(sessionId, { upToMessageId });
    },
  };

  // After a boot: each chat our stop or a crash cut continues — one chat every resumeGapMs, oldest
  // first — and what queued behind its turn follows it in order. An item leaves the stored list
  // only as its run starts, so a second restart mid-way loses none. A message to the chat in the
  // meantime made its continue stale (send took the item); the owner's Stop dropped it.
  async function resumeOne({ chatId, cont }) {
    const chat = store.getChat(chatId);
    // Materialized Cursor-task transcripts are read-only; a job run has its own trigger and timeout.
    if (!chat || chat.caller === "task" || notResumable(chat)) return void takeWaiting(chatId);
    let continuing = cont && !chat.job_id;
    const count = store.getKv?.(resumesKey(chatId));
    const fresh = !count || Date.now() - count.at > 60 * 60_000;
    if (continuing && !fresh && count.n >= MAX_RESUMES) {
      continuing = false;
      log.error?.(`[runner] chat ${chatId}: cut ${count.n} times within an hour — not continuing it again`);
    }
    const provider = sdkFor(chat);
    if (continuing && chat.agent_id && typeof provider?.clearStuck === "function") {
      try {
        await provider.clearStuck(chat.agent_id, await agentOptions(chat));
      } catch (error) {
        log.error?.(`[runner] clearStuck ${chat.agent_id}: ${error?.message || error}`);
      }
    }
    if (stopping || active.has(chatId) || !pending.has(chatId)) return;
    // Read after the awaits: the owner may have taken a message back (unqueue) meanwhile.
    const { turn, queue } = runq.get(chatId);
    if (continuing) {
      const text = turn?.text ?? lastUserPrompt(store, chatId); // no runq: cut by an older build
      const prompt = resumePrompt(text);
      store.appendEvent(chatId, null, "user", { text: prompt });
      store.setKv(resumesKey(chatId), { n: (fresh ? 0 : count.n) + 1, at: Date.now() });
      startRun(chatId, prompt, queue, { ids: turn?.ids || [], turnText: text ?? prompt });
      log.info?.(`[runner] resumed chat ${chatId} after restart`);
    } else if (queue.length && kept.next(chatId) < 0) {
      startRun(chatId, mergeQueued(messagesOf(queue)), [], { ids: idsOf(queue) });
    } else if (queue.length) {
      kept.push(chatId, mergeQueued(messagesOf(queue)), idsOf(queue)); // behind the kept FIFO
      runq.save(chatId, null, []);
    } else runq.save(chatId, null, []);
    pending.remove(chatId);
  }

  if (pending.list().length) {
    Promise.resolve()
      .then(async () => {
        for (let first = true; !stopping; first = false) {
          if (!first) await new Promise((resolve) => setTimeout(resolve, resumeGapMs));
          const item = pending.list()[0];
          if (!item || stopping) return;
          await resumeOne(item).catch((error) => log.error?.(`[runner] resume after restart failed ${item.chatId}: ${error?.message || error}`));
          // Never spin on an item that did not leave the list (e.g. its chat is busy right now).
          if (!stopping && pending.list()[0]?.chatId === item.chatId) pending.remove(item.chatId);
        }
      })
      .catch((error) => log.error?.(`[runner] resume-after-restart: ${error?.message || error}`));
  }

  return api;
}

async function cancelSdkRun(run) {
  if (run.supports?.("cancel") === false) return;
  await run.cancel().catch(() => {});
}

// Events that do not mean anything reached the owner (a run that only emitted these failed silently).
const QUIET_EVENTS = new Set(["run.phase", "usage", "usage.request", "status", "thinking", "thinking.done"]);

function normalizeStatus(status, cancelRequested) {
  const value = String(status || "").toLowerCase();
  if (cancelRequested || value.includes("cancel")) return "cancelled";
  if (value === "finished" || value === "completed" || value === "success") return "finished";
  return "error";
}

function lastUserPrompt(store, chatId) {
  let text = null;
  for (const event of store.allEvents(chatId)) {
    if (event.type !== "user" || !event.data?.text) continue;
    const value = String(event.data.text);
    if (value.startsWith("[ادامه پس از ری‌استارت") || value.startsWith("اجرای قبلی به‌خاطر ری‌استارت")) continue;
    text = value;
  }
  return text;
}

// A colleague's message (related.mjs chat_send) is not called the owner's request on a resume.
export function resumePrompt(lastUser) {
  if (lastUser) {
    const who = lastUser.startsWith("📥 ") ? "پیام قبلی (از شخص ثالث — نه درخواست Owner) این بود" : "درخواست قبلی Owner این بود";
    return (
      `[ادامه پس از ری‌استارت سرور]\n` +
      `${who}:\n«${lastUser.slice(0, 4000)}»\n\n` +
      `از جایی که قطع شدی ادامه بده. مراحل و ابزارهایی که قبلاً درست انجام شده را تکرار نکن؛ بقیه را تمام کن و نتیجه بده.`
    );
  }
  return (
    `[ادامه پس از ری‌استارت سرور]\n` +
    `اجرای قبلی قطع شد. از همان‌جا ادامه بده؛ کار تکراری نکن و نتیجه را بده.`
  );
}
