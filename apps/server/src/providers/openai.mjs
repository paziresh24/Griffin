import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PROVIDER_OPENAI } from "./ids.mjs";

export { PROVIDER_OPENAI };

// OpenAI-compatible chat-completions provider (any /v1 endpoint: OpenAI, LiteLLM, OpenRouter, Z.ai…).
// Same agent contract as cursor.mjs/claude.mjs: create/resume return an agent whose send()
// emits Cursor-shaped InteractionUpdates through onDelta and settles a run promise.

// Not a ration (owner 2026-09-25: a cap hides the real problem — fix the cause): a model that
// needs 300 tool rounds in one send is in a loop, and the run fails loudly so it gets looked at.
const RUNAWAY_ROUNDS = Math.max(2, Number(process.env.GRIFFIN_OPENAI_MAX_ROUNDS) || 300);

// Context management (dsh compaction-seam pattern, adapted): sessions grow without bound and one
// long working chat crossed the endpoint's 1,048,576-token cap on 2026-09-27 — every later run in
// that chat then failed with the same "maximum context length" error. Two triggers now: proactive
// compaction at a pressure threshold, and an aggressive compact-and-retry when the endpoint still
// reports overflow. The session file keeps the compacted form only; the events table already holds
// the lossless transcript.
const COMPACT_AT_TOKENS = Math.max(10_000, Number(process.env.GRIFFIN_OPENAI_COMPACT_AT) || 600_000);
const COMPACT_KEEP_RECENT = Math.max(4, Number(process.env.GRIFFIN_OPENAI_KEEP_RECENT) || 12);
const TOOL_MAX_CHARS = Math.max(2_000, Number(process.env.GRIFFIN_OPENAI_TOOL_MAX) || 20_000);
const CONTEXT_OVERFLOW =
  /maximum context length|context_length_exceeded|reduce the length of the messages|prompt is too long|too many tokens/i;

// Stuck detection (OpenHands/Gemini-CLI pattern): identical tool rounds in a row mean a loop.
// First offence gets an in-band nudge the model must answer; repeating after it fails loudly.
const STUCK_AFTER = Math.max(2, Number(process.env.GRIFFIN_OPENAI_STUCK_AFTER) || 3);
const STUCK_NUDGE =
  "[تذکر سیستمی] همین فراخوانی ابزار را با آرگومان‌های یکسان چند بار پشت‌سرهم زدی و نتیجه همان بود. " +
  "از حلقه خارج شو: یا نتیجه را بپذیر و کار را ادامه بده، یا روش دیگری امتحان کن. همان فراخوانی را دوباره تکرار نکن.";

// Pace detection: a long streak of one-short-terminal-command rounds, or many tool rounds with no
// text for the owner, means the run is crawling and looks silent. One in-band nudge each per send.
const SMALL_CMD_AFTER = Math.max(3, Number(process.env.GRIFFIN_OPENAI_SMALL_CMD_AFTER) || 6);
const SILENT_AFTER = Math.max(4, Number(process.env.GRIFFIN_OPENAI_SILENT_AFTER) || 10);
const SMALL_CMD_NUDGE =
  "[تذکر سیستمی] چند فراخوانی پشت‌سرهمِ debug_exec با یک دستور کوچک زدی. از این بعد در هر فراخوانی یک اسکریپت کامل بده: " +
  "همهٔ دستورهای آن مرحله پشت‌هم، با echo برای جداکردن بخش‌ها؛ دستورِ تکی در هر دور ممنوع است — زمان اونر تلف می‌شود.";
const SILENT_NUDGE =
  "[تذکر سیستمی] بیش از ده فراخوانی ابزار بدون هیچ متنی گذشته است. همین حالا یک خط پیشرفت کوتاه فارسی برای اونر بنویس " +
  "(تا اینجا چه پیدا شد، بعدش چه می‌کنی)، بعد کار را ادامه بده.";

// A round is "small-terminal" when it is exactly one debug_exec carrying a single short command —
// no newlines, no chaining. That is the breadcrumb pattern the nudge is there to break.
function isSmallTerminalRound(toolCalls) {
  if (toolCalls.length !== 1) return false;
  const [call] = toolCalls;
  if (call.name !== "debug_exec") return false;
  const command = call.args && typeof call.args.command === "string" ? call.args.command : "";
  return command.length > 0 && command.length <= 160 && !/[\n;]|&&/.test(command);
}
const SUMMARY_RULES =
  "You summarize the middle of an operations agent's conversation for its own continuing use. " +
  "Keep every decision, key finding, identifier (paths, hosts, ids, branches), command that was run and its " +
  "outcome, open questions, and unfinished steps. Drop chit-chat and raw bulk output. Persian, max ~600 words, " +
  "plain text only — no preamble.";

const SESSION_DIR = ".griffin-openai-sessions";
const FALLBACK_SYSTEM =
  "You are Griffin, an operations agent. Facts come from your tools, never from memory. " +
  "Talk Persian, short, result first.";

export function createOpenAIProvider({
  apiKey,
  baseUrl,
  defaultModel = "gpt-4o-mini",
  // low|medium|high, sent as reasoning_effort when set (Z.ai GLM honours it: 1/21/148 reasoning
  // tokens for the same prompt, 2026-09-24). Unset = the endpoint's own default.
  reasoningEffort = "",
  fetchImpl = globalThis.fetch.bind(globalThis),
  idleMs = 90_000,
  runawayRounds = RUNAWAY_ROUNDS,
  compactAtTokens = COMPACT_AT_TOKENS,
  compactKeepRecent = COMPACT_KEEP_RECENT,
  toolMaxChars = TOOL_MAX_CHARS,
  stuckAfter = STUCK_AFTER,
  smallCmdAfter = SMALL_CMD_AFTER,
  silentAfter = SILENT_AFTER,
  log = console,
} = {}) {
  const root = String(baseUrl || "").replace(/\/+$/, "");
  const sessions = new Map(); // agentId -> { messages: [] } (OpenAI messages; system rebuilt per send)

  const authHeaders = () => ({
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    "content-type": "application/json",
  });

  function sessionFile(cwd, agentId) {
    return cwd ? path.join(cwd, SESSION_DIR, `${agentId}.json`) : null;
  }

  function loadSession(agentId, cwd, isResume) {
    const known = sessions.get(agentId);
    if (known) return known;
    const file = sessionFile(cwd, agentId);
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(parsed?.messages)) {
          const session = { messages: parsed.messages, promptTokens: 0 };
          sessions.set(agentId, session);
          return session;
        }
      } catch (error) {
        log.error?.(`[openai] session ${agentId} unreadable: ${error?.message || error}`);
      }
    }
    if (isResume) {
      throw Object.assign(new Error(`openai session not found: ${agentId}`), {
        code: "agent_not_found",
        name: "AgentNotFoundError",
      });
    }
    const session = { messages: [], promptTokens: 0 };
    sessions.set(agentId, session);
    return session;
  }

  function persistSession(agentId, session, cwd) {
    const file = sessionFile(cwd, agentId);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ agentId, messages: session.messages, updatedAt: new Date().toISOString() }));
    } catch (error) {
      log.error?.(`[openai] session ${agentId} persist failed: ${error?.message || error}`);
    }
  }

  // ---- context management -------------------------------------------------------------
  // Exact while available (the endpoint reports it with every completion), estimate otherwise:
  // mixed Persian/ASCII averages ~3 chars per token — close enough for a threshold trigger.
  function estimateTokens(messages) {
    let chars = 0;
    for (const message of messages) {
      chars += 8;
      if (typeof message?.content === "string") chars += message.content.length;
      for (const call of message?.tool_calls || []) chars += (call?.function?.arguments || "").length + 16;
    }
    return Math.ceil(chars / 3);
  }

  function contextTokens(session) {
    return session.promptTokens > 0 ? session.promptTokens : estimateTokens(session.messages);
  }

  function renderForSummary(messages) {
    const lines = [];
    for (const message of messages) {
      if (message.role === "user") lines.push(`کاربر: ${String(message.content).slice(0, 2_000)}`);
      else if (message.role === "assistant") {
        const calls = (message.tool_calls || [])
          .map((call) => `${call?.function?.name}(${String(call?.function?.arguments || "").slice(0, 300)})`)
          .join("; ");
        lines.push(`دستیار${calls ? ` [ابزار: ${calls}]` : ""}: ${String(message.content || "").slice(0, 1_500)}`);
      } else if (message.role === "tool") lines.push(`نتیجهٔ ابزار: ${String(message.content || "").slice(0, 1_000)}`);
    }
    // Most recent work matters most; if the middle is huge, keep its head and tail.
    let text = lines.join("\n");
    if (text.length > 150_000) text = `${text.slice(0, 75_000)}\n…[بخش میانی حذف شد]…\n${text.slice(-75_000)}`;
    return text;
  }

  async function summarizeMiddle(middle, modelId) {
    const body = renderForSummary(middle);
    try {
      const completion = await requestCompletion(
        { model: modelId, messages: [{ role: "system", content: SUMMARY_RULES }, { role: "user", content: body }] },
        { signal: null, emit: async () => {} },
      );
      if (completion?.text && completion.text.trim()) return completion.text.trim();
    } catch (error) {
      log.error?.(`[openai] compaction summarize failed (${error?.message || error}) — keeping a raw digest`);
    }
    // Never block compaction on a failed summary: a clipped digest still shrinks the session.
    return `${body.slice(0, 4_000)}\n…[خلاصهٔ خودکار در دسترس نبود؛ گزیدهٔ خام]`;
  }

  // dsh-style replace: the first user message (the original task) stays verbatim, the middle
  // collapses into one summary message, the tail stays verbatim. Never splits a tool round.
  async function compactSession(session, { modelId, keep, reason }) {
    let cut = Math.max(1, session.messages.length - Math.max(2, keep));
    while (cut > 1 && session.messages[cut - 1]?.tool_calls?.length) cut -= 1; // keep calls with their results
    while (cut < session.messages.length && session.messages[cut]?.role === "tool") cut += 1; // don't orphan a result
    if (cut <= 1) return false;
    const head = session.messages[0];
    const middle = session.messages.slice(1, cut);
    const kept = session.messages.slice(cut);
    const digest = await summarizeMiddle(middle, modelId);
    session.messages = [
      head,
      {
        role: "user",
        content:
          `[خلاصهٔ فشردهٔ بخش میانی گفتگو — ${reason}. قبل از پیام‌های اخیر:${middle.length} پیام خلاصه شد]\n` +
          `${digest}\n\n(پیام‌های پس از این خلاصه عیناً حفظ شده‌اند؛ کار را از همان‌جا ادامه بده.)`,
      },
      ...kept,
    ];
    session.promptTokens = 0; // re-measured on the next completion
    log.error?.(`[openai] session compacted (${reason}): ${middle.length} messages summarized, ${kept.length} kept`);
    return true;
  }

  function roundSignature(toolCalls) {
    if (!toolCalls?.length) return null;
    const hash = createHash("sha256");
    for (const call of toolCalls) hash.update(`${call.name}\\u0000${stableStringify(call.args)}\\u0000`);
    return hash.digest("hex");
  }

  // One model round-trip: posts stream:true, emits live updates (text/thinking/tool fragments)
  // and resolves the normalized completion. Endpoints that ignore streaming and answer with a
  // plain JSON body are handled by the content-type branch.
  // A stream that goes silent (2026-09-24: 5+ minutes mid-thought, only the 15-minute stale sweep
  // would have ended it) is aborted after idleMs and the round retried once — only when no answer
  // text went out yet, so a retry never duplicates what the user already saw.
  async function requestCompletion(payload, { signal, emit }) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await requestOnce(payload, { signal, emit });
      } catch (error) {
        if (signal?.aborted) throw error;
        // 429: the endpoint asked us to slow down — wait and send the same round again. Failing the
        // run dropped a colleague's answer when several chats ran at once (2026-09-25 eval: 2 of 10).
        const limited = error?.status === 429 || /rate limit|too many requests/i.test(String(error?.message));
        // A dropped connection or a gateway 5xx is the network, not the model: retry the same round.
        // «fetch failed» ended a 12-minute run and threw its work away (2026-09-26).
        const transient =
          [500, 502, 503, 504].includes(error?.status) ||
          /fetch failed|terminated|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|other side closed|UND_ERR/i.test(
            `${error?.message} ${error?.cause?.code || ""} ${error?.cause?.message || ""}`,
          );
        if ((limited || transient) && !error?.partialText && attempt < 6) {
          const wait = Math.min(error.retryAfterMs || 2_000 * 2 ** attempt, 60_000);
          log.error?.(`[openai] ${limited ? "rate limited" : `transient error (${error?.message})`} — retry in ${Math.round(wait / 1000)}s`);
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
        if (!error?.stalled || error.partialText || attempt >= 1) throw error;
        log.error?.(`[openai] stream idle ${Math.round(idleMs / 1000)}s — retrying the round`);
      }
    }
  }

  async function requestOnce(payload, { signal, emit }) {
    const idle = new AbortController();
    const onOuter = () => idle.abort();
    signal?.addEventListener?.("abort", onOuter, { once: true });
    const state = { text: false };
    let timer = null;
    const poke = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(Object.assign(new Error("openai stream stalled"), { stalled: true })), idleMs);
    };
    poke();
    try {
      return await requestStream(payload, { signal: idle.signal, emit, poke, state });
    } catch (error) {
      if (idle.signal.aborted && !signal?.aborted) {
        throw Object.assign(new Error(`openai stream stalled (${Math.round(idleMs / 1000)}s without data)`), { stalled: true, partialText: state.text });
      }
      // Whatever broke, remember whether answer text already went out: a retry must not repeat it.
      if (error && typeof error === "object" && error.partialText === undefined) error.partialText = state.text;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onOuter);
    }
  }

  async function requestStream(payload, { signal, emit, poke, state }) {
    const response = await fetchImpl(`${root}/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ ...payload, stream: true }),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      throw Object.assign(new Error(errorText(parsed) || `openai http ${response.status}`), {
        status: response.status,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
      });
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("event-stream")) {
      const json = await response.json();
      return withLiveFlags(fromCompleteResponse(json), false);
    }
    return consumeSse(response.body, emit, { poke, state });
  }

  function withLiveFlags(completion, live) {
    return { ...completion, liveText: live, liveReasoning: live };
  }

  async function consumeSse(body, emit, { poke = () => {}, state = {} } = {}) {
    const out = { text: "", reasoning: "", toolCalls: [], usage: null, finishReason: null };
    const acc = new Map(); // sse tool_call index -> { id, name, argsStr, emittedStarted }
    let thinkingStartedAt = null;
    let buffer = "";
    const decoder = new TextDecoder();

    const endThinking = async () => {
      if (thinkingStartedAt == null) return;
      await emit({ type: "thinking-completed", thinkingDurationMs: Date.now() - thinkingStartedAt });
      thinkingStartedAt = null;
    };

    for await (const chunk of body) {
      poke();
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.usage) out.usage = event.usage;
        if (event.error) throw new Error(errorText(event) || "openai stream error");
        const choice = event.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) out.finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning) {
          if (thinkingStartedAt == null) thinkingStartedAt = Date.now();
          out.reasoning += reasoning;
          await emit({ type: "thinking-delta", text: reasoning });
        }
        if (typeof delta.content === "string" && delta.content) {
          await endThinking();
          out.text += delta.content;
          state.text = true;
          await emit({ type: "text-delta", text: delta.content });
        }
        for (const fragment of delta.tool_calls || []) {
          const index = fragment.index ?? 0;
          const slot = acc.get(index) || { id: "", name: "", argsStr: "", emittedStarted: false };
          if (fragment.id) slot.id = fragment.id;
          if (fragment.function?.name) slot.name = fragment.function.name;
          if (fragment.function?.arguments) slot.argsStr += fragment.function.arguments;
          acc.set(index, slot);
          if (!slot.emittedStarted && (slot.id || slot.name)) {
            slot.emittedStarted = true;
            await emit({ type: "tool-call-started", callId: slot.id, toolCall: mcpToolCall(slot.name, {}) });
          }
          const parsed = tryParse(slot.argsStr);
          if (parsed) await emit({ type: "partial-tool-call", callId: slot.id, toolCall: mcpToolCall(slot.name, parsed) });
        }
      }
    }
    await endThinking();
    for (const [index, slot] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
      out.toolCalls.push({
        id: slot.id || `call-${index}`,
        name: slot.name,
        argsStr: slot.argsStr || "{}",
        args: tryParse(slot.argsStr) ?? {},
        emittedStarted: slot.emittedStarted,
      });
    }
    return withLiveFlags(out, true);
  }

  function makeAgent(sessionId, options) {
    const isResume = Boolean(sessionId);
    const agentId = sessionId || randomUUID();
    const session = loadSession(agentId, options?.cwd, isResume);

    return {
      get agentId() {
        return agentId;
      },
      async send(message, sendOptions = {}) {
        const abort = new AbortController();
        let settle;
        let settled = false;
        const done = new Promise((resolve) => {
          settle = resolve;
        });
        const finish = (result) => {
          if (settled) return;
          settled = true;
          settle(result);
        };
        const emit = async (update) => {
          await sendOptions.onDelta?.({ update });
        };

        const run = {
          id: randomUUID(),
          supports: (cap) => cap === "cancel" || cap === "nudge",
          async cancel() {
            abort.abort();
          },
          // sweepStale() calls this before killing a silent run: break the stuck round, drop a
          // note into the session, and let the loop continue instead of losing the work.
          async nudge(text) {
            if (abort.signal.aborted) return;
            nudgeText = String(text || STUCK_NUDGE);
            flow.abort(Object.assign(new Error("nudged"), { nudged: true }));
          },
          async steer() {
            return "revert_to_followup";
          },
          wait: () => done,
        };

        let nudgeText = null;
        let flow = new AbortController();
        const flowSignal = () =>
          AbortSignal.any ? AbortSignal.any([abort.signal, flow.signal]) : abort.signal;

        (async () => {
          // History is committed per round: the user message and every fully-completed round
          // survive a failure; only the in-flight round (assistant/tool_calls without all its
          // tool results) is rolled back, so the transcript never goes malformed.
          let committed = null;
          let pressureCompacted = false;
          let overflowCompactions = 0;
          let stuckSignature = null;
          let stuckRounds = 0;
          let stuckNudged = false;
          let smallCmdRounds = 0;
          let smallCmdNudged = false;
          let silentRounds = 0;
          let silentNudged = false;
          try {
            if (!apiKey) throw new Error("OpenAI API key missing");
            if (!root) throw new Error("OpenAI base url missing");
            const modelId = sendOptions.model?.id || options.model?.id || defaultModel;
            const system = systemPrompt(options, sendOptions.mode);
            session.messages.push({ role: "user", content: toUserContent(message) });
            committed = session.messages.length;
            const tools = toOpenAITools(options.customTools || {}, log);

            for (let round = 0; ; round += 1) {
              if (round >= runawayRounds) throw new Error(`runaway: ${runawayRounds} tool rounds in one send — looks like a loop`);
              // Pressure trigger: compact before the endpoint ever has to refuse us.
              if (!pressureCompacted && contextTokens(session) > compactAtTokens) {
                pressureCompacted = true;
                await emit({ type: "summary-started" });
                const done0 = await compactSession(session, { modelId, keep: compactKeepRecent, reason: "فشار کانتکست" });
                if (done0) persistSession(agentId, session, options?.cwd);
              }
              let completion;
              try {
                completion = await requestCompletion(
                  {
                    model: modelId,
                    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
                    messages: [
                      { role: "system", content: system },
                      ...session.messages,
                    ],
                    ...(tools.length ? { tools } : {}),
                  },
                  { signal: flowSignal(), emit },
                );
              } catch (error) {
                // A nudge aborts the in-flight request; the loop continues with the note in-band.
                if (flow.signal.aborted && !abort.signal.aborted) {
                  session.messages.push({ role: "user", content: nudgeText || STUCK_NUDGE });
                  committed = session.messages.length;
                  flow = new AbortController();
                  continue;
                }
                // Overflow trigger: compact harder and retry the same round (2026-09-27: without
                // this, a chat over the limit failed identically 13 times in a row).
                if (overflowCompactions < 2 && CONTEXT_OVERFLOW.test(String(error?.message || error))) {
                  overflowCompactions += 1;
                  await emit({ type: "summary-started" });
                  // second attempt is more aggressive: keep less, summarize more
                  const shrunk = await compactSession(session, {
                    modelId,
                    keep: overflowCompactions === 1 ? compactKeepRecent : 2,
                    reason: `سرریز کانتکست (تلاش ${overflowCompactions})`,
                  });
                  if (shrunk) {
                    persistSession(agentId, session, options?.cwd);
                    continue;
                  }
                }
                throw error;
              }
              if (completion.usage?.prompt_tokens) {
                session.promptTokens = (completion.usage.prompt_tokens || 0) + (completion.usage.completion_tokens || 0);
              }
              if (completion.usage) await emit({ type: "turn-ended", usage: completion.usage });
              if (completion.reasoning && completion.liveReasoning === false) {
                await emit({ type: "thinking-delta", text: completion.reasoning });
                await emit({ type: "thinking-completed", thinkingDurationMs: 0 });
              }
              if (completion.text && completion.liveText === false) {
                await emit({ type: "text-delta", text: completion.text });
              }
              if (!completion.toolCalls.length) {
                if (!completion.text && !completion.usage && !completion.reasoning) throw new Error("empty completion from openai endpoint");
                session.messages.push({ role: "assistant", content: completion.text || "" });
                persistSession(agentId, session, options?.cwd);
                finish({ status: abort.signal.aborted ? "cancelled" : "finished" });
                return;
              }
              session.messages.push({
                role: "assistant",
                content: completion.text || null,
                tool_calls: completion.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.argsStr || "{}" },
                })),
              });
              for (const call of completion.toolCalls) {
                await runToolCall(call, { options, emit, session, log });
              }
              committed = session.messages.length;
              // Pace: long streaks of one-short-command rounds or of owner-silence each get one
              // in-band nudge per send (2026-09-28: a pod investigation ran ~120 one-second
              // commands and stayed silent for ten minutes).
              silentRounds = completion.text ? 0 : silentRounds + 1;
              if (!silentNudged && silentRounds > silentAfter) {
                silentNudged = true;
                silentRounds = 0;
                log.error?.("[openai] silent for too many tool rounds — asking for a progress line");
                session.messages.push({ role: "user", content: SILENT_NUDGE });
                committed = session.messages.length;
                continue;
              }
              smallCmdRounds = isSmallTerminalRound(completion.toolCalls) ? smallCmdRounds + 1 : 0;
              if (!smallCmdNudged && smallCmdRounds >= smallCmdAfter) {
                smallCmdNudged = true;
                smallCmdRounds = 0;
                log.error?.("[openai] streak of one-command terminal rounds — asking for batched scripts");
                session.messages.push({ role: "user", content: SMALL_CMD_NUDGE });
                committed = session.messages.length;
                continue;
              }
              // Stuck detection: the same calls with the same args, round after round.
              const signature = roundSignature(completion.toolCalls);
              if (signature !== null && signature === stuckSignature) stuckRounds += 1;
              else {
                stuckSignature = signature;
                stuckRounds = signature !== null ? 1 : 0;
              }
              if (stuckRounds >= stuckAfter) {
                if (!stuckNudged) {
                  stuckNudged = true;
                  log.error?.(`[openai] ${stuckRounds} identical tool rounds — nudging the model`);
                  session.messages.push({ role: "user", content: STUCK_NUDGE });
                  committed = session.messages.length;
                  continue;
                }
                throw new Error(
                  `stuck: ${stuckRounds} identical tool rounds in a row even after the nudge — stopping the loop`,
                );
              }
            }
          } catch (error) {
            if (committed != null && session.messages.length > committed) {
              session.messages.length = committed;
            }
            finish({
              status: abort.signal.aborted ? "cancelled" : "error",
              error: { message: String(error?.message || error) },
            });
          }
        })();

        return run;
      },
    };
  }

  async function runToolCall(call, { options, emit, session, log }) {
    if (!call.emittedStarted) {
      await emit({ type: "tool-call-started", callId: call.id, toolCall: mcpToolCall(call.name, call.args) });
    }
    const def = (options.customTools || {})[call.name];
    let ok = true;
    let result;
    if (!def || typeof def.execute !== "function") {
      ok = false;
      result = { error: `unknown tool: ${call.name}` };
    } else {
      try {
        result = await def.execute(call.args || {});
      } catch (error) {
        ok = false;
        result = { error: String(error?.message || error) };
      }
    }
    const value = resultValue(result);
    await emit({
      type: "tool-call-completed",
      callId: call.id,
      // Cursor-SDK parity: the whole UI/delivery stack (result.js, format.mjs firstJson) reads
      // MCP-shaped results — value.content[0].text. Emitting the bare string broke every chart
      // card and Telegram delivery after the 2026-09-24 provider switch (charts rendered as an
      // empty box: chartId was never parsed out).
      toolCall: {
        ...mcpToolCall(call.name, call.args),
        result: { status: ok ? "success" : "error", value: { content: [{ type: "text", text: value }] } },
      },
    });
    // The timeline keeps the full (redacted) result; the model's context keeps a capped copy —
    // one 40 KB dump repeated over rounds is what starves long sessions.
    const inContext =
      value.length > toolMaxChars ? `${value.slice(0, toolMaxChars)}\n… [خروجی ${value.length} کاراکتری برای صرفه‌جویی در کانتکست کوتاه شد]` : value;
    session.messages.push({ role: "tool", tool_call_id: call.id, content: inContext });
    if (!ok) log.error?.(`[openai] tool ${call.name} failed: ${String(result?.error).slice(0, 300)}`);
  }

  return {
    id: PROVIDER_OPENAI,
    defaultModel,
    async listModels() {
      if (!apiKey || !root) return [];
      const response = await fetchImpl(`${root}/models`, {
        method: "GET",
        headers: authHeaders(),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`openai models http ${response.status}`);
      const payload = await response.json();
      return (Array.isArray(payload?.data) ? payload.data : [])
        .filter((m) => m?.available !== false)
        .map((m) => ({ id: String(m.id), name: String(m.name || m.id), provider: PROVIDER_OPENAI }));
    },
    async health() {
      const started = Date.now();
      if (!apiKey) return { ok: false, error: "no openai api key" };
      if (!root) return { ok: false, error: "no openai base url" };
      try {
        const response = await fetchImpl(`${root}/models`, {
          method: "GET",
          headers: authHeaders(),
          signal: AbortSignal.timeout(8_000),
        });
        return { ok: response.ok || response.status === 401, status: response.status, ms: Date.now() - started };
      } catch (error) {
        return {
          ok: false,
          error: error?.name === "TimeoutError" ? "timeout" : String(error?.cause?.code || error?.message),
          ms: Date.now() - started,
        };
      }
    },
    create(options) {
      return makeAgent(null, options);
    },
    resume(agentId, options) {
      return makeAgent(agentId, options);
    },
  };
}

function fromCompleteResponse(json) {
  if (json?.error) throw new Error(errorText(json) || "openai request failed");
  const message = json?.choices?.[0]?.message || {};
  const toolCalls = (message.tool_calls || []).map((call, index) => ({
    id: call.id || `call-${index}`,
    name: call.function?.name || "",
    argsStr: call.function?.arguments || "{}",
    args: tryParse(call.function?.arguments) ?? {},
    emittedStarted: false,
  }));
  return {
    text: typeof message.content === "string" ? message.content : "",
    reasoning: message.reasoning_content ?? message.reasoning ?? "",
    toolCalls,
    usage: json?.usage || null,
    finishReason: json?.choices?.[0]?.finish_reason || null,
  };
}

function toOpenAITools(customTools, log) {
  const out = [];
  for (const [name, def] of Object.entries(customTools || {})) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      log.warn?.(`[openai] tool name not expressible, skipped: ${name}`);
      continue;
    }
    out.push({
      type: "function",
      function: {
        name,
        description: def?.description || name,
        parameters: def?.inputSchema || { type: "object", properties: {} },
      },
    });
  }
  return out;
}

// The persona/rules live in the agent workspace (installRules writes CLAUDE.md there for the
// Claude provider); read them back so every provider speaks with the same voice.
function systemPrompt(options, mode) {
  let text = FALLBACK_SYSTEM;
  // Per-run rules from agentOptions: the shared CLAUDE.md in cwd can belong to a concurrent run of
  // the same agent for another caller (owner vs a colleague's thread).
  if (options?.rules) {
    text = String(options.rules).trim();
  } else if (options?.cwd) {
    try {
      const file = path.join(options.cwd, "CLAUDE.md");
      if (fs.existsSync(file)) {
        const rules = fs.readFileSync(file, "utf8").trim();
        if (rules) text = rules;
      }
    } catch {
      /* fall back to the minimal system prompt */
    }
  }
  if (mode === "plan") {
    text += "\n\nPlan mode: investigate with read-only tools and propose a plan; do not perform changes.";
  }
  return text;
}

function toUserContent(message) {
  if (typeof message === "string") return message;
  const text = message?.text || "";
  const images = message?.images || [];
  if (!images.length) return text;
  // Text-only path, same trade-off as the Claude provider: image parts through proxies are
  // unreliable; the note at least keeps the model aware an image exists.
  return `${text}\n\n[${images.length} image(s) attached]`;
}

function mcpToolCall(name, args) {
  return {
    type: "mcp",
    args: {
      providerIdentifier: "custom-user-tools",
      toolName: name,
      args: args && typeof args === "object" ? args : {},
    },
  };
}

function resultValue(result) {
  if (!result || typeof result !== "object") return String(result ?? "");
  if (Array.isArray(result.content)) {
    const texts = [];
    let images = 0;
    for (const part of result.content) {
      if (part?.type === "text" && part.text != null) texts.push(String(part.text));
      else if (part?.type === "image") images += 1;
    }
    let text = texts.join("\n");
    if (images) text += `${text ? "\n" : ""}[${images} image(s) omitted]`;
    if (text) return text;
  }
  if (result.error !== undefined && Object.keys(result).length === 1) return String(result.error);
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function tryParse(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Key order must not turn "the same call" into a different one for the stuck detector.
function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function errorText(body) {
  const message = body?.error?.message || body?.error || body?.message;
  if (!message) return "";
  const hint = body?.error?.hint ? ` (${body.error.hint})` : "";
  return `${String(message)}${hint}`;
}
