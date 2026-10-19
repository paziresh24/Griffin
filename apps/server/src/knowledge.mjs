import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AGENTS, DEFAULT_AGENT } from "./agents/registry.mjs";
import { agentSlug } from "./persona.mjs";

// Local knowledge tree under the workspace. Authoritative on this server; GitLab push is
// best-effort and out of scope here. Nothing unreviewed is injected into the prompt —
// these tools only write/list files the owner can read later.

export const KNOWLEDGE_WRITE = "knowledge_write";
export const KNOWLEDGE_LIST = "knowledge_list";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BODY = 32_000;
// Every character a regex with the m flag treats as a line end, plus other control characters:
// none may sit in a title, or the title could forge a frontmatter line (`reviewed:`, `chat:`).
const LINE_BREAKS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;
const SECRET_RE =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)|(?:\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)|(?:\b(?:sk|pk|api)[_-]?[a-z0-9]{20,}\b)|(?:\b(?:ghp|gho|glpat|xox[baprs])-[A-Za-z0-9_-]{20,}\b)|(?:\bAKIA[0-9A-Z]{16}\b)/i;

const writeSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short Persian title for the note" },
    body: { type: "string", description: "Markdown body. No secrets, tokens, or passwords." },
    ttlHours: {
      type: "number",
      description: "Optional TTL for live numbers (hours). Omit for durable notes.",
    },
  },
  required: ["title", "body"],
  additionalProperties: false,
};

const listSchema = {
  type: "object",
  properties: {
    agent: { type: "string", description: "Agent id whose knowledge to list (default: this chat's agent)" },
    file: { type: "string", description: "Read one note in full: a file name from the list or from the Playbook index in your rules" },
  },
  additionalProperties: false,
};

// autoTrust (GRIFFIN_KNOWLEDGE_AUTO_TRUST=1) / trust (knowledge-trust.mjs createChatTrust:
// recordNote, isTrustedNote). Notes are recorded whenever trust is given, so turning the flag on
// later trusts notes written while it was off too.
export function createKnowledge({ store, root, git = true, autoTrust = false, trust = null } = {}) {
  if (!root) throw new Error("knowledge root required");
  fs.mkdirSync(root, { recursive: true });
  ensureGit(root, git, store);

  function resolveAgentMeta(agentId) {
    const profile = store?.getAgentProfile?.(agentId);
    if (profile) return { id: profile.id, label: profile.label, domain: profile.domain };
    const fallback = AGENTS[agentId];
    if (fallback) return { id: agentId, label: fallback.label, domain: fallback.domain };
    return null;
  }

  function agentDir(agentId) {
    const meta = resolveAgentMeta(agentId);
    if (!meta) throw new Error(`unknown agent: ${agentId}`);
    const dir = path.join(root, "agents", agentId, "knowledge");
    fs.mkdirSync(dir, { recursive: true });
    const agentMd = path.join(root, "agents", agentId, "AGENT.md");
    if (!fs.existsSync(agentMd)) {
      fs.writeFileSync(agentMd, `# ${meta.label}\n\n${meta.domain}\n`, "utf8");
    }
    return dir;
  }

  function scan(body) {
    if (SECRET_RE.test(body)) {
      return "body looks like it contains a secret/token/JWT — refused";
    }
    return null;
  }

  function slugify(title) {
    const base = String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "note";
    return SLUG.test(base) ? base : `note-${Date.now().toString(36)}`;
  }

  return {
    tool(chatId) {
      return {
        [KNOWLEDGE_WRITE]: {
          description: autoTrust
            ? "Save a durable note into this agent's local knowledge git (under knowledge/agents/<id>/knowledge/). Do not put secrets. A note written in the owner's own chat that read no third-party content (a colleague, Telegram, the web, another chat) reaches later chats automatically; others wait for the owner's review."
            : "Save a durable note into this agent's local knowledge git (under knowledge/agents/<id>/knowledge/). Do not put secrets. Notes are NOT auto-injected into future prompts until the owner reviews them.",
          inputSchema: writeSchema,
          async execute(args) {
            const chat = store.getChat(chatId);
            const agentId = chat?.agent || DEFAULT_AGENT;
            const title = String(args?.title || "").replace(LINE_BREAKS, " ").trim().slice(0, 120);
            const body = String(args?.body || "");
            if (!title) return { isError: true, content: [{ type: "text", text: "title required" }] };
            if (!body.trim()) return { isError: true, content: [{ type: "text", text: "body required" }] };
            if (body.length > MAX_BODY) return { isError: true, content: [{ type: "text", text: "body too long" }] };
            const bad = scan(body) || scan(title);
            if (bad) return { isError: true, content: [{ type: "text", text: bad }] };

            const dir = agentDir(agentId);
            let slug = slugify(title);
            let file = path.join(dir, `${slug}.md`);
            let n = 2;
            while (fs.existsSync(file)) {
              slug = `${slugify(title)}-${n}`;
              file = path.join(dir, `${slug}.md`);
              n += 1;
            }

            const ttlHours = Number(args?.ttlHours);
            const ttl = Number.isFinite(ttlHours) && ttlHours > 0
              ? new Date(Date.now() + ttlHours * 3600_000).toISOString()
              : null;
            const at = new Date().toISOString();
            const front = [
              "---",
              `title: ${JSON.stringify(title)}`,
              `agent: ${agentId}`,
              `chat: ${chatId}`,
              `at: ${at}`,
              `reviewed: false`,
              ...(ttl ? [`expires: ${ttl}`] : []),
              "---",
              "",
              body.trim(),
              "",
            ].join("\n");
            fs.writeFileSync(file, front, "utf8");
            trust?.recordNote(agentId, path.basename(file), chatId, front);
            writeDirectory(root);
            const committed = commit(root, git, `knowledge: ${agentId}/${slug}`);
            const rel = path.relative(root, file);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  path: rel,
                  agent: agentId,
                  reviewed: false,
                  committed,
                  note: autoTrust
                    ? "saved locally; reaches later chats automatically if this chat read no third-party content, otherwise after the owner's review"
                    : "saved locally; not injected into prompts until reviewed",
                }),
              }],
            };
          },
        },
        [KNOWLEDGE_LIST]: {
          description:
            "List local knowledge notes for an agent (filenames + titles), or read one note in full with {file} — including Playbook notes.",
          inputSchema: listSchema,
          async execute(args) {
            const chat = store.getChat(chatId);
            const agentId = String(args?.agent || chat?.agent || DEFAULT_AGENT);
            if (!resolveAgentMeta(agentId)) {
              return { isError: true, content: [{ type: "text", text: `unknown agent: ${agentId}` }] };
            }
            // With auto-trust on, a note's title and body are content: only notes the prompt may
            // carry (reviewed or auto-trusted) and the playbook are named or served, so listing
            // never brings an untrusted chat's words into this one.
            const trusted = (name, text) => {
              const front = frontmatter(text);
              if (front.get("expires") && Date.parse(front.get("expires")) <= Date.now()) return false;
              return front.get("reviewed") === "true" || Boolean(trust?.isTrustedNote(agentId, name, text));
            };
            if (args?.file) {
              const own = readAgentNote(root, agentId, String(args.file));
              if (autoTrust && own != null && !trusted(String(args.file), own)) {
                return { isError: true, content: [{ type: "text", text: `note ${args.file} waits for the owner's review (written in a chat that read third-party content)` }] };
              }
              const text = readNote(root, agentId, String(args.file));
              if (text == null) return { isError: true, content: [{ type: "text", text: `no such note: ${args.file}` }] };
              return { content: [{ type: "text", text }] };
            }
            const dir = agentDir(agentId);
            let notes = fs.readdirSync(dir)
              .filter((name) => name.endsWith(".md"))
              .slice(0, 200)
              .map((name) => {
                const text = fs.readFileSync(path.join(dir, name), "utf8");
                const front = frontmatter(text);
                return {
                  file: name,
                  title: noteTitle(front, name),
                  reviewed: front.get("reviewed") === "true",
                  expires: front.get("expires") || null,
                  text,
                };
              });
            let unlisted = 0;
            if (autoTrust) {
              const listed = notes.filter((n) => trusted(n.file, n.text));
              unlisted = notes.length - listed.length;
              notes = listed;
            }
            notes = notes.map(({ text: _text, ...note }) => note);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  agent: agentId,
                  notes,
                  total: notes.length,
                  ...(autoTrust ? { unlisted, unlistedWhy: "notes from chats that read third-party content, waiting for the owner's review" } : {}),
                  source: "local-knowledge",
                }),
              }],
            };
          },
        },
      };
    },
  };
}

function ensureGit(root, enabled, store = null) {
  if (!enabled) return;
  if (fs.existsSync(path.join(root, ".git"))) return;
  spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", `${agentSlug()}@local`], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", agentSlug()], { cwd: root, stdio: "ignore" });
  const readme = path.join(root, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      "# Agent knowledge\n\nLocal source of truth on this server. `rules/` and `AGENT.md` need owner review before they change behaviour. `knowledge/` may auto-commit but is never auto-injected into prompts.\n",
      "utf8",
    );
  }
  writeDirectory(root, store);
  commit(root, true, "knowledge: init");
}

function writeDirectory(root, store = null) {
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const lines = ["# Agent directory\n", "Generated from the local knowledge tree.\n"];
  const profiles = store?.listAgentProfiles?.() || null;
  const entries = profiles?.length
    ? profiles.map((p) => ({ id: p.id, label: p.label, domain: p.domain }))
    : Object.keys(AGENTS).map((id) => ({ id, label: AGENTS[id].label, domain: AGENTS[id].domain }));
  for (const entry of entries) {
    lines.push(`- \`${entry.id}\` — ${entry.label}: ${entry.domain}`);
  }
  lines.push("");
  fs.writeFileSync(path.join(root, "agents", "directory.md"), lines.join("\n"), "utf8");
}

function commit(root, enabled, message) {
  if (!enabled) return false;
  if (!fs.existsSync(path.join(root, ".git"))) return false;
  spawnSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  const result = spawnSync("git", ["commit", "-m", message], { cwd: root, encoding: "utf8" });
  return result.status === 0;
}

// Reviewed, unexpired notes for an agent — the ONLY knowledge injected into prompts. The owner
// flips `reviewed: true` (reviewedRunbookSet); the agent can only write reviewed:false, so a note
// the model invented never becomes trusted on its own (guards against knowledge poisoning).
export function reviewedRunbooks(root, agentId, { max = 24, maxChars = 24000, now = Date.now() } = {}) {
  const dir = path.join(root, "agents", agentId, "knowledge");
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const out = [];
  let budget = maxChars;
  for (const name of names.sort()) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const front = frontmatter(text);
    if (front.get("reviewed") !== "true") continue;
    const expires = front.get("expires");
    if (expires && Date.parse(expires) <= now) continue;
    const title = noteTitle(front, name);
    const body = noteBody(text);
    if (!body) continue;
    const chunk = body.slice(0, Math.max(0, budget));
    if (!chunk) break;
    out.push({ file: name, title: String(title).trim(), body: chunk });
    budget -= chunk.length + title.length;
    if (out.length >= max || budget <= 0) break;
  }
  return out;
}

// The playbook: the owner's own verified notes, dropped as Markdown files with a `description:`
// front-matter line into <knowledge>/playbook/ (for example synced from their own coding-assistant
// memory). Only the one-line index goes into the prompt; the
// model reads a note in full with knowledge_list {file}. A note that looks like it holds a secret
// is never listed or served.
const NOTE_FILE = /^[a-z0-9][a-z0-9._-]{0,120}\.md$/i;

export function playbookIndex(root, { max = 250 } = {}) {
  let names;
  try {
    names = fs.readdirSync(path.join(root, "playbook")).filter((n) => NOTE_FILE.test(n) && n !== "MEMORY.md").sort();
  } catch {
    return [];
  }
  const out = [];
  for (const file of names.slice(0, max)) {
    const text = readNote(root, null, file);
    if (!text) continue;
    const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (description) out.push({ file, description: description.slice(0, 240) });
  }
  return out;
}

// One of the agent's own notes, raw (null when it is not there or the name is not a note file).
function readAgentNote(root, agentId, file) {
  if (!NOTE_FILE.test(file)) return null;
  try {
    return fs.readFileSync(path.join(root, "agents", agentId, "knowledge", file), "utf8");
  } catch {
    return null;
  }
}

function readNote(root, agentId, file) {
  if (!NOTE_FILE.test(file)) return null;
  const dirs = [agentId && path.join(root, "agents", agentId, "knowledge"), path.join(root, "playbook")].filter(Boolean);
  for (const dir of dirs) {
    try {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      return SECRET_RE.test(text) ? null : text;
    } catch {}
  }
  return null;
}

// Owner review gate: list notes (with body) and flip the reviewed flag. Returns null if missing.
export function listAgentNotes(root, agentId) {
  const dir = path.join(root, "agents", agentId, "knowledge");
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  return names.sort().map((name) => {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    const front = frontmatter(text);
    return {
      file: name,
      title: noteTitle(front, name),
      reviewed: front.get("reviewed") === "true",
      expires: front.get("expires") || null,
      at: front.get("at") || null,
      body: noteBody(text),
    };
  });
}

export function setNoteReviewed(root, agentId, file, reviewed, { git = true } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}\.md$/.test(String(file || ""))) return false;
  const full = path.join(root, "agents", agentId, "knowledge", file);
  if (!fs.existsSync(full)) return false;
  let text = fs.readFileSync(full, "utf8");
  const flag = `reviewed: ${reviewed ? "true" : "false"}`;
  const lines = text.split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end < 0) {
    text = `---\n${flag}\n---\n${text}`;
  } else {
    const at = lines.slice(1, end).findIndex((line) => /^reviewed:/.test(line));
    if (at >= 0) lines[at + 1] = flag;
    else lines.splice(1, 0, flag);
    text = lines.join("\n");
  }
  fs.writeFileSync(full, text, "utf8");
  commit(root, git, `knowledge: ${reviewed ? "review" : "unreview"} ${agentId}/${file}`);
  return true;
}

// Notes the prompt may carry when auto-trust is on: reviewed notes, plus notes isTrustedNote vouches
// for (knowledge-trust.mjs: unchanged since knowledge_write saved them in a chat that was clean up
// to then). Trust is decided at read time. Returns
// { full, index, omitted }: `full` — reviewed first, then auto-trusted, each newest first, up to
// `max` bodies / `maxChars`; `index` — every other injectable note as { title, file, trust }.
export function injectableNotes(root, agentId, { isTrustedNote = () => false, max = 24, maxChars = 24000, indexChars = 2500, now = Date.now() } = {}) {
  const dir = path.join(root, "agents", agentId, "knowledge");
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return { full: [], index: [], omitted: 0 };
  }
  const notes = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let text;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const front = frontmatter(text);
    const expires = front.get("expires");
    if (expires && Date.parse(expires) <= now) continue;
    const trust = front.get("reviewed") === "true" ? "reviewed" : isTrustedNote(agentId, name, text) ? "auto" : null;
    if (!trust) continue;
    const body = noteBody(text);
    if (!body) continue;
    let at = Date.parse(front.get("at") || "");
    if (!Number.isFinite(at)) {
      try {
        at = fs.statSync(full).mtimeMs;
      } catch {
        at = 0;
      }
    }
    notes.push({ file: name, title: noteTitle(front, name), body, trust, at });
  }
  notes.sort((a, b) => (a.trust === b.trust ? b.at - a.at || a.file.localeCompare(b.file) : a.trust === "reviewed" ? -1 : 1));
  const full = [];
  const index = [];
  let budget = maxChars;
  let indexBudget = indexChars;
  let omitted = 0;
  for (const note of notes) {
    if (full.length < max && budget > 0) {
      const chunk = note.body.length > budget ? `${note.body.slice(0, budget)}\n… (cut here; the rest: knowledge_list {file: "${note.file}"})` : note.body;
      full.push({ file: note.file, title: note.title, body: chunk, trust: note.trust });
      budget -= chunk.length + note.title.length;
      continue;
    }
    const cost = note.title.length + note.file.length + 6;
    if (cost > indexBudget) {
      omitted += 1;
      continue;
    }
    index.push({ title: note.title, file: note.file, trust: note.trust });
    indexBudget -= cost;
  }
  return { full, index, omitted };
}

export function findSecrets(text) {
  return SECRET_RE.test(String(text || ""));
}

// The frontmatter of a note as key -> value, split on "\n" only (never U+2028/U+2029/\r, which a
// title could carry): only the first block between "---" lines at the very top counts, so a body
// line like `reviewed: true` can never pass the owner's review gate.
export function frontmatter(text) {
  const out = new Map();
  const lines = String(text || "").split("\n");
  if (lines[0] !== "---") return out;
  for (let i = 1; i < lines.length && lines[i] !== "---"; i += 1) {
    const match = /^([a-z_]+):[ \t]*(.*)$/.exec(lines[i]);
    if (match && !out.has(match[1])) out.set(match[1], match[2].trim());
  }
  return out;
}

function noteTitle(front, fallback) {
  const raw = front.get("title");
  if (!raw) return fallback;
  let title = raw;
  if (raw.startsWith('"')) {
    try { title = JSON.parse(raw); } catch { title = raw.replace(/^"|"$/g, ""); }
  }
  return String(title).replace(LINE_BREAKS, " ").trim() || fallback;
}

function noteBody(text) {
  return String(text).replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}
