import { randomUUID } from "node:crypto";
import { ANTIGRAVITY_USER_AGENT } from "../subscription-auth.mjs";

// The wire of the subscription engines (subscription-auth.mjs). openai.mjs keeps its session in
// chat-completions shape and its tool loop as it is; for a plan account each round is translated here
// to the plan's own API and its stream back to the same completion object
// ({text, reasoning, toolCalls, usage, finishReason}) consumeSse returns.
//   codex        ChatGPT backend, OpenAI Responses API: POST <base>/responses (SSE, store:false)
//   antigravity  Google Cloud Code Assist: POST <base>/v1internal:streamGenerateContent?alt=sse with the
//                Gemini request wrapped in {project, model, request}. Gemini 3 wants each functionCall's
//                thoughtSignature back on the next round: it rides on the session's tool_call as `signature`.

const tryParse = (text) => {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

const mcpToolCall = (name, args) => ({ type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: name, args: args && typeof args === "object" ? args : {} } });

// Lines of an SSE body, one parsed `data:` JSON at a time.
async function* sseEvents(body, poke) {
  const decoder = new TextDecoder();
  let buffer = "";
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
      const event = tryParse(data);
      if (event) yield event;
    }
  }
}

const systemText = (messages) => messages.filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n\n");
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text || "").join("") : String(content ?? ""));

// ---------------------------------------------------------------- codex (Responses API)

export function codexBody(payload, { sessionId } = {}) {
  const input = [];
  for (const m of payload.messages || []) {
    if (m.role === "system") continue;
    if (m.role === "user") input.push({ type: "message", role: "user", content: [{ type: "input_text", text: textOf(m.content) }] });
    else if (m.role === "assistant") {
      if (textOf(m.content)) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: textOf(m.content) }] });
      for (const call of m.tool_calls || []) input.push({ type: "function_call", call_id: call.id, name: call.function?.name || "", arguments: call.function?.arguments || "{}" });
    } else if (m.role === "tool") {
      // A note the loop adds as a tool message without a call id (pruneMiddle's repeat counter) is plain text.
      if (m.tool_call_id) input.push({ type: "function_call_output", call_id: m.tool_call_id, output: textOf(m.content) });
      else input.push({ type: "message", role: "user", content: [{ type: "input_text", text: textOf(m.content) }] });
    }
  }
  const effort = payload.reasoning_effort;
  return {
    model: payload.model,
    instructions: systemText(payload.messages || []) || "You are a helpful assistant.",
    input,
    tools: (payload.tools || []).map((t) => ({ type: "function", name: t.function.name, description: t.function.description || "", parameters: t.function.parameters || { type: "object", properties: {} }, strict: false })),
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: effort || "medium", summary: "auto" },
    store: false,
    stream: true,
    include: [],
    ...(sessionId ? { prompt_cache_key: sessionId } : {}),
  };
}

export const codexTransport = {
  request(payload, grant, { baseUrl, sessionId }) {
    return {
      url: `${baseUrl}/responses`,
      headers: {
        authorization: `Bearer ${grant.access}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(grant.accountId ? { "chatgpt-account-id": grant.accountId } : {}),
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        ...(sessionId ? { session_id: sessionId } : {}),
      },
      body: codexBody(payload, { sessionId }),
    };
  },
  async consume(body, emit, { poke = () => {}, state = {} } = {}) {
    const out = { text: "", reasoning: "", toolCalls: [], usage: null, finishReason: null };
    const calls = new Map(); // item id -> {id, name, argsStr, emittedStarted, order}
    let thinkingAt = null;
    const endThinking = async () => {
      if (thinkingAt == null) return;
      await emit({ type: "thinking-completed", thinkingDurationMs: Date.now() - thinkingAt });
      thinkingAt = null;
    };
    for await (const ev of sseEvents(body, poke)) {
      const type = String(ev.type || "");
      if (type === "response.output_text.delta" && ev.delta) {
        await endThinking();
        out.text += ev.delta;
        state.text = true;
        await emit({ type: "text-delta", text: ev.delta });
      } else if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && ev.delta) {
        if (thinkingAt == null) thinkingAt = Date.now();
        out.reasoning += ev.delta;
        await emit({ type: "thinking-delta", text: ev.delta });
      } else if (type === "response.output_item.added" && ev.item?.type === "function_call") {
        const slot = { id: ev.item.call_id || ev.item.id, name: ev.item.name || "", argsStr: ev.item.arguments || "", emittedStarted: true, order: calls.size };
        calls.set(ev.item.id || slot.id, slot);
        await emit({ type: "tool-call-started", callId: slot.id, toolCall: mcpToolCall(slot.name, {}) });
      } else if (type === "response.function_call_arguments.delta") {
        const slot = calls.get(ev.item_id);
        if (slot) {
          slot.argsStr += ev.delta || "";
          const parsed = tryParse(slot.argsStr);
          if (parsed) await emit({ type: "partial-tool-call", callId: slot.id, toolCall: mcpToolCall(slot.name, parsed) });
        }
      } else if (type === "response.output_item.done" && ev.item?.type === "function_call") {
        const key = ev.item.id || ev.item.call_id;
        const slot = calls.get(key) || { id: ev.item.call_id, emittedStarted: false, order: calls.size };
        slot.id = ev.item.call_id || slot.id;
        slot.name = ev.item.name || slot.name;
        if (typeof ev.item.arguments === "string") slot.argsStr = ev.item.arguments;
        calls.set(key, slot);
      } else if (type === "response.completed" || type === "response.incomplete") {
        const u = ev.response?.usage;
        if (u) out.usage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: u.total_tokens || 0, ...(u.input_tokens_details?.cached_tokens ? { prompt_tokens_details: { cached_tokens: u.input_tokens_details.cached_tokens } } : {}) };
        out.finishReason = type === "response.incomplete" ? ev.response?.incomplete_details?.reason || "length" : calls.size ? "tool_calls" : "stop";
      } else if (type === "response.failed" || type === "error") {
        const err = ev.response?.error || ev.error || ev;
        throw Object.assign(new Error(String(err?.message || "codex stream error")), { apiCode: err?.code ?? null });
      }
    }
    await endThinking();
    out.toolCalls = [...calls.values()].sort((a, b) => a.order - b.order).map((s, i) => ({ id: s.id || `call-${i}`, name: s.name, argsStr: s.argsStr || "{}", args: tryParse(s.argsStr) ?? {}, emittedStarted: s.emittedStarted }));
    return out;
  },
  async models(grant, { baseUrl, fetchImpl }) {
    const res = await fetchImpl(`${baseUrl}/models?client_version=0.99.0`, {
      headers: { authorization: `Bearer ${grant.access}`, ...(grant.accountId ? { "chatgpt-account-id": grant.accountId } : {}), originator: "codex_cli_rs" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw Object.assign(new Error(`codex models http ${res.status}`), { status: res.status });
    const body = await res.json().catch(() => ({}));
    const list = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
    return list
      .filter((m) => (m.visibility ?? "list") === "list" && m.supported_in_api !== false)
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => ({ id: String(m.slug || m.id), name: String(m.display_name || m.slug || m.id) }));
  },
  // The plan's windows as Codex itself reads them (GET backend-api/wham/usage): the 5-hour and the
  // weekly one, each with the percent used and when it resets.
  async usage(grant, { baseUrl, fetchImpl }) {
    const origin = String(baseUrl).replace(/\/codex\/?$/, "");
    const res = await fetchImpl(`${origin}/wham/usage`, {
      headers: { authorization: `Bearer ${grant.access}`, ...(grant.accountId ? { "chatgpt-account-id": grant.accountId } : {}), originator: "codex_cli_rs" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw Object.assign(new Error(`codex usage http ${res.status}`), { status: res.status });
    return codexWindows(await res.json().catch(() => ({})));
  },
};

const windowName = (seconds) => {
  const h = Math.round(Number(seconds) / 3600);
  if (!h) return "";
  return h % 168 === 0 ? (h === 168 ? "هفتگی" : `${h / 168} هفته`) : h % 24 === 0 ? (h === 24 ? "روزانه" : `${h / 24} روزه`) : `${h} ساعته`;
};
/** wham/usage → the usage panel's windows: { label, percentage, resetAt }. */
export function codexWindows(body) {
  const rl = body?.rate_limit || {};
  return [rl.primary_window, rl.secondary_window]
    .filter((w) => w && w.used_percent != null)
    .map((w) => ({
      label: windowName(w.limit_window_seconds) || "سهمیه",
      percentage: Math.round(Number(w.used_percent)),
      resetAt: w.reset_at ? new Date(Number(w.reset_at) * 1000).toISOString() : w.reset_after_seconds != null ? new Date(Date.now() + Number(w.reset_after_seconds) * 1000).toISOString() : null,
    }));
}

// ---------------------------------------------------------------- antigravity (Gemini over Cloud Code)

// Gemini takes an OpenAPI subset of JSON Schema: no $schema/additionalProperties/const/oneOf…, a single
// type per node. Unknown keys make the whole request fail, so anything outside the subset is dropped.
const SCHEMA_KEYS = new Set(["type", "description", "properties", "required", "items", "enum", "format", "nullable", "minItems", "maxItems", "minimum", "maximum"]);
export function geminiSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "OBJECT", properties: {} };
  const out = {};
  let type = schema.type;
  if (Array.isArray(type)) {
    if (type.includes("null")) out.nullable = true;
    type = type.find((t) => t !== "null") || "string";
  }
  if (!type) type = schema.properties ? "object" : schema.items ? "array" : schema.enum ? "string" : (schema.anyOf || schema.oneOf) ? null : "string";
  if (!type && Array.isArray(schema.anyOf || schema.oneOf)) {
    const first = (schema.anyOf || schema.oneOf).find((s) => s && s.type !== "null") || {};
    return { ...geminiSchema(first), ...(schema.description ? { description: String(schema.description) } : {}) };
  }
  for (const [k, v] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(k) || k === "type") continue;
    if (k === "properties" && v && typeof v === "object") out.properties = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, geminiSchema(s)]));
    else if (k === "items") out.items = geminiSchema(Array.isArray(v) ? v[0] : v);
    // Gemini refuses an empty string among enum values (app_settings_set's reasoningEffort ["", …],
    // 2026-11-23: «enum[0]: cannot be empty» on every turn); an enum left empty is dropped.
    else if (k === "enum") {
      const values = (Array.isArray(v) ? v : []).filter((x) => x != null && String(x) !== "").map(String);
      if (values.length) out.enum = values;
    }
    else if (k === "format") {
      if (type === "string" && ["enum", "date-time"].includes(v)) out.format = v;
    } else out[k] = v;
  }
  out.type = String(type).toUpperCase();
  if (out.type === "OBJECT") {
    out.properties ||= {};
    if (Array.isArray(out.required)) out.required = out.required.filter((r) => r in out.properties);
  } else delete out.required;
  if (out.enum && out.type !== "STRING") delete out.enum;
  return out;
}

export function geminiRequest(payload) {
  const contents = [];
  const nameOf = new Map(); // tool_call id -> function name
  const push = (role, part) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else contents.push({ role, parts: [part] });
  };
  for (const m of payload.messages || []) {
    if (m.role === "system") continue;
    if (m.role === "user") push("user", { text: textOf(m.content) || " " });
    else if (m.role === "assistant") {
      if (textOf(m.content)) push("model", { text: textOf(m.content) });
      for (const call of m.tool_calls || []) {
        nameOf.set(call.id, call.function?.name || "");
        push("model", { functionCall: { name: call.function?.name || "", args: tryParse(call.function?.arguments) || {} }, ...(call.signature ? { thoughtSignature: call.signature } : {}) });
      }
    } else if (m.role === "tool") {
      const name = nameOf.get(m.tool_call_id);
      if (name) push("user", { functionResponse: { name, response: { output: textOf(m.content) } } });
      else push("user", { text: textOf(m.content) || " " });
    }
  }
  // A model turn whose calls came from another engine carries no signature; Gemini then refuses the
  // whole request, so such a call is sent with the validator-skip marker the vendors' clients use.
  for (const c of contents) {
    if (c.role !== "model") continue;
    for (const part of c.parts) if (part.functionCall && !part.thoughtSignature) part.thoughtSignature = "skip_thought_signature_validator";
  }
  const tools = (payload.tools || []).map((t) => ({ name: t.function.name, description: t.function.description || "", parameters: geminiSchema(t.function.parameters) }));
  const system = systemText(payload.messages || []);
  const effort = payload.reasoning_effort;
  return {
    contents,
    ...(system ? { systemInstruction: { role: "user", parts: [{ text: system }] } } : {}),
    ...(tools.length ? { tools: [{ functionDeclarations: tools }], toolConfig: { functionCallingConfig: { mode: "AUTO" } } } : {}),
    generationConfig: { thinkingConfig: { includeThoughts: true, ...(effort ? { thinkingLevel: effort === "low" ? "low" : "high" } : {}) } },
  };
}

export const antigravityTransport = {
  request(payload, grant, { baseUrl, sessionId }) {
    const request = geminiRequest(payload);
    if (sessionId) request.sessionId = sessionId;
    return {
      url: `${baseUrl}/v1internal:streamGenerateContent?alt=sse`,
      headers: { authorization: `Bearer ${grant.access}`, "content-type": "application/json", accept: "text/event-stream", "User-Agent": ANTIGRAVITY_USER_AGENT },
      body: { project: grant.projectId, model: payload.model, request, requestType: "agent", userAgent: "antigravity", requestId: `agent-${randomUUID()}` },
    };
  },
  async consume(body, emit, { poke = () => {}, state = {} } = {}) {
    const out = { text: "", reasoning: "", toolCalls: [], usage: null, finishReason: null };
    let thinkingAt = null;
    const endThinking = async () => {
      if (thinkingAt == null) return;
      await emit({ type: "thinking-completed", thinkingDurationMs: Date.now() - thinkingAt });
      thinkingAt = null;
    };
    for await (const ev of sseEvents(body, poke)) {
      const r = ev.response || ev;
      if (r.error) throw Object.assign(new Error(String(r.error.message || "antigravity stream error")), { apiCode: r.error.status || r.error.code || null });
      const u = r.usageMetadata;
      if (u) out.usage = { prompt_tokens: u.promptTokenCount || 0, completion_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), total_tokens: u.totalTokenCount || 0, ...(u.cachedContentTokenCount ? { prompt_tokens_details: { cached_tokens: u.cachedContentTokenCount } } : {}) };
      const cand = r.candidates?.[0];
      if (!cand) continue;
      if (cand.finishReason) out.finishReason = String(cand.finishReason).toLowerCase();
      for (const part of cand.content?.parts || []) {
        if (part.functionCall) {
          await endThinking();
          const id = part.functionCall.id || `call-${randomUUID().slice(0, 8)}`;
          const args = part.functionCall.args && typeof part.functionCall.args === "object" ? part.functionCall.args : {};
          const sig = part.thoughtSignature || part.thought_signature || null;
          out.toolCalls.push({ id, name: part.functionCall.name || "", argsStr: JSON.stringify(args), args, emittedStarted: true, ...(sig ? { signature: sig } : {}) });
          await emit({ type: "tool-call-started", callId: id, toolCall: mcpToolCall(part.functionCall.name, {}) });
          await emit({ type: "partial-tool-call", callId: id, toolCall: mcpToolCall(part.functionCall.name, args) });
        } else if (typeof part.text === "string" && part.text) {
          if (part.thought) {
            if (thinkingAt == null) thinkingAt = Date.now();
            out.reasoning += part.text;
            await emit({ type: "thinking-delta", text: part.text });
          } else {
            await endThinking();
            out.text += part.text;
            state.text = true;
            await emit({ type: "text-delta", text: part.text });
          }
        }
      }
    }
    await endThinking();
    if (out.toolCalls.length && (!out.finishReason || out.finishReason === "stop")) out.finishReason = "tool_calls";
    return out;
  },
  async catalog(grant, { baseUrl, fetchImpl }) {
    const res = await fetchImpl(`${baseUrl}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: { authorization: `Bearer ${grant.access}`, "content-type": "application/json", "User-Agent": ANTIGRAVITY_USER_AGENT },
      body: JSON.stringify({ project: grant.projectId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw Object.assign(new Error(`antigravity models http ${res.status}`), { status: res.status });
    return antigravityCatalog(await res.json().catch(() => ({})));
  },
  async models(grant, opts) {
    return (await this.catalog(grant, opts)).models;
  },
  async usage(grant, opts = {}) {
    const { baseUrl, fetchImpl = fetch } = opts;
    const summary = await fetchAntigravityQuotaSummary(grant, { baseUrl, fetchImpl }).catch(() => null);
    if (summary && summary.windows.length && summary.hasSharedGemini) return summary.windows;
    // Summary missing or omitted the shared Gemini pool: fill from fetchAvailableModels.
    const cat = await this.catalog(grant, opts).catch(() => null);
    if (summary && summary.windows.length) {
      if (!cat?.windows?.length) return summary.windows;
      const summaryHasArgon = summary.windows.some((w) => /\bargon\b/i.test(w.label));
      const extra = cat.windows.filter((w) => !(summaryHasArgon && /\bargon\b/i.test(w.label)));
      return [...extra, ...summary.windows];
    }
    return cat?.windows || [];
  },
  // The id this account really runs: a picked family («gemini-4-neon») takes the variant of the chat's
  // effort («gemini-4-neon-xhigh»); an exact id it lists stays; anything else is said plainly instead
  // of Google's bare «Requested entity was not found» (another account's model, 2026-11-23).
  resolve(model, effort, catalog) {
    // No list to go by (a failed or empty read): send the id as is; Google's own answer is the check.
    if (!catalog || !catalog.models.length || catalog.ids.has(model)) return model;
    const suffix = String(model).match(/-(low|medium|high|xhigh)$/)?.[1];
    const family = catalog.families.get(model) || (suffix ? catalog.families.get(String(model).slice(0, -suffix.length - 1)) : null);
    if (family) return `${family.id}-${pickLevel(family.levels, effort || suffix)}`;
    throw Object.assign(new Error(`مدل ${model} روی این حساب آنتی‌گرویتی نیست. مدل‌های این حساب: ${catalog.models.map((m) => m.id).join("، ")}`), { status: 404, code: "model" });
  },
};

const LEVELS = ["low", "medium", "high", "xhigh"];
// Griffin's effort (low … max) onto the levels a family has: the same one, else the nearest below,
// else the lowest. No effort = high, Antigravity's own default.
export function pickLevel(levels, effort) {
  const want = LEVELS.indexOf(effort === "max" ? "xhigh" : effort || "high");
  const sorted = [...levels].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b));
  return sorted.filter((l) => LEVELS.indexOf(l) <= want).at(-1) || sorted[0];
}

/**
 * fetchAvailableModels → what the picker shows: the agent models Antigravity itself offers
 * (agentModelSorts, plus its command model), Gemini only — Claude through Antigravity needs
 * Anthropic's signed thinking replayed, which this engine does not carry — without the ones marked
 * disabled («Unavailable») or internal (no display name: tab_*, sonar, tiered). Effort variants
 * («Gemini 4 Neon (XHigh)» = gemini-4-neon-xhigh) are one model; the chat's effort picks the variant.
 */
export function antigravityCatalog(body) {
  const all = body?.models && typeof body.models === "object" ? body.models : {};
  const offered = [...(body?.agentModelSorts || []).flatMap((s) => (s?.groups || []).flatMap((g) => g?.modelIds || [])), ...(body?.commandModelIds || [])];
  const source = offered.length ? [...new Set(offered)] : Object.keys(all);
  const usable = source.filter((id) => {
    const m = all[id];
    return m && /^gemini-/i.test(id) && m.displayName && !m.disabled && !m.isInternal && !/image|embedding|tts/i.test(id);
  });
  const families = new Map();
  const rows = [];
  for (const id of usable) {
    const name = String(all[id].displayName);
    const level = id.match(/-(low|medium|high|xhigh)$/)?.[1];
    if (!level || !new RegExp(`\\(${level}\\)\\s*$`, "i").test(name)) {
      rows.push({ id, name });
      continue;
    }
    const base = id.slice(0, -level.length - 1);
    let family = families.get(base);
    if (!family) {
      family = { id: base, name: name.replace(/\s*\([^)]*\)\s*$/, ""), levels: [] };
      families.set(base, family);
      rows.push(family);
    }
    family.levels.push(level);
  }
  const byLevel = (a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b);
  // Each model carries its quota (remainingFraction, resetTime); models that share a pool show the same
  // pair (every Gemini at once, 2026-11-23), so one window per pair, named by the models in it.
  // Proto3 JSON omits remainingFraction when it is 0 (100% used), while keeping resetTime.
  const pools = new Map();
  for (const row of rows) {
    const q = all[row.levels ? `${row.id}-${row.levels[0]}` : row.id]?.quotaInfo;
    if (!q) continue;
    const rawFrac = q.remainingFraction;
    const frac = rawFrac != null && Number.isFinite(Number(rawFrac)) ? Math.max(0, Math.min(1, Number(rawFrac))) : q.resetTime ? 0 : null;
    if (frac == null) continue;
    const key = `${frac}|${q.resetTime || ""}`;
    if (!pools.has(key)) pools.set(key, { names: [], frac, resetAt: q.resetTime || null });
    pools.get(key).names.push(row.name);
  }
  const windows = [...pools.values()].map(({ names, frac, resetAt }) => ({
    label: names.length > 2 ? `${names[0]} و ${names.length - 1} مدل دیگر` : names.join(" و "),
    percentage: Math.max(0, Math.min(100, Math.round((1 - frac) * 100))),
    resetAt,
  }));
  return {
    windows,
    models: rows.map((m) => (m.levels ? { id: m.id, name: m.name, efforts: [...m.levels].sort(byLevel) } : m)),
    families,
    ids: new Set(usable),
    defaultId: body?.defaultAgentModelId || null,
  };
}

async function fetchAntigravityQuotaSummary(grant, { baseUrl, fetchImpl = fetch }) {
  const res = await fetchImpl(`${baseUrl}/v1internal:retrieveUserQuotaSummary`, {
    method: "POST",
    headers: { authorization: `Bearer ${grant.access}`, "content-type": "application/json", "User-Agent": ANTIGRAVITY_USER_AGENT },
    body: JSON.stringify({ project: grant.projectId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw Object.assign(new Error(`antigravity quota summary http ${res.status}`), { status: res.status });
  return antigravityQuotaSummary(await res.json());
}

function summaryWindowKind(bucket, resetAt, now) {
  const hint = [bucket?.window, bucket?.windowType, bucket?.window_type, bucket?.displayName, bucket?.display_name, bucket?.bucketId, bucket?.bucket_id]
    .filter(Boolean)
    .join(" ");
  if (/5[-_\s]?h|five[-_\s]?hour/i.test(hint)) return { kind: "5h", text: "۵ ساعته", order: 1 };
  if (/daily|24[-_\s]?h|1[-_\s]?d/i.test(hint)) return { kind: "daily", text: "روزانه", order: 2 };
  if (/week|7[-_\s]?d/i.test(hint)) return { kind: "weekly", text: "هفتگی", order: 3 };
  const ms = resetAt ? Date.parse(resetAt) - now : NaN;
  if (Number.isFinite(ms) && ms > 0) {
    if (ms <= 5.5 * 3600_000) return { kind: "5h", text: "۵ ساعته", order: 1 };
    if (ms <= 25 * 3600_000) return { kind: "daily", text: "روزانه", order: 2 };
    return { kind: "weekly", text: "هفتگی", order: 3 };
  }
  const fallback = String(bucket?.displayName || bucket?.display_name || bucket?.window || "").trim();
  return { kind: fallback.toLowerCase() || "other", text: fallback || "سهمیه", order: 4 };
}

/**
 * retrieveUserQuotaSummary → per-pool 5-hour & weekly quota windows (Gemini shared pool + separate
 * Argon pool). Skips disabled groups/buckets and non-Gemini pools (Claude/GPT) that Griffin does not
 * expose on Antigravity. Handles proto3 zero-omission (missing remainingFraction with resetTime = 0).
 */
export function antigravityQuotaSummary(body, now = Date.now()) {
  const container = body?.quotaSummary || body?.quota_summary || body;
  const groups = container?.groups || container?.quotaGroups || container?.quota_groups;
  const topBuckets = container?.buckets || container?.quotaBuckets || container?.quota_buckets;
  const raw = [];
  if (Array.isArray(groups)) {
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i];
      if (!g || typeof g !== "object" || g.disabled) continue;
      const gName = String(g.displayName || g.display_name || g.name || g.groupId || g.group_id || g.id || "").trim();
      const bs = g.buckets || g.quotaBuckets || g.quota_buckets || [];
      if (!Array.isArray(bs)) continue;
      for (const b of bs) raw.push({ b, gName, gIdx: i });
    }
  }
  if (Array.isArray(topBuckets)) {
    for (const b of topBuckets) raw.push({ b, gName: "", gIdx: -1 });
  }
  const dedup = new Map();
  let hasSharedGemini = false;
  for (const { b, gName, gIdx } of raw) {
    if (!b || typeof b !== "object" || b.disabled) continue;
    const combinedName = `${gName} ${b.bucketId || b.bucket_id || ""} ${b.displayName || b.display_name || ""}`.trim();
    const isArgon = /\bargon\b/i.test(combinedName);
    const isGemini = /\bgemini\b/i.test(combinedName);
    const isNonGemini = /\b(claude|gpt|anthropic|openai)\b/i.test(combinedName) && !isGemini && !isArgon;
    if (isNonGemini) continue;
    const q = b.quotaInfo || b.quota_info || b.quota || b;
    const resetAt = q.resetTime || q.reset_time || q.resetAt || null;
    const rawFrac = q.remainingFraction ?? q.remaining_fraction ?? q.fractionRemaining;
    const frac = rawFrac != null && Number.isFinite(Number(rawFrac)) ? Math.max(0, Math.min(1, Number(rawFrac))) : resetAt ? 0 : null;
    if (frac == null) continue;
    const win = summaryWindowKind(b, resetAt, now);
    const groupKey = isArgon ? "argon" : isGemini ? "gemini" : gName.toLowerCase() || `g${gIdx}`;
    const groupOrder = isArgon ? 2 : isGemini ? 1 : 3;
    if (groupKey === "gemini") hasSharedGemini = true;
    const label = groupKey === "gemini" ? win.text : groupKey === "argon" ? `Argon ${win.text}` : gName ? `${gName} ${win.text}` : win.text;
    const key = `${groupKey}:${win.kind}`;
    const prev = dedup.get(key);
    if (!prev || frac < prev.frac) {
      dedup.set(key, {
        groupOrder,
        winOrder: win.order,
        frac,
        window: { label, percentage: Math.max(0, Math.min(100, Math.round((1 - frac) * 100))), resetAt },
      });
    }
  }
  const windows = [...dedup.values()]
    .sort((a, b) => a.groupOrder - b.groupOrder || a.winOrder - b.winOrder)
    .map((x) => x.window);
  return { windows, hasSharedGemini };
}

export const PLAN_TRANSPORTS = { codex: codexTransport, antigravity: antigravityTransport };
