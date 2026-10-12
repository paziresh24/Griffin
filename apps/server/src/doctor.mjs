import fs from "node:fs";
import { kindOf } from "./providers/ids.mjs";

// Self-check and self-repair. Born from a fresh install where a Claude subscription token went in
// as an API key, health said ok, and every run finished empty. The doctor probes each engine for real, reads the last runs, and
// knows a few safe fixes; heal() applies the ones that cannot make things worse on its own.
//
// Titles are fixed Persian strings with {vars} (the web UI translates them); `detail` is raw text.

const RECENT_ERRORS = [];
let consoleHooked = false;
// The last distinct console.error lines — what an operator would grep the logs for.
export function hookConsoleErrors(max = 60) {
  if (consoleHooked) return;
  consoleHooked = true;
  const original = console.error.bind(console);
  console.error = (...args) => {
    const line = args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 400);
    const last = RECENT_ERRORS[RECENT_ERRORS.length - 1];
    if (last?.line === line) last.count += 1;
    else RECENT_ERRORS.push({ at: new Date().toISOString(), line, count: 1 });
    if (RECENT_ERRORS.length > max) RECENT_ERRORS.shift();
    original(...args);
  };
}
export const recentErrors = () => RECENT_ERRORS.slice();

// Why an engine call failed, from its status and text. Order matters: a 403 that names a region
// is a region block, not a bad key.
export function classifyEngineError({ status = 0, text = "", network = false } = {}) {
  const t = String(text);
  if (network || /timeout|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|socket hang up|certificate/i.test(t)) return "network";
  if (/region|country|territor|not available in your|unsupported_country|sanction/i.test(t)) return "region";
  if (status === 402 || /quota|credit|insufficient|balance|usage limit|hit your limit/i.test(t)) return "quota";
  // Too many requests right now: the key works, the engine is just busy.
  if (status === 429 || /rate limit|too many requests|concurren/i.test(t)) return "busy";
  if (status === 401 || /invalid[ _-]?(api[ _-]?)?key|unauthori[sz]ed|authentication|invalid x-api-key|invalid bearer/i.test(t)) return "bad_key";
  if (status === 404 || /model.*(not found|does not exist|unknown)|unknown model/i.test(t)) return "model";
  if (status === 403) return "forbidden";
  return "other";
}

export const CAUSE_ADVICE = {
  no_key: "کلیدی برای این موتور نیست",
  bad_key: "کلید رد شد (نامعتبر یا منقضی)",
  region: "سرویس از این کشور/IP جواب نمی‌دهد — یک پراکسی خروجی لازم است",
  network: "سرور به این موتور نمی‌رسد (شبکه/DNS/فیلتر) — پراکسی خروجی را چک کن",
  quota: "سهمیه یا اعتبار این موتور تمام شده",
  model: "این مدل یا آدرس پایه پیدا نشد",
  forbidden: "دسترسی رد شد (۴۰۳)",
  other: "خطای ناشناخته",
};
// Causes that do not go away by waiting: an agent on such an engine is moved without asking.
const PERSISTENT = new Set(["no_key", "bad_key", "region", "model"]);

const isOAuth = (key) => String(key || "").startsWith("sk-ant-oat");

export function createDoctor({ store, runner, providers, providerKey, providerConfig, openaiBaseUrl = () => "", engineIds, dataDir, integrations = null, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  async function call(url, init, timeoutMs = 15_000) {
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = response.ok ? "" : (await response.text().catch(() => "")).slice(0, 400);
      return { status: response.status, ok: response.ok, text };
    } catch (error) {
      return { status: 0, ok: false, text: error?.name === "TimeoutError" ? "timeout" : String(error?.cause?.code || error?.message || error), network: true };
    }
  }

  // A real call per engine — reachability alone said «ok» for a rejected key.
  async function probeEngine(id) {
    const started = now();
    const key = providerKey(id);
    const config = providerConfig(id) || {};
    const done = (fields) => ({ id, hasKey: Boolean(key), ms: now() - started, ...fields });
    if (!key) return done({ ok: false, cause: "no_key" });
    let r;
    // Several accounts share a kind (claude, claude-2 …): branch on the kind, keep the account's own key.
    const kind = kindOf(id) || id;
    if (kind === "openai") {
      const base = String(config.baseUrl || openaiBaseUrl() || "https://api.openai.com/v1").replace(/\/+$/, "");
      const model = config.model || providers[id]?.defaultModel;
      if (!model) return done({ ok: false, cause: "model", detail: "no default model" });
      r = await call(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
      }, 30_000);
    } else if (kind === "claude") {
      r = await call("https://api.anthropic.com/v1/models", {
        headers: {
          ...(isOAuth(key) ? { authorization: `Bearer ${key}`, "anthropic-beta": "oauth-2025-04-20" } : { "x-api-key": key }),
          "anthropic-version": "2023-06-01",
        },
      });
    } else {
      try {
        const list = await providers[id].listModels();
        r = list?.length ? { ok: true, status: 200 } : { ok: false, status: 0, text: "no models returned" };
      } catch (error) {
        r = { ok: false, status: Number(error?.status) || 0, text: String(error?.message || error) };
      }
    }
    if (r.ok) return done({ ok: true, status: r.status });
    const cause = classifyEngineError(r);
    if (cause === "busy") return done({ ok: true, busy: true, status: r.status, detail: r.text });
    return done({ ok: false, status: r.status, cause, detail: r.text });
  }

  async function probeEngines() {
    return Promise.all(engineIds.map((id) => probeEngine(id).catch((error) => ({ id, ok: false, cause: "other", detail: String(error?.message || error) }))));
  }

  // Runs whose root is a person or a job, newest first: errors and «finished with nothing».
  function recentRuns(limit = 30) {
    // node:sqlite is synchronous: a scan of a large events table froze the whole app for minutes.
    // Runs come from the runs index; output is probed per run through the chat index with LIMIT 1.
    const rows = store.db.prepare(
      `SELECT r.id, r.chat_id, r.status, r.error, r.started_at
         FROM runs r JOIN chats c ON c.id = r.chat_id
        WHERE r.status != 'running' AND c.parent_chat_id IS NULL
        ORDER BY r.started_at DESC LIMIT ?`,
    ).all(limit);
    const output = store.db.prepare("SELECT 1 FROM events WHERE chat_id = ? AND run_id = ? AND type IN ('text','tool.started') LIMIT 1");
    return rows.map((row) => ({ ...row, empty: row.status === "finished" && !output.get(row.chat_id, row.id) }));
  }

  function stuckRuns(maxMs = 45 * 60_000) {
    const cutoff = new Date(now() - maxMs).toISOString();
    return store.db.prepare("SELECT id, chat_id, started_at FROM runs WHERE status = 'running' AND started_at < ?").all(cutoff);
  }

  function diskFree() {
    try {
      const s = fs.statfsSync(dataDir);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  async function report() {
    const engines = await probeEngines();
    const working = engines.filter((e) => e.ok).map((e) => e.id);
    const checks = [];
    const add = (check) => checks.push({ level: "ok", ...check });

    if (!working.length) {
      add({ id: "engines", level: "error", title: "هیچ موتوری کار نمی‌کند — ایجنت‌ها نمی‌توانند جواب بدهند", fix: { id: "wizard", title: "راه‌اندازی موتور", manual: true } });
    }
    for (const e of engines) {
      if (e.ok) add({ id: `engine:${e.id}`, title: "موتور {engine} سالم است", vars: { engine: e.id } });
      else if (e.cause !== "no_key") add({ id: `engine:${e.id}`, level: "error", title: "موتور {engine}: {why}", vars: { engine: e.id, why: CAUSE_ADVICE[e.cause] || e.cause }, detail: e.detail, cause: e.cause });
    }

    // Agents on an engine that does not answer.
    for (const profile of store.listAgentProfiles()) {
      const engine = engines.find((e) => e.id === profile.provider);
      const moved = store.getKv(`doctor:moved:${profile.id}`);
      if (moved && moved !== profile.provider && engines.find((e) => e.id === moved)?.ok) {
        add({ id: `agent:${profile.id}`, level: "warn", title: "ایجنت {agent} موقتاً روی {engine} است؛ موتور اصلی‌اش ({original}) دوباره سالم است", vars: { agent: profile.label || profile.id, engine: profile.provider, original: moved }, fix: { id: `restore:${profile.id}`, title: "برگرداندن به {original}", vars: { original: moved }, auto: true } });
        continue;
      }
      if (!engine || engine.ok) continue;
      const target = working[0];
      add({
        id: `agent:${profile.id}`,
        level: "error",
        title: "ایجنت {agent} روی {engine} است که کار نمی‌کند",
        vars: { agent: profile.label || profile.id, engine: profile.provider },
        ...(target ? { fix: { id: `switch:${profile.id}:${target}`, title: "انتقال به {target}", vars: { target }, auto: PERSISTENT.has(engine.cause) } } : {}),
      });
    }

    // Plan-limit marks on engines that answer now.
    for (const e of engines) {
      const until = Number(store.getKv(`limited:${e.id}`) || 0);
      if (e.ok && until > now()) add({ id: `limit:${e.id}`, level: "warn", title: "موتور {engine} «سقف پر» علامت خورده ولی الان جواب می‌دهد", vars: { engine: e.id }, fix: { id: `clear_limit:${e.id}`, title: "برداشتن علامت سقف" } });
    }

    const runs = recentRuns();
    const failed = runs.filter((r) => r.status === "error" || r.empty);
    // Half the recent runs failed, or the very last one did (a fresh install has one run).
    if (failed.length && (failed.length / runs.length >= 0.5 || failed[0] === runs[0])) {
      const sample = failed.find((r) => r.error)?.error;
      add({ id: "runs", level: failed.length / runs.length >= 0.5 ? "error" : "warn", title: "{failed} از {total} ران اخیر خطا دادند یا خالی تمام شدند", vars: { failed: failed.length, total: runs.length }, detail: sample ? String(sample).slice(0, 400) : "runs finished with no output" });
    } else if (runs.length) add({ id: "runs", title: "ران‌های اخیر سالم‌اند" });

    const stuck = stuckRuns();
    if (stuck.length) add({ id: "stuck", level: "warn", title: "{count} ران بیش از ۴۵ دقیقه است در جریان است", vars: { count: stuck.length }, fix: { id: "cancel_stuck", title: "متوقف کردن ران‌های گیرکرده", auto: true } });

    for (const i of integrations?.list?.() || []) {
      if (!i.enabled) continue;
      const state = i.status?.state;
      if (state === "error" || state === "unavailable" || state === "stopped") {
        const relogin = i.kind === "telegram_account" && /AUTH_KEY|SESSION|login/i.test(String(i.status?.error || ""));
        add({ id: `integration:${i.id}`, level: "warn", title: "اتصال {name} وصل نیست ({state})", vars: { name: i.name, state }, detail: i.status?.error || null, fix: relogin ? { id: "relogin", title: "ورود دوباره در تنظیمات → اتصال‌ها", manual: true } : { id: `restart:${i.id}`, title: "وصل کردن دوباره" } });
      }
    }

    const free = diskFree();
    if (free != null && free < 1024 ** 3) add({ id: "disk", level: free < 200 * 1024 ** 2 ? "error" : "warn", title: "فضای دیسک داده کم است: {mb} مگابایت", vars: { mb: Math.round(free / 1024 ** 2) } });

    const level = checks.some((c) => c.level === "error") ? "error" : checks.some((c) => c.level === "warn") ? "warn" : "ok";
    const result = { at: new Date(now()).toISOString(), level, engines, checks, errors: recentErrors().slice(-15) };
    store.setKv("doctor:last", JSON.stringify({ at: result.at, level }));
    return result;
  }

  async function fix(fixId) {
    const [kind, a, b] = String(fixId).split(":");
    if (kind === "switch" && a && b) {
      const profile = store.getAgentProfile(a);
      if (!profile) throw new Error(`unknown agent ${a}`);
      if (!engineIds.includes(b)) throw new Error(`unknown engine ${b}`);
      if (!store.getKv(`doctor:moved:${a}`)) store.setKv(`doctor:moved:${a}`, profile.provider);
      store.updateAgentProfile(a, { provider: b, model: null });
      return { ok: true, done: `agent ${a}: ${profile.provider} → ${b}` };
    }
    if (kind === "restore" && a) {
      const original = store.getKv(`doctor:moved:${a}`);
      if (!original) throw new Error("nothing to restore");
      store.updateAgentProfile(a, { provider: original, model: null });
      store.deleteKv(`doctor:moved:${a}`);
      return { ok: true, done: `agent ${a} back on ${original}` };
    }
    if (kind === "clear_limit" && a) {
      store.deleteKv(`limited:${a}`);
      return { ok: true, done: `limit mark cleared on ${a}` };
    }
    if (kind === "cancel_stuck") {
      const stuck = stuckRuns();
      for (const run of stuck) await runner.cancel(run.chat_id, { user: false }).catch(() => {});
      await runner.sweepStale?.().catch(() => {});
      return { ok: true, done: `${stuck.length} stuck run(s) cancelled` };
    }
    if (kind === "restart" && a && integrations) {
      integrations.update(a, { enabled: false });
      integrations.update(a, { enabled: true });
      return { ok: true, done: `integration ${a} restarted` };
    }
    throw new Error(`unknown fix: ${fixId}`);
  }

  // The fixes marked auto: an agent off a dead engine, back once it heals, and stuck runs.
  async function heal() {
    const r = await report();
    const applied = [];
    for (const check of r.checks) {
      if (!check.fix?.auto) continue;
      try {
        applied.push((await fix(check.fix.id)).done);
      } catch (error) {
        console.error(`[doctor] ${check.fix.id}: ${error.message}`);
      }
    }
    if (applied.length) {
      console.log(`[doctor] healed: ${applied.join("; ")}`);
      const log = JSON.parse(store.getKv("doctor:healed") || "[]");
      store.setKv("doctor:healed", JSON.stringify([...log, ...applied.map((done) => ({ at: r.at, done }))].slice(-50)));
      return { ...(await report()), applied };
    }
    return { ...r, applied };
  }

  // Agent-facing: the owner's agent can look at its own health and repair it.
  const tools = {
    self_check: {
      description:
        "Check Griffin's own health for real: each engine (live call; why it fails — bad key, region block, network, quota), agents on a dead engine, recent failed/empty runs, stuck runs, messenger connections, disk, and the last server errors. Use when something «does not work», before guessing.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const r = await report();
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      },
    },
    self_fix: {
      description:
        "Apply one fix that self_check offered (its fix.id, e.g. switch:<agent>:<engine>, restore:<agent>, clear_limit:<engine>, cancel_stuck, restart:<integration>). Manual fixes (wizard, relogin) need the owner in the UI.",
      inputSchema: { type: "object", properties: { fix: { type: "string" } }, required: ["fix"], additionalProperties: false },
      async execute({ fix: id }) {
        try {
          return { content: [{ type: "text", text: JSON.stringify(await fix(id)) }] };
        } catch (error) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: error.message }) }], isError: true };
        }
      },
    },
  };

  return { report, fix, heal, probeEngine, tools };
}
