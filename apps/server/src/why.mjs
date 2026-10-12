// «چرا؟»: how one reply came about, read from the run's own events and the review /
// guard decisions recorded for it — no model call. Steps are what happened in order (the tools,
// notes, a message the owner sent mid-run, a review or guard decision, a stalled stream, the end);
// chips are the few things worth a glance; run is what the reply ran on.

const resultText = (result) => {
  const value = result?.value ?? result;
  if (typeof value === "string") return value;
  if (typeof value?.error === "string") return value.error;
  if (Array.isArray(value?.content)) return value.content.map((part) => part?.text || "").join("\n");
  if (typeof value?.text === "string") return value.text;
  return "";
};

const isError = (result) => result?.status === "error" || result?.isError === true;

// Decisions that mean «stopped or asked the owner» stand out; the rest are a quiet line.
const BAD_DECISIONS = new Set(["blocked", "refused", "denied", "vetoed", "review-rejected", "review-upheld"]);

export function explainRun(events, { approvals = [], manifest = null } = {}) {
  const steps = [];
  const chips = new Set();
  const startedAt = new Map();
  const used = new Set();
  const run = { model: null, provider: null, effort: null, retry: false, fallback: false, usage: null };
  for (const event of events || []) {
    const data = event.data || {};
    switch (event.type) {
      case "run.started":
        Object.assign(run, { model: data.model || null, provider: data.provider || null, effort: data.effort || null, retry: Boolean(data.retry), fallback: Boolean(data.fallback) });
        if (data.fallback) chips.add("fallback");
        break;
      case "tool.started":
        if (data.callId && !startedAt.has(data.callId)) startedAt.set(data.callId, event.at);
        break;
      case "tool.done": {
        if (data.sub) break;
        used.add(data.name);
        const status = data.result?.status === "cancelled" ? "cancelled" : isError(data.result) ? "error" : "success";
        const began = startedAt.get(data.callId);
        const durationMs = began && event.at ? Math.max(0, Date.parse(event.at) - Date.parse(began)) : null;
        const last = steps.at(-1);
        if (status === "success" && last?.kind === "tool" && last.status === "success" && last.name === data.name) {
          last.count = (last.count || 1) + 1;
          last.at = event.at || last.at;
          last.durationMs = last.durationMs == null || durationMs == null ? last.durationMs ?? durationMs : last.durationMs + durationMs;
          break;
        }
        steps.push({ kind: "tool", name: data.name || "tool", status, durationMs, at: event.at || null, ...(status === "error" ? { error: resultText(data.result).slice(0, 500) } : {}) });
        break;
      }
      case "note":
        steps.push({ kind: "note", text: data.text || "" });
        break;
      case "user":
        if (data.intent === "steer") {
          chips.add("mid-run-message");
          steps.push({ kind: "message", text: data.text || "" });
        }
        break;
      case "run.phase":
        if (data.phase === "stale" || data.phase === "verified" || data.phase === "verify-mismatch") steps.push({ kind: "phase", phase: data.phase, text: data.note || data.detail || "" });
        break;
      case "usage": {
        const n = (v) => Number(v) || 0;
        const input = n(data.prompt_tokens ?? data.inputTokens ?? data.input_tokens);
        const u = run.usage || { requests: 0, input: 0, output: 0, context: 0 };
        run.usage = { requests: u.requests + 1, input: u.input + input, output: u.output + n(data.completion_tokens ?? data.outputTokens ?? data.output_tokens), context: input || u.context };
        break;
      }
      case "run.finished":
        if (data.status === "error") chips.add("error");
        steps.push({ kind: "end", status: data.status || "finished", ...(data.error ? { error: data.error } : {}) });
        break;
      default:
        break;
    }
  }
  // A decision lands just before the tool's own done; it goes in time order among the steps.
  for (const row of approvals) {
    const bad = BAD_DECISIONS.has(row.decision);
    if (bad) chips.add("stopped");
    if (row.caller === "review") chips.add("reviewed");
    let detail = "";
    try {
      const parsed = row.detail_json ? JSON.parse(row.detail_json) : null;
      detail = typeof parsed === "string" ? parsed : parsed ? JSON.stringify(parsed) : "";
    } catch {
      detail = String(row.detail_json || "");
    }
    const step = { kind: "decision", tool: row.tool, decision: row.decision, by: row.caller, bad, text: detail.slice(0, 1000), at: row.at };
    const index = steps.findIndex((s) => s.at && s.at > row.at);
    if (index < 0) steps.splice(steps.at(-1)?.kind === "end" ? steps.length - 1 : steps.length, 0, step);
    else steps.splice(index, 0, step);
  }
  const available = manifest?.tools || [];
  return {
    run,
    chips: [...chips],
    steps,
    tools: { available: available.length, used: [...used], unused: available.filter((name) => !used.has(name)) },
  };
}
