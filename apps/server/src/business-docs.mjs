import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { genv } from "./env.mjs";

// A business knowledge repo (AGENTS.md and docs/), readable by the owner's assistant and by a
// colleague's agent (peer:*) registered while it is on — which otherwise gets no file access at all;
// an earlier colleague gets it when the owner widens that quota. Reads come from one git ref
// (origin/main), never from the working tree, so a half-edited checkout or a file outside
// AGENTS.md/docs/ (secrets, the env file, memory) can never be returned: every agent can get the
// business information easily. Off unless the install names the repo (GRIFFIN_BUSINESS_DOCS_REPO,
// businessDocsConfig below).

export const BUSINESS_DOCS_SEARCH = "business_docs_search";
export const BUSINESS_DOCS_READ = "business_docs_read";
export const BUSINESS_DOCS_TOOL_NAMES = [BUSINESS_DOCS_SEARCH, BUSINESS_DOCS_READ];
export const DEFAULT_BUSINESS_DOCS_LABEL = "the business docs repo";

const MAX_READ_CHARS = 60_000;
const MAX_MATCHES = 60;
const FETCH_EVERY_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 30_000;
// AGENTS.md at the root, or a text file under docs/. No "..", no leading slash, no NUL.
const ALLOWED_PATH = /^(?:AGENTS\.md|docs\/[^\0]+\.(?:md|yaml|yml|json|csv|txt))$/;
const SEARCH_PATHSPECS = ["md", "yaml", "yml", "json", "csv", "txt"].map((ext) => `:(glob)docs/**/*.${ext}`);

export function isAllowedDocPath(p) {
  const s = String(p || "").trim();
  if (!s || s.includes("..") || s.startsWith("/") || s.includes("\\")) return false;
  return ALLOWED_PATH.test(s);
}

function text(t) {
  return { content: [{ type: "text", text: t }] };
}
function err(t) {
  return { isError: true, content: [{ type: "text", text: t }] };
}

// ref: the remote-tracking branch by its full name — a short "origin/main" would resolve a tag of that
// name first, and a plain fetch brings tags along (review 2026-10-15).
export function createBusinessDocs({ repoDir, ref = "refs/remotes/origin/main", fetch = true, now = () => Date.now(), label = DEFAULT_BUSINESS_DOCS_LABEL, gitBin = "git", gitTimeoutMs = GIT_TIMEOUT_MS, log = console } = {}) {
  let lastFetch = 0;
  // Asynchronous, so a slow git never stalls the server's one thread; cut off at gitTimeoutMs.
  // status: git's exit code, or null when it was killed or could not start.
  const git = (args) =>
    new Promise((resolve) => {
      execFile(gitBin, ["-C", repoDir, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: gitTimeoutMs, killSignal: "SIGKILL" }, (error, stdout) => {
        const status = !error ? 0 : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "too-big" : typeof error.code === "number" ? error.code : null;
        resolve({ status, stdout: stdout || "" });
      });
    });

  // Network fetch runs in the background; reads serve the ref as it is now. GIT_TERMINAL_PROMPT=0:
  // an expired credential fails fast instead of waiting.
  function refresh() {
    if (!fetch || now() - lastFetch < FETCH_EVERY_MS) return;
    lastFetch = now();
    try {
      const child = spawn(gitBin, ["-C", repoDir, "fetch", "-q", "origin"], {
        stdio: "ignore",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 60_000,
      });
      child.on("error", (error) => log?.error?.(`[business-docs] fetch: ${error.message}`));
      child.on("exit", (code) => {
        if (code) log?.error?.(`[business-docs] fetch exited ${code}; the docs stay as last fetched (a checkout under REPOS_ROOT is refreshed by the broker)`);
      });
      child.unref();
    } catch {
      /* a failed fetch only means slightly older docs */
    }
  }

  async function search(query) {
    refresh();
    const q = String(query || "").trim();
    if (q.length < 2) return err("query: at least 2 characters");
    // Same file types read() serves, so search never shows a line read() would refuse.
    const r = await git(["grep", "-n", "-I", "-i", "-F", "-e", q, ref, "--", "AGENTS.md", ...SEARCH_PATHSPECS]);
    if (r.status === 1) return text(`no match for «${q}» in AGENTS.md or docs/ (${ref}). Start from docs/INDEX.md.`);
    // Over 8 MB of matches: the first ones are shown, as for any long result.
    if (r.status !== 0 && r.status !== "too-big") return err("search failed");
    const lines = r.stdout.split("\n").filter(Boolean).map((l) => l.slice(ref.length + 1));
    const shown = lines.slice(0, MAX_MATCHES).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
    const more = lines.length > MAX_MATCHES ? `\n… ${lines.length - MAX_MATCHES} more; narrow the query.` : "";
    return text(`${shown.join("\n")}${more}`);
  }

  async function read(p0, offset) {
    refresh();
    const p = String(p0 || "").trim();
    if (!isAllowedDocPath(p)) return err("path must be AGENTS.md or a text file under docs/ (md, yaml, json, csv, txt)");
    const r = await git(["show", `${ref}:${p}`]);
    if (r.status === "too-big") return err(`${p} is over 8 MB and cannot be read here; search it with business_docs_search instead.`);
    if (r.status !== 0) return err(`not found: ${p}. Start from docs/INDEX.md.`);
    const start = Math.max(0, Number.parseInt(offset, 10) || 0);
    const body = r.stdout.slice(start, start + MAX_READ_CHARS);
    const rest = r.stdout.length - (start + body.length);
    return text(rest > 0 ? `${body}\n\n[… ${rest} more characters; call again with offset=${start + body.length}]` : body);
  }

  return {
    search,
    read,
    tools() {
      return {
        [BUSINESS_DOCS_SEARCH]: {
          description: `Search the business knowledge (${label}: AGENTS.md and docs/). Case-insensitive text search; returns path:line:text. Start with docs/INDEX.md via business_docs_read.`,
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", description: "plain text to find (Persian or English)" } },
            required: ["query"],
            additionalProperties: false,
          },
          execute: async (args) => search(args?.query),
        },
        [BUSINESS_DOCS_READ]: {
          description: `Read one file of the business knowledge (${label}): AGENTS.md or a text file under docs/ (e.g. docs/INDEX.md). Long files come in parts; pass offset to continue.`,
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "AGENTS.md or docs/…" },
              offset: { type: "number", description: "character offset for the next part" },
            },
            required: ["path"],
            additionalProperties: false,
          },
          execute: async (args) => read(args?.path, args?.offset),
        },
      };
    },
  };
}

// The install's switch: GRIFFIN_BUSINESS_DOCS_REPO names a git checkout whose AGENTS.md + docs/ at
// origin/main become the tools; GRIFFIN_BUSINESS_DOCS_LABEL is what the tools and the prompt call it
// (unset: a neutral name). No repo => null (off).
export function businessDocsConfig(read = genv) {
  const repo = String(read("BUSINESS_DOCS_REPO", "") ?? "").trim();
  if (!repo) return null;
  return { repoDir: path.resolve(repo), label: String(read("BUSINESS_DOCS_LABEL", "") ?? "").trim() || DEFAULT_BUSINESS_DOCS_LABEL };
}

// The line the prompt gets on an install with the tools (prompt.mjs buildRules).
export const businessDocsLine = (label) => `\nBusiness docs: business_docs_search / business_docs_read read ${label} (AGENTS.md + docs/, start at docs/INDEX.md).\n`;

/**
 * The install's business docs, from its switch (businessDocsConfig). Off (no
 * switch, or the path is not a git checkout): no tools, no names in any catalog, no prompt line.
 * On: the tools, their names for the catalogs, the label for the prompt, and — once per database
 * (kv marker) — the tools enabled on the default agent, so an owner who turns them off keeps them off.
 */
export function businessDocsFeature({ config, store = null, log = console, ...options }) {
  const off = { docs: null, names: [], promptLabel: "", tools: () => ({}) };
  if (!config?.repoDir) return off;
  if (!fs.existsSync(path.join(config.repoDir, ".git"))) {
    log?.error?.(`[business-docs] GRIFFIN_BUSINESS_DOCS_REPO is not a git checkout: ${config.repoDir}`);
    return off;
  }
  const label = config.label || DEFAULT_BUSINESS_DOCS_LABEL;
  const docs = createBusinessDocs({ repoDir: config.repoDir, label, log, ...options });
  const marker = "profile-tools:business-docs-v1";
  if (store && !store.getKv(marker)) {
    if (store.getAgentProfile("griffin")) store.enableAgentTools("griffin", BUSINESS_DOCS_TOOL_NAMES);
    store.setKv(marker, { at: new Date().toISOString() });
  }
  return { docs, names: [...BUSINESS_DOCS_TOOL_NAMES], promptLabel: label, tools: () => docs.tools() };
}
