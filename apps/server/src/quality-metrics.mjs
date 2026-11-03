// Griffin's service-quality metrics per user (a colleague's list, 2026-10-31): ZTRR, human fallback,
// clarification, MTTH, full delegation, override/abort and complex-task share — read from an
// install's own database, nothing written. Self-contained (node:sqlite only): it is piped into an
// install's container as is, so an older build still gets measured.
//
// A task is a root chat a person started (the owner, a teammate on Telegram, a colleague's agent
// over MCP); its sub-chats (delegate, Agent, consult) count toward it. Jobs, the ops room and e2e
// probes are not people and stay out unless `system` is asked for.
//
// What a human touch is, from what the app records:
// - question: an ask card (ask.pending). To the requester (audience requester, or anything the
//   agent itself asked in the owner's own chat) it is a clarification; a guard card, or an ask to
//   the owner in someone else's chain, is an approval.
// - a run whose last answer ends in «؟» and the person wrote again: a clarification in text.
// - handoff: owner_task (access only a person can give) or a guard decision that sends the work to
//   a person (escalate, peer-card = a method card for the colleague to run, refused, blocked).
// - abort: a run the person stopped (cancelled with no error; a restart's cut has an error text).
// - steer: a message typed while a run was still working (user.queue «started»).
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const HANDOFF_DECISIONS = new Set(["escalate", "peer-card", "refused", "blocked"]);
// Bookkeeping, not a step of the work.
const META_TOOLS = new Set(["ToolSearch", "TodoWrite", "todo_write", "updateTodos", "update_todos"]);
const TODO_TOOLS = new Set(["TodoWrite", "todo_write", "updateTodos", "update_todos"]);
export const COMPLEX_STEPS = 5;
const QUESTION_END = /[؟?]\s*[*_)»"']*\s*$/;

const tableHas = (db, table, column) => db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column) != null;
const tableExists = (db, table) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;

// Who a chat's caller is as a person. null = not a person (jobs, ops, internal agents, probes).
export function personOf(chat) {
  const caller = String(chat.caller || "owner");
  if (chat.job_id) return null;
  if (caller === "owner") return { key: "owner", kind: "owner" };
  if (caller === "team") return { key: `team:${chat.person_id || "?"}`, kind: "team", personId: chat.person_id || null };
  if (caller.startsWith("peer:")) {
    const id = caller.slice(5);
    if (/^e2e-/.test(id)) return null;
    return { key: caller, kind: id.startsWith("net-") ? "network" : "peer", peerId: id };
  }
  return null;
}

const systemOf = (chat) => (chat.job_id ? "job" : ["scheduler", "ops"].includes(chat.caller) ? chat.caller : null);

// exclude: user keys left out of the totals (still listed), e.g. a bot that only posts cards.
export function qualityMetrics(db, { since = null, until = null, system = false, complexSteps = COMPLEX_STEPS, exclude = [] } = {}) {
  const cols = ["id", "parent_chat_id", "caller", "person_id", "job_id", "mode"].filter((c) => tableHas(db, "chats", c));
  const pick = (c) => (cols.includes(c) ? c : `NULL AS ${c}`);
  const chats = db.prepare(`SELECT id, created_at, ${["parent_chat_id", "caller", "person_id", "job_id", "mode"].map(pick).join(", ")} FROM chats`).all();
  const byId = new Map(chats.map((c) => [c.id, c]));
  const rootOf = new Map();
  const root = (id) => {
    if (rootOf.has(id)) return rootOf.get(id);
    const seen = new Set();
    let at = byId.get(id);
    while (at?.parent_chat_id && byId.has(at.parent_chat_id) && !seen.has(at.id)) {
      seen.add(at.id);
      at = byId.get(at.parent_chat_id);
    }
    const r = at?.id ?? id;
    rootOf.set(id, r);
    return r;
  };

  const tasks = new Map();
  for (const c of chats) {
    if (c.parent_chat_id && byId.has(c.parent_chat_id)) continue;
    if (since && c.created_at < since) continue;
    if (until && c.created_at >= until) continue;
    const who = personOf(c) || (system && systemOf(c) ? { key: `system:${systemOf(c)}`, kind: "system" } : null);
    if (!who) continue;
    tasks.set(c.id, {
      id: c.id, who, mode: c.mode || "agent", created: c.created_at,
      userMsgs: 0, steps: 0, children: 0, todo: false, clarify: 0, textClarify: 0, approvals: 0, handoffs: 0,
      aborts: 0, steers: 0, lastRun: null, firstTouch: null, stepTimes: [], userTimes: [], runs: [],
    });
  }
  const taskOf = (chatId) => tasks.get(root(chatId)) || null;
  for (const c of chats) if (c.parent_chat_id && byId.has(c.parent_chat_id)) { const t = taskOf(c.id); if (t) t.children += 1; }
  const touch = (t, at) => { if (at && (!t.firstTouch || at < t.firstTouch)) t.firstTouch = at; };

  // Events: only the kinds the metrics read, one pass.
  const ev = db.prepare(`SELECT chat_id, run_id, type, at,
      CASE WHEN type IN ('tool.started') THEN json_extract(data, '$.name') END AS tool,
      CASE WHEN type = 'ask.pending' THEN json_extract(data, '$.audience') END AS audience,
      CASE WHEN type = 'ask.pending' THEN json_extract(data, '$.via') END AS via,
      CASE WHEN type = 'ask.pending' THEN json_extract(data, '$.fromChatId') END AS from_chat,
      CASE WHEN type = 'user.queue' THEN json_extract(data, '$.state') END AS state,
      CASE WHEN type = 'text' THEN substr(rtrim(json_extract(data, '$.text')), -12) END AS tail
    FROM events WHERE type IN ('user', 'tool.started', 'ask.pending', 'user.queue', 'text')${since ? " AND at >= ?" : ""} ORDER BY id`);
  const lastText = new Map(); // run id -> tail of its last text block
  for (const e of since ? ev.iterate(since) : ev.iterate()) {
    const t = taskOf(e.type === "ask.pending" && e.from_chat ? e.from_chat : e.chat_id);
    if (!t) continue;
    const inRoot = root(e.chat_id) === e.chat_id;
    if (e.type === "user") {
      if (inRoot) { t.userMsgs += 1; t.userTimes.push(e.at); }
    } else if (e.type === "tool.started") {
      if (TODO_TOOLS.has(e.tool)) t.todo = true;
      if (META_TOOLS.has(e.tool)) continue;
      t.steps += 1;
      t.stepTimes.push(e.at);
      if (e.tool === "owner_task") { t.handoffs += 1; touch(t, e.at); }
    } else if (e.type === "ask.pending") {
      const toRequester = e.audience === "requester" || (t.who.kind === "owner" && e.via !== "guard");
      if (toRequester) t.clarify += 1;
      else t.approvals += 1;
      touch(t, e.at);
    } else if (e.type === "user.queue") {
      if (inRoot && e.state === "started") { t.steers += 1; touch(t, e.at); }
    } else if (e.type === "text" && e.run_id && inRoot) lastText.set(e.run_id, e.tail || "");
  }

  for (const r of db.prepare(`SELECT id, chat_id, status, error, started_at FROM runs${since ? " WHERE started_at >= ?" : ""} ORDER BY started_at`).all(...(since ? [since] : []))) {
    const t = taskOf(r.chat_id);
    if (!t || root(r.chat_id) !== r.chat_id) continue;
    t.runs.push(r);
    t.lastRun = r;
    if (r.status === "cancelled" && !r.error) { t.aborts += 1; touch(t, r.started_at); }
  }
  // A run that ended on a question and the person wrote again: that was a clarification.
  for (const t of tasks.values()) {
    t.runs.forEach((r, i) => {
      if (r.status !== "finished" || !QUESTION_END.test(lastText.get(r.id) || "")) return;
      const next = t.runs[i + 1];
      if (next && t.userTimes.some((at) => at >= r.started_at && at <= next.started_at)) { t.textClarify += 1; touch(t, next.started_at); }
    });
  }

  if (tableExists(db, "approvals")) {
    for (const a of db.prepare(`SELECT chat_id, decision, at FROM approvals${since ? " WHERE at >= ?" : ""}`).all(...(since ? [since] : []))) {
      if (!a.chat_id || !HANDOFF_DECISIONS.has(a.decision)) continue;
      const t = taskOf(a.chat_id);
      if (!t) continue;
      t.handoffs += 1;
      touch(t, a.at);
    }
  }

  const labels = labelsOf(db);
  const groups = new Map();
  for (const t of tasks.values()) {
    const done = t.lastRun?.status === "finished";
    const asked = t.clarify + t.textClarify + t.approvals;
    t.success = done;
    // Strict: one message and nothing else from a person. «noAsk»: the person may have written again
    // (often a new question in the same chat), but the agent never asked, handed off or got stopped.
    t.noAsk = done && asked === 0 && t.handoffs === 0 && t.aborts === 0 && t.steers === 0;
    t.zeroTouch = t.noAsk && t.userMsgs <= 1;
    t.fallback = t.handoffs > 0;
    t.overridden = t.aborts > 0 || t.steers > 0;
    t.complex = t.steps >= complexSteps || t.children > 0 || t.todo;
    t.stepsBeforeTouch = t.firstTouch ? t.stepTimes.filter((at) => at < t.firstTouch).length : null;
    const g = groups.get(t.who.key) || groups.set(t.who.key, { key: t.who.key, kind: t.who.kind, label: labels(t.who), tasks: [] }).get(t.who.key);
    g.tasks.push(t);
  }
  const rows = [...groups.values()].map((g) => ({ key: g.key, kind: g.kind, label: g.label, ...summarize(g.tasks) })).sort((a, b) => b.tasks - a.tasks);
  const counted = (key, kind) => kind !== "system" && !exclude.includes(key);
  const people = rows.filter((r) => counted(r.key, r.kind));
  const all = [...tasks.values()].filter((t) => counted(t.who.key, t.who.kind));
  // Full delegation is a person's own setting: only where they run their own chats (the install's owner).
  const deciders = people.filter((r) => r.freeShare != null);
  return {
    since, until, complexSteps,
    total: { ...summarize(all), users: people.length, fullDelegationUsers: deciders.length ? round(deciders.filter((r) => r.freeShare >= 0.5).length / deciders.length) : null },
    users: rows,
  };
}

const round = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const rate = (ts, f) => (ts.length ? round(ts.filter(f).length / ts.length) : null);

export function summarize(ts) {
  const touched = ts.filter((t) => t.stepsBeforeTouch != null);
  const handed = ts.filter((t) => t.fallback && t.stepsBeforeTouch != null);
  const own = ts.filter((t) => t.who.kind === "owner");
  return {
    tasks: ts.length,
    ztrr: rate(ts, (t) => t.zeroTouch),
    ztrrNoAsk: rate(ts, (t) => t.noAsk),
    success: rate(ts, (t) => t.success),
    humanFallback: rate(ts, (t) => t.fallback),
    clarificationsPerTask: round(mean(ts.map((t) => t.clarify + t.textClarify)), 2),
    askCardClarificationsPerTask: round(mean(ts.map((t) => t.clarify)), 2),
    approvalsPerTask: round(mean(ts.map((t) => t.approvals)), 2),
    mtthSteps: round(mean(touched.map((t) => t.stepsBeforeTouch)), 1),
    mtthHandoffSteps: round(mean(handed.map((t) => t.stepsBeforeTouch)), 1),
    overrideAbort: rate(ts, (t) => t.overridden),
    aborts: rate(ts, (t) => t.aborts > 0),
    complexShare: rate(ts, (t) => t.complex),
    stepsPerTask: round(mean(ts.map((t) => t.steps)), 1),
    messagesPerTask: round(mean(ts.map((t) => t.userMsgs)), 2),
    freeShare: own.length ? rate(own, (t) => ["agent", "auto"].includes(t.mode)) : null,
  };
}

function labelsOf(db) {
  const persons = new Map();
  if (tableExists(db, "persons")) {
    const fa = tableHas(db, "persons", "fa_name");
    for (const p of db.prepare(`SELECT id, display_name${fa ? ", fa_name" : ""} FROM persons`).all()) persons.set(p.id, p.fa_name || p.display_name);
  }
  const peers = new Map();
  if (tableExists(db, "peer_users")) for (const p of db.prepare("SELECT id, label FROM peer_users").all()) peers.set(p.id, p.label);
  return (who) => {
    if (who.kind === "owner") return "owner";
    if (who.kind === "team") return persons.get(who.personId) || who.key;
    if (who.peerId) return peers.get(who.peerId) || who.peerId;
    return who.key;
  };
}

// CLI: node quality-metrics.mjs [db] [--days N] [--system] [--exclude k1,k2] [--json]; also read from
// stdin by a pipe (`node --input-type=module -`) with QM_DB / QM_DAYS / QM_SYSTEM / QM_EXCLUDE / QM_JSON.
export function main(argv = process.argv.slice(2), env = process.env) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const file = argv.find((a, i) => !a.startsWith("--") && !["--days", "--exclude"].includes(argv[i - 1])) || env.QM_DB || ["/data/griffin.sqlite", "/data/platform.sqlite"].find((f) => existsSync(f)) || "/data/griffin.sqlite";
  const exclude = String(value("exclude") || env.QM_EXCLUDE || "").split(",").filter(Boolean);
  const days = Number(value("days") || env.QM_DAYS || 30);
  const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
  const db = new DatabaseSync(file, { readOnly: true });
  const out = qualityMetrics(db, { since, exclude, system: flag("system") || env.QM_SYSTEM === "1" });
  db.close();
  if (flag("json") || env.QM_JSON === "1") return console.log(JSON.stringify(out));
  const pct = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);
  const line = (r) => [r.label.padEnd(28).slice(0, 28), String(r.tasks).padStart(5), pct(r.ztrr).padStart(5), pct(r.humanFallback).padStart(5), String(r.clarificationsPerTask ?? "-").padStart(5), String(r.mtthSteps ?? "-").padStart(6), pct(r.freeShare).padStart(5), pct(r.overrideAbort).padStart(5), pct(r.complexShare).padStart(5)].join(" ");
  console.log(["user".padEnd(28), "tasks", " ZTRR", " fall", "clar", "  MTTH", " full", " ovr", " cplx"].join(" "));
  for (const r of out.users) console.log(line(r));
  console.log(line({ ...out.total, label: "TOTAL" }));
}

if (import.meta.url === `file://${process.argv[1]}` || [undefined, "-", "[stdin]"].includes(process.argv[1])) main();
