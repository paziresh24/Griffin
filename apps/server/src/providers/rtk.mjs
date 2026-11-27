import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { genv } from "../env.mjs";

// rtk (github.com/rtk-ai/rtk, «Rust Token Killer»): a small binary that runs a shell command and prints
// a compact version of its output — exit codes pass through, and when a filter fails it prints the raw
// output. Every token a long `git diff` or `grep -rn` puts into the context is re-read on every later request
// of the chat, so Bash output is where a chat spends most.
//
// How it is wired: a PreToolUse hook on Bash (claude.mjs) feeds the command to `rtk hook claude`, which
// answers with the same command prefixed `rtk …` (`git status` → `rtk git status`). We do not use
// `rtk init -g`: that edits the owner's ~/.claude/settings.json and CLAUDE.md, which are the owner's
// files. The hook lives in code, so every chat with Bash gets it and Settings → RTK switches it off at once.
//
// What the live test of this MR found (SDK 0.3.x, a mock Anthropic server, 2026-11-22): the rewritten
// command IS what Claude Code runs and what its permission check reads — an approval card and every
// allow/deny rule see `rtk git push`, not `git push`, and our other PreToolUse guards see the original.
// So the rewrite is made only where nothing in the permission step can differ:
//   • the chat's mode asks for nothing (agent / auto = bypassPermissions) — in ask/edits/plan mode a read-only
//     `git status` would turn into a card, because `rtk git status` is not on Claude Code's read-only list;
//   • the owner has no Bash deny/ask rule in his settings (a rule written for `git push --force` would not match);
//   • the command is a plain chain of read-only commands (below), never a pipe, redirect or machine format.
// Never a risk to the command: any failure (no binary, timeout, odd answer) runs the original command, and the
// rewrite never carries a permission decision.

const SYSTEM_BIN = "/usr/local/bin/rtk";

/** The rtk binary to use, or null: GRIFFIN_RTK_BIN (dev), else the image's /usr/local/bin/rtk. Not ~/.local/bin (HOME is inside the data folder, which a chat may write) and not PATH: the server runs this file with its own env on every Bash call. */
export function rtkBinary(env = process.env, system = SYSTEM_BIN) {
  const given = genv("RTK_BIN", "", env);
  for (const file of [given, system]) {
    if (!file) continue;
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // next candidate
    }
  }
  return null;
}

let warned = false;
/** Config RTK (on by default; Settings → Configuration), read on every call so it takes effect in a chat that is already open. */
export const rtkEnabled = (env = process.env) => genv("RTK", "on", env) !== "off";

/**
 * Can this run have rtk at all? Only where Bash runs in the container: with CLAUDE_HOST the command runs on the
 * host, which needs its own rtk first (RTK_HOST=on). Never an owner's job (nobody reads its output and it may
 * parse it). The RTK switch is not read here but by the hook, per call. Returns { bin } or null.
 */
export function rtkFor({ full = false, host = false, ownerJob = false, env = process.env, system } = {}) {
  if (!full || ownerJob) return null;
  if (host && genv("RTK_HOST", "off", env) !== "on") return null;
  const bin = rtkBinary(env, system);
  if (!bin && !warned && !host && rtkEnabled(env)) {
    warned = true;
    console.error("[rtk] config RTK is on but no rtk binary was found (the image build could not download it): chats run their commands as written");
  }
  return bin ? { bin } : null;
}

// ---- which commands may be rewritten -------------------------------------------------------------------------

// Read-only git only (`git -C dir log` too): mutating git (commit, push, …) stays as written — its output is short and
// a hook's or a remote's message must reach the model whole. branch/tag/remote only in their listing forms.
// Left out on purpose (measured 2026-11-22 with the real binary): `find` (rtk regroups paths by folder), `ls` (little
// to save), `tree`, `wc` (tiny), test runners (they run code), kubectl/psql/docker/cat (their output is evidence).
const GIT_READ = new Set(["status", "log", "diff", "show", "blame", "ls-files", "shortlog", "describe"]);
const GIT_LIST = { branch: /^(-a|-r|-v|-vv|--all|--remotes|--verbose|--list|--show-current)$/, tag: /^(-l|-n\d*|--list)$/, remote: /^-v$/ };
const GREP_UNSAFE = /\s(-[a-zA-Z0-9]*[cqlLoZ][a-zA-Z0-9]*|--(count|quiet|silent|files-with-matches|files-without-match|only-matching|null|json|replace))(\s|=|$)/;
const MACHINE = /\s(--(format|pretty|json|template|porcelain|null|raw|output)(=|\s|$)|-[a-zA-Z0-9]*z(\s|$)|-o\s*(json|yaml)|--name-only|--name-status)/;

function segmentOk(segment) {
  const words = segment.trim().split(/\s+/);
  const head = words[0];
  if (!head || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || /["'$\\*?{}()[\]!]/.test(head)) return false;
  if (head === "cd") return words.length <= 2;
  if (MACHINE.test(` ${segment}`)) return false;
  switch (head) {
    case "git": {
      let i = 1;
      while (words[i] === "-C" || words[i] === "-c" || words[i] === "--no-pager") i += words[i] === "--no-pager" ? 1 : 2;
      const sub = words[i];
      if (GIT_READ.has(sub)) return true;
      return Boolean(GIT_LIST[sub]) && words.slice(i + 1).every((word) => GIT_LIST[sub].test(word));
    }
    case "grep":
    case "rg":
      return !GREP_UNSAFE.test(` ${segment}`);
    default:
      return false;
  }
}

/** true when `command` may be handed to rtk: a plain && / ; chain whose every part is one of the read-only commands above. */
export function rtkMayRewrite(command) {
  if (typeof command !== "string") return false;
  const text = command.trim();
  if (!text || text.length > 4000) return false;
  // Pipes, redirects, background, subshells, variables, heredocs, multi-line scripts: the shape of the output is someone's input.
  if (/[|<>`$\n\r]|(^|[^&])&([^&]|$)/.test(text)) return false;
  // `;` and `&&` are split on below without reading quotes, so a quoted one (`find -name 'x; ls ' -delete`) could hide a part.
  if (/["']/.test(text) && /[;&]/.test(text)) return false;
  return text.split(/&&|;/).every(segmentOk);
}

// ---- the owner's own permission rules --------------------------------------------------------------------------

const ruleCache = new Map();
function bashRulesIn(file) {
  try {
    const { mtimeMs, size } = fs.statSync(file);
    const hit = ruleCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.value;
    const permissions = JSON.parse(fs.readFileSync(file, "utf8"))?.permissions || {};
    const value = [...(permissions.deny || []), ...(permissions.ask || [])].some((rule) => /^Bash\b/.test(String(rule)));
    ruleCache.set(file, { mtimeMs, size, value });
    return value;
  } catch (error) {
    // No such file is the usual case; a file we cannot read or parse is treated as «there may be rules».
    return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? false : true;
  }
}

/** Does the owner's user/project/local settings hold a Bash deny or ask rule? Those are matched against the rewritten text, so no rewrite then. */
export function hasBashRules({ cwd, env = process.env, configDirs = [] } = {}) {
  const home = env.HOME || os.homedir();
  // Every folder Claude Code may read user settings from for this run; one with a rule is enough to stay out.
  const dirs = new Set([env.CLAUDE_CONFIG_DIR, path.join(home, ".claude"), ...configDirs].filter(Boolean));
  const files = [...dirs].map((dir) => path.join(dir, "settings.json"));
  if (cwd) files.push(path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json"));
  return files.some(bashRulesIn);
}

// ---- the hook --------------------------------------------------------------------------------------------------------

// What rtk keeps on disk: only counts and command text in history.db (`rtk gain`). RTK_TEE=0 stops the copy of the
// raw output it saves for «recall» (recall.db; measured 2026-11-22 — RTK_RECALL alone did not), and telemetry stays off. RTK_SUPPRESS_HOOK_WARNING: without `rtk init -g` rtk adds a «No hook installed» line to every output.
export const RTK_ENV = Object.freeze({ RTK_TEE: "0", RTK_RECALL: "disabled", RTK_TELEMETRY_DISABLED: "1", RTK_SUPPRESS_HOOK_WARNING: "1" });

// What the hook runs: `rtk hook claude` with the PreToolUse JSON on stdin; stdout is JSON or empty.
function runHook(bin, payload, { timeoutMs = 3000, spawnImpl = spawn, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child;
    const finish = (value, kill = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (kill) {
        try {
          child?.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish("", true), timeoutMs);
    try {
      child = spawnImpl(bin, ["hook", "claude"], { env: { HOME: env.HOME, PATH: env.PATH, ...RTK_ENV }, cwd: cwd && fs.existsSync(cwd) ? cwd : undefined, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return finish("");
    }
    child.on("error", () => finish(""));
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.length > 200_000) finish("", true);
    });
    child.on("close", (code) => finish(code === 0 ? out : ""));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * The PreToolUse hook for Bash. Returns the SDK hook output: {} (run as written) or
 * { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } } with the command rewritten.
 * updatedInput replaces the whole input, so description/timeout/run_in_background are carried over.
 * `active()` is asked on every call (the chat's mode and Settings → RTK can change while its process lives).
 */
export function rtkHook({ bin, active = () => true, rules = hasBashRules, cwd: chatCwd, configDirs, ...options }) {
  return async (input) => {
    try {
      if (input?.tool_name !== "Bash" || !active()) return {};
      const toolInput = input.tool_input || {};
      const command = toolInput.command;
      // The settings that apply are the chat's own folder's, not wherever an earlier `cd` left the shell.
      const home = chatCwd || input.cwd;
      if (!rtkMayRewrite(command) || rules({ cwd: home, configDirs })) return {};
      const raw = await runHook(bin, { tool_name: "Bash", tool_input: { command } }, { ...options, cwd: home });
      if (!raw.trim()) return {};
      const rewritten = JSON.parse(raw)?.hookSpecificOutput?.updatedInput?.command;
      if (typeof rewritten !== "string" || !rewritten.trim() || rewritten === command) return {};
      return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...toolInput, command: rewritten } } };
    } catch {
      return {};
    }
  };
}

/** Add the Bash hook to a hooks object (same shape as the other guards in claude.mjs). */
export function withRtk(hooks, rtk) {
  if (!rtk) return hooks;
  return { ...(hooks || {}), PreToolUse: [...(hooks?.PreToolUse || []), { matcher: "Bash", hooks: [rtkHook(rtk)] }] };
}

/** The run's env: rtk's folder on PATH (the rewritten command is a bare `rtk …`) and its storage switches. */
export function withRtkPath(env, rtk) {
  if (!rtk) return env;
  const dir = path.dirname(rtk.bin);
  const parts = String(env.PATH || "").split(path.delimiter);
  return { ...env, ...RTK_ENV, ...(parts.includes(dir) ? {} : { PATH: [dir, ...parts.filter(Boolean)].join(path.delimiter) }) };
}

// One line for the model: its Bash output may be shortened, and how to get the raw text.
export const RTK_NOTE =
  "Shell output: read-only git (status, log, diff, show, …) and grep/rg may run through rtk, which shortens their output (repeated lines folded, a diff with less context). Exit codes are unchanged. When you need every line or exact fields, put RTK_DISABLED=1 in front of the command (`RTK_DISABLED=1 git diff`) — and never conclude something is absent from an output that says it was truncated.";
