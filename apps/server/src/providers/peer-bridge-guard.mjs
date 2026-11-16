// Another install's agent is reached over the agents' network (network.mjs network_ask), never through a
// hand-made MCP bridge to its /mcp (2026-11-09, a colleague's install: a repo's .mcp.json carried a stdio
// «griffin» server that forwards to another install's /mcp with a personal peer token. The agent asked
// the other install with mcp__griffin__griffin_send, the task went «auth-required» while that install waited for its owner, the
// turn ended «منتظر مالک», and when it finished nothing woke his chat: a bridge has no follow. The
// network's network_ask follows a task that outlives its wait and wakes the asking chat with the answer.)
//
// This PreToolUse check refuses the bridge's work-starting calls — send and reply, under the griffin_* or
// the karsara_* name, on any MCP server but this install's own — and says which tool to use instead. Its
// read-only calls (wait, tasks, limits, cancel) still pass, so a task already started can be read to its
// end. Config PEER_BRIDGE_GUARD=off turns it off.

const BRIDGED = /^mcp__(.+?)__(?:griffin|karsara)_(send|reply)$/;

/** The refusal for a call to another Griffin's /mcp through a hand-made bridge, else null. own = this install's MCP server name. */
export function peerBridgeRefusal(toolName, own) {
  const m = BRIDGED.exec(String(toolName || ""));
  if (!m || m[1] === own) return null;
  const tool = own ? `mcp__${own}__network_ask` : "network_ask";
  const reply = own ? `mcp__${own}__network_reply` : "network_reply";
  return (
    `Refused: «${m[1]}» is a hand-made bridge to another install's agent. When that agent needs longer than the call (it is still working, or waits for its own owner's approval), nothing brings its answer back to this chat — it is lost. ` +
    `Use ${tool} {agent, request} instead (${m[2] === "reply" ? `and ${reply} {agent, taskId, answer} to answer its question` : "find the agent id with network_agents"}): ` +
    "its answer comes back to THIS chat by itself as «[گزارش خودکار زیرکارها — شبکهٔ ایجنت‌ها …]», so tell the asker it is in progress and end your turn. Do not retry through the bridge, Bash or curl."
  );
}
