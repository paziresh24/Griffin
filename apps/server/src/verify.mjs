// Maker/checker separation (harness-engineering's structural fix — "a model is its own output's
// best defense attorney"): when a run in a teammate / peer / unattended chat finishes, the
// read-only probes its final report leaned on are re-executed OUTSIDE the model — no context, no
// LLM, deterministic — and the stable parts are compared with what the run recorded. Agreement is
// one timeline event; a mismatch is injected as a system line so the agent's NEXT turn corrects
// the record with the person it reported to. Read-only probes only; GRIFFIN_VERIFY=off disables.

const PROBES = ["http_check", "dns_lookup"];
const VERIFY_CALLERS = (caller) => caller === "team" || caller === "scheduler" || caller === "ops" || String(caller || "").startsWith("peer:");
const MAX_PROBES = 5;
const CALL_MS = 20_000;

// The stable part of a probe's answer — everything volatile (timings, ms, headers beyond status)
// is deliberately dropped so a healthy re-check never false-alarms.
function signature(name, raw) {
  if (name === "http_check") return `status=${raw?.status ?? "none"}${raw?.error ? ` error=${raw.error}` : ""}`;
  if (name === "dns_lookup") return `records=${[...(raw?.records || [])].sort().join("|")}${raw?.error ? ` error=${raw.error}` : ""}`;
  return null;
}

// Events hold the SDK shape ({status, value:{content:[{text:JSON}]}}); the broker returns the raw
// execute() value. Accept both (and the plain object), tolerate non-JSON text.
function rawOf(result) {
  const value = result?.value ?? result;
  const text = value?.content?.[0]?.text;
  if (typeof text === "string") {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* plain text result */
    }
  }
  return value && typeof value === "object" ? value : {};
}

function probeKey(name, args) {
  const src = { ...(args || {}) };
  delete src.why;
  try {
    return `${name}\u0000${JSON.stringify(src)}`;
  } catch {
    return `${name}\u0000${String(args)}`;
  }
}

export function createVerifier({
  store,
  callTool,
  runner,
  log = console,
  probes = PROBES,
  mayVerifyCaller = VERIFY_CALLERS,
  enabled = () => process.env.GRIFFIN_VERIFY !== "off",
} = {}) {
  async function callWithTimeout(name, args) {
    return Promise.race([
      callTool(name, args),
      new Promise((_r, reject) => setTimeout(() => reject(new Error("verify timeout")), CALL_MS)),
    ]);
  }

  /**
   * Re-check the probes of the LAST finished run in this chat. Returns a small summary object
   * (also {skipped: reason} shapes) so tests and callers can assert without parsing logs.
   */
  async function verifyFinishedRun(chatId) {
    try {
      if (!enabled()) return { skipped: "off" };
      const chat = store.getChat?.(chatId);
      if (!mayVerifyCaller(chat?.caller)) return { skipped: "caller" };
      if (typeof runner?.isActive === "function" && runner.isActive(chatId)) return { skipped: "active" };

      const lastId = store.lastEventId?.(chatId) ?? 0;
      const events = (store.eventsAfter?.(chatId, Math.max(0, lastId - 4000), 4000) || []);
      // Only the last run: drop everything before its run.started.
      let start = 0;
      for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].type === "run.started") { start = i; break; }
      const run = events.slice(start);
      const runId = run.find((e) => e.type === "run.started")?.runId || null;

      const last = new Map(); // probeKey -> {name, args, raw, sig}
      for (const event of run) {
        if (event.type !== "tool.done") continue;
        const data = event.data || {};
        if (!probes.includes(data.name) || data.result?.status !== "success") continue;
        const raw = rawOf(data.result);
        const sig = signature(data.name, raw);
        if (sig == null) continue;
        last.set(probeKey(data.name, data.args), { name: data.name, args: data.args || {}, raw, sig });
      }
      const checks = [...last.values()].slice(0, MAX_PROBES);
      if (!checks.length) return { skipped: "no-probes" };

      const results = [];
      const mismatches = [];
      for (const check of checks) {
        let fresh;
        try {
          fresh = await callWithTimeout(check.name, check.args);
        } catch (error) {
          results.push({ name: check.name, args: check.args, verified: false, reason: `re-check failed: ${error?.message || error}` });
          continue;
        }
        const sig = signature(check.name, rawOf({ value: fresh }));
        const verified = sig === check.sig;
        results.push({ name: check.name, args: check.args, verified, was: check.sig, now: sig });
        if (!verified) mismatches.push(results.at(-1));
      }

      if (mismatches.length) {
        store.appendEvent?.(chatId, runId, "run.phase", {
          phase: "verify-mismatch",
          note: mismatches.map((m) => `${m.name}: ${m.was} → ${m.now}`).join(" · ").slice(0, 500),
        });
        const lines = mismatches
          .map((m) => `- ${m.name} ${m.args?.url || m.args?.name || ""}: موقع گزارش ${m.was}، الان ${m.now}`)
          .join("\n");
        const text =
          `[راستی‌آزمایی خودکار — این پیام را سیستم فرستاده، نه Owner]\n` +
          `ادعای پایان کارِ همین رند با وضعیت فعلی سیستم نمی‌خواند:\n${lines}\n` +
          `به کسی که کار را گزارش کردی یک خط اصلاح بفرست؛ ادعای قبلی را تکرار نکن و اگر ریشه‌اش را می‌دانی بگو.`;
        await runner.send(chatId, { text, images: [], intent: "queue" });
        log.error?.(`[verify] chat ${chatId}: ${mismatches.length}/${checks.length} probe(s) drifted — correction queued`);
      } else {
        store.appendEvent?.(chatId, runId, "run.phase", { phase: "verified", note: `${checks.length} probe(s) re-checked, unchanged` });
      }
      return { checks: results.length, mismatches: mismatches.length };
    } catch (error) {
      log.error?.(`[verify] chat ${chatId}: ${error?.message || error}`);
      return { skipped: "error" };
    }
  }

  return { verifyFinishedRun };
}
