import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

// Read-only tools for the assistant's own workspace directory (and its linked Claude memory/*.md notes)
// when a run uses an engine without Claude Code's built-in Read/Grep/Glob (e.g. GLM, Gemini, Codex).
// Refuses symlinks escaping the roots, blocks secret/session/repo-state paths, and keeps KNOWLEDGE_ROOT out.

const MAX_LIST = 300;
const MAX_READ_LINES = 1500;
const MAX_READ_CHARS = 60_000;
const MAX_SEARCH_MATCHES = 80;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;

const SKIP_DIRS = new Set([".git", "node_modules", ".claude", ".cursor", ".griffin-openai-sessions"]);
const BLOCKED_NAME_RE =
  /^(?:\.env(?:\..+)?|\.claude\.json|secrets?\.ya?ml|secrets?\.json|credentials?\.ya?ml|credentials?\.json)$/i;
const BLOCKED_PART_RE = /(?:secret|token|credential|password|\.pem$|\.key$|\.p12$|\.pfx$|\.sqlite$|\.db$)/i;

const textRes = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], isError: false });
const errRes = (msg) => ({ content: [{ type: "text", text: String(msg) }], isError: true });

function realOrNull(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function inside(real, rootReal) {
  return real === rootReal || real.startsWith(`${rootReal}${path.sep}`);
}

function isSensitiveRel(rel) {
  const parts = String(rel || "")
    .split(path.sep)
    .filter(Boolean);
  if (!parts.length) return false;
  for (const part of parts) {
    if (SKIP_DIRS.has(part)) return true;
    if (BLOCKED_NAME_RE.test(part)) return true;
    if (BLOCKED_PART_RE.test(part)) return true;
  }
  return false;
}

export function createWorkspaceTools({ workspaceDir, memoryDir = null, knowledgeRoot = null } = {}) {
  const wsReal = workspaceDir ? realOrNull(workspaceDir) : null;
  const memReal = memoryDir ? realOrNull(memoryDir) : null;
  const knowReal = knowledgeRoot ? realOrNull(knowledgeRoot) : null;
  if (!wsReal && !memReal) return {};

  const resolveSafe = (rawPath = "") => {
    const norm = String(rawPath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (!norm) return { kind: "root", real: wsReal };

    const isMem = norm === "memory" || norm.startsWith("memory/");
    if (isMem) {
      if (!memReal) throw new Error("no assistant memory directory exists");
      const sub = norm === "memory" ? "" : norm.slice("memory/".length);
      const abs = path.resolve(memReal, sub || ".");
      const real = realOrNull(abs);
      if (!real || !inside(real, memReal)) throw new Error("path escapes assistant memory");
      if (sub && !sub.endsWith(".md") && !existsSync(real)) throw new Error("not found");
      return { kind: "memory", real, rel: sub ? `memory/${sub}` : "memory", baseReal: memReal };
    }

    if (!wsReal) throw new Error("workspace directory does not exist");
    if (isSensitiveRel(norm)) throw new Error("access to this path is restricted");
    const abs = path.resolve(wsReal, norm);
    const real = realOrNull(abs);
    if (!real || !inside(real, wsReal)) throw new Error("path escapes assistant workspace");
    if (knowReal && inside(real, knowReal)) throw new Error("use knowledge_list to read Griffin knowledge notes");
    const relFromWs = path.relative(wsReal, real);
    if (isSensitiveRel(relFromWs)) throw new Error("access to this path is restricted");
    return { kind: "workspace", real, rel: relFromWs || ".", baseReal: wsReal };
  };

  async function walk(dirReal, baseReal, prefix, isMem, out, limit) {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dirReal, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (out.length >= limit) break;
      if (ent.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(ent.name)) continue;
      if (BLOCKED_NAME_RE.test(ent.name) || BLOCKED_PART_RE.test(ent.name)) continue;
      const full = path.join(dirReal, ent.name);
      if (!isMem && knowReal && inside(full, knowReal)) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(full, baseReal, rel, isMem, out, limit);
      } else if (ent.isFile()) {
        if (isMem && !ent.name.endsWith(".md")) continue;
        out.push(rel);
      }
    }
  }

  return {
    workspace_list: {
      description:
        "List files in this assistant's working folder and its linked Claude memory notes (`memory/`). Read-only; hides secrets and internal folders.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional subfolder, e.g. hami-tools or memory" },
          limit: { type: "integer", description: "Max entries (default 150, max 300)" },
        },
        additionalProperties: false,
      },
      async execute(args) {
        try {
          const limit = Math.min(Math.max(1, Number(args?.limit) || 150), MAX_LIST);
          const target = resolveSafe(args?.path || "");
          const files = [];
          if (target.kind === "root") {
            if (memReal) files.push("memory/");
            if (wsReal) await walk(wsReal, wsReal, "", false, files, limit);
          } else if (target.kind === "memory") {
            const st = await fs.stat(target.real);
            if (st.isFile()) {
              if (!target.real.endsWith(".md")) throw new Error("only .md memory notes can be listed");
              files.push(target.rel);
            } else {
              await walk(target.real, memReal, "memory", true, files, limit);
            }
          } else {
            const st = await fs.stat(target.real);
            if (st.isFile()) {
              files.push(target.rel);
            } else {
              await walk(target.real, wsReal, target.rel === "." ? "" : target.rel, false, files, limit);
            }
          }
          return textRes({ files, total: files.length, truncated: files.length >= limit });
        } catch (error) {
          return errRes(error?.message || error);
        }
      },
    },

    workspace_read: {
      description:
        "Read one text file from this assistant's working folder (e.g. hami-tools/PLAYBOOK.md) or linked memory (`memory/<file>.md`), with line numbers and paging.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path inside the workspace or `memory/<file>.md`" },
          offset: { type: "integer", description: "First line to return (1-based, default 1)" },
          limit: { type: "integer", description: "Max lines to return (default 400, max 1500)" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(args) {
        try {
          const target = resolveSafe(args?.path || "");
          if (target.kind === "root") throw new Error("path must name a file");
          if (target.kind === "memory" && !target.real.endsWith(".md")) {
            throw new Error("only .md files inside memory/ can be read");
          }
          const st = await fs.stat(target.real);
          if (!st.isFile()) throw new Error("path is not a file");
          const raw = await fs.readFile(target.real);
          if (raw.subarray(0, 4096).includes(0)) throw new Error("binary file");
          const allLines = raw.toString("utf8").split("\n");
          const offset = Math.max(1, Number(args?.offset) || 1);
          const limit = Math.min(Math.max(1, Number(args?.limit) || 400), MAX_READ_LINES);
          const out = [];
          let chars = 0;
          let lastLine = offset - 1;
          for (let i = offset - 1; i < Math.min(allLines.length, offset - 1 + limit); i++) {
            const line = `${String(i + 1).padStart(5, " ")}  ${allLines[i]}`;
            if (chars + line.length + 1 > MAX_READ_CHARS && out.length > 0) break;
            out.push(line);
            chars += line.length + 1;
            lastLine = i + 1;
          }
          return textRes({
            path: target.rel,
            lines: allLines.length,
            shown: [offset, lastLine],
            nextOffset: lastLine < allLines.length ? lastLine + 1 : null,
            text: out.join("\n"),
          });
        } catch (error) {
          return errRes(error?.message || error);
        }
      },
    },

    workspace_search: {
      description:
        "Search text across files in this assistant's working folder and linked `memory/*.md` notes.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression or plain text to find" },
          path: { type: "string", description: "Optional subfolder or `memory`" },
          ignoreCase: { type: "boolean", description: "Case-insensitive match" },
          limit: { type: "integer", description: "Max matching lines (default 40, max 80)" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      async execute(args) {
        try {
          const pattern = String(args?.pattern || "");
          if (!pattern) throw new Error("pattern is required");
          const re = new RegExp(pattern, args?.ignoreCase ? "i" : "");
          const maxMatches = Math.min(Math.max(1, Number(args?.limit) || 40), MAX_SEARCH_MATCHES);
          const target = resolveSafe(args?.path || "");
          const files = [];
          if (target.kind === "root") {
            if (memReal) await walk(memReal, memReal, "memory", true, files, MAX_LIST);
            if (wsReal) await walk(wsReal, wsReal, "", false, files, MAX_LIST);
          } else if (target.kind === "memory") {
            const st = await fs.stat(target.real);
            if (st.isFile()) files.push(target.rel);
            else await walk(target.real, memReal, "memory", true, files, MAX_LIST);
          } else {
            const st = await fs.stat(target.real);
            if (st.isFile()) files.push(target.rel);
            else await walk(target.real, wsReal, target.rel === "." ? "" : target.rel, false, files, MAX_LIST);
          }

          const matches = [];
          for (const rel of files) {
            if (matches.length >= maxMatches) break;
            const resolved = resolveSafe(rel);
            let st;
            try {
              st = await fs.stat(resolved.real);
            } catch {
              continue;
            }
            if (!st.isFile() || st.size > MAX_SEARCH_FILE_BYTES) continue;
            let raw;
            try {
              raw = await fs.readFile(resolved.real);
            } catch {
              continue;
            }
            if (raw.subarray(0, 4096).includes(0)) continue;
            const lines = raw.toString("utf8").split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                matches.push(`${rel}:${i + 1}:${lines[i].slice(0, 240)}`);
                if (matches.length >= maxMatches) break;
              }
            }
          }
          return textRes({ matches, total: matches.length, truncated: matches.length >= maxMatches });
        } catch (error) {
          return errRes(error?.message || error);
        }
      },
    },
  };
}
