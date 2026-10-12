import { randomUUID } from "node:crypto";
import { eventsFromUpdate } from "./updates.mjs";

// Kept messages: the owner's message whose run ended in an error before anything
// reached them (no text, no tool) is kept in the store's kv, oldest first, until a retry gets
// through or the owner deletes it. A newer message joins the end of that FIFO, never jumps it.
// After MAX_KEPT_RETRIES failed retries a kept message is no longer retried on its own and stops
// holding newer ones back; «ارسال دوباره» and «حذف» still work.
export const MAX_KEPT_RETRIES = 3;
const keptKey = (chatId) => `kept:${chatId}`;
export function keptList(store, chatId) {
  const value = store.getKv?.(keptKey(chatId));
  return Array.isArray(value) ? value : [];
}
// What the thread shows: ids only, oldest first (a delete names one by id, never by position).
export const keptIds = (store, chatId) => keptList(store, chatId).map((k) => k.id);

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
  // onPlanLimit(chat, error) -> true when the chat should be retried once on another provider.
  onPlanLimit = () => false,
  // When true, a plain "send" while busy is downgraded to queue (used while ask_agent blocks).
  isSoftBusy = () => false,
  // When true, the run is deliberately parked (waiting for an answer to an open question), so
  // silence is expected and sweepStale must leave it alone.
  isBlocked = () => false,
  log = console,
}) {
  const active = new Map(); // chatId -> { runId, run, cancelRequested, cancelRequestedAt, forcedDone, queue, lastEventAt }
  // Keyed by provider + agentId: a chat whose routing moved engines (GLM → Claude for a colleague
  // thread) kept its old agent_id and got the cached GLM agent — Z.ai then 404'd "opus" (2026-10-11).
  const agents = new Map(); // `${provider.id}:${agentId}` -> SDKAgent
  const pendingResume = []; // chats whose in-flight run died with the process

  const kept = {
    list: (chatId) => keptList(store, chatId),
    save: (chatId, list) => (list.length ? store.setKv(keptKey(chatId), list) : store.deleteKv(keptKey(chatId))),
    push: (chatId, message) => kept.save(chatId, [...kept.list(chatId), { id: `k${randomUUID().replace(/-/g, "").slice(0, 12)}`, message, fails: 0 }]),
    // The oldest kept message still retried on its own, or -1.
    next: (chatId) => kept.list(chatId).findIndex((k) => k.fails < MAX_KEPT_RETRIES),
    update: (chatId, id, fn) => kept.save(chatId, kept.list(chatId).flatMap((k) => (k.id === id ? fn(k) : [k]))),
  };
  const startKept = (chatId, index) => {
    const item = kept.list(chatId)[index];
    return item ? startRun(chatId, item.message, [], { keptId: item.id }) : null;
  };

  const sdkFor = (chat) => (providerFor ? providerFor(chat) : sdk);
  const agentKey = (chat, id) => `${sdkFor(chat)?.id || ""}:${id}`;

  for (const run of store.runningRuns()) {
    const chat = store.getChat(run.chat_id);
    store.appendEvent(run.chat_id, run.id, "run.finished", {
      status: "cancelled",
      error: "به‌خاطر ری‌استارت سرور قطع شد — در حال ازسرگیری",
    });
    store.finishRun(run.chat_id, run.id, "cancelled", "به‌خاطر ری‌استارت سرور قطع شد — در حال ازسرگیری");
    // Materialized Cursor-task transcripts are read-only; don't spawn a new agent run for them.
    if (chat && chat.caller !== "task") {
      pendingResume.push({
        chatId: chat.id,
        agentId: chat.agent_id || null,
        lastUser: lastUserPrompt(store, chat.id),
      });
    }
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

  async function createFresh(chat) {
    if (chat.agent_id) agents.delete(agentKey(chat, chat.agent_id));
    store.setAgentId(chat.id, null);
    const options = await agentOptions({ ...chat, agent_id: null });
    const provider = sdkFor(chat);
    const agent = await withRetry(() => provider.create(options));
    agents.set(agentKey(chat, agent.agentId), agent);
    store.setAgentId(chat.id, agent.agentId);
    return agent;
  }

  async function agentFor(chat, { forceFresh = false } = {}) {
    if (forceFresh) return createFresh(chat);
    if (chat.agent_id && agents.has(agentKey(chat, chat.agent_id))) return agents.get(agentKey(chat, chat.agent_id));
    const options = await agentOptions(chat);
    const provider = sdkFor(chat);
    try {
      const agent = chat.agent_id
        ? await withRetry(() => provider.resume(chat.agent_id, options))
        : await withRetry(() => provider.create(options));
      agents.set(agentKey(chat, agent.agentId), agent);
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

  async function execute(chatId, entry, message) {
    const { runId } = entry;
    const emit = (type, data) => {
      entry.lastEventAt = Date.now();
      store.appendEvent(chatId, runId, type, data);
    };
    let status = "error";
    let error = null;
    try {
      const chat = store.getChat(chatId);
      emit("run.phase", { phase: "connecting" });
      const label = runLabel(chat);
      const run = await startSdkRun(chat, message, {
        ...(label.model && label.model !== "auto" ? { model: { id: label.model } } : chat.model ? { model: { id: chat.model } } : {}),
        ...(label.effort ? { effort: label.effort } : {}),
        mode: chat.mode === "plan" ? "plan" : "agent",
        onDelta: ({ update }) => {
          for (const event of eventsFromUpdate(update)) {
            if (!QUIET_EVENTS.has(event.type)) entry.produced = true;
            emit(event.type, event.data);
          }
        },
      });
      entry.run = run;
      store.setSdkRunId(runId, run.id);
      if (entry.cancelRequested) await cancelSdkRun(run);
      const result = await run.wait();
      status = normalizeStatus(result.status, entry.cancelRequested);
      if (status === "error") error = result.error?.message || "run failed";
      if (status === "error" && result.error?.code === "plan_limit" && !entry.retried && onPlanLimit(store.getChat(chatId), result.error)) {
        entry.retryOnFallback = true;
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
        if (keep && !entry.keptId) kept.push(chatId, message);
        if (keep && entry.keptId) {
          kept.update(chatId, entry.keptId, (k) => [{ ...k, fails: k.fails + 1 }]);
          if (kept.list(chatId).find((k) => k.id === entry.keptId)?.fails === MAX_KEPT_RETRIES) {
            entry.keptGaveUp = true;
            emit("note", { text: `این پیام ${MAX_KEPT_RETRIES} بار به ایجنت نرسید؛ دیگر خودکار فرستاده نمی‌شود و پیام‌های تازه‌تر منتظرش نمی‌مانند. «ارسال دوباره» یا «حذف» را بزنید.` });
          }
        }
        // A retry that got an answer out: the kept message is delivered.
        if (entry.keptId && !keep) {
          kept.update(chatId, entry.keptId, () => []);
          entry.keptDelivered = true;
        }
        emit("run.finished", { status, ...(error ? { error } : {}), ...(keep ? { undelivered: true } : {}) });
        store.finishRun(chatId, runId, status, error);
        active.delete(chatId);
      }
    }
    if (entry.forcedDone) return;
    if (entry.retryOnFallback) {
      // The session handle belongs to the limited provider; the next run starts fresh elsewhere.
      store.setAgentId(chatId, null);
      const retryId = startRun(chatId, message, entry.queue.splice(0));
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
      kept.push(chatId, mergeQueued(queued));
      entry.drainKept = true;
    } else if (queued.length) {
      startRun(chatId, mergeQueued(queued), []);
      return;
    }
    // The next kept message goes when this run was a retry that got through (or gave up), or the
    // owner sent something during it; a first failure waits for «ارسال دوباره».
    if (!entry.cancelRequested && kept.next(chatId) >= 0 && (entry.keptDelivered || entry.keptGaveUp || entry.drainKept)) {
      startKept(chatId, kept.next(chatId));
    }
  }

  function mergeQueued(messages) {
    if (messages.length === 1) return messages[0];
    const text = messages.map((m) => (typeof m === "string" ? m : m.text)).join("\n\n");
    const images = messages.flatMap((m) => (typeof m === "string" ? [] : m.images || []));
    return images.length ? { text, images } : text;
  }

  function startRun(chatId, message, queue = [], { keptId = null } = {}) {
    const runId = store.startRun(chatId);
    const chat = store.getChat(chatId);
    const entry = { runId, run: null, cancelRequested: false, cancelRequestedAt: null, forcedDone: false, queue, lastEventAt: Date.now(), keptId };
    active.set(chatId, entry);
    const label = runLabel(chat);
    store.appendEvent(chatId, runId, "run.started", { model: label.model, mode: chat.mode, provider: label.provider, ...(keptId ? { retry: true } : {}) });
    execute(chatId, entry, message);
    return runId;
  }

  function toSdkMessage({ text, images }) {
    if (!images?.length) return text;
    return { text, images: images.map((image) => ({ data: image.data, mimeType: image.mimeType })) };
  }

  const api = {
    // intent: "send" (fails when busy), "queue" (after current run), "steer" (inject into current run)
    async send(chatId, { text, images = [], intent = "send" }) {
      const current = active.get(chatId);
      let effective = intent;
      if (current && effective === "send" && isSoftBusy(chatId)) effective = "queue";
      const message = toSdkMessage({ text, images });
      const userData = { text, images: images.length, ...(current ? { intent: effective } : {}) };
      // Kept messages wait for a retry: a new one joins the end of that FIFO, delivered after them.
      if (kept.next(chatId) >= 0) {
        store.appendEvent(chatId, null, "user", { ...userData, intent: "queue" });
        kept.push(chatId, message);
        if (!current) return { runId: startKept(chatId, kept.next(chatId)), delivered: "queued" };
        current.drainKept = true;
        return { runId: current.runId, delivered: "queued" };
      }
      if (!current) {
        store.appendEvent(chatId, null, "user", userData);
        return { runId: startRun(chatId, message), delivered: "run" };
      }
      if (effective === "send") throw new BusyError();
      if (effective === "steer" && current.run?.steer) {
        const outcome = await current.run.steer(message).catch(() => "revert_to_followup");
        if (outcome === "complete_delivered") {
          store.appendEvent(chatId, current.runId, "user", userData);
          return { runId: current.runId, delivered: "steered" };
        }
      }
      store.appendEvent(chatId, null, "user", { ...userData, intent: "queue" });
      current.queue.push(message);
      return { runId: current.runId, delivered: "queued" };
    },

    // user=false is the process shutting down: stop the runs, keep delegated work on record.
    async cancel(chatId, { user = true } = {}) {
      if (user) onUserCancel(chatId); // also when the parent's own turn already ended
      const entry = active.get(chatId);
      if (!entry) return { status: "not-active" };
      entry.cancelRequested = true;
      entry.cancelRequestedAt = Date.now();
      entry.queue.length = 0;
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
      for (const [chatId, entry] of [...active]) {
        if (entry.cancelRequested) {
          if (entry.forcedDone || now - entry.cancelRequestedAt <= forceMs) continue;
          entry.forcedDone = true;
          const note = "لغو درخواست شد ولی SDK جواب نداد — محلی بسته شد";
          store.appendEvent(chatId, entry.runId, "run.finished", { status: "cancelled", error: note });
          store.finishRun(chatId, entry.runId, "cancelled", note);
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

    // «ارسال دوباره»: the oldest kept message (even one given up on) goes again now.
    retry(chatId) {
      if (active.has(chatId)) throw new BusyError();
      if (!kept.list(chatId).length) return { status: "nothing-kept" };
      return { runId: startKept(chatId, 0), delivered: "retry" };
    },

    // «حذف»: drops one kept message by id without sending it.
    dropKept(chatId, id) {
      const before = kept.list(chatId).length;
      kept.update(chatId, id, () => []);
      return kept.list(chatId).length < before;
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
  };

  // After a crash/recreate: clear stuck provider runs, then continue each orphaned chat.
  if (pendingResume.length) {
    Promise.resolve()
      .then(async () => {
        const seen = new Set();
        for (const item of pendingResume) {
          if (seen.has(item.chatId)) continue;
          seen.add(item.chatId);
          const chat = store.getChat(item.chatId);
          if (!chat) continue;
          const provider = sdkFor(chat);
          if (item.agentId && typeof provider?.clearStuck === "function") {
            try {
              await provider.clearStuck(item.agentId, await agentOptions(chat));
            } catch (error) {
              log.error?.(`[runner] clearStuck ${item.agentId}: ${error?.message || error}`);
            }
          }
          try {
            await api.send(item.chatId, { text: resumePrompt(item.lastUser) });
            log.info?.(`[runner] resumed chat ${item.chatId} after restart`);
          } catch (error) {
            log.error?.(`[runner] resume after restart failed ${item.chatId}: ${error?.message || error}`);
          }
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
const QUIET_EVENTS = new Set(["run.phase", "usage", "status", "thinking", "thinking.done"]);

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

function resumePrompt(lastUser) {
  if (lastUser) {
    return (
      `[ادامه پس از ری‌استارت سرور]\n` +
      `درخواست قبلی Owner این بود:\n«${lastUser.slice(0, 4000)}»\n\n` +
      `از جایی که قطع شدی ادامه بده. مراحل و ابزارهایی که قبلاً درست انجام شده را تکرار نکن؛ بقیه را تمام کن و نتیجه بده.`
    );
  }
  return (
    `[ادامه پس از ری‌استارت سرور]\n` +
    `اجرای قبلی قطع شد. از همان‌جا ادامه بده؛ کار تکراری نکن و نتیجه را بده.`
  );
}
