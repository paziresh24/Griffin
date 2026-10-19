import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PROVIDER_OPENAI } from "./ids.mjs";
import { stripProductSignature } from "../identity.mjs";
import { SIGNATURE_RE } from "../persona.mjs";

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
// Tool-result clearing (Anthropic "context editing", the lightest compaction): once a session
// passes CLEAR_AT tokens, tool results older than the last CLEAR_KEEP are replaced by a short stub
// (head preview + "re-run if needed"). Lossless where it matters — the events table keeps every
// result — and done in batches of at least CLEAR_MIN so the cached prompt prefix breaks rarely.
// 2026-10-08 evidence: 7d of glm-5.3-flash = 7,039 rounds at ~50k prompt tokens each, peaks 222k,
// almost all of it stale tool output re-read every round.
const CLEAR_AT_TOKENS = Math.max(20_000, Number(process.env.GRIFFIN_OPENAI_CLEAR_AT) || 80_000);
const CLEAR_KEEP = Math.max(2, Number(process.env.GRIFFIN_OPENAI_CLEAR_KEEP) || 8);
const CLEAR_MIN = 6;
const CLEARED_MARK = "[نتیجهٔ قدیمی ابزار";

// Error streak (Fowler's "sensor whose message says how to self-correct"): consecutive failing
// tool calls with different args slip past the identical-round stuck detector — the model keeps
// guessing paths/domains. One in-band nudge per send.
const ERROR_STREAK = Math.max(2, Number(process.env.GRIFFIN_OPENAI_ERROR_STREAK) || 3);
const ERROR_NUDGE =
  "[تذکر سیستمی] چند فراخوانی پشت‌سرهم خطا داد. حدس نزن و همان را با تغییر جزئی تکرار نکن: پیام خطا و hint آن را بخوان؛ " +
  "اگر مسیر واقعاً بسته است (دسترسی/سرویس پایین)، همان را مانعِ کار گزارش کن، وگرنه با ابزار درست مقدار واقعی را پیدا کن (مسیر، دامنه، نام).";

// Premature stop (the "every 'continue' is a harness failure" rule): a final answer that promises
// work («چک می‌کنم، خبر می‌دم») while no delegated subtask is running ends the run with nobody left
// to wake it — 2026-10-08 evidence: dozens of runs ended exactly so. One continuation per send.
const PROMISE_TAIL =
  /(?:(?:چک|بررسی|نگاه|پیدا|درست|اجرا|امتحان|تست|اعمال|اضافه|تکمیل|ادامه|جمع‌?\s?بندی)\s*(?:رو\s*|را\s*)?(?:می[‌\s]?)(?:کنم|کنیم|دم|دهم|زنم|گیرم|گیریم)|(?:خبر|اطلاع|گزارش|نتیجه\S*)\s*(?:را\s*|رو\s*)?(?:می[‌\s]?)(?:دم|دهم|گم|گویم)|\blet me\b|\bI(?:'ll| will) (?:now )?(?:check|look|run|fix|try|verify|report))/i;
const CONTINUE_NUDGE =
  "[تذکر سیستمی] پیام آخرت قول کاری را داد که هنوز انجام نشده، و هیچ زیرکاری هم در جریان نیست — بعد از این پیام کسی بیدارت نمی‌کند. " +
  "همین حالا همان کار را با ابزار انجام بده و جواب نهایی را بنویس؛ اگر واقعاً نمی‌شود، مانع را دقیق بگو.";

const SIGNATURE_TAIL = new RegExp(`\\s*—\\s*${SIGNATURE_RE}\\s*$`, "u");

export function promisesWork(text) {
  const clean = stripProductSignature(String(text || "").replace(SIGNATURE_TAIL, "")).trim();
  if (!clean) return false;
  // Only the closing sentence counts: an offer («اگر خواستید اعمال می‌کنم») or a question is fine.
  const last = clean.split(/(?<=[.!؟?\n])\s+/u).filter(Boolean).slice(-2).join(" ").slice(-220);
  // An offer, a question, or a decision left to a human («بگویید و اجرا می‌کنم», «با تأیید شما») is fine.
  if (/[؟?]\s*$/.test(last) || /(^|\s)(اگر|اگه|در صورت|if you|بگویید|بگید|با شماست|تأیید|تایید)(\s|$)/i.test(last)) return false;
  return PROMISE_TAIL.test(last);
}

// Read-only calls the model issued in one round run concurrently (it already declared them
// independent by batching them). Anything that can change state or ask a human stays sequential,
// so a cancel mid-batch still stops the rest (2026-10-06).
const PARALLEL_SAFE =
  /^(kube_(get|status|logs|df)|gitlab_(file|search|projects|commits)|infisical_(list|get|projects|access)|http_check|dns_lookup|tls_check|web_search|web_fetch|metrics_query|grafana_(search|dashboard|panel_query|query)|alerts_active|s3_list|knowledge_list|incidents_list|incident_history|list_agents|mikrotik_print|mikrotik_ping|nsin_edge_ranges|arvan_(domains|dns_records|dns_export|dnssec|cache_settings|purge_tags))$/;
export function parallelSafe(call) {
  const args = call?.args || {};
  if (call?.name === "debug_exec") return !args.host || args.host === "sandbox";
  if (call?.name === "pg_query") return !args.write;
  return PARALLEL_SAFE.test(String(call?.name || ""));
}

// Head AND tail: a script's last section and an error trailer live at the end of the output.
export function clipToolText(value, max) {
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${value.slice(0, head)}\n… [خروجی ${value.length} کاراکتری کوتاه شد: ${value.length - max} کاراکتر از وسط حذف شد] …\n${value.slice(-tail)}`;
}

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
  "You are Griffin, an AI agent. Facts come from your tools, never from memory. " +
  "Answer in the user's language, short, result first.";

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
  clearAtTokens = CLEAR_AT_TOKENS,
  clearKeep = CLEAR_KEEP,
  errorStreak = ERROR_STREAK,
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

  // Returns how many results were stubbed. Only fires when enough stale results piled up, so the
  // prompt prefix (and the endpoint's cache of it) changes in rare batches, not every round.
  function clearStaleResults(session) {
    const toolIdx = [];
    session.messages.forEach((m, i) => {
      if (m.role === "tool") toolIdx.push(i);
    });
    const stale = toolIdx
      .slice(0, Math.max(0, toolIdx.length - clearKeep))
      .filter((i) => {
        const content = String(session.messages[i].content || "");
        return content.length > 600 && !content.startsWith(CLEARED_MARK);
      });
    if (stale.length < CLEAR_MIN) return 0;
    for (const i of stale) {
      const content = String(session.messages[i].content);
      session.messages[i] = {
        ...session.messages[i],
        content: `${CLEARED_MARK} (${content.length} کاراکتر) برای سبک‌کردن کانتکست پاک شد. ابتدایش: «${content.slice(0, 300)}…» — اگر دوباره لازمش داری، ابزار را دوباره بزن.]`,
      };
    }
    session.promptTokens = 0;
    return stale.length;
  }

  // Lossless-first stage before paying the summarizer: identical (call, result) pairs — the
  // steady diet of a monitoring/looping run, the same probe round after round — are emitted once
  // with a repeat count and dropped afterwards. Nothing the summary needs is lost, and the
  // summarizer input can shrink several-fold for free ("lossless before lossy" in the compaction
  // funnel). A tool result is paired with its call through tool_call_id, so repeats anywhere in
  // the middle collapse, not just adjacent ones.
  function pruneMiddle(messages) {
    const callOf = new Map(); // tool_call_id -> name(args) key of the round that issued it
    const items = []; // { message, key } — key set for tool results only
    const counts = new Map(); // key -> occurrences
    for (const message of messages) {
      if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          callOf.set(call?.id, `${call?.function?.name}(${String(call?.function?.arguments || "").slice(0, 400)})`);
        }
        items.push({ message });
        continue;
      }
      if (message.role === "tool") {
        const key = `${callOf.get(message.tool_call_id) || "?"}\u0000${String(message.content || "")}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        items.push({ message, key });
        continue;
      }
      items.push({ message });
    }
    const emitted = new Set();
    const out = [];
    for (const item of items) {
      if (!item.key) {
        out.push(item.message);
        continue;
      }
      const first = !emitted.has(item.key);
      if (!first) continue; // a later identical (call, result) — already represented
      emitted.add(item.key);
      out.push(item.message);
      const total = counts.get(item.key) || 1;
      if (total > 1) out.push({ role: "tool", content: `[همان نتیجهٔ فوق — در این بخش ${total} بار تکرار شد]` });
    }
    return out;
  }

  function renderForSummary(messages) {
    const lines = [];
    for (const message of pruneMiddle(messages)) {
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
        // A spent plan (Z.ai "Usage limit reached", code 1308/1310) does not come back in a minute:
        // fail at once as plan_limit so Griffin moves the work to another provider. A saturated Z.ai
        // coding window answers "issue with the selected model … may not exist or you may not have
        // access" instead of a clean quota error (2026-10-10: both plans dry → a 5-min task took 2h
        // because this was thrown as a plain error and the two-way fallback never fired).
        // autoFallback: main's exact text test, so auto mode moves (and only then fails at once)
        // exactly as before. The code is for ask mode: a spent plan (Z.ai's body code 1308/1310 or
        // the plan texts, the model-access answer included — a saturated window, 2026-10-10) is
        // plan_limit; a bare 1308/1310 in the text (an index such as messages.1310) is
        // engine_unavailable. A body code main's text test misses goes through main's retries
        // unchanged and ends, if it still fails, as plan_limit with autoFallback false: auto treats
        // it as the ordinary error main gave, ask mode as a spent plan.
        const text = String(error?.message);
        const autoFallback = /usage limit|quota|credit balance|\b13(08|10)\b|insufficient (balance|quota)|issue with the selected model|may not have access/i.test(text);
        const spent = ["1308", "1310"].includes(String(error?.apiCode ?? "")) || /usage limit|quota|credit balance|insufficient (balance|quota)|issue with the selected model|may not have access/i.test(text);
        if (spent || autoFallback) {
          error.code = spent ? "plan_limit" : "engine_unavailable";
          error.autoFallback = autoFallback;
          if (autoFallback) throw error;
        }
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
          await emit?.({ type: "api-retry", attempt: attempt + 1, maxRetries: 6, delayMs: wait, status: error?.status ?? (limited ? 429 : null) });
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
        apiCode: parsed?.error?.code ?? null,
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
        if (event.error) throw Object.assign(new Error(errorText(event) || "openai stream error"), { apiCode: event.error?.code ?? null });
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
    const session = loadSession(agentId, options?.stateDir || options?.cwd, isResume);
    // Fresh session after a rewind/switch: seed the conversation it should still remember.
    if (!isResume && session.messages.length === 0 && Array.isArray(options?.seedMessages) && options.seedMessages.length) {
      session.messages = options.seedMessages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
        .map((m) => ({ role: m.role, content: m.content }));
    }

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
          supports: (cap) => cap === "cancel" || cap === "nudge" || cap === "steer",
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
          // A message the owner sends mid-run joins this run at the next round boundary (after the
          // tools in flight, or instead of finishing) — real steering, not a queued next turn.
          async steer(next) {
            if (settled || abort.signal.aborted) return "revert_to_followup";
            steered.push(next);
            return "complete_delivered";
          },
          wait: () => done,
        };

        let nudgeText = null;
        const steered = [];
        let flow = new AbortController();
        const flowSignal = () =>
          AbortSignal.any ? AbortSignal.any([abort.signal, flow.signal]) : abort.signal;

        (async () => {
          // History is committed per round: the user message and every fully-completed round
          // survive a failure; only the in-flight round (assistant/tool_calls without all its
          // tool results) is rolled back, so the transcript never goes malformed.
          let committed = null;
          // Steered messages enter the history as user turns; true when there were any.
          const takeSteered = () => {
            if (!steered.length) return false;
            for (const next of steered.splice(0)) session.messages.push({ role: "user", content: toUserContent(next) });
            committed = session.messages.length;
            return true;
          };
          let pressureCompacted = false;
          let overflowCompactions = 0;
          let stuckSignature = null;
          let stuckRounds = 0;
          let stuckNudged = false;
          let smallCmdRounds = 0;
          let smallCmdNudged = false;
          let silentRounds = 0;
          let silentNudged = false;
          let errorRun = 0;
          let errorNudged = false;
          let continueNudged = false;
          try {
            if (!apiKey) throw new Error("OpenAI API key missing");
            if (!root) throw new Error("OpenAI base url missing");
            const modelId = sendOptions.model?.id || options.model?.id || defaultModel;
            // xhigh/max are Claude levels; an OpenAI-style endpoint gets its own top level.
            const effort = { xhigh: "high", max: "high" }[sendOptions.effort] || sendOptions.effort || reasoningEffort;
            const system = systemPrompt(options, sendOptions.mode);
            session.messages.push({ role: "user", content: toUserContent(message) });
            committed = session.messages.length;
            const tools = toOpenAITools(options.customTools || {}, log);

            for (let round = 0; ; round += 1) {
              if (round >= runawayRounds) throw new Error(`runaway: ${runawayRounds} tool rounds in one send — looks like a loop`);
              if (contextTokens(session) > clearAtTokens) {
                const cleared = clearStaleResults(session);
                if (cleared) {
                  log.error?.(`[openai] cleared ${cleared} stale tool results (context over ${clearAtTokens} tokens)`);
                  persistSession(agentId, session, options?.stateDir || options?.cwd);
                }
              }
              // Pressure trigger: compact before the endpoint ever has to refuse us.
              if (!pressureCompacted && contextTokens(session) > compactAtTokens) {
                pressureCompacted = true;
                await emit({ type: "summary-started" });
                const done0 = await compactSession(session, { modelId, keep: compactKeepRecent, reason: "فشار کانتکست" });
                if (done0) persistSession(agentId, session, options?.stateDir || options?.cwd);
              }
              let completion;
              try {
                completion = await requestCompletion(
                  {
                    model: modelId,
                    ...(effort ? { reasoning_effort: effort } : {}),
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
                    persistSession(agentId, session, options?.stateDir || options?.cwd);
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
                if (!abort.signal.aborted && takeSteered()) {
                  await emit({ type: "user-message-appended" });
                  await emit({ type: "text-delta", text: "\n\n" });
                  continue;
                }
                if (!continueNudged && !abort.signal.aborted && promisesWork(completion.text) && !(Number(options?.pendingWork?.()) > 0)) {
                  continueNudged = true;
                  log.error?.("[openai] final answer promises unfinished work with nothing pending — continuing the run");
                  session.messages.push({ role: "user", content: CONTINUE_NUDGE });
                  committed = session.messages.length;
                  await emit({ type: "text-delta", text: "\n\n" });
                  continue;
                }
                persistSession(agentId, session, options?.stateDir || options?.cwd);
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
              let outcomes;
              if (completion.toolCalls.length > 1 && completion.toolCalls.every(parallelSafe)) {
                outcomes = await Promise.all(completion.toolCalls.map((call) => runToolCall(call, { options, emit, log })));
              } else {
                outcomes = [];
                for (const call of completion.toolCalls) {
                  // A cancel mid-round must not run the rest of the batch: a stopped run still fired
                  // ask_owner and pinged the owner's Telegram (2026-10-06). The catch rolls back the round.
                  if (abort.signal.aborted) throw new Error("cancelled");
                  outcomes.push(await runToolCall(call, { options, emit, log }));
                }
              }
              for (const outcome of outcomes) {
                session.messages.push(outcome.message);
                errorRun = outcome.ok ? 0 : errorRun + 1;
              }
              if (abort.signal.aborted) throw new Error("cancelled");
              committed = session.messages.length;
              if (takeSteered()) {
                await emit({ type: "user-message-appended" });
                continue;
              }
              if (!errorNudged && errorRun >= errorStreak) {
                errorNudged = true;
                errorRun = 0;
                log.error?.("[openai] streak of failing tool calls — asking the model to read the errors");
                session.messages.push({ role: "user", content: ERROR_NUDGE });
                committed = session.messages.length;
                continue;
              }
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
              error: { message: String(error?.message || error), ...(error?.code === "plan_limit" || error?.code === "engine_unavailable" ? { code: error.code, ...(typeof error.autoFallback === "boolean" ? { autoFallback: error.autoFallback } : {}) } : {}) },
            });
          }
        })();

        return run;
      },
    };
  }

  async function runToolCall(call, { options, emit, log }) {
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
        if (result && typeof result === "object" && result.isError) ok = false;
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
    if (!ok) log.error?.(`[openai] tool ${call.name} failed: ${String(result?.error ?? value).slice(0, 300)}`);
    return { ok, message: { role: "tool", tool_call_id: call.id, content: clipToolText(value, toolMaxChars) } };
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
        // 401/403 = the key is refused: not healthy (the engine card would otherwise say «ready»).
        return { ok: response.ok, status: response.status, ...(response.ok ? {} : { error: `http_${response.status}` }), ms: Date.now() - started };
      } catch (error) {
        return {
          ok: false,
          error: error?.name === "TimeoutError" ? "timeout" : String(error?.cause?.code || error?.message),
          ms: Date.now() - started,
        };
      }
    },
    // Plan quota (5-hour + weekly windows). Z.ai exposes it on the account host, not the coding
    // path — derive the origin from baseUrl. Returns null for any other OpenAI-compatible endpoint.
    async usage() {
      if (!apiKey || !/\bz\.ai\b/.test(root)) return null;
      const origin = root.replace(/\/api\/.*$/, "");
      try {
        const response = await fetchImpl(`${origin}/api/monitor/usage/quota/limit`, {
          method: "GET",
          headers: authHeaders(),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return { error: `http ${response.status}` };
        const limits = (await response.json())?.data?.limits || [];
        // Observed 2026-10-05 (pro plan): unit 3 + number 5 = the 5-hour window, unit 6 + number 1 = weekly.
        const label = (l) => (l.unit === 3 ? `${l.number} ساعته` : l.unit === 6 ? (l.number === 1 ? "هفتگی" : `${l.number} هفته`) : l.unit === 5 ? "روزانه" : `${l.number}×${l.unit}`);
        const windows = limits.map((l) => ({
          label: label(l),
          used: l.currentValue ?? 0,
          limit: l.usage ?? null,
          remaining: l.remaining ?? null,
          percentage: l.percentage ?? null,
          resetAt: l.nextResetTime || null,
        }));
        return { provider: PROVIDER_OPENAI, windows };
      } catch (error) {
        return { error: error?.name === "TimeoutError" ? "timeout" : String(error?.message || error) };
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
  if (json?.error) throw Object.assign(new Error(errorText(json) || "openai request failed"), { apiCode: json.error?.code ?? null });
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
