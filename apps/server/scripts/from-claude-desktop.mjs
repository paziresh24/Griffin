#!/usr/bin/env node
// Claude Desktop (Code tab) sessions -> Griffin owner chats that go on with the same Claude session.
//
// For each desktop session (<sessions>/local_*.json, holding its cliSessionId and cwd):
//   - a Griffin chat (owner, griffin, Claude, opus, the session's effort), on one of the repos named
//     with --repos (or GRIFFIN_IMPORT_REPOS) when the session ran in it, with agent_id = the Claude session id;
//   - its user messages and the assistant's text as Griffin events (masked), at their real times;
//   - the transcript (<projects>/<laptop slug>/<id>.jsonl and its <id>/ folder) copied to
//     <claude-home>/projects/<slug of the folder Griffin runs the chat in>/, so resume finds it.
// Finished sessions (desktop summary «completed») come in archived. Run again to bring the latest over
// (kv desktop-import:<id>): a new session is moved; a moved one that went on in Desktop gets its
// history and transcript again; one that went on in Griffin is left alone. Every moved chat that has
// not run in Griffin yet gets its transcript where its first run will look (the worktree name follows
// the assistant's name). Run when the app is idle.
//   node from-claude-desktop.mjs --sessions DIR --projects DIR --db FILE --claude-home DIR [--repos a,b=Dir] [--only ID] [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { maskText } from "../src/redact.mjs";
import { worktreeDir } from "../src/worktrees.mjs";

const slugOf = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");

// Repos a desktop folder maps to: "name" (a folder of that name anywhere in the path) or
// "name=Folder" (the session ran in Folder, the chat goes on repo name). Nothing listed = no repo.
export function parseRepos(spec = process.env.GRIFFIN_IMPORT_REPOS || "") {
  return String(spec)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [name, folder] = item.split("=").map((x) => x.trim());
      return { name, folder: folder || name };
    })
    .filter((r) => /^[A-Za-z0-9._-]+$/.test(r.name) && r.folder);
}

export function repoOf(cwd, repos = parseRepos()) {
  const list = typeof repos === "string" ? parseRepos(repos) : repos;
  for (const { name, folder } of list) {
    const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`/${escaped}(/|$)`).test(cwd)) return name;
  }
  return null;
}

// Griffin runs a repo chat in its worktree <repos>/_wt/<name>-<id8> (worktrees.mjs: the name its tree
// already has, else the assistant's), else in the agent's folder.
export const griffinCwd = (chatId, repo, workspace = "/workspace") => (repo ? worktreeDir(`${workspace}/repos`, chatId) : `${workspace}/agents/griffin`);

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
// The person's words: system reminders the app put around them go; a message that is only harness
// text (a task notification, a slash command's output) is no turn.
const HARNESS = /^<(task-notification|command-|local-command|bash-|user-prompt-submit|ide_|ci-monitor-event)/;
export const userWords = (content) => {
  const text = textOf(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return HARNESS.test(text) ? "" : text;
};

// Turns of a transcript: a real user message (not a tool result, meta, compact summary, side chain or
// harness text such as <task-notification>) and the assistant text after it.
export function turnsOf(lines) {
  const turns = [];
  for (const line of lines) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.isSidechain) continue;
    if (d.type === "user" && !d.isMeta && !d.isCompactSummary) {
      const text = userWords(d.message?.content);
      if (!text) continue;
      turns.push({ user: text, at: d.timestamp, texts: [], endAt: d.timestamp });
    } else if (d.type === "assistant" && turns.length) {
      const text = textOf(d.message?.content);
      const turn = turns.at(-1);
      if (text.trim()) turn.texts.push(text);
      if (d.timestamp) turn.endAt = d.timestamp;
    }
  }
  return turns;
}

function statusOf(session) {
  try {
    const s = typeof session.postTurnSummary === "string" ? JSON.parse(session.postTurnSummary) : session.postTurnSummary;
    return s?.status_category || "";
  } catch {
    return "";
  }
}

function copyTree(src, dst, force = false) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, errorOnExist: false, force });
}
// The transcript and its subagents' folder, to where Griffin's Claude Code resumes it.
function placeTranscript(src, id, dst, force = false) {
  copyTree(src, path.join(dst, `${id}.jsonl`), force);
  const sub = path.join(path.dirname(src), id);
  if (fs.existsSync(sub)) copyTree(sub, path.join(dst, id), force);
}

export function importSessions({ sessions, projects, db, claudeHome, repoList, only = null, dryRun = false }) {
  const list = fs.readdirSync(sessions).filter((f) => /^local_.*\.json$/.test(f)).map((file) => JSON.parse(fs.readFileSync(path.join(sessions, file), "utf8")));
  return importList(list, { projects, db, claudeHome, repoList, only, dryRun });
}

// Plain Claude Code (CLI, or a desktop without its session files): every <projects>/<slug>/<id>.jsonl is a
// session. Its folder, title and times come from the transcript itself; symlinks are never followed
// (an uploaded archive may hold any).
export function sessionsFromProjects(projects) {
  const list = [];
  for (const dir of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(projects, dir.name), { withFileTypes: true })) {
      if (!f.isFile() || !/^[0-9a-f-]{36}\.jsonl$/.test(f.name)) continue;
      const src = path.join(projects, dir.name, f.name);
      const lines = fs.readFileSync(src, "utf8").split("\n");
      let cwd = "";
      let summary = "";
      for (const line of lines) {
        if (cwd && summary) break;
        if (!line.includes('"cwd"') && !line.includes('"summary"')) continue;
        try {
          const d = JSON.parse(line);
          if (!cwd && typeof d.cwd === "string") cwd = d.cwd;
          if (!summary && d.type === "summary" && typeof d.summary === "string") summary = d.summary;
        } catch {
          /* a broken line */
        }
      }
      const turns = turnsOf(lines);
      if (!turns.length) continue;
      const ms = (t) => (t && Date.parse(t)) || null;
      const id = f.name.slice(0, -6);
      list.push({ sessionId: id, cliSessionId: id, cwd, src, title: summary || turns[0].user.replace(/\s+/g, " ").slice(0, 80), createdAt: ms(turns[0].at), lastActivityAt: ms(turns.at(-1).endAt) });
    }
  }
  return list;
}

// From the browser (history-import.mjs): never on a repo (this install may not have the same
// repos), and in this install's own workspace, where its Claude Code looks for the session.
export function importProjects({ projects, db, claudeHome, workspace = "/workspace", dryRun = false }) {
  return importList(sessionsFromProjects(projects), { projects, db, claudeHome, workspace, repos: false, dryRun });
}

function importList(list, { projects, db: dbFile, claudeHome, workspace = "/workspace", repos = true, repoList = parseRepos(), only = null, dryRun = false }) {
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA busy_timeout = 10000");
  const getKv = db.prepare("SELECT value FROM kv WHERE key = ?");
  const setKv = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const insertChat = db.prepare(`INSERT INTO chats (id, title, agent_id, model, mode, pinned, archived, created_at, updated_at, caller, agent, provider, sim, effort, repo)
    VALUES (?, ?, ?, 'opus', 'agent', ?, ?, ?, ?, 'owner', 'griffin', 'claude', 0, ?, ?)`);
  const insertRun = db.prepare("INSERT INTO runs (id, chat_id, status, started_at, ended_at) VALUES (?, ?, 'finished', ?, ?)");
  const insertEvent = db.prepare("INSERT INTO events (chat_id, run_id, type, data, at) VALUES (?, ?, ?, ?, ?)");
  const writeTurns = (chatId, turns, created) => {
    for (const t of turns) {
      const runId = randomUUID();
      const at = t.at || created;
      insertEvent.run(chatId, null, "user", JSON.stringify({ text: maskText(t.user) }), at);
      insertRun.run(runId, chatId, at, t.endAt || at);
      insertEvent.run(chatId, runId, "run.started", JSON.stringify({ model: "opus", provider: "claude" }), at);
      if (t.texts.length) insertEvent.run(chatId, runId, "text", JSON.stringify({ text: maskText(t.texts.join("\n\n")) }), t.endAt || at);
      insertEvent.run(chatId, runId, "run.finished", JSON.stringify({ status: "finished" }), t.endAt || at);
    }
  };
  // A session Griffin already runs (its own chat, or one moved by hand) is not brought in twice.
  const inGriffin = db.prepare("SELECT 1 FROM chats WHERE agent_id = ? LIMIT 1");
  // Desktop can give a session a new Claude session id (its id local_… stays): known by either.
  const bySession = new Map();
  for (const r of db.prepare("SELECT key, value FROM kv WHERE key LIKE 'desktop-import:%'").all()) {
    try {
      const v = JSON.parse(r.value);
      if (v.session) bySession.set(v.session, { key: r.key, value: r.value });
    } catch {
      /* not ours */
    }
  }
  const rows = [];
  for (const s of list) {
    const id = s.cliSessionId;
    if (!id || (only && only !== id && only !== s.sessionId)) continue;
    const row = { session: s.sessionId, id, cwd: s.cwd || "", title: s.title || "(بی‌عنوان)" };
    rows.push(row);
    const src = s.src || path.join(projects, slugOf(s.cwd || ""), `${id}.jsonl`);
    const known = getKv.get(`desktop-import:${id}`) ? { key: `desktop-import:${id}`, value: getKv.get(`desktop-import:${id}`).value } : bySession.get(s.sessionId) || null;
    const moved = known && { value: known.value };
    if (!moved && inGriffin.get(id)) {
      row.action = "skipped (already in Griffin)";
      continue;
    }
    if (moved) {
      // Went on in Griffin: its own turns are there now, nothing is touched. Otherwise the transcript
      // goes where the chat's first run looks, and the history again if Desktop went on.
      const { chatId, at } = JSON.parse(moved.value);
      const chat = db.prepare("SELECT repo, worktree_path FROM chats WHERE id = ?").get(chatId);
      if (!chat) {
        row.action = "skipped (deleted in Griffin)";
        continue;
      }
      if (db.prepare("SELECT COUNT(*) n FROM runs WHERE chat_id = ? AND started_at > ?").get(chatId, at).n) {
        row.action = "skipped (continued in Griffin)";
        continue;
      }
      if (!fs.existsSync(src)) {
        row.action = "missing transcript";
        continue;
      }
      const dst = path.join(claudeHome, "projects", slugOf(chat.worktree_path || griffinCwd(chatId, chat.repo, workspace)));
      const changed = (s.lastActivityAt || 0) > Date.parse(at);
      const placed = fs.existsSync(path.join(dst, `${id}.jsonl`));
      Object.assign(row, { chatId, repo: chat.repo, to: dst });
      if (!changed && placed) {
        row.action = "skipped (up to date)";
        continue;
      }
      const turns = changed ? turnsOf(fs.readFileSync(src, "utf8").split("\n")) : null;
      if (turns) row.turns = turns.length;
      if (dryRun) {
        row.action = changed ? "would refresh" : "would relink";
        continue;
      }
      placeTranscript(src, id, dst, true);
      db.exec("BEGIN");
      try {
        if (known.key !== `desktop-import:${id}`) {
          db.prepare("UPDATE chats SET agent_id = ? WHERE id = ?").run(id, chatId);
          db.prepare("DELETE FROM kv WHERE key = ?").run(known.key);
        }
        if (turns) {
          db.prepare("DELETE FROM events WHERE chat_id = ?").run(chatId);
          db.prepare("DELETE FROM runs WHERE chat_id = ?").run(chatId);
          writeTurns(chatId, turns, turns[0]?.at || at);
          row.archived = statusOf(s) === "completed" && !(s.pinned || s.isStarred) ? 1 : 0;
          db.prepare("UPDATE chats SET updated_at = ?, archived = ? WHERE id = ?").run(new Date(s.lastActivityAt).toISOString(), row.archived, chatId);
        }
        setKv.run(`desktop-import:${id}`, JSON.stringify({ chatId, session: s.sessionId, at: new Date().toISOString() }));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      row.action = changed ? "refreshed" : "relinked";
      continue;
    }
    if (!fs.existsSync(src)) {
      row.action = "missing transcript";
      continue;
    }
    const turns = turnsOf(fs.readFileSync(src, "utf8").split("\n"));
    const chatId = randomUUID();
    const repo = repos ? repoOf(s.cwd || "", repoList) : null;
    const archived = statusOf(s) === "completed" && !(s.pinned || s.isStarred) ? 1 : 0; // a pinned one stays in sight
    const dst = path.join(claudeHome, "projects", slugOf(griffinCwd(chatId, repo, workspace)));
    Object.assign(row, { chatId, repo, archived, turns: turns.length, to: dst });
    if (dryRun) {
      row.action = "would move";
      continue;
    }
    const iso = (ms, fallback) => (ms ? new Date(ms).toISOString() : fallback);
    const created = iso(s.createdAt, turns[0]?.at || new Date().toISOString());
    const updated = iso(s.lastActivityAt, turns.at(-1)?.endAt || created);
    placeTranscript(src, id, dst);
    db.exec("BEGIN");
    try {
      insertChat.run(chatId, row.title.slice(0, 120), id, s.pinned || s.isStarred ? 1 : 0, archived, created, updated, s.effort || null, repo);
      writeTurns(chatId, turns, created);
      setKv.run(`desktop-import:${id}`, JSON.stringify({ chatId, session: s.sessionId, at: new Date().toISOString() }));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    row.action = "moved";
  }
  db.close();
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const get = (name) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : null;
  };
  const opts = { sessions: get("sessions"), projects: get("projects"), db: get("db"), claudeHome: get("claude-home"), repoList: parseRepos(get("repos") ?? undefined), only: get("only"), dryRun: args.includes("--dry-run") };
  if (!opts.sessions || !opts.projects || !opts.db || !opts.claudeHome) {
    console.error("usage: from-claude-desktop.mjs --sessions DIR --projects DIR --db FILE --claude-home DIR [--repos a,b=Dir] [--only ID] [--dry-run]");
    process.exit(2);
  }
  const rows = importSessions(opts);
  for (const r of rows) console.log(`${r.action}\t${r.archived ? "archived" : "open"}\t${r.turns ?? ""}\t${r.repo || "-"}\t${r.title}\t${r.chatId || ""}`);
  console.log(`total ${rows.length}, moved ${rows.filter((r) => r.action === "moved").length}, refreshed ${rows.filter((r) => r.action === "refreshed").length}, relinked ${rows.filter((r) => r.action === "relinked").length}`);
}
