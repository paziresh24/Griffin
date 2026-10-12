import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

// File and git tools for a chat that works on a repo (its own worktree, worktrees.mjs). Every
// engine gets them — a plain chat-completions engine has no file tools of its own — and they reach only that worktree: no path
// outside it, nothing under .git, no git option that points git elsewhere. Builds and tests run in
// the sandbox, which sees the repos at the same path (debug_exec host "sandbox"); pushing goes
// through the broker (git_push) and only the chat's own branch.

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const GIT_ALLOWED = new Set(["status", "diff", "log", "show", "add", "rm", "mv", "restore", "commit", "blame", "shortlog"]);
// Options that make git read or write outside the worktree, run programs, or switch branches.
const GIT_REFUSED = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--upload-pack|--receive-pack|--ext-diff|--output|--config-env|--template|--super-prefix)(=|$)/;

function git(args, cwd, { input, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_NAME: "Griffin",
          GIT_AUTHOR_EMAIL: process.env.GRIFFIN_GIT_EMAIL || "griffin@localhost",
          GIT_COMMITTER_NAME: "Griffin",
          GIT_COMMITTER_EMAIL: process.env.GRIFFIN_GIT_EMAIL || "griffin@localhost",
          // No repo hooks (husky etc.) run inside the app container.
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: "*",
          GIT_CONFIG_KEY_1: "core.hooksPath",
          GIT_CONFIG_VALUE_1: "/dev/null",
        },
      },
      (error, stdout, stderr) => {
        // git diff/grep exit 1 for "differences" / "no match": that is an answer, not a failure.
        if (error && !(error.code === 1 && !stderr)) reject(new Error(String(stderr || error.message).trim().slice(-1500)));
        else resolve(String(stdout));
      },
    );
    if (input != null) child.stdin.end(input);
  });
}

const clip = (text, max = 60_000) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters cut)` : text);

export function createRepoChatTools({ dir, repo, branch, push }) {
  const root = path.resolve(dir);
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    /* created on first run; checked again per call */
  }

  // A path inside the worktree, never .git, never through a symlink that leaves it.
  function inside(given = ".") {
    const full = path.resolve(root, String(given || "."));
    const rel = path.relative(root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path is outside this chat's worktree (${root})`);
    if (rel.split(path.sep).includes(".git")) throw new Error(".git is off limits; use repo_git");
    let probe = full;
    for (;;) {
      try {
        const real = realpathSync(probe);
        if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) throw new Error("path leaves the worktree through a symlink");
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (probe === root) break;
        probe = path.dirname(probe);
      }
    }
    return full;
  }
  const where = { repo, branch, worktree: root };

  return {
    repo_list: {
      description: `List files of this chat's repo (${repo}, branch ${branch}): tracked and new files, .gitignore respected. Optional path prefix.`,
      inputSchema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 5000 } }, additionalProperties: false },
      async execute(args = {}) {
        const prefix = path.relative(root, inside(args.path));
        const out = await git(["ls-files", "--cached", "--others", "--exclude-standard", "--", prefix || "."], root);
        const files = out.split("\n").filter(Boolean);
        const limit = Number(args.limit) || 1000;
        return { ...where, files: files.slice(0, limit), total: files.length, truncated: files.length > limit };
      },
    },

    repo_read: {
      description: "Read a text file of this chat's repo, with line numbers. offset is the first line (1-based), limit the number of lines (default 400).",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 5000 } },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(args) {
        const file = inside(args.path);
        const stat = await fs.stat(file);
        if (stat.isDirectory()) throw new Error("that is a folder; use repo_list");
        const buffer = await fs.readFile(file);
        if (buffer.subarray(0, 8000).includes(0)) return { ...where, path: args.path, binary: true, bytes: stat.size };
        const lines = buffer.subarray(0, MAX_READ_BYTES).toString("utf8").split("\n");
        const from = (Number(args.offset) || 1) - 1;
        const count = Number(args.limit) || 400;
        const text = lines.slice(from, from + count).map((line, i) => `${String(from + i + 1).padStart(5)}  ${line}`).join("\n");
        return { path: args.path, lines: lines.length, shown: [from + 1, Math.min(from + count, lines.length)], text, ...(stat.size > MAX_READ_BYTES ? { cutAtBytes: MAX_READ_BYTES } : {}) };
      },
    },

    repo_search: {
      description: "Search this chat's repo (git grep, tracked and new files). pattern is an extended regex; path narrows it. Returns file:line:text.",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string", minLength: 1 }, path: { type: "string" }, ignoreCase: { type: "boolean" } },
        required: ["pattern"],
        additionalProperties: false,
      },
      async execute(args) {
        const prefix = path.relative(root, inside(args.path)) || ".";
        const out = await git(["grep", "-n", "-I", "-E", "--untracked", ...(args.ignoreCase ? ["-i"] : []), "-e", String(args.pattern), "--", prefix], root);
        const hits = out.split("\n").filter(Boolean);
        return { matches: hits.slice(0, 300), total: hits.length, truncated: hits.length > 300 };
      },
    },

    repo_write: {
      description: "Create or overwrite a file in this chat's repo (folders are made as needed). Prefer repo_edit for a change inside an existing file.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
      async execute(args) {
        const file = inside(args.path);
        const content = String(args.content ?? "");
        if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error("file too large (2 MB max)");
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content);
        return { path: args.path, written: Buffer.byteLength(content) };
      },
    },

    repo_edit: {
      description: "Replace text in a file of this chat's repo. old must match exactly (whitespace included) and only once, unless all is true.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, old: { type: "string", minLength: 1 }, new: { type: "string" }, all: { type: "boolean" } },
        required: ["path", "old", "new"],
        additionalProperties: false,
      },
      async execute(args) {
        const file = inside(args.path);
        const text = await fs.readFile(file, "utf8");
        const count = text.split(args.old).length - 1;
        if (!count) throw new Error("old text not found — read the file again and copy it exactly");
        if (count > 1 && !args.all) throw new Error(`old text occurs ${count} times — give more context or all:true`);
        await fs.writeFile(file, args.all ? text.split(args.old).join(args.new) : text.replace(args.old, () => args.new));
        return { path: args.path, replaced: args.all ? count : 1 };
      },
    },

    repo_git: {
      description: `Run git in this chat's worktree (branch ${branch}): ${[...GIT_ALLOWED].join(", ")}. args is the list after "git", e.g. ["commit","-m","fix: …"] or ["diff","--stat"]. Branch switching, -C/-c and options that point git elsewhere are refused. Push with repo_push.`,
      inputSchema: { type: "object", properties: { args: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 } }, required: ["args"], additionalProperties: false },
      async execute(args) {
        const list = (args.args || []).map(String);
        if (!GIT_ALLOWED.has(list[0])) throw new Error(`git ${list[0]} is not allowed here (allowed: ${[...GIT_ALLOWED].join(", ")})`);
        const refused = list.find((a) => GIT_REFUSED.test(a));
        if (refused) throw new Error(`git option ${refused} is not allowed here`);
        // Paths given to add/rm/mv/restore stay inside the worktree.
        if (["add", "rm", "mv", "restore"].includes(list[0])) for (const arg of list.slice(1)) if (!arg.startsWith("-")) inside(arg);
        return { ...where, output: clip(await git(list, root)) };
      },
    },

    repo_push: {
      description: `Push this chat's branch (${branch}) of ${repo} to GitLab (never another branch, never force). Commit first with repo_git. The answer carries the link to open a merge request.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return push({ repo, branch });
      },
    },
  };
}

// What the agent is told when a chat works on a repo.
export function repoRules({ repo, branch, dir, moved = null }) {
  const switched = moved
    ? `\nThe owner moved this chat from the repo «${moved.from}» to «${repo}»${moved.at ? ` (${moved.at.slice(0, 16)}Z)` : ""}: earlier turns about files, branches or commits refer to «${moved.from}»${moved.parked ? `, whose tree is set aside untouched at ${moved.parked} — not yours to change now` : ""}.`
    : "";
  return `## Repository of this chat
This chat works on the repo «${repo}» in its own git worktree ${dir} on branch ${branch} (nothing else touches it).
Read and change files with repo_list / repo_read / repo_search / repo_edit / repo_write; commit with repo_git; push with repo_push (only this branch — the answer has the merge-request link).
Run builds and tests in the sandbox, which sees the same path: debug_exec {host:"sandbox", command:"cd ${dir} && …"}.
Never push to or change the default branch; say what you changed and give the branch / MR link.${switched}`;
}
