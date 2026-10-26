import { CALLER_LABELS, DEFAULT_AGENT } from "./agents/registry.mjs";
import { clip } from "./updates.mjs";
import { normalizeProvider } from "./providers/ids.mjs";
import { redactSecrets } from "./push.mjs";
import { maskText } from "./redact.mjs";
import { ASK_TOOL, ASK_REQUESTER_TOOL } from "./asks.mjs";
import { OWNER_TASK_TOOL } from "./todos.mjs";
import { FORWARDING_TOOLS, peerReachable } from "./related.mjs";
import { motherInfo, SHARED } from "./integrations/mother.mjs";

// ask_agent: free-text request to a peer agent. Runs in a child chat whose tools come from
// the peer's profile (tools_json). Discovery is via list_agents / agent profiles in the DB.

export const ASK_AGENT_TOOL = "ask_agent";
export const DELEGATE_TOOL = "delegate";
export const SUBTASKS_TOOL = "subtasks";
const DELEGATE_KV = "delegate:"; // delegate:<childChatId> -> { parent, agent, state: running|done|reported, status }

// Blocking window for ask_agent. Past it the work is NOT cancelled — it becomes a delegate-style
// subtask and its result is delivered to the parent automatically.
const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const MAX_REQUEST = 8_000;
const FACT_CAP = 40;
// A follow-up to the same peer within this window continues the previous child chat (the peer
// keeps its session and everything it already read) instead of starting cold in a new one.
const REUSE_WINDOW_MS = 2 * 60 * 60_000;

// consult: another model answers the asking agent inside one
// blocking call, in a child chat of the asking chat with that chat's own agent, tools, mode and
// folder — never more. The model is pinned to one engine account; the other usable accounts of the
// same kind that run that model are its fallbacks (index.mjs modelCandidates reads them from the
// consult's kv row), so a Claude account at its plan limit moves to the next one. The caps stop a
// looping agent from spending the owner's keys: the hourly counts live in the database (kv
// consult-times), so a restart does not reset them; the running counts are in memory, since a
// restart ends every consult (runner notResumable).
export const CONSULT_TOOL = "consult";
// Past this the consult is cancelled. It stays under the runner's 15-minute stale sweep, which would
// otherwise cancel the asking run, quiet while it waits.
export const CONSULT_TIMEOUT_MS = 13 * 60_000;
// Nobody watches a consult live: a model that keeps working without answering stops here
// (providers/claude.mjs maxTurns).
export const CONSULT_MAX_TURNS = 40;
export const CONSULT_MAX_PER_HOUR = 6;
export const CONSULT_MAX_PER_HOUR_ALL = 20;
export const CONSULT_MAX_RUNNING = 2;
// Consults running at once across all the owner's chats.
export const CONSULT_MAX_RUNNING_ALL = 4;
const CONSULT_TIMES_KV = "consult-times"; // [{ chat, t }]: every consult started in the last hour
export const CONSULT_PROMPT_MAX = 4000;
const CONSULT_ANSWER_MAX = 20_000;
const CONSULT_POLL_MS = 500;
const CONSULT_KV = "consult:"; // consult:<childChatId> -> { from, accounts: [account ids, first = pinned], model }
// What a consult chat is not given (index.mjs): work handed on would wake it with a new run after its
// call returned, on the owner's keys, with nobody reading the answer. It answers the agent that
// asked: no question to the owner or the requester (it would stall the asking run), no chore left
// for the owner, and nothing sent out of the chat (Telegram, a colleague, another chat) — in the
// owner's own chain the guard would not stop those.
export const CONSULT_WITHHELD = [
  ...new Set([ASK_AGENT_TOOL, DELEGATE_TOOL, SUBTASKS_TOOL, CONSULT_TOOL, ASK_TOOL, ASK_REQUESTER_TOOL, OWNER_TASK_TOOL, ...FORWARDING_TOOLS, "send_to_person"]),
  // Nor anything that outlives the call or changes the owner's setup: jobs, the shared agent
  // profile, a suggestion card in front of the owner, a knowledge note, a colleague invite, incidents.
  ...["jobs_create", "jobs_update", "jobs_run", "jobs_delete", "agent_tools_enable", "agent_tools_disable", "agent_settings_set"],
  ...["chat_suggest", "chat_dismiss_suggestion", "knowledge_write", "peer_invite", "incident_ack", "incident_update", "incident_source_set", "incident_assign", "incident_suggest"],
  ...["knowledge_edit", "knowledge_delete"],
  // Nor ring the owner's phone: the asking chat decides what he must know.
  "notify_owner",
  // Nor talk to a colleague's agent (it would wake this chat later, like a delegated task).
  "network_ask", "network_reply", "network_connect",
];
/** The consult row of a chat (null for any other chat). */
export const consultOf = (store, chatId) => (chatId ? store.getKv(`${CONSULT_KV}${chatId}`) : null);

// The accounts that run `model` now, best first: the one named (or the kind's base account), then
// the other accounts of the same kind. check(id) -> null when that account can run the model now,
// else why not. Another account of the openai kind can be another vendor (Z.ai, OpenRouter), so it
// is a fallback only when lists(id) says it offers the model by that exact id.
export async function resolveConsultAccounts({ provider, model, accounts = [], check = async () => null, lists = async () => false }) {
  const named = accounts.find((a) => a.id === provider);
  const kind = named?.kind || (accounts.some((a) => a.kind === provider) ? provider : null);
  if (!kind) return { error: `unknown engine account "${provider}"; accounts: ${accounts.map((a) => a.id).join(", ")}` };
  const order = [...(named ? [named] : []), ...accounts.filter((a) => a.kind === kind && a.id !== provider)];
  const usable = [];
  let problem = null;
  for (const a of order) {
    const why = await check(a.id);
    const listed = a === order[0] || kind !== "openai" || (await lists(a.id));
    if (!why && listed) usable.push(a.id);
    else problem ??= why || `engine account "${a.id}" does not list model "${model}"`;
  }
  return usable.length ? { accounts: usable } : { error: problem || `no engine account runs "${model}" now` };
}

// The engine candidates of a consult chat, in order: one per account, all on the model asked for.
// Nothing else: a consult never runs on another model or vendor nobody named.
export function consultCandidates(row, { usable = () => true } = {}) {
  if (!row?.model || !Array.isArray(row.accounts)) return [];
  return row.accounts.filter((id) => usable(id)).map((provider) => ({ provider, model: row.model }));
}

const inputSchema = {
  type: "object",
  properties: {
    agent: {
      type: "string",
      description: "Peer agent id from list_agents (do not invent ids).",
    },
    request: {
      type: "string",
      description: "Free-text request in Persian for the peer agent.",
    },
  },
  required: ["agent", "request"],
};

// A mother chat's delegate also takes shared: a general issue's thread (mother.mjs SHARED).
const delegateSharedSchema = {
  ...inputSchema,
  properties: {
    ...inputSchema.properties,
    shared: {
      type: "boolean",
      description: "true for a general issue others hit too (an outage, CI, a shared service): the thread is listed in the owner's main list and other colleagues' messages on it join it",
    },
  },
};

export function createPeers({
  store,
  runner,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(),
  wakeDelayMs = 3_000,
  log = console,
  // consult: (provider, model, parentChat) -> { accounts: [account ids that run the model, best
  // first] } or { error }. index.mjs checks the account registry (on, keyed, not limited, lists it).
  consultAccounts = async () => ({ error: "consult is not set up on this server" }),
  consultTimeoutMs = CONSULT_TIMEOUT_MS,
  consultPollMs = CONSULT_POLL_MS,
}) {
  const childrenOf = new Map(); // parentChatId -> Set(childChatId)
  const askTail = new Map(); // parentChatId -> Promise — serialize parallel ask_agent calls
  // The SDK sometimes re-issues a tool call it gave up waiting for (seen 2026-09-19: the same
  // ask_agent 84 s apart). An identical request already in flight is joined, not re-run.
  const inflight = new Map(); // `${parent}\u0000${agent}\u0000${request}` -> Promise
  const sameKey = (parentChatId, args) => `${parentChatId}\u0000${String(args?.agent || "").trim()}\u0000${String(args?.request || "").trim()}`;

  function track(parentId, childId) {
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, new Set());
    childrenOf.get(parentId).add(childId);
  }

  function untrack(parentId, childId) {
    const set = childrenOf.get(parentId);
    if (!set) return;
    set.delete(childId);
    if (!set.size) childrenOf.delete(parentId);
  }

  function enqueueAsk(parentId, job) {
    const prev = askTail.get(parentId) || Promise.resolve();
    const next = prev.then(job, job);
    askTail.set(
      parentId,
      next.finally(() => {
        if (askTail.get(parentId) === next) askTail.delete(parentId);
      }),
    );
    return next;
  }

  function waitForRun(chatId, ms) {
    return new Promise((resolve) => {
      let timeout = null;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onEvent = (event) => {
        if (event.type !== "run.finished") return;
        finish({ status: event.data?.status || "error", error: event.data?.error || null });
      };
      const cleanup = () => {
        clearTimeout(timeout);
        store.bus.off(`chat:${chatId}`, onEvent);
      };
      store.bus.on(`chat:${chatId}`, onEvent);
      // If the run already finished before we subscribed (fast mock / race), settle from DB.
      const latest = store.db.prepare(
        "SELECT status, error FROM runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1",
      ).get(chatId);
      if (latest && latest.status !== "running") {
        finish({ status: latest.status, error: latest.error || null });
        return;
      }
      // Blocking budget over: the work is NOT cancelled — runAsk turns it into a delegate-style
      // subtask so the result still reaches the parent automatically (seen 2026-09-20: two
      // 10-minute ask_agent cycles were killed at the timeout and the answer never came).
      timeout = setTimeout(() => finish({ timedOut: true }), ms);
    });
  }

  // A run ending cancels the ask_agent children it was blocked on. Delegated subtasks outlive the
  // run that started them and stop only on an explicit cancel (includeDelegates).
  async function cancelChildren(parentChatId, { includeDelegates = false } = {}) {
    const delegated = includeDelegates ? delegatesOf(parentChatId).filter((d) => d.state === "running").map((d) => d.childId) : [];
    const ids = [...new Set([...(childrenOf.get(parentChatId) || []), ...delegated])];
    for (const childId of ids) {
      await cancelChildren(childId, { includeDelegates });
      await runner.cancel(childId).catch(() => {});
    }
  }

  // ---- delegate: hand work to a peer and return at once; the parent is woken with the result ----

  function readDelegate(childId) {
    return store.getKv(`${DELEGATE_KV}${childId}`) || null;
  }

  function writeDelegate(childId, value) {
    store.setKv(`${DELEGATE_KV}${childId}`, value);
  }

  function allDelegates() {
    return store.db
      .prepare("SELECT key, value FROM kv WHERE key LIKE ?")
      .all(`${DELEGATE_KV}%`)
      .map((row) => {
        try {
          return { childId: row.key.slice(DELEGATE_KV.length), ...JSON.parse(row.value) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  function delegatesOf(parentChatId) {
    return allDelegates().filter((d) => d.parent === parentChatId);
  }

  // Work still owed to this chat: delegated children running, or finished but not yet reported.
  function pendingDelegates(parentChatId) {
    return delegatesOf(parentChatId).filter((d) => d.state === "running" || d.state === "done").length;
  }

  const watching = new Set();
  function watchChild(childId) {
    if (watching.has(childId)) return;
    watching.add(childId);
    const onEvent = (event) => {
      if (event.type !== "run.finished") return;
      store.bus.off(`chat:${childId}`, onEvent);
      watching.delete(childId);
      childDone(childId, event.data?.status || "error", event.data?.error || null);
    };
    store.bus.on(`chat:${childId}`, onEvent);
  }

  function childDone(childId, status, error) {
    const entry = readDelegate(childId);
    if (!entry || entry.state !== "running") return;
    // An explicit cancel means "stop", not "report back": waking the parent made Griffin re-delegate
    // the very work that was just cancelled (2026-09-24).
    if (status === "cancelled") {
      writeDelegate(childId, { ...entry, state: "reported", status, error, doneAt: now().toISOString() });
      return;
    }
    writeDelegate(childId, { ...entry, state: "done", status, error, doneAt: now().toISOString() });
    scheduleWake(entry.parent);
  }

  const wakeTimers = new Map();
  function scheduleWake(parentChatId) {
    if (wakeTimers.has(parentChatId)) return; // coalesce: several children → one parent run
    wakeTimers.set(
      parentChatId,
      setTimeout(() => {
        wakeTimers.delete(parentChatId);
        wake(parentChatId).catch((error) => log.error?.(`[delegate] wake ${parentChatId}: ${error?.message || error}`));
      }, wakeDelayMs),
    );
  }

  async function wake(parentChatId) {
    if (!store.getChat(parentChatId)) return;
    const mine = delegatesOf(parentChatId);
    const done = mine.filter((d) => d.state === "done");
    if (!done.length) return;
    const still = mine.filter((d) => d.state === "running");
    const parts = done.map((d) => {
      const env = buildEnvelope(store, d.childId, { status: d.status === "finished" ? "finished" : d.status, error: d.error });
      const label = CALLER_LABELS[d.agent] || d.agent;
      return (
        `### ${label} — ${env.status} (subtask ${d.childId})\n` +
        `${env.summary || env.brief || "(بدون متن)"}\n` +
        (env.unknowns.length ? `نامعلوم/خطا: ${env.unknowns.join(" · ").slice(0, 500)}\n` : "") +
        (env.facts.length ? `ابزارهای اجراشده: ${[...new Set(env.facts.map((f) => f.tool))].join(", ")}\n` : "")
      );
    });
    const text =
      `[گزارش خودکار زیرکارها — این پیام را سیستم فرستاده، نه Owner]\n\n${parts.join("\n")}\n` +
      (still.length ? `هنوز در کار: ${still.map((d) => `${CALLER_LABELS[d.agent] || d.agent} (${d.childId})`).join("، ")} — نتیجه‌شان خودکار می‌رسد؛ منتظر نمان.\n` : "") +
      `این نتیجه‌ها را برای کسی که کار را خواسته جمع‌بندی کن (نتیجه اول). اگر زیرکار ناقص مانده، از همان ایجنت ادامه‌اش را بخواه (همان جلسه با همهٔ خوانده‌هایش ادامه پیدا می‌کند)؛ کار را از صفر تعریف نکن.`;
    for (const d of done) writeDelegate(d.childId, { ...readDelegate(d.childId), state: "reported", reportedAt: now().toISOString() });
    try {
      await runner.send(parentChatId, { text, images: [], intent: runner.isActive(parentChatId) ? "queue" : "send" });
    } catch (error) {
      // Parent could not take it now: put them back so the next wake retries.
      for (const d of done) writeDelegate(d.childId, { ...readDelegate(d.childId), state: "done" });
      log.error?.(`[delegate] parent ${parentChatId} busy: ${error?.message || error}`);
      setTimeout(() => scheduleWake(parentChatId), 30_000).unref?.();
    }
  }

  // After a restart: re-attach to running children and report the ones that ended meanwhile.
  function recover() {
    for (const d of allDelegates()) {
      if (d.state === "done") scheduleWake(d.parent);
      if (d.state !== "running") continue;
      watchChild(d.childId);
      const latest = store.db.prepare("SELECT status, error FROM runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1").get(d.childId);
      if (latest && latest.status !== "running" && !runner.isActive(d.childId)) {
        // The runner resumes orphans shortly after start; give it a moment before calling it done.
        setTimeout(() => {
          if (!runner.isActive(d.childId) && readDelegate(d.childId)?.state === "running") {
            const again = store.db.prepare("SELECT status, error FROM runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1").get(d.childId);
            childDone(d.childId, again?.status || "error", again?.error || null);
          }
        }, 60_000).unref?.();
      }
    }
  }

  function childState(d) {
    if (d.state !== "running") return d.status === "finished" ? "completed" : d.status === "cancelled" ? "canceled" : "failed";
    return "working";
  }

  function delegateTool(parentChatId) {
    return {
      description:
        "Hand a piece of work to a peer agent and return immediately (non-blocking). Use it for anything that may take more than a minute or when several peers can work in parallel. The result is reported to this chat automatically when the peer finishes — do not poll or wait; finish your turn (tell the asker what you started). Use subtasks to list/check/steer/cancel. For a quick lookup you need right now, ask_agent is fine.",
      inputSchema: motherInfo(store, parentChatId) ? delegateSharedSchema : inputSchema,
      async execute(args) {
        const request = String(args?.request || "").trim();
        const twin = delegatesOf(parentChatId).find(
          (d) => d.state === "running" && d.agent === String(args?.agent || "").trim() && d.request === request,
        );
        if (twin) {
          return { content: [{ type: "text", text: JSON.stringify({ subtask: twin.childId, agent: twin.agent, state: "working", note: "همین کار از قبل در جریان است؛ نتیجه خودکار می‌آید." }) }] };
        }
        const spawned = spawnChild(parentChatId, args);
        if (spawned.error) return { isError: true, content: [{ type: "text", text: spawned.error }] };
        const { child, callerAgent, target, continued } = spawned;
        writeDelegate(child.id, { parent: parentChatId, agent: target, request, state: "running", at: now().toISOString() });
        // A mother chat's general issue: listed in the main sidebar, open to every mother (mother.mjs SHARED).
        const mother = args?.shared === true ? motherInfo(store, parentChatId) : null;
        if (mother && !continued) {
          store.setKv(`${SHARED}${child.id}`, { by: mother.name, motherChat: parentChatId, at: now().toISOString() });
          store.updateChat(child.id, { title: `🧵 ${request.split("\n")[0].slice(0, 70)}` });
        }
        watchChild(child.id);
        try {
          await runner.send(child.id, { text: peerMessage(callerAgent, request, { continued }), images: [] });
        } catch (error) {
          childDone(child.id, "error", String(error?.message || error));
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ subtask: child.id, agent: target, state: "working", note: "نتیجه خودکار به همین چت گزارش می‌شود؛ منتظر نمان و نوبتت را تمام کن." }),
          }],
        };
      },
    };
  }

  function subtasksTool(parentChatId) {
    return {
      description:
        "Manage subtasks you started with delegate: action=list (all, with state), get {id} (report so far), steer {id, message} (extra instruction to a running subtask), cancel {id}.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "steer", "cancel"] },
          id: { type: "string", description: "subtask id from delegate/list" },
          message: { type: "string", description: "for steer" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async execute(args) {
        const reply = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
        const mine = delegatesOf(parentChatId);
        if (args?.action === "list") {
          return reply({ subtasks: mine.map((d) => ({ id: d.childId, agent: d.agent, state: childState(d), since: d.at })) });
        }
        const d = mine.find((x) => x.childId === String(args?.id || ""));
        if (!d) return { isError: true, content: [{ type: "text", text: "unknown subtask id (use action=list)" }] };
        if (args.action === "get") {
          return reply({ id: d.childId, agent: d.agent, state: childState(d), ...buildEnvelope(store, d.childId, { status: d.status || "running" }) });
        }
        if (args.action === "cancel") {
          await cancelChildren(d.childId, { includeDelegates: true });
          await runner.cancel(d.childId).catch(() => {});
          return reply({ id: d.childId, state: "canceling" });
        }
        const message = String(args?.message || "").trim();
        if (!message) return { isError: true, content: [{ type: "text", text: "message is required for steer" }] };
        const running = runner.isActive(d.childId);
        if (!running) {
          writeDelegate(d.childId, { ...d, state: "running", at: now().toISOString() });
          watchChild(d.childId);
        }
        // Labelled so the child never reads it as the owner's word (a steer once talked a
        // subagent out of refusing a push; PEER_CONTEXT says a parent's message approves nothing).
        const text = `[پیام ایجنت والد — هدایت است، تأیید Owner نیست]\n\n${message}`;
        const out = await runner.send(d.childId, { text, images: [], intent: running ? "steer" : "send" });
        return reply({ id: d.childId, delivered: out?.delivered || "run" });
      },
    };
  }

  function tool(parentChatId) {
    return {
      description:
        "Ask a peer agent a free-text question and wait for its report (blocking window ~3 minutes). Use when the work belongs to another agent's domain (e.g. CDN → arvan-ban, NSIN → nsin-ban, cluster/origin → platform). If the peer needs longer you get {status:'running'} with a chatRef — the work keeps going and its result arrives in this chat automatically; do NOT re-ask the same request, just say it is in progress. Never use this for Telegram — Griffin owns telegram_dialogs/read/send. Do not use it to bypass your own tool quota.",
      inputSchema,
      async execute(args) {
        const key = sameKey(parentChatId, args);
        if (inflight.has(key)) return inflight.get(key);
        // Parallel ask_agent in one model step used to spawn two children; serialize per parent.
        const job = enqueueAsk(parentChatId, () => runAsk(parentChatId, args)).finally(() => inflight.delete(key));
        inflight.set(key, job);
        return job;
      },
    };
  }

  // Validates the request and creates the child chat (same quota/loop rules for ask_agent and delegate).
  function spawnChild(parentChatId, args) {
    const target = String(args?.agent || "").trim();
    const request = String(args?.request || "").trim();
    const targetProfile = store.getAgentProfile(target);
    if (!target || !targetProfile) {
      const ids = store.listAgentProfiles?.().map((p) => p.id).join(", ");
      return { error: `unknown agent: ${target || "(empty)"}${ids ? ` — agents here: ${ids}` : " — call list_agents"}` };
    }
    if (!request) return { error: "request is required" };
    if (request.length > MAX_REQUEST) return { error: "request too long" };
    const parent = store.getChat(parentChatId);
    if (!parent) return { error: "parent chat missing" };
    if (consultOf(store, parentChatId)) return { error: "a consult answers by itself: it cannot hand work on to another agent" };
    const callerAgent = parent.agent || DEFAULT_AGENT;
    const prior = parseChain(parent.call_chain);
    // One hop to yourself only where you hold a quota on yourself (a single-agent install: registry).
    const selfHop = target === callerAgent && targetProfile.meta?.callers?.[callerAgent] && !prior.includes(target);
    if (target === callerAgent && !selfHop) return { error: `cannot ${ASK_AGENT_TOOL} yourself` };
    const chain = prior.concat(callerAgent);
    if (!selfHop && chain.includes(target)) return { error: `call loop refused: ${[...chain, target].join(" → ")}` };
    // Seen 2026-09-24: a peer's report was cut, Griffin re-asked "ادامهٔ کار قبلی" and the new
    // child started from zero — every router read done again. Continue the idle one instead.
    const since = new Date(now().getTime() - REUSE_WINDOW_MS).toISOString();
    const previous = store.db
      .prepare("SELECT id FROM chats WHERE parent_chat_id = ? AND agent = ? AND updated_at > ? ORDER BY updated_at DESC LIMIT 1")
      .get(parentChatId, target, since);
    if (previous && !runner.isActive?.(previous.id) && readDelegate(previous.id)?.state !== "running") {
      return { child: store.getChat(previous.id), callerAgent, target, request, continued: true };
    }
    const child = store.createChat({
      title: `← ${CALLER_LABELS[callerAgent] || callerAgent}: ${request.trim().split("\n")[0].slice(0, 60)}`,
      model: targetProfile.model || parent.model,
      mode: parent.mode === "plan" ? "plan" : "agent",
      caller: callerAgent,
      agent: target,
      parentChatId: parentChatId,
      callChain: chain,
      provider: normalizeProvider(targetProfile.provider),
    });
    return { child, callerAgent, target, request };
  }

  async function runAsk(parentChatId, args) {
    const spawned = spawnChild(parentChatId, args);
    if (spawned.error) return { isError: true, content: [{ type: "text", text: spawned.error }] };
    const { child, callerAgent, target, request, continued } = spawned;
    track(parentChatId, child.id);

    try {
      await runner.send(child.id, { text: peerMessage(callerAgent, request, { continued }), images: [] });
      const outcome = await waitForRun(child.id, timeoutMs);
      if (outcome.timedOut) {
        // Keep the work alive as a delegate-style subtask: the result is delivered to this chat
        // automatically when the peer finishes. The caller is free to end its turn meanwhile.
        writeDelegate(child.id, { parent: parentChatId, agent: target, request, state: "running", at: now().toISOString(), via: ASK_AGENT_TOOL });
        watchChild(child.id);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "running",
              summary: null,
              facts: [],
              unknowns: [`درخواست بیش از ${Math.round(timeoutMs / 60000)} دقیقه طول کشید و هنوز در جریان است`],
              chatRef: child.id,
              note: "کار ادامه دارد و نتیجه‌اش خودکار در همین چت گزارش می‌شود. همین درخواست را دوباره نپرس؛ اگر جواب نهایی لازم است، بگو زیرکار در جریان است و همین‌جا منتظر گزارش بمان.",
            }),
          }],
        };
      }
      const envelope = buildEnvelope(store, child.id, {
        status: outcome.status === "finished" ? "finished" : outcome.status || "error",
        error: outcome.error,
        at: now().toISOString(),
      });
      // Raw tool results made the answer too big for Claude Code to read inline: it spilled to a file
      // the chain cannot open and the parent asked the same thing again (2026-10-21, ops room 01:13).
      // The parent needs the answer and what was run, not every tool's output.
      const { facts = [], ...slim } = envelope;
      return { content: [{ type: "text", text: JSON.stringify({ ...slim, toolsRun: [...new Set(facts.map((f) => f.tool))] }) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "error",
            summary: null,
            facts: [],
            unknowns: [String(error?.message || error)],
            chatRef: child.id,
          }),
        }],
      };
    } finally {
      untrack(parentChatId, child.id);
    }
  }


  // ---- consult: ask another model and get its answer back in the same call ----
  const consultStarting = new Map(); // parentChatId -> consults past the caps, not yet tracked
  // The last hour's consults, read from and written to the database on every check (one synchronous
  // step with the check, so parallel calls still see each other's slots).
  const consultTimes = (t) => {
    const list = store.getKv(CONSULT_TIMES_KV);
    return (Array.isArray(list) ? list : []).filter((e) => e && typeof e.chat === "string" && Number.isFinite(e.t) && t - e.t < 3_600_000);
  };
  const consultsRunning = (chatId) =>
    [...(childrenOf.get(chatId) || [])].filter((id) => consultOf(store, id)).length + (consultStarting.get(chatId) || 0);
  const consultsRunningAll = () => {
    let n = 0;
    for (const chatId of new Set([...childrenOf.keys(), ...consultStarting.keys()])) n += consultsRunning(chatId);
    return n;
  };

  // The same consult (chat, account, model, prompt) asked again while the first still runs — an
  // engine re-issuing a tool call it gave up on — shares the first one's answer instead of a second run.
  const consultInflight = new Map();
  function consultTool(parentChatId) {
    const fail = (error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] });
    const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
    const trimmed = (value) => (typeof value === "string" ? value.trim() : "");
    return {
      description:
        "Ask another model (another engine account or vendor, for a cross-check or a second pair of hands) and get its answer back in this same call — then go on with your work. It runs as a sub-chat of this one on exactly that account/model, with this chat's tools, mode and folder (never more); if that account is at its plan limit, another account of the same kind that runs the model takes over. The owner sees it under this chat. It may take minutes (at most 13). The prompt must stand alone. Its answer is another model's view: verify before acting on it.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", description: "engine account id or kind, e.g. claude, claude-2, openai" },
          model: { type: "string", description: "model id that account runs, e.g. claude-opus-4-7 or glm-5.3" },
          prompt: { type: "string", description: "self-contained task or question, with paths and context (at most 4,000 characters)" },
        },
        required: ["provider", "model", "prompt"],
        additionalProperties: false,
      },
      async execute(args) {
        // The asking run is part of the key: after the owner's Stop, the next run's same consult is a
        // new one, not a share in the cancelled one's «the asking chat stopped».
        const key = [parentChatId, runner.runIdOf?.(parentChatId) ?? "", trimmed(args?.provider), trimmed(args?.model), trimmed(args?.prompt).replace(/\s+/g, " ")].join("\u0000");
        if (consultInflight.has(key)) return consultInflight.get(key);
        const job = runConsult(args).finally(() => consultInflight.delete(key));
        consultInflight.set(key, job);
        return job;
      },
    };

    async function runConsult(args) {
        const from = store.getChat(parentChatId);
        if (!from) return fail("chat not found");
        // The owner's own top-level chat only: not a job, a colleague's or the ops room's chain, a
        // sub-chat (a delegated task, an ask_agent child, another consult) or a side chat.
        if ((from.caller || "owner") !== "owner" || from.job_id || from.sim) return fail("consult works only from one of the owner's own chats.");
        if (from.parent_chat_id || from.side_of) return fail("consult is not available inside a sub-chat or a side chat; ask from the main chat.");
        // Not the Telegram desk (the global chat) nor a chat linked to Telegram: what is said there
        // comes from people other than the owner (related.mjs peerReachable, chat_send's own rule).
        if (!peerReachable(store, from)) return fail("consult is not available in a Telegram chat; ask from one of the owner's web chats.");
        const provider = typeof args?.provider === "string" ? args.provider.trim().slice(0, 40) : "";
        const model = typeof args?.model === "string" ? args.model.trim().slice(0, 200) : "";
        // Masked before it leaves for another vendor and before the child's user event stores it: a
        // secret the asking agent read in a tool result must not be pasted on.
        const asked = typeof args?.prompt === "string" ? args.prompt.trim() : "";
        if (!provider || !model || !asked) return fail("provider, model and prompt are required");
        if (asked.length > CONSULT_PROMPT_MAX) return fail(`prompt is ${asked.length} characters; the limit is ${CONSULT_PROMPT_MAX}. Shorten it or point to files instead.`);
        const prompt = redactSecrets(maskText(asked));
        // The caps are checked and taken in one synchronous step: calls made in parallel (one model
        // step can issue several) each see the others' slots.
        const t = now().getTime();
        const chatKey = String(parentChatId);
        const times = consultTimes(t);
        if (times.filter((e) => e.chat === chatKey).length >= CONSULT_MAX_PER_HOUR) return fail(`this chat already consulted ${CONSULT_MAX_PER_HOUR} times in the last hour; decide with what you have.`);
        if (times.length >= CONSULT_MAX_PER_HOUR_ALL) return fail(`the owner's chats already consulted ${CONSULT_MAX_PER_HOUR_ALL} times in the last hour; decide with what you have.`);
        const running = consultsRunning(parentChatId);
        if (running >= CONSULT_MAX_RUNNING) return fail(`${running} consults of this chat are still running; wait for one to answer first.`);
        const runningAll = consultsRunningAll();
        if (runningAll >= CONSULT_MAX_RUNNING_ALL) return fail(`${runningAll} consults are already running across the owner's chats; wait for one to answer first.`);
        store.setKv(CONSULT_TIMES_KV, [...times, { chat: chatKey, t }]);
        consultStarting.set(parentChatId, (consultStarting.get(parentChatId) || 0) + 1);
        const doneStarting = () => {
          const left = (consultStarting.get(parentChatId) || 1) - 1;
          if (left > 0) consultStarting.set(parentChatId, left);
          else consultStarting.delete(parentChatId);
        };
        // A call refused before anything ran gives its slot back.
        const refund = () => {
          const list = consultTimes(now().getTime());
          const at = list.findIndex((e) => e.chat === chatKey && e.t === t);
          if (at >= 0) store.setKv(CONSULT_TIMES_KV, list.filter((_, i) => i !== at));
        };
        let resolved;
        try {
          // Through a promise, so a lookup that throws at once is refused (and refunded) like any other.
          resolved = await Promise.resolve()
            .then(() => consultAccounts(provider, model, from))
            .catch((error) => ({ error: String(error?.message || error) }));
        } finally {
          doneStarting();
        }
        const accounts = Array.isArray(resolved?.accounts) ? resolved.accounts.filter(Boolean) : [];
        if (!accounts.length) {
          refund();
          return fail(resolved?.error || `no engine account can run ${provider}:${model} now.`);
        }
        let child;
        try {
          child = store.createChat({
            title: `مشورت با ${model}: ${prompt.replace(/\s+/g, " ").slice(0, 60)}`,
            model: `${accounts[0]}:${model}`,
            // The asking chat's mode: in plan mode the consult plans too.
            mode: from.mode === "plan" ? "plan" : "agent",
            // The asking chat's agent and caller: the same tool set, never more.
            caller: from.caller || "owner",
            agent: from.agent || DEFAULT_AGENT,
            parentChatId,
            callChain: parseChain(from.call_chain),
            provider: normalizeProvider(accounts[0]),
          });
          // The asking chat's reasoning effort, when the owner set one there.
          if (from.effort) store.updateChat(child.id, { effort: from.effort });
          store.setKv(`${CONSULT_KV}${child.id}`, { from: parentChatId, accounts, model });
        } catch (error) {
          refund();
          return fail(`the consult could not start: ${error?.message || error}`);
        }
        // Tracked like an ask_agent child: the asking run ending (the owner's Stop, a restart) cancels it.
        track(parentChatId, child.id);
        const askingRun = runner.runIdOf?.(parentChatId) ?? null;
        const consultFrom = `${accounts[0]}:${model}`;
        const text =
          `[مشورت از چتِ «${redactSecrets(maskText(String(from.title || "").replace(/\s+/g, " ").slice(0, 80)))}» — ایجنتِ آن چت کمکت را می‌خواهد، نه Owner]\n` +
          "همان ابزارها و پوشهٔ آن چت را داری. کار را انجام بده و جوابِ کامل را در پاسخِ آخرت بنویس؛ همان متن به آن ایجنت برمی‌گردد.\n\n" +
          prompt;
        try {
          try {
            await runner.send(child.id, { text, images: [] });
          } catch (error) {
            refund();
            return fail(`the consult could not start: ${error?.message || error}`);
          }
          const end = Date.now() + consultTimeoutMs;
          let stopped = null;
          for (;;) {
            if (!store.getChat(child.id)) {
              await Promise.resolve(runner.cancel(child.id)).catch(() => {});
              return ok({ consultId: child.id, state: "failed", from: consultFrom, error: "the owner deleted this consult" });
            }
            // Ended, and no fallback run took over (a plan limit starts a new run on the next account).
            if (!runner.isActive(child.id) && lastRun(child.id)?.status !== "running") break;
            if (askingRun && (runner.runIdOf?.(parentChatId) ?? null) !== askingRun) stopped = "the asking chat stopped";
            else if (Date.now() >= end) stopped = `over its time limit (${Math.round(consultTimeoutMs / 60_000) || "<1"} min)`;
            if (stopped) {
              await Promise.resolve(runner.cancel(child.id)).catch(() => {});
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, consultPollMs));
          }
          const status = lastRun(child.id)?.status || "error";
          const answer = consultAnswer(store, child.id);
          // The account that answered (a fallback may have taken over from the first).
          const started = [...store.allEvents(child.id)].filter((event) => event.type === "run.started").at(-1)?.data;
          const servedBy = started?.provider ? `${started.provider}:${started.model || model}` : consultFrom;
          if (stopped || status !== "finished") {
            return ok({ consultId: child.id, state: "failed", from: servedBy, error: stopped || lastRun(child.id)?.error || status, answer });
          }
          return ok({ consultId: child.id, state: "finished", from: servedBy, answer });
        } finally {
          untrack(parentChatId, child.id);
          // A consult that failed before any output must not leave a «پیام نرسید» card with «دوباره»
          // under a hidden sub-chat: nobody waits for a retry of it (runner.mjs kept messages).
          store.deleteKv?.(`kept:${child.id}`);
        }
    }
  }

  function lastRun(chatId) {
    return store.db.prepare("SELECT status, error FROM runs WHERE chat_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(chatId) || null;
  }

  recover();

  return {
    tool,
    consultTool,
    delegateTool,
    subtasksTool,
    pendingDelegates,
    cancelChildren, hasChildren: (parentChatId) => (childrenOf.get(parentChatId)?.size || 0) > 0, buildEnvelope: (chatId, meta) => buildEnvelope(store, chatId, meta) };
}

// The request and who sent it; how to handle a peer's request is in the callee's rules
// (prompt.mjs PEER_CONTEXT), said once per run instead of in front of every request.
export function peerMessage(callerAgent, request, { continued = false } = {}) {
  const who = CALLER_LABELS[callerAgent] || callerAgent;
  return continued
    ? `[ادامه — درخواست تازه از «${who}» در همین گفتگو؛ هرچه قبلاً خواندی معتبر است، دوباره نخوان]\n\n${request}`
    : `[درخواست از «${who}»]\n\n${request}`;
}

// What a consult said last: the text after its last tool call in its latest run (the narration
// between tools is not the answer), redacted, its end kept when over the cap.
export function consultAnswer(store, chatId) {
  const events = [...store.allEvents(chatId)];
  // The latest FINISHED run: a steer queued right at the end starts a new, empty run a few ms later,
  // and reading that one sent «(بدون متن)» and the work was delegated again (2026-10-21, 11f41845).
  let start = 0;
  let lastStart = -1;
  events.forEach((event, i) => {
    if (event.type === "run.started") lastStart = i;
    if (event.type === "run.finished" && lastStart >= 0) start = lastStart;
  });
  if (lastStart > start && !events.slice(start).some((e) => e.type === "run.finished")) start = lastStart; // nothing finished yet
  let all = "";
  let final = "";
  for (const event of events.slice(start)) {
    if (event.type === "text" && event.data?.text) {
      all += String(event.data.text);
      final += String(event.data.text);
    }
    if (event.type === "tool.done") final = "";
  }
  let answer = redactSecrets((final.trim() || all.trim()), { maxLength: Infinity });
  if (answer.length > CONSULT_ANSWER_MAX) answer = `…${answer.slice(answer.length - CONSULT_ANSWER_MAX + 1)}`;
  return answer;
}

export function buildEnvelope(store, chatId, { status, error = null, at = null } = {}) {
  const facts = [];
  const texts = [];
  let finalText = ""; // text after the last tool call = the peer's actual answer
  const events = [...store.allEvents(chatId)];
  // A continued child chat holds earlier runs too — report only the latest one.
  let start = 0;
  events.forEach((event, i) => { if (event.type === "run.started") start = i; });
  for (const event of events.slice(start)) {
    if (event.type === "text" && event.data?.text) {
      texts.push(String(event.data.text));
      finalText += String(event.data.text);
    }
    if (event.type === "tool.done") finalText = "";
    // No break at the cap: the final answer comes after the tools, and stopping here dropped it
    // (2026-09-24: a 41-tool run reported only its first narration line).
    if (event.type === "tool.done" && event.data?.name && facts.length < FACT_CAP) {
      facts.push(clip({
        tool: event.data.name,
        args: event.data.args || null,
        result: event.data.result ?? null,
        at: event.at,
      }));
    }
  }
  // The narration between tools ("now I check …") drowned the answer (2026-09-24: the report began
  // mid-sentence). Report the final answer; fall back to the tail of everything said.
  const all = texts.join("").trim();
  const answer = finalText.trim();
  // 12k, not 4k: a long report lost its first and last items and the parent asked again (2026-10-21, 319c583f).
  const summary = (answer.length >= 40 ? answer.slice(0, 12_000) : all.length > 12_000 ? `…${all.slice(-12_000)}` : all) || null;
  const brief = briefFromFacts(facts) || (summary ? summary.split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 3).join("\n").slice(0, 500) : null);
  // Which model answered, and whether the run moved there after a plan limit (a delegated
  // subtask keeps the auto-fallback): the owner sees it in the result his chat gets back.
  const started = events[start]?.type === "run.started" ? events[start].data || {} : {};
  const moved = Boolean(started.limitMove || started.movedFrom);
  const shown = started.model && started.model !== "auto" ? started.model : started.provider || null;
  const answeredBy = shown ? { model: shown, ...(started.provider ? { provider: started.provider } : {}), ...(moved ? { movedAfterLimit: true } : {}) } : null;
  const unknowns = [];
  if (error) unknowns.push(String(error));
  if (!summary && !brief && status === "finished") unknowns.push("peer returned no text summary");
  return {
    status: status || "error",
    summary,
    brief,
    facts,
    unknowns,
    chatRef: chatId,
    ...(answeredBy ? { answeredBy, ...(moved ? { modelLabel: `پاسخ از ${answeredBy.model} (موتور قبلی به سقف پلن خورد)` } : {}) } : {}),
    ...(at ? { at } : {}),
  };
}

function briefFromFacts(facts) {
  for (const fact of facts) {
    const payload = unwrapToolPayload(fact?.result);
    const rows = payload?.df;
    if (fact?.tool === "kube_df" && Array.isArray(rows) && rows[0]) {
      const row = rows[0];
      const parts = [
        row.available != null ? `${row.available} آزاد` : null,
        row.size != null ? `کل ${row.size}` : null,
        row.used != null ? `استفاده ${row.used}` : null,
        row.usePercent != null ? `(${row.usePercent})` : null,
      ].filter(Boolean);
      if (parts.length) return parts.join(" · ");
    }
  }
  return null;
}

function unwrapToolPayload(result) {
  if (!result || typeof result !== "object") return null;
  if (result.df || result.records || result.pods) return result;
  const content = result.value?.content || result.content;
  if (!Array.isArray(content)) return result;
  for (const part of content) {
    const text = typeof part?.text === "string" ? part.text : typeof part?.text?.text === "string" ? part.text.text : null;
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // keep looking
    }
  }
  return result;
}

function parseChain(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
