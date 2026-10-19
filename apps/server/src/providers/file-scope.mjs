import fs from "node:fs";
import path from "node:path";

// Claude Code's own file tools run in-process with bypassPermissions, outside Griffin's tool guard and
// two-reviewer gate (they wrap Griffin's tools only). As the app's user they could read /data (the
// owner token, engine keys, secrets.key) or write a note marked «reviewed: true» into the knowledge
// store, which then reaches every agent's rules. So a chain the owner did not start
// (a colleague's Telegram thread, a peer's request, a job, the ops room, the Telegram desk) gets no
// built-in file or web tool at all; the owner's own chats read only the workspace and write only in
// the chat's own folder, never in the knowledge store or the agent's state.

// Each built-in that touches files, and the input field holding its path.
export const FILE_TOOLS = Object.freeze({ Read: "file_path", Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path", Glob: "path", Grep: "path" });
const WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
// What a chain gets when the owner did not start it.
export const NO_FILE_TOOLS = Object.freeze(["TodoWrite"]);

// The real path of `target`, through symlinks, even when it does not exist yet (a file to be
// written): the nearest existing ancestor is resolved, the rest appended.
function realish(target) {
  let dir = target;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest.reverse());
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return target;
      rest.push(path.basename(dir));
      dir = up;
    }
  }
}

const inside = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * scope: { cwd, read: [roots], write: [roots], deny: [paths] }. Returns a check
 * (toolName, input) -> null when allowed, else the reason the call is refused (the model reads it).
 */
export function fileGuard({ cwd, read = [], write = [], deny = [] }) {
  const roots = (list) => list.filter(Boolean).map((p) => realish(path.resolve(p)));
  const readRoots = roots(read);
  const writeRoots = roots(write);
  const denied = roots(deny);
  return (toolName, input = {}) => {
    const field = FILE_TOOLS[toolName];
    if (!field) return null;
    if (toolName === "Glob") {
      const pattern = String(input.pattern || "");
      if (path.isAbsolute(pattern) || pattern.startsWith("~") || pattern.split(/[\\/]/).includes("..")) return "Glob takes a pattern relative to its path; give `path` inside the workspace instead.";
    }
    const given = input[field] == null || input[field] === "" ? cwd : String(input[field]);
    if (given.startsWith("~")) return "Paths under the home folder are outside this chat's reach.";
    const target = realish(path.resolve(cwd, given));
    if (denied.some((d) => inside(d, target))) return "This path is off limits to file tools (the knowledge store and agent state change only through the app's own tools).";
    const allowed = WRITES.has(toolName) ? writeRoots : readRoots;
    if (allowed.some((root) => inside(root, target))) return null;
    return WRITES.has(toolName)
      ? "Writing is allowed only inside this chat's own folder."
      : "Reading is allowed only inside the workspace; server data and secrets are not readable here.";
  };
}

// The SDK hook that applies a guard to every file tool call (it runs whatever the permission mode).
export function fileGuardHooks(guard) {
  return {
    PreToolUse: [
      {
        matcher: Object.keys(FILE_TOOLS).join("|"),
        hooks: [
          async (input) => {
            const why = guard(input?.tool_name, input?.tool_input || {});
            return why ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } } : {};
          },
        ],
      },
    ],
  };
}
