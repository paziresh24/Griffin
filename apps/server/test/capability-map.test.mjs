import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityMap, subagentBrief, CAPABILITY_FAMILIES } from "../src/capability-map.mjs";
import { subagentHook } from "../src/providers/claude.mjs";

// The tools an owner chat had on 2026-11-02 (manifest of chat 05128c5d), plus the specialists' and
// a colleague chain's own: every one must belong to a family, so none shows up as a bare name.
const SEEN = "agent_create agent_delete agent_settings_get agent_settings_set agent_tools_disable agent_tools_enable agent_tools_list alerts_active ask_agent ask_owner ask_requester browser_click browser_close browser_console browser_eval browser_hover browser_open browser_press browser_screenshot browser_select browser_snapshot browser_tabs browser_type browser_upload browser_wait build_tool chat_archive chat_chapter chat_dismiss_suggestion chat_list chat_read chat_send chat_suggest chrome_act chrome_cdp chrome_devtools chrome_eval chrome_screenshot chrome_snapshot chrome_tabs cnpg_retry_bootstrap consult debug_exec delegate dns_lookup git_clone git_fetch git_push gitlab_commits gitlab_file gitlab_mr gitlab_mr_changes gitlab_mrs gitlab_pipeline gitlab_project_member gitlab_projects gitlab_propose gitlab_search gitlab_version grafana_dashboard grafana_panel_query grafana_query grafana_search http_check inbox_list incident_ack incident_assign incident_history incident_source_set incident_sources incident_suggest incident_update incidents_list infisical_access infisical_create_project infisical_get infisical_list infisical_machine_identity infisical_projects infisical_upsert jobs_create jobs_delete jobs_list jobs_run jobs_update knowledge_delete knowledge_edit knowledge_list knowledge_write kube_copy_secret kube_create kube_delete kube_df kube_exec kube_get kube_logs kube_secret kube_status later list_agents mcp_server_add mcp_server_list mcp_server_login mcp_server_remove metrics_query mikrotik_address_list_add mikrotik_exec mikrotik_forward_add mikrotik_ping mikrotik_print mikrotik_remove mikrotik_set_enabled network_agents network_ask network_connect network_reply notify_owner owner_task peer_connection peer_invite pg_query preview_list preview_logs preview_restart preview_start preview_stop repo_edit repo_git repo_list repo_push repo_read repo_search repo_write s3_get s3_list self_check self_fix show_media ssh_exec subtasks telegram_delete telegram_dialogs telegram_edit telegram_ledger telegram_media telegram_read telegram_send telegram_watch_list tell_owner tls_check vcenter_customization_specs vcenter_inventory vcenter_vm_create vcenter_vm_get vcenter_vms visualize web_fetch web_search arvan_cache_purge arvan_cache_settings arvan_dns_create arvan_dns_delete arvan_dns_export arvan_dns_records arvan_dnssec arvan_domains arvan_load_balancer_get arvan_page_rule_create arvan_page_rules arvan_purge_tags arvan_reports arvan_security_rules nsin_dns_records nsin_cache_purge request_full_access related_chat_send upgrade_model send_to_person updateTodos business_docs_search business_docs_read".split(" ");

test("every tool seen in a run belongs to a family", () => {
  const unmapped = SEEN.filter((n) => !CAPABILITY_FAMILIES.some((f) => (f.prefix ? n.startsWith(f.prefix) : f.names.includes(n))));
  assert.deepEqual(unmapped, []);
});

test("the map has only the families this run has, names them all, and tells the two browsers apart", () => {
  const map = capabilityMap(["kube_get", "kube_logs", "browser_open", "chrome_tabs", "later"], { chrome: "connected" });
  assert.match(map, /\(5\): browser_open chrome_tabs kube_get\/logs later/);
  assert.match(map, /kube_\*/);
  assert.match(map, /browser_\* — headless Chromium in the SANDBOX/);
  assert.match(map, /chrome_\* — the OWNER'S OWN Chrome/);
  assert.match(map, /Two browsers:/);
  assert.match(map, /later — wake THIS chat/);
  assert.doesNotMatch(map, /mikrotik|arvan_|telegram_/);
});

test("a run with only the sandbox browser is told the owner's Chrome is out of reach", () => {
  assert.match(capabilityMap(["browser_open"]), /owner's own Chrome is not reachable/);
  assert.match(capabilityMap(["browser_open", "chrome_tabs"], { chrome: "paired" }), /paired, not connected now/);
});

test("an unknown tool still shows, with its description's first sentence", () => {
  const map = capabilityMap(["brand_new_tool"], { descriptions: { brand_new_tool: "Does a new thing for the owner. Long detail here." } });
  assert.match(map, /- brand_new_tool — Does a new thing for the owner\./);
  assert.equal(capabilityMap([]), "");
});

test("the subagent brief carries the binding rules and the map, and the hook hands it over", async () => {
  const brief = subagentBrief(["infisical_upsert", "kube_get"], { ownerName: "Alex" });
  assert.match(brief, /subagent of /);
  assert.match(brief, /Secrets move only through Infisical/);
  assert.match(brief, /Tehran time/);
  assert.match(brief, /Report ONCE/);
  assert.match(brief, /Capability map/);
  const out = await subagentHook(brief).hooks[0]({ hook_event_name: "SubagentStart", agent_id: "a", agent_type: "general-purpose" });
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: brief } });
});

test("the full owner map stays small (it is in every request)", () => {
  const map = capabilityMap(SEEN);
  assert.ok(map.length < 11_000, `map is ${map.length} chars`);
});
