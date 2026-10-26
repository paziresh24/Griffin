import { changeOf } from "../review.mjs";
import { ASK_TOOL } from "../asks.mjs";
import { BROWSER_WRITE_TOOLS } from "../browser-names.mjs";

// Plan mode means «make no changes». Claude Code applies allow rules (Griffin's allowedTools, and with
// full Claude Code the owner's own settings.json) before canUseTool, so an allowed Write, Edit or Bash
// ran in plan mode without ever reaching the plan gate (a colleague's review of Karsara e11b087,
// 2026-10-20). A PreToolUse hook runs before any of those rules: this decides what it lets through.

// Built-ins that only read or plan. A subagent (Task/Agent) runs its own tools through the same hook.
const READ_BUILTINS = new Set(["Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoWrite", "ToolSearch", "ExitPlanMode", "BashOutput", "ListMcpResourcesTool", "ReadMcpResourceTool", "Task", "Agent"]);
// The app's own tools that change something but are not in the change reviewer's list (review.mjs
// changeOf covers the platform's: shells, merges, DNS, routers, SQL writes, purges, pushes …).
const APP_WRITES = new Set(["telegram_send", "telegram_edit", "telegram_delete", "knowledge_write", "jobs_create", "jobs_update", "jobs_delete", "jobs_run", "repo_write", "repo_edit", "delegate", "chat_send", "send_to_person", "edit_sent", "delete_sent", "incident_ack", "incident_update", "vcenter_vm_create", "peer_invite", "infisical_upsert", "infisical_machine_identity", "gitlab_project_member", "mcp_server_add", "mcp_server_remove", "agent_create", "agent_delete", "agent_tools_enable", "agent_tools_disable", "agent_settings_set", "preview_start", "preview_restart", "preview_stop", "cnpg_retry_bootstrap", "kube_copy_secret", ...BROWSER_WRITE_TOOLS]);
const GIT_READS = /^(status|diff|log|show|blame|shortlog)$/;

/** -> why the call is refused in plan mode, or null when it may run. mcpPrefix = "mcp__<griffin server>__". */
export function planModeRefusal(toolName, input = {}, mcpPrefix) {
  const name = String(toolName || "");
  if (READ_BUILTINS.has(name)) return null;
  const why = "Plan mode: make no changes. Read and plan, then present the plan with ExitPlanMode for the owner to approve.";
  if (mcpPrefix && name.startsWith(mcpPrefix)) {
    const bare = name.slice(mcpPrefix.length);
    if (bare === ASK_TOOL) return null;
    if (APP_WRITES.has(bare)) return why;
    if (bare === "repo_git") return GIT_READS.test(String((input?.args || [])[0] || "")) ? null : why;
    if (bare === "pg_query" && input?.write) return why;
    return changeOf(bare, input || {}) ? why : null;
  }
  // Bash, Write, Edit, NotebookEdit, KillShell, and the owner's own MCP servers (what they do is unknown).
  return why;
}
