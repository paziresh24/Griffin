// Config CLAUDE_HOST: the owner's full Claude Code runs on the host machine as their own user (their
// ssh keys, kubectl, gh, git credentials, skills, CLAUDE.md, memory), not in the app container. Only the
// Claude Code process moves: Griffin's tools, hooks (state/file guards) and approvals still come back
// over its stdio through the SDK's control channel (spawnClaudeCodeProcess).
//
// The process starts with `ssh <target>`; the host key's authorized_keys entry forces a
// small wrapper on the host (a forced command) that reads one JSON line {cwd, args, env} from stdin
// and execs Claude Code there with the rest of stdin. The key, target and known_hosts are deploy-time
// env (GRIFFIN_CLAUDE_HOST_TARGET / _KEY / _KNOWN_HOSTS / _PORT), never config: who may run on the
// host is the deploy's call, which sections do is the owner's (config CLAUDE_HOST).
import { spawn } from "node:child_process";
import fs from "node:fs";
import { genv } from "../env.mjs";

// What the host process needs from Griffin's env: the Claude login and Claude Code's own switches,
// the proxy. Not HOME, PATH or CLAUDE_CONFIG_DIR: the host has its own.
const FORWARD = /^(ANTHROPIC_|CLAUDE_|MCP_|DISABLE_|ENABLE_|MAX_|BASH_|https?_proxy$|HTTPS?_PROXY$|no_proxy$|NO_PROXY$)/;
export const forwardEnv = (env = {}) =>
  Object.fromEntries(Object.entries(env).filter(([key, value]) => FORWARD.test(key) && key !== "CLAUDE_CONFIG_DIR" && value != null));

export function hostTarget(env = process.env) {
  const target = genv("CLAUDE_HOST_TARGET", "", env);
  const key = genv("CLAUDE_HOST_KEY", "", env);
  if (!target || !key || !fs.existsSync(key)) return null;
  return { target, key, port: genv("CLAUDE_HOST_PORT", "22", env), knownHosts: genv("CLAUDE_HOST_KNOWN_HOSTS", "", env) };
}

// Which runs go to the host: config CLAUDE_HOST off | owner (their chats) | owner+jobs (and their jobs),
// unless the chat itself says host or container (chats.runs_on, its menu). A chat of theirs in
// bypass mode («no asking») always runs as their own user, like Claude Desktop, when this
// install has a host to run on. Only runs with full Claude Code: nothing else has a terminal to move.
export function runsOnHost({ claudeCode, ownerJob = false, mode = "off", chosen = null, bypass = false }) {
  if (!claudeCode) return false;
  if (bypass && !ownerJob) return true;
  if (chosen === "host" || chosen === "container") return chosen === "host";
  return mode === "owner+jobs" || (mode === "owner" && !ownerJob);
}

export function hostSpawner({ target, key, port = "22", knownHosts = "" }, spawnImpl = spawn) {
  return ({ args, cwd, env, signal }) => {
    const child = spawnImpl(
      "ssh",
      ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", ...(knownHosts ? ["-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=yes"] : []), "-i", key, "-p", String(port), target],
      { stdio: ["pipe", "pipe", "inherit"], signal },
    );
    child.stdin.write(`${JSON.stringify({ cwd, args, env: forwardEnv(env) })}\n`);
    return child;
  };
}
