// Built-in node:sqlite: no native module to build or download on the capsule.
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_AGENT } from "./agents/registry.mjs";
import { seedProfilesFromRegistry, unique } from "./agents/profiles.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  agent_id TEXT,
  model TEXT,
  mode TEXT NOT NULL DEFAULT 'agent',
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  sdk_run_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_chat ON runs(chat_id, started_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  run_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_chat ON events(chat_id, id);
CREATE TABLE IF NOT EXISTS charts (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  meta TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS charts_chat ON charts(chat_id, created_at);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  mime_type TEXT NOT NULL,
  data BLOB NOT NULL,
  meta TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_chat ON media(chat_id, created_at);
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS shares_chat ON shares(chat_id);
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  secret TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'telegram',
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  username TEXT,
  category TEXT NOT NULL DEFAULT 'unclassified',
  access_json TEXT NOT NULL DEFAULT '{}',
  boundaries TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  history_json TEXT NOT NULL DEFAULT '[]',
  meta_json TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS persons_updated ON persons(updated_at);

CREATE TABLE IF NOT EXISTS integration_links (
  integration_id TEXT NOT NULL REFERENCES integrations(id),
  external_chat TEXT NOT NULL,
  chat_id TEXT REFERENCES chats(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (integration_id, external_chat)
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  mode TEXT NOT NULL DEFAULT 'agent',
  agent TEXT NOT NULL DEFAULT 'platform',
  trigger_type TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT '{}',
  delivery TEXT NOT NULL DEFAULT '{}',
  options TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  chat_id TEXT REFERENCES chats(id),
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  summary TEXT,
  delivery TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs(job_id, started_at);
CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  blurb TEXT NOT NULL DEFAULT '',
  -- what this agent is, in its own words: appended to the shared core rules on every run
  instructions TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'cursor',
  model TEXT,
  tools_json TEXT NOT NULL DEFAULT '[]',
  meta_json TEXT NOT NULL DEFAULT '{}',
  built_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Append-only audit of gated (irreversible) tool calls: who asked, what, and the decision.
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  chat_id TEXT,
  caller TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  decision TEXT NOT NULL,
  approver TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS approvals_at ON approvals(at);
-- External agents (A2A / MCP). Identity is the person (user); each device/agent is a client with
-- its own revocable token. Only the SHA-256 of a token is stored.
CREATE TABLE IF NOT EXISTS peer_users (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS peer_clients (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS peer_clients_user ON peer_clients(user_id);
-- Every JSON-RPC call an external agent makes over /mcp (bounded ring, no argument values).
-- Without it "Griffin never answered" is undiagnosable: a client that only ever handshakes, a
-- tool name we do not know, or a call that failed before a task row existed leaves no trace.
CREATE TABLE IF NOT EXISTS peer_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT,
  method TEXT NOT NULL,
  tool TEXT,
  arg_keys TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS peer_calls_user ON peer_calls(user_id, id);
-- A unit of work an external agent asked for (A2A Task). context = chat; the task's events are
-- the chat events after start_event_id. Terminal state is persisted once observed.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT,
  caller TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT,
  start_event_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  state_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_message ON tasks(user_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_chat ON tasks(chat_id, created_at);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, created_at);
`;

const now = () => new Date().toISOString();
// Bounded MCP call log: enough to debug a peer's client, never a growing archive.
const PEER_CALLS_KEEP = 5_000;

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // Chats a job created: kept out of the sidebar and listed under the job instead.
  if (!db.prepare("PRAGMA table_info(chats)").all().some((c) => c.name === "job_id")) {
    db.exec("ALTER TABLE chats ADD COLUMN job_id TEXT");
  }
  // Who the agent is talking to (owner / another agent / scheduler) and which agent persona.
  // Distinct from agent_id, which is the Cursor SDK agent handle.
  if (!db.prepare("PRAGMA table_info(chats)").all().some((c) => c.name === "person_id")) {
    db.exec("ALTER TABLE chats ADD COLUMN person_id TEXT");
  }
  if (!db.prepare("PRAGMA table_info(chats)").all().some((c) => c.name === "caller")) {
    db.exec("ALTER TABLE chats ADD COLUMN caller TEXT NOT NULL DEFAULT 'owner'");
  }
  if (!db.prepare("PRAGMA table_info(chats)").all().some((c) => c.name === "agent")) {
    db.exec("ALTER TABLE chats ADD COLUMN agent TEXT NOT NULL DEFAULT 'platform'");
  }
  // Peer-call child chats (ask_agent): hidden from the sidebar; ask_owner routes to the root.
  if (!db.prepare("PRAGMA table_info(chats)").all().some((c) => c.name === "parent_chat_id")) {
    db.exec("ALTER TABLE chats ADD COLUMN parent_chat_id TEXT");
  }
  if (!db.prepare("PRAGMA table_info(chats)").all().some((c) => c.name === "call_chain")) {
    db.exec("ALTER TABLE chats ADD COLUMN call_chain TEXT");
  }
  // Agents that have actually run in this root chat (persona + ask_agent peers).
  if (!db.prepare("PRAGMA table_info(chats)").all().some((c) => c.name === "agents_worked")) {
    db.exec("ALTER TABLE chats ADD COLUMN agents_worked TEXT");
  }
  // Runtime backend: cursor (@cursor/sdk) or claude (Claude Agent SDK). Immutable after first run
  // unless the owner switches it (clears agent_id like agent switch).
  if (!db.prepare("PRAGMA table_info(chats)").all().some((c) => c.name === "provider")) {
    db.exec("ALTER TABLE chats ADD COLUMN provider TEXT NOT NULL DEFAULT 'cursor'");
  }
  // Which agent persona runs a scheduled job (immutable per run chat; editable on the job).
  if (!db.prepare("PRAGMA table_info(jobs)").all().some((c) => c.name === "agent")) {
    db.exec("ALTER TABLE jobs ADD COLUMN agent TEXT NOT NULL DEFAULT 'platform'");
  }

  // One emitter for everything: "chat:<id>" carries events, "chats" carries list changes.
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  const q = {
    insertChat: db.prepare(
      "INSERT INTO chats (id, title, model, mode, job_id, caller, agent, parent_chat_id, call_chain, person_id, provider, created_at, updated_at) VALUES (@id, @title, @model, @mode, @jobId, @caller, @agent, @parentChatId, @callChain, @personId, @provider, @at, @at)",
    ),
    getChat: db.prepare("SELECT * FROM chats WHERE id = ?"),
    listChats: db.prepare(`
      SELECT c.*, r.status AS run_status, r.started_at AS run_started_at
      FROM chats c
      LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE chat_id = c.id ORDER BY started_at DESC LIMIT 1)
      WHERE c.archived = @archived AND c.job_id IS NULL AND c.parent_chat_id IS NULL AND (c.caller IS NULL OR c.caller <> 'team')
      ORDER BY c.pinned DESC, c.updated_at DESC
      LIMIT 500`),
    listChildChats: db.prepare("SELECT id FROM chats WHERE parent_chat_id = ?"),
    // Peer-call child chats (ask_agent/delegate) with their latest run status, for the sidebar nest.
    childChatsWithStatus: db.prepare(`
      SELECT c.*, r.status AS run_status, r.started_at AS run_started_at
      FROM chats c
      LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE chat_id = c.id ORDER BY started_at DESC LIMIT 1)
      WHERE c.parent_chat_id IS NOT NULL
      ORDER BY c.created_at DESC
      LIMIT 1000`),
    touchChat: db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?"),
    setAgent: db.prepare("UPDATE chats SET agent_id = ? WHERE id = ?"),
    setAgentsWorked: db.prepare("UPDATE chats SET agents_worked = ? WHERE id = ?"),
    listChildAgents: db.prepare("SELECT DISTINCT agent FROM chats WHERE parent_chat_id = ? AND agent IS NOT NULL"),
    insertEvent: db.prepare(
      "INSERT INTO events (chat_id, run_id, type, data, at) VALUES (?, ?, ?, ?, ?)",
    ),
    eventsAfter: db.prepare(
      "SELECT id, run_id, type, data, at FROM events WHERE chat_id = ? AND id > ? ORDER BY id LIMIT ?",
    ),
    insertRun: db.prepare(
      "INSERT INTO runs (id, chat_id, status, started_at) VALUES (?, ?, 'running', ?)",
    ),
    setSdkRun: db.prepare("UPDATE runs SET sdk_run_id = ? WHERE id = ?"),
    finishRun: db.prepare("UPDATE runs SET status = ?, error = ?, ended_at = ? WHERE id = ?"),
    runningRuns: db.prepare("SELECT * FROM runs WHERE status = 'running'"),
    getKv: db.prepare("SELECT value FROM kv WHERE key = ?"),
    setKv: db.prepare(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
  };

  const rowToEvent = (row) => ({
    id: row.id,
    runId: row.run_id,
    type: row.type,
    data: JSON.parse(row.data),
    at: row.at,
  });

  const store = {
    db,
    bus,

    createChat({
      title,
      model = null,
      mode = "agent",
      jobId = null,
      caller = "owner",
      agent = DEFAULT_AGENT,
      parentChatId = null,
      callChain = null,
      personId = null,
      provider = "cursor",
    }) {
      const chat = {
        id: randomUUID(),
        title: title.slice(0, 120),
        model,
        mode,
        jobId,
        caller: caller || "owner",
        agent: agent || DEFAULT_AGENT,
        parentChatId: parentChatId || null,
        callChain: callChain == null ? null : (typeof callChain === "string" ? callChain : JSON.stringify(callChain)),
        personId: personId || null,
        provider: provider === "claude" ? "claude" : "cursor",
        at: now(),
      };
      q.insertChat.run(chat);
      // Peer children stay out of the sidebar (same idea as job chats).
      if (!chat.parentChatId) bus.emit("chats", { type: "created", chatId: chat.id });
      return store.getChat(chat.id);
    },

    // Walk parent_chat_id to the owner-facing root (for ask_owner routing).
    rootChatId(chatId) {
      let id = chatId;
      const seen = new Set();
      while (id && !seen.has(id)) {
        seen.add(id);
        const chat = q.getChat.get(id);
        if (!chat?.parent_chat_id) return id;
        id = chat.parent_chat_id;
      }
      return chatId;
    },

    listChildChatIds(parentChatId) {
      return q.listChildChats.all(parentChatId).map((row) => row.id);
    },
    listChatsForPerson(personId, { archived = false } = {}) {
      return db.prepare(`SELECT c.*, r.status AS run_status, r.started_at AS run_started_at FROM chats c LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE chat_id = c.id ORDER BY started_at DESC LIMIT 1) WHERE c.person_id = ? AND c.archived = ? ORDER BY c.updated_at DESC LIMIT 200`).all(String(personId), archived ? 1 : 0).map((row) => ({ ...row }));
    },

    // Everything that hangs off a chat, for job retention and job deletion.
    deleteChat(id) {
      for (const childId of store.listChildChatIds(id)) store.deleteChat(childId);
      for (const sql of [
        "DELETE FROM integration_links WHERE chat_id = ?",
        "DELETE FROM shares WHERE chat_id = ?",
        "DELETE FROM media WHERE chat_id = ?",
        "DELETE FROM charts WHERE chat_id = ?",
        "DELETE FROM events WHERE chat_id = ?",
        "DELETE FROM runs WHERE chat_id = ?",
        "UPDATE job_runs SET chat_id = NULL WHERE chat_id = ?",
      ]) db.prepare(sql).run(id);
      const changes = db.prepare("DELETE FROM chats WHERE id = ?").run(id).changes;
      if (changes) bus.emit("chats", { type: "deleted", chatId: id });
      return changes;
    },

    getChat(id) {
      const row = q.getChat.get(id);
      return row ? { ...row } : null;
    },

    listChats({ archived = false } = {}) {
      return q.listChats.all({ archived: archived ? 1 : 0 }).map((row) => ({ ...row }));
    },

    // All peer-call child chats (ask_agent/delegate), newest first, with latest run status.
    listChildChatsAll() {
      return q.childChatsWithStatus.all().map((row) => ({ ...row }));
    },

    updateChat(id, patch) {
      const current = store.getChat(id);
      if (!current) return null;
      const allowed = { title: "title", pinned: "pinned", archived: "archived", model: "model", mode: "mode", personId: "person_id", agent: "agent", provider: "provider" };
      const sets = [];
      const values = [];
      for (const [key, column] of Object.entries(allowed)) {
        if (!(key in patch)) continue;
        sets.push(`${column} = ?`);
        const value = patch[key];
        values.push(typeof value === "boolean" ? Number(value) : value);
      }
      if (!sets.length) return current;
      const agentChanged = "agent" in patch && patch.agent && patch.agent !== current.agent;
      const providerChanged = "provider" in patch && patch.provider && patch.provider !== current.provider;
      if (agentChanged || providerChanged) {
        // Drop the SDK session handle so the next run creates under the new persona/provider.
        sets.push("agent_id = ?");
        values.push(null);
      }
      db.prepare(`UPDATE chats SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
      bus.emit("chats", { type: "updated", chatId: id });
      return store.getChat(id);
    },

    setAgentId(chatId, agentId) {
      q.setAgent.run(agentId, chatId);
    },

    // Record an agent that performed work in a root chat (for sidebar glyphs).
    noteAgentWork(chatId, agentId) {
      if (!chatId || !agentId) return;
      const rootId = store.rootChatId(chatId);
      const chat = store.getChat(rootId);
      if (!chat || chat.parent_chat_id) return;
      const list = parseAgentsWorked(chat.agents_worked);
      if (list.includes(agentId)) return;
      list.push(agentId);
      q.setAgentsWorked.run(JSON.stringify(list), rootId);
      bus.emit("chats", { type: "updated", chatId: rootId });
    },

    // Agents that worked in this chat: persisted list, else current + peer children.
    agentsWorked(chat) {
      if (!chat) return [];
      const stored = parseAgentsWorked(chat.agents_worked);
      if (stored.length) return stored;
      const ids = [];
      const self = chat.agent || DEFAULT_AGENT;
      if (self) ids.push(self);
      for (const row of q.listChildAgents.all(chat.id)) {
        if (row.agent && !ids.includes(row.agent)) ids.push(row.agent);
      }
      return ids;
    },

    appendEvent(chatId, runId, type, data = {}) {
      const at = now();
      const info = q.insertEvent.run(chatId, runId, type, JSON.stringify(data), at);
      const event = { id: Number(info.lastInsertRowid), runId, type, data, at };
      bus.emit(`chat:${chatId}`, event);
      bus.emit("event", chatId, event);
      return event;
    },

    eventsAfter(chatId, afterId = 0, limit = 5000) {
      return q.eventsAfter.all(chatId, afterId, limit).map(rowToEvent);
    },

    // All events of a chat, in pages, for folding into a timeline server-side.
    *allEvents(chatId) {
      let after = 0;
      for (;;) {
        const rows = q.eventsAfter.all(chatId, after, 5000);
        for (const row of rows) yield rowToEvent(row);
        if (rows.length < 5000) return;
        after = rows.at(-1).id;
      }
    },

    // One-time cleanup: rewrite events whose stored JSON is large with a sanitizer (e.g. image bytes
    // that older versions kept inside tool results). Returns how many rows changed.
    compactLargeEvents(sanitize, minBytes = 64 * 1024) {
      const rows = db.prepare("SELECT id, data FROM events WHERE length(data) > ?").all(minBytes);
      const update = db.prepare("UPDATE events SET data = ? WHERE id = ?");
      let changed = 0;
      for (const row of rows) {
        const next = JSON.stringify(sanitize(JSON.parse(row.data)));
        if (next.length < row.data.length) {
          update.run(next, row.id);
          changed += 1;
        }
      }
      return changed;
    },

    startRun(chatId) {
      const id = randomUUID();
      const at = now();
      q.insertRun.run(id, chatId, at);
      q.touchChat.run(at, chatId);
      const chat = store.getChat(chatId);
      if (chat?.agent) store.noteAgentWork(chatId, chat.agent);
      bus.emit("chats", { type: "run", chatId, status: "running" });
      return id;
    },

    setSdkRunId(runId, sdkRunId) {
      q.setSdkRun.run(sdkRunId, runId);
    },

    finishRun(chatId, runId, status, error = null) {
      const at = now();
      q.finishRun.run(status, error, at, runId);
      q.touchChat.run(at, chatId);
      bus.emit("chats", { type: "run", chatId, status });
    },

    runningRuns() {
      return q.runningRuns.all();
    },

    createPeerUser({ id, label }) {
      db.prepare("INSERT INTO peer_users (id, label, enabled, created_at) VALUES (?, ?, 1, ?)").run(id, label, now());
      return store.getPeerUser(id);
    },

    getPeerUser(id) {
      return db.prepare("SELECT * FROM peer_users WHERE id = ?").get(String(id || "")) || null;
    },

    listPeerUsers() {
      return db.prepare("SELECT * FROM peer_users ORDER BY created_at").all();
    },

    setPeerUserEnabled(id, enabled) {
      db.prepare("UPDATE peer_users SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    },

    addPeerClient({ id, userId, label, tokenHash, expiresAt = null }) {
      db.prepare(
        "INSERT INTO peer_clients (id, user_id, label, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, userId, label, tokenHash, now(), expiresAt);
    },

    listPeerClients(userId) {
      return db
        .prepare("SELECT id, user_id, label, created_at, expires_at, revoked_at, last_used_at FROM peer_clients WHERE user_id = ? ORDER BY created_at")
        .all(userId);
    },

    peerClientByHash(tokenHash) {
      return db.prepare("SELECT * FROM peer_clients WHERE token_hash = ?").get(tokenHash) || null;
    },

    revokePeerClient(userId, clientId) {
      return db.prepare("UPDATE peer_clients SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(now(), clientId, userId).changes > 0;
    },

    touchPeerClient(clientId) {
      db.prepare("UPDATE peer_clients SET last_used_at = ? WHERE id = ?").run(now(), clientId);
    },

    // Argument *values* are never stored — only which keys a client sent, so a malformed call is
    // recognisable without keeping the peer's request text here.
    recordPeerCall({ userId, clientId = null, method, tool = null, argKeys = null, outcome, detail = null, ms = 0 }) {
      const info = db
        .prepare(
          "INSERT INTO peer_calls (at, user_id, client_id, method, tool, arg_keys, outcome, detail, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(now(), userId, clientId, method, tool, argKeys, outcome, detail ? String(detail).slice(0, 500) : null, Math.round(ms));
      const id = Number(info.lastInsertRowid);
      if (id % 256 === 0) db.prepare("DELETE FROM peer_calls WHERE id < ?").run(id - PEER_CALLS_KEEP);
      return id;
    },

    listPeerCalls(userId, { limit = 50 } = {}) {
      return db
        .prepare("SELECT * FROM peer_calls WHERE user_id = ? ORDER BY id DESC LIMIT ?")
        .all(userId, Math.min(Number(limit) || 50, 500));
    },

    createTask({ id, userId, clientId = null, caller, chatId, messageId = null, startEventId, state = "submitted" }) {
      const at = now();
      db.prepare(
        "INSERT INTO tasks (id, user_id, client_id, caller, chat_id, message_id, start_event_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, userId, clientId, caller, chatId, messageId, startEventId, state, at, at);
      return store.getTask(id);
    },

    getTask(id) {
      return db.prepare("SELECT * FROM tasks WHERE id = ?").get(String(id || "")) || null;
    },

    taskByMessage(userId, messageId) {
      return db.prepare("SELECT * FROM tasks WHERE user_id = ? AND message_id = ?").get(userId, String(messageId)) || null;
    },

    setTaskState(id, state, reason = null) {
      db.prepare("UPDATE tasks SET state = ?, state_reason = ?, updated_at = ? WHERE id = ?").run(state, reason, now(), id);
    },

    listTasks(userId, { chatId = null, limit = 50 } = {}) {
      return chatId
        ? db.prepare("SELECT * FROM tasks WHERE user_id = ? AND chat_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, chatId, limit)
        : db.prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit);
    },

    openTasks() {
      return db.prepare("SELECT * FROM tasks WHERE state NOT IN ('completed', 'failed', 'canceled', 'rejected')").all();
    },

    lastEventId(chatId) {
      return db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE chat_id = ?").get(chatId).id;
    },

    recordApproval({ chatId = null, caller, tool, args, decision, approver = null, detail = null }) {
      const clipJson = (value) => {
        const raw = JSON.stringify(value ?? null);
        return raw.length > 4000 ? JSON.stringify({ clipped: raw.slice(0, 4000) }) : raw;
      };
      db.prepare(
        "INSERT INTO approvals (at, chat_id, caller, tool, args_json, decision, approver, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(now(), chatId, String(caller), String(tool), clipJson(args), String(decision), approver, detail == null ? null : clipJson(detail));
    },

    listApprovals({ limit = 100 } = {}) {
      return db.prepare("SELECT * FROM approvals ORDER BY id DESC LIMIT ?").all(limit);
    },

    getKv(key) {
      const row = q.getKv.get(key);
      return row ? JSON.parse(row.value) : null;
    },

    setKv(key, value) {
      q.setKv.run(key, JSON.stringify(value));
    },

    // Charts keep their data inside the spec (Vega-Lite "datasets"), so a chart renders the
    // same way later even when the clusters or Prometheus are gone.
    saveChart({ chatId, title, spec, meta }) {
      const id = randomUUID();
      db.prepare("INSERT INTO charts (id, chat_id, title, spec, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, chatId, title, JSON.stringify(spec), JSON.stringify(meta), now());
      return id;
    },

    // Images a tool fetched (e.g. s3_get). Stored here so the chat keeps showing them later and the
    // event log stays small (events only carry the media id).
    saveMedia({ chatId, mimeType, data, meta = {} }) {
      const id = randomUUID();
      db.prepare("INSERT INTO media (id, chat_id, mime_type, data, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, chatId, mimeType, data, JSON.stringify(meta), now());
      return id;
    },

    getMedia(id) {
      const row = db.prepare("SELECT * FROM media WHERE id = ?").get(id);
      return row ? { ...row, meta: JSON.parse(row.meta) } : null;
    },

    listMedia(chatId) {
      return db.prepare("SELECT id, mime_type, length(data) AS bytes, meta, created_at FROM media WHERE chat_id = ? ORDER BY created_at")
        .all(chatId)
        .map((row) => ({ ...row, meta: JSON.parse(row.meta) }));
    },

    upsertPerson({ integrationId, externalId, name, username = null, category = null, data = {} }) {
      const source = String(data?.platform || "telegram");
      const current = db.prepare("SELECT * FROM persons WHERE source = ? AND external_id = ?").get(source, String(externalId));
      const id = current?.id || randomUUID();
      const at = now();
      const history = current ? JSON.parse(current.history_json || "[]") : [];
      db.prepare(`INSERT INTO persons (id, source, external_id, display_name, username, category, access_json, boundaries, notes, history_json, meta_json, last_seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, external_id) DO UPDATE SET display_name=excluded.display_name, username=excluded.username, updated_at=excluded.updated_at`)
        .run(id, source, String(externalId), name || current?.display_name || String(externalId), username, category || current?.category || "unclassified", current?.access_json || "{}", current?.boundaries || "", current?.notes || "", JSON.stringify(history), JSON.stringify(data || {}), at, current?.created_at || at, at);
      return store.getPerson(id);
    },
    getPerson(id) {
      const row = db.prepare("SELECT * FROM persons WHERE id = ?").get(id);
      return row && { ...row, access: JSON.parse(row.access_json), history: JSON.parse(row.history_json), meta: JSON.parse(row.meta_json || "{}") };
    },
    listPersons({ source = null, query = "", category = null } = {}) {
      const rows = db.prepare(`SELECT * FROM persons WHERE (? IS NULL OR source = ?) AND (? = '' OR display_name LIKE '%' || ? || '%' OR username LIKE '%' || ? || '%' OR external_id = ?) AND (? IS NULL OR category = ?) ORDER BY updated_at DESC`).all(source, source, query, query, query, query, category, category);
      return rows.map((row) => ({ ...row, access: JSON.parse(row.access_json), history: JSON.parse(row.history_json), meta: JSON.parse(row.meta_json || "{}") }));
    },
    updatePerson(id, patch = {}) {
      const current = store.getPerson(id); if (!current) return null;
      const next = { ...current, ...patch, display_name: patch.name || patch.display_name || current.display_name, access: patch.access || current.access, history: patch.history || current.history, meta: patch.data || patch.meta || current.meta };
      db.prepare("UPDATE persons SET display_name=?, username=?, category=?, access_json=?, boundaries=?, notes=?, history_json=?, meta_json=?, updated_at=? WHERE id=?").run(next.display_name, next.username || null, next.category || "unclassified", JSON.stringify(next.access), String(next.boundaries || ""), String(next.notes || ""), JSON.stringify(next.history), JSON.stringify(next.meta), now(), id);
      return store.getPerson(id);
    },
    addPersonMessage({ personId, externalMessageId = null, direction, text, data = {}, at = now() }) {
      if (!personId || !text) return null;
      const p = store.getPerson(personId);
      const next = [...(p?.history || [])];
      if (next.length >= 600) next.shift();
      next.push({ id: externalMessageId || String(Date.now()), direction, text: String(text), data, at });
      db.prepare("UPDATE persons SET history_json=?, last_seen_at=?, updated_at=? WHERE id=?").run(JSON.stringify(next), at, at, personId);
      bus.emit("person.message", { personId, direction, text: String(text), at });
    },
    listPersonMessages(personId, limit = 200) {
      const p = store.getPerson(personId);
      const hist = p?.history || [];
      return hist.slice(-Math.max(0, Number(limit) || 200));
    },

    // Integrations (Telegram/Bale bots, Telegram account). `secret` (bot token / session) never leaves the
    // server; `settings` holds non-secret state such as paired chats and the pairing code.
    createIntegration({ kind, name, secret, settings = {} }) {
      const id = randomUUID();
      db.prepare("INSERT INTO integrations (id, kind, name, secret, settings, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, kind, name, secret, JSON.stringify(settings), now());
      return store.getIntegration(id);
    },

    getIntegration(id) {
      const row = db.prepare("SELECT * FROM integrations WHERE id = ?").get(id);
      return row ? { ...row, enabled: Boolean(row.enabled), settings: JSON.parse(row.settings) } : null;
    },

    listIntegrations() {
      return db.prepare("SELECT id FROM integrations ORDER BY created_at").all().map((r) => store.getIntegration(r.id));
    },

    updateIntegration(id, patch) {
      const current = store.getIntegration(id);
      if (!current) return null;
      const next = { ...current, ...patch, settings: { ...current.settings, ...(patch.settings || {}) } };
      db.prepare("UPDATE integrations SET name = ?, secret = ?, settings = ?, enabled = ? WHERE id = ?")
        .run(next.name, next.secret, JSON.stringify(next.settings), Number(next.enabled), id);
      return store.getIntegration(id);
    },

    deleteIntegration(id) {
      db.prepare("DELETE FROM integration_links WHERE integration_id = ?").run(id);
      return db.prepare("DELETE FROM integrations WHERE id = ?").run(id).changes;
    },

    linkedChat(integrationId, externalChat) {
      return db.prepare("SELECT chat_id FROM integration_links WHERE integration_id = ? AND external_chat = ?").get(integrationId, String(externalChat))?.chat_id || null;
    },

    linkChat(integrationId, externalChat, chatId) {
      db.prepare(`INSERT INTO integration_links (integration_id, external_chat, chat_id, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(integration_id, external_chat) DO UPDATE SET chat_id = excluded.chat_id, updated_at = excluded.updated_at`)
        .run(integrationId, String(externalChat), chatId, now());
    },

    linksForChat(chatId) {
      return db.prepare("SELECT integration_id, external_chat FROM integration_links WHERE chat_id = ?").all(chatId);
    },

    // Public read-only links. One active link per chat; revoking kills it for good.
    shareChat(chatId) {
      const active = db.prepare("SELECT token, created_at FROM shares WHERE chat_id = ? AND revoked_at IS NULL").get(chatId);
      if (active) return active;
      const token = randomBytes(24).toString("base64url");
      const created_at = now();
      db.prepare("INSERT INTO shares (token, chat_id, created_at) VALUES (?, ?, ?)").run(token, chatId, created_at);
      return { token, created_at };
    },

    getShareForChat(chatId) {
      return db.prepare("SELECT token, created_at FROM shares WHERE chat_id = ? AND revoked_at IS NULL").get(chatId) || null;
    },

    revokeShare(chatId) {
      return db.prepare("UPDATE shares SET revoked_at = ? WHERE chat_id = ? AND revoked_at IS NULL").run(now(), chatId).changes;
    },

    chatForShare(token) {
      const row = db.prepare("SELECT chat_id FROM shares WHERE token = ? AND revoked_at IS NULL").get(String(token));
      return row ? store.getChat(row.chat_id) : null;
    },

    getChart(id) {
      const row = db.prepare("SELECT * FROM charts WHERE id = ?").get(id);
      return row ? { ...row, spec: JSON.parse(row.spec), meta: JSON.parse(row.meta) } : null;
    },

    // Rendered-PNG cache for a chart (keyed in kv), so a chart is rasterized once for messengers.
    getChartMedia(chartId) {
      const id = store.getKv(`chartpng:${chartId}`);
      if (!id) return null;
      const media = store.getMedia(id);
      return media || null;
    },
    setChartMedia(chartId, mediaId) {
      store.setKv(`chartpng:${chartId}`, mediaId);
    },

    listCharts(chatId) {
      return db.prepare("SELECT id, title, meta, created_at FROM charts WHERE chat_id = ? ORDER BY created_at")
        .all(chatId)
        .map((row) => ({ ...row, meta: JSON.parse(row.meta) }));
    },

    // Jobs: a saved prompt plus a trigger (schedule today, more later) and where to deliver the answer.
    createJob({ name, prompt, model = null, mode = "agent", agent = "platform", triggerType, trigger = {}, delivery = {}, options = {}, enabled = true, nextAt = null }) {
      const id = randomUUID();
      const at = now();
      db.prepare(`INSERT INTO jobs (id, name, prompt, model, mode, agent, trigger_type, trigger, delivery, options, enabled, next_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, name, prompt, model, mode, agent || "platform", triggerType, JSON.stringify(trigger), JSON.stringify(delivery), JSON.stringify(options), Number(enabled), nextAt, at, at);
      bus.emit("jobs", { type: "created", jobId: id });
      return store.getJob(id);
    },

    getJob(id) {
      const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
      return row ? jobFromRow(row) : null;
    },

    listJobs() {
      return db.prepare("SELECT * FROM jobs ORDER BY created_at").all().map(jobFromRow);
    },

    updateJob(id, patch) {
      const current = store.getJob(id);
      if (!current) return null;
      const next = {
        name: patch.name ?? current.name,
        prompt: patch.prompt ?? current.prompt,
        model: patch.model === undefined ? current.model : patch.model,
        mode: patch.mode ?? current.mode,
        agent: patch.agent === undefined ? current.agent : patch.agent,
        triggerType: patch.triggerType ?? current.triggerType,
        trigger: patch.trigger ?? current.trigger,
        delivery: patch.delivery ?? current.delivery,
        options: patch.options ?? current.options,
        enabled: patch.enabled === undefined ? current.enabled : Boolean(patch.enabled),
        nextAt: patch.nextAt === undefined ? current.nextAt : patch.nextAt,
      };
      db.prepare(`UPDATE jobs SET name = ?, prompt = ?, model = ?, mode = ?, agent = ?, trigger_type = ?, trigger = ?, delivery = ?, options = ?, enabled = ?, next_at = ?, updated_at = ?
        WHERE id = ?`)
        .run(next.name, next.prompt, next.model, next.mode, next.agent || "platform", next.triggerType, JSON.stringify(next.trigger), JSON.stringify(next.delivery), JSON.stringify(next.options), Number(next.enabled), next.nextAt, now(), id);
      bus.emit("jobs", { type: "updated", jobId: id });
      return store.getJob(id);
    },

    deleteJob(id) {
      for (const row of db.prepare("SELECT chat_id FROM job_runs WHERE job_id = ? AND chat_id IS NOT NULL").all(id)) {
        store.deleteChat(row.chat_id);
      }
      db.prepare("DELETE FROM job_runs WHERE job_id = ?").run(id);
      const changes = db.prepare("DELETE FROM jobs WHERE id = ?").run(id).changes;
      if (changes) bus.emit("jobs", { type: "deleted", jobId: id });
      return changes;
    },

    startJobRun({ jobId, chatId, trigger }) {
      const id = randomUUID();
      db.prepare("INSERT INTO job_runs (id, job_id, chat_id, trigger, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)")
        .run(id, jobId, chatId, trigger, now());
      bus.emit("jobs", { type: "run", jobId });
      return id;
    },

    finishJobRun(id, { status, error = null, summary = null, delivery = null }) {
      db.prepare("UPDATE job_runs SET status = ?, error = ?, summary = ?, delivery = ?, ended_at = ? WHERE id = ?")
        .run(status, error, summary, delivery ? JSON.stringify(delivery) : null, now(), id);
      const row = db.prepare("SELECT job_id FROM job_runs WHERE id = ?").get(id);
      if (row) bus.emit("jobs", { type: "run", jobId: row.job_id });
    },

    listJobRuns(jobId, limit = 20) {
      return db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?").all(jobId, limit).map(jobRunFromRow);
    },

    lastJobRun(jobId) {
      const row = db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1").get(jobId);
      return row ? jobRunFromRow(row) : null;
    },

    // A job that fires every half hour would grow forever; keep only the newest runs and their chats.
    pruneJobRuns(jobId, keep = 20) {
      const stale = db.prepare("SELECT id, chat_id FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT -1 OFFSET ?").all(jobId, keep);
      for (const row of stale) {
        if (row.chat_id) store.deleteChat(row.chat_id);
        db.prepare("DELETE FROM job_runs WHERE id = ?").run(row.id);
      }
      return stale.length;
    },

    // --- agent profiles (provider + enabled tools; source of truth after seed) ---

    seedAgentProfiles() {
      let inserted = 0;
      for (const row of seedProfilesFromRegistry()) {
        const existing = store.getAgentProfile(row.id);
        if (existing) {
          // New caller rows from the registry are added; anything the owner edited stays.
          const callers = { ...(existing.meta?.callers || {}) };
          const missing = Object.keys(row.meta.callers || {}).filter((id) => !callers[id]);
          if (missing.length) {
            for (const id of missing) callers[id] = row.meta.callers[id];
            store.updateAgentProfile(row.id, { meta: { ...(existing.meta || {}), callers } });
          }
          continue;
        }
        store.upsertAgentProfile(row);
        inserted += 1;
      }
      return inserted;
    },

    getAgentProfile(id) {
      const row = db.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(String(id || ""));
      return row ? profileFromRow(row) : null;
    },

    listAgentProfiles() {
      return db.prepare("SELECT * FROM agent_profiles ORDER BY built_in DESC, label ASC").all().map(profileFromRow);
    },

    upsertAgentProfile({
      id,
      label,
      domain = "",
      blurb = "",
      instructions = "",
      provider = "cursor",
      model = null,
      tools = [],
      meta = {},
      builtIn = false,
    }) {
      if (!id) throw new Error("agent profile id required");
      const at = now();
      const existing = store.getAgentProfile(id);
      const toolsJson = JSON.stringify(unique(Array.isArray(tools) ? tools : []));
      const metaJson = JSON.stringify(meta && typeof meta === "object" ? meta : {});
      const prov = provider === "claude" ? "claude" : "cursor";
      if (existing) {
        db.prepare(
          `UPDATE agent_profiles SET label = ?, domain = ?, blurb = ?, instructions = ?, provider = ?, model = ?, tools_json = ?, meta_json = ?, built_in = ?, updated_at = ? WHERE id = ?`,
        ).run(label, domain, blurb || "", instructions || "", prov, model || null, toolsJson, metaJson, Number(builtIn), at, id);
      } else {
        db.prepare(
          `INSERT INTO agent_profiles (id, label, domain, blurb, instructions, provider, model, tools_json, meta_json, built_in, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, label, domain, blurb || "", instructions || "", prov, model || null, toolsJson, metaJson, Number(builtIn), at, at);
      }
      bus.emit("agents", { type: existing ? "updated" : "created", agentId: id });
      return store.getAgentProfile(id);
    },

    updateAgentProfile(id, patch = {}) {
      const current = store.getAgentProfile(id);
      if (!current) return null;
      const meta = { ...(current.meta || {}) };
      if (patch.meta !== undefined && patch.meta && typeof patch.meta === "object") {
        Object.assign(meta, patch.meta);
      }
      if (patch.allTools !== undefined) meta.allTools = Boolean(patch.allTools);
      if (Array.isArray(patch.disabled)) meta.disabled = unique(patch.disabled);

      let tools = patch.tools !== undefined ? unique(patch.tools) : current.tools;
      // An explicit tool list means leaving "every tool" mode.
      if (patch.tools !== undefined && patch.allTools === undefined) {
        meta.allTools = false;
        meta.disabled = [];
      }

      return store.upsertAgentProfile({
        id: current.id,
        label: patch.label !== undefined ? String(patch.label).slice(0, 120) : current.label,
        domain: patch.domain !== undefined ? String(patch.domain).slice(0, 500) : current.domain,
        blurb: patch.blurb !== undefined ? String(patch.blurb).slice(0, 500) : current.blurb,
        instructions: patch.instructions !== undefined ? String(patch.instructions).slice(0, 20_000) : current.instructions,
        provider: patch.provider !== undefined ? patch.provider : current.provider,
        model: patch.model !== undefined ? (patch.model || null) : current.model,
        tools,
        meta,
        builtIn: current.built_in,
      });
    },

    /** Remove a custom agent. Chats that used it keep their history and fall back to the default. */
    deleteAgentProfile(id) {
      const profile = store.getAgentProfile(id);
      if (!profile) return false;
      db.prepare("DELETE FROM agent_profiles WHERE id = ?").run(String(id));
      bus.emit("agents", { type: "deleted", agentId: String(id) });
      return true;
    },

    enableAgentTools(id, names) {
      const profile = store.getAgentProfile(id);
      if (!profile) return null;
      const add = unique((Array.isArray(names) ? names : [names]).map(String));
      if (profile.meta?.allTools) {
        const disabled = (profile.meta.disabled || []).filter((n) => !add.includes(n));
        return store.updateAgentProfile(id, { disabled, meta: { ...profile.meta, disabled } });
      }
      return store.updateAgentProfile(id, { tools: unique([...(profile.tools || []), ...add]) });
    },

    disableAgentTools(id, names) {
      const profile = store.getAgentProfile(id);
      if (!profile) return null;
      const remove = unique((Array.isArray(names) ? names : [names]).map(String));
      if (profile.meta?.allTools) {
        const disabled = unique([...(profile.meta.disabled || []), ...remove]);
        return store.updateAgentProfile(id, { meta: { ...profile.meta, disabled } });
      }
      const tools = (profile.tools || []).filter((n) => !remove.includes(n));
      return store.updateAgentProfile(id, { tools });
    },

    close() {
      db.close();
    },
  };

  store.seedAgentProfiles();
  return store;
}

function profileFromRow(row) {
  let tools = [];
  let meta = {};
  try {
    tools = JSON.parse(row.tools_json || "[]");
  } catch {
    tools = [];
  }
  try {
    meta = JSON.parse(row.meta_json || "{}");
  } catch {
    meta = {};
  }
  return {
    id: row.id,
    label: row.label,
    domain: row.domain || "",
    blurb: row.blurb || "",
    instructions: row.instructions || "",
    provider: row.provider || "cursor",
    model: row.model || null,
    tools: Array.isArray(tools) ? tools : [],
    meta: meta && typeof meta === "object" ? meta : {},
    built_in: Boolean(row.built_in),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseAgentsWorked(raw) {
  if (!raw) return [];
  try {
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const id of list) {
      if (typeof id === "string" && id && !out.includes(id)) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

function jobFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    mode: row.mode,
    agent: row.agent || "platform",
    triggerType: row.trigger_type,
    trigger: JSON.parse(row.trigger),
    delivery: JSON.parse(row.delivery),
    options: JSON.parse(row.options),
    enabled: Boolean(row.enabled),
    nextAt: row.next_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jobRunFromRow(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    chatId: row.chat_id,
    trigger: row.trigger,
    status: row.status,
    error: row.error,
    summary: row.summary,
    delivery: row.delivery ? JSON.parse(row.delivery) : null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
