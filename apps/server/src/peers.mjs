import { CALLER_LABELS, DEFAULT_AGENT } from "./agents/registry.mjs";
import { clip } from "./updates.mjs";

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
  additionalProperties: false,
};

export function createPeers({
  store,
  runner,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(),
  wakeDelayMs = 3_000,
  log = console,
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
        `${(env.summary || env.brief || "(بدون متن)").slice(0, 3_000)}\n` +
        (env.unknowns.length ? `نامعلوم/خطا: ${env.unknowns.join(" · ").slice(0, 500)}\n` : "") +
        (env.facts.length ? `ابزارهای اجراشده: ${[...new Set(env.facts.map((f) => f.tool))].join(", ")}\n` : "")
      );
    });
    const text =
      `[گزارش خودکار زیرکارها — این پیام را سیستم فرستاده، نه Owner]\n\n${parts.join("\n")}\n` +
      (still.length ? `هنوز در کار: ${still.map((d) => `${CALLER_LABELS[d.agent] || d.agent} (${d.childId})`).join("، ")} — نتیجه‌شان خودکار می‌رسد؛ منتظر نمان.\n` : "") +
      `این نتیجه‌ها را برای کسی که کار را خواسته جمع‌بندی کن (نتیجه اول). اگر کار دیگری لازم است دوباره delegate کن.`;
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
      inputSchema,
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
        const { child, callerAgent, target } = spawned;
        writeDelegate(child.id, { parent: parentChatId, agent: target, request, state: "running", at: now().toISOString() });
        watchChild(child.id);
        try {
          await runner.send(child.id, { text: peerMessage(callerAgent, request), images: [] });
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
        const out = await runner.send(d.childId, { text: message, images: [], intent: running ? "steer" : "send" });
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
    if (!target || !targetProfile) return { error: `unknown agent: ${target || "(empty)"} — call list_agents` };
    if (!request) return { error: "request is required" };
    if (request.length > MAX_REQUEST) return { error: "request too long" };
    const parent = store.getChat(parentChatId);
    if (!parent) return { error: "parent chat missing" };
    const callerAgent = parent.agent || DEFAULT_AGENT;
    if (target === callerAgent) return { error: `cannot ${ASK_AGENT_TOOL} yourself` };
    const chain = parseChain(parent.call_chain).concat(callerAgent);
    if (chain.includes(target)) return { error: `call loop refused: ${[...chain, target].join(" → ")}` };
    const child = store.createChat({
      title: `← ${CALLER_LABELS[callerAgent] || callerAgent}: ${request.slice(0, 60)}`,
      model: targetProfile.model || parent.model,
      mode: parent.mode === "plan" ? "plan" : "agent",
      caller: callerAgent,
      agent: target,
      parentChatId: parentChatId,
      callChain: chain,
      provider: targetProfile.provider === "claude" ? "claude" : "cursor",
    });
    return { child, callerAgent, target, request };
  }

  async function runAsk(parentChatId, args) {
    const spawned = spawnChild(parentChatId, args);
    if (spawned.error) return { isError: true, content: [{ type: "text", text: spawned.error }] };
    const { child, callerAgent, target, request } = spawned;
    track(parentChatId, child.id);

    try {
      await runner.send(child.id, { text: peerMessage(callerAgent, request), images: [] });
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
      return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
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

  recover();

  return {
    tool,
    delegateTool,
    subtasksTool,
    pendingDelegates,
    cancelChildren, hasChildren: (parentChatId) => (childrenOf.get(parentChatId)?.size || 0) > 0, buildEnvelope: (chatId, meta) => buildEnvelope(store, chatId, meta) };
}

export function peerMessage(callerAgent, request) {
  const who = CALLER_LABELS[callerAgent] || callerAgent;
  return (
    `[درخواست از «${who}»] این پیام را ایجنت همتا فرستاده، نه Owner. سهمیهٔ ابزارت همان سهمیهٔ همین صداکننده روی توست — کامل از آن استفاده کن. ` +
    `اگر هیچ ابزاری آن سیستم را پوشش نمی‌دهد، با ترمینال (debug_exec) و کریدنشیالِ سکرت‌منیجر کار را انجام بده. «ابزارش را ندارم» نتیجه نیست. ` +
    `اگر سؤال از Owner لازم است ask_owner بزن (سؤالِ اجازه همیشه به خود Owner می‌رسد، نه به درخواست‌کننده؛ اگر ریشه زمان‌بند باشد کسی نیست و خودت تصمیم بگیر). ` +
    `جواب نهایی: Markdown کوتاه فارسی (حداکثر یک عنوان کوتاه + چند بولت یا یک جدول کوچک). فقط عدد و واقعیت ابزار. مسیر API/SSH را ننویس مگر Owner بپرسد یا همهٔ مسیرها شکست خورده باشند. وضعیت ساختگی برای ابزارها نساز.\n\n${request}`
  );
}

export function buildEnvelope(store, chatId, { status, error = null, at = null } = {}) {
  const facts = [];
  const texts = [];
  for (const event of store.allEvents(chatId)) {
    if (event.type === "text" && event.data?.text) texts.push(String(event.data.text));
    if (event.type === "tool.done" && event.data?.name) {
      facts.push(clip({
        tool: event.data.name,
        args: event.data.args || null,
        result: event.data.result ?? null,
        at: event.at,
      }));
      if (facts.length >= FACT_CAP) break;
    }
  }
  const summary = texts.join("").trim().slice(0, 4000) || null;
  const brief = briefFromFacts(facts) || (summary ? summary.split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 3).join("\n").slice(0, 500) : null);
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
