import { eventsFromUpdate } from "./updates.mjs";

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
  // When true, a plain "send" while busy is downgraded to queue (used while ask_agent blocks).
  isSoftBusy = () => false,
  // When true, the run is deliberately parked (waiting for an answer to an open question), so
  // silence is expected and sweepStale must leave it alone.
  isBlocked = () => false,
  log = console,
}) {
  const active = new Map(); // chatId -> { runId, run, cancelRequested, cancelRequestedAt, forcedDone, queue, lastEventAt }
  const agents = new Map(); // agentId -> SDKAgent
  const pendingResume = []; // chats whose in-flight run died with the process

  const sdkFor = (chat) => (providerFor ? providerFor(chat) : sdk);

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
    if (chat.agent_id) agents.delete(chat.agent_id);
    store.setAgentId(chat.id, null);
    const options = await agentOptions({ ...chat, agent_id: null });
    const provider = sdkFor(chat);
    const agent = await withRetry(() => provider.create(options));
    agents.set(agent.agentId, agent);
    store.setAgentId(chat.id, agent.agentId);
    return agent;
  }

  async function agentFor(chat, { forceFresh = false } = {}) {
    if (forceFresh) return createFresh(chat);
    if (chat.agent_id && agents.has(chat.agent_id)) return agents.get(chat.agent_id);
    const options = await agentOptions(chat);
    const provider = sdkFor(chat);
    try {
      const agent = chat.agent_id
        ? await withRetry(() => provider.resume(chat.agent_id, options))
        : await withRetry(() => provider.create(options));
      agents.set(agent.agentId, agent);
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
      const run = await startSdkRun(chat, message, {
        ...(chat.model ? { model: { id: chat.model } } : {}),
        mode: chat.mode === "plan" ? "plan" : "agent",
        onDelta: ({ update }) => {
          for (const event of eventsFromUpdate(update)) emit(event.type, event.data);
        },
      });
      entry.run = run;
      store.setSdkRunId(runId, run.id);
      if (entry.cancelRequested) await cancelSdkRun(run);
      const result = await run.wait();
      status = normalizeStatus(result.status, entry.cancelRequested);
      if (status === "error") error = result.error?.message || "run failed";
    } catch (caught) {
      status = entry.cancelRequested ? "cancelled" : "error";
      error = status === "error" ? String(caught?.message || caught) : null;
      if (status === "error") log.error?.(`[runner] chat ${chatId}: ${error}`);
    } finally {
      // sweepStale() may already have finalized this run locally (the SDK never confirmed the
      // cancel) — do not double-write run state if the stuck promise eventually settles anyway.
      if (!entry.forcedDone) {
        onCancel(chatId); // releases a question still waiting when the run ends for any reason
        emit("run.finished", { status, ...(error ? { error } : {}) });
        store.finishRun(chatId, runId, status, error);
        active.delete(chatId);
      }
    }
    if (entry.forcedDone) return;
    if (status === "finished") Promise.resolve().then(() => onFinished(chatId)).catch(() => {});
    // Everything that queued up during the run goes in as ONE turn: separate turns answered each
    // stale message on its own (a colleague got three replies in a minute, 2026-09-25).
    const queued = entry.queue.splice(0);
    if (queued.length) startRun(chatId, mergeQueued(queued), []);
  }

  function mergeQueued(messages) {
    if (messages.length === 1) return messages[0];
    const text = messages.map((m) => (typeof m === "string" ? m : m.text)).join("\n\n");
    const images = messages.flatMap((m) => (typeof m === "string" ? [] : m.images || []));
    return images.length ? { text, images } : text;
  }

  function startRun(chatId, message, queue = []) {
    const runId = store.startRun(chatId);
    const chat = store.getChat(chatId);
    const entry = { runId, run: null, cancelRequested: false, cancelRequestedAt: null, forcedDone: false, queue, lastEventAt: Date.now() };
    active.set(chatId, entry);
    const label = runLabel(chat);
    store.appendEvent(chatId, runId, "run.started", { model: label.model, mode: chat.mode, provider: label.provider });
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
      if (!current) {
        store.appendEvent(chatId, null, "user", userData);
        return { runId: startRun(chatId, message), delivered: "run" };
      }
      if (effective === "send") throw new BusyError();
      if (effective === "steer" && current.run?.steer) {
        const outcome = await current.run.steer(text).catch(() => "revert_to_followup");
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
