import test from "node:test";
import assert from "node:assert/strict";
import { planModeRefusal } from "../src/providers/plan-mode-guard.mjs";

// Plan mode refuses changes in a PreToolUse hook, because allow rules (allowedTools, the owner's
// settings.json) skip canUseTool (Mr. Rezaei's review, 2026-10-20).
const P = "mcp__iris__";
const refused = (name, input = {}) => Boolean(planModeRefusal(name, input, P));

test("plan mode: reading and planning pass, every change is refused", () => {
  for (const name of ["Read", "Glob", "Grep", "WebFetch", "TodoWrite", "ExitPlanMode", "Task"]) assert.equal(refused(name), false, name);
  for (const name of ["Write", "Edit", "NotebookEdit", "Bash", "KillShell", "mcp__someones-server__do"]) assert.equal(refused(name), true, name);
});

test("plan mode: the app's read tools pass, its writes are refused", () => {
  assert.equal(refused(`${P}kube_status`), false);
  assert.equal(refused(`${P}ask_owner`), false);
  assert.equal(refused(`${P}pg_query`), false);
  assert.equal(refused(`${P}pg_query`, { write: true }), true);
  assert.equal(refused(`${P}gitlab_mr`, { action: "merge" }), true);
  assert.equal(refused(`${P}telegram_send`, { chat: "x", text: "y" }), true);
  assert.equal(refused(`${P}repo_git`, { args: ["diff"] }), false);
  assert.equal(refused(`${P}repo_git`, { args: ["commit", "-m", "x"] }), true);
});
