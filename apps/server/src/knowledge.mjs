import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AGENTS, DEFAULT_AGENT } from "./agents/registry.mjs";

// Local knowledge tree under the workspace. Authoritative on the capsule; GitLab push is
// best-effort and out of scope here. Nothing unreviewed is injected into the prompt —
// these tools only write/list files the owner can read later.

export const KNOWLEDGE_WRITE = "knowledge_write";
export const KNOWLEDGE_LIST = "knowledge_list";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BODY = 32_000;
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
  },
  additionalProperties: false,
};

export function createKnowledge({ store, root, git = true } = {}) {
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
          description:
            "Save a durable note into this agent's local knowledge git (under knowledge/agents/<id>/knowledge/). Do not put secrets. Notes are NOT auto-injected into future prompts until the owner reviews them.",
          inputSchema: writeSchema,
          async execute(args) {
            const chat = store.getChat(chatId);
            const agentId = chat?.agent || DEFAULT_AGENT;
            const title = String(args?.title || "").trim().slice(0, 120);
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
                  note: "saved locally; not injected into prompts until reviewed",
                }),
              }],
            };
          },
        },
        [KNOWLEDGE_LIST]: {
          description:
            "List local knowledge notes for an agent (filenames + titles). Does not load bodies into the prompt.",
          inputSchema: listSchema,
          async execute(args) {
            const chat = store.getChat(chatId);
            const agentId = String(args?.agent || chat?.agent || DEFAULT_AGENT);
            if (!(agentId in AGENTS)) {
              return { isError: true, content: [{ type: "text", text: `unknown agent: ${agentId}` }] };
            }
            const dir = agentDir(agentId);
            const notes = fs.readdirSync(dir)
              .filter((name) => name.endsWith(".md"))
              .slice(0, 200)
              .map((name) => {
                const text = fs.readFileSync(path.join(dir, name), "utf8");
                const title = /title:\s*(?:"([^"]*)"|([^\n]+))/.exec(text);
                const reviewed = /reviewed:\s*true/.test(text);
                const expires = /expires:\s*([^\n]+)/.exec(text)?.[1]?.trim() || null;
                return {
                  file: name,
                  title: (title?.[1] || title?.[2] || name).trim(),
                  reviewed,
                  expires,
                };
              });
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ agent: agentId, notes, total: notes.length, source: "local-knowledge" }),
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
  spawnSync("git", ["config", "user.email", "griffin@local"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "griffin"], { cwd: root, stdio: "ignore" });
  const readme = path.join(root, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      "# Griffin agent knowledge\n\nLocal source of truth on the capsule. `rules/` and `AGENT.md` need owner review before they change behaviour. `knowledge/` may auto-commit but is never auto-injected into prompts.\n",
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
export function reviewedRunbooks(root, agentId, { max = 6, maxChars = 6000, now = Date.now() } = {}) {
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
    if (!/^reviewed:\s*true\s*$/m.test(text)) continue;
    const expires = /^expires:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (expires && Date.parse(expires) <= now) continue;
    const title = (/^title:\s*(?:"([^"]*)"|(.+))$/m.exec(text) || [])[1] || (/^title:\s*(?:"([^"]*)"|(.+))$/m.exec(text) || [])[2] || name;
    const body = text.replace(/^---[\s\S]*?---\n/, "").trim();
    if (!body) continue;
    const chunk = body.slice(0, Math.max(0, budget));
    if (!chunk) break;
    out.push({ file: name, title: String(title).trim(), body: chunk });
    budget -= chunk.length + title.length;
    if (out.length >= max || budget <= 0) break;
  }
  return out;
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
    const title = (/^title:\s*(?:"([^"]*)"|(.+))$/m.exec(text) || [])[1] || (/^title:\s*(?:"([^"]*)"|(.+))$/m.exec(text) || [])[2] || name;
    return {
      file: name,
      title: String(title).trim(),
      reviewed: /^reviewed:\s*true\s*$/m.test(text),
      expires: /^expires:\s*(.+)$/m.exec(text)?.[1]?.trim() || null,
      at: /^at:\s*(.+)$/m.exec(text)?.[1]?.trim() || null,
      body: text.replace(/^---[\s\S]*?---\n/, "").trim(),
    };
  });
}

export function setNoteReviewed(root, agentId, file, reviewed, { git = true } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}\.md$/.test(String(file || ""))) return false;
  const full = path.join(root, "agents", agentId, "knowledge", file);
  if (!fs.existsSync(full)) return false;
  let text = fs.readFileSync(full, "utf8");
  if (/^reviewed:\s*(true|false)\s*$/m.test(text)) {
    text = text.replace(/^reviewed:\s*(?:true|false)\s*$/m, `reviewed: ${reviewed ? "true" : "false"}`);
  } else {
    text = text.replace(/^---\n/, `---\nreviewed: ${reviewed ? "true" : "false"}\n`);
  }
  fs.writeFileSync(full, text, "utf8");
  commit(root, git, `knowledge: ${reviewed ? "review" : "unreview"} ${agentId}/${file}`);
  return true;
}

export function findSecrets(text) {
  return SECRET_RE.test(String(text || ""));
}
