import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AGENT, resolveAgentId } from "./registry.mjs";
import { installRules } from "../prompt.mjs";

// Per-agent working directories under <workspace>/agents/<id> so two agents can run at once
// without overwriting each other's .cursor/rules. Directories every agent should be able to read
// (a repository clone, a handbook) are symlinked into each agent's cwd; name them in
// GRIFFIN_SHARED_CLONES, comma separated. The live clone under <workspace>/repos (kept fresh, see
// index.mjs) wins over a plain copy at the workspace root.

const SHARED = String(process.env.GRIFFIN_SHARED_CLONES || "").split(",").map((s) => s.trim()).filter(Boolean);

export function agentCwd(workspaceRoot, agentId = DEFAULT_AGENT) {
  return path.join(workspaceRoot, "agents", resolveAgentId(agentId));
}

export function prepareAgentWorkspaces(workspaceRoot, { agents = [DEFAULT_AGENT], linkShared = SHARED, profiles = null, reposRoot = path.join(workspaceRoot, "repos") } = {}) {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const prepared = [];
  for (const id of agents.length ? agents : [DEFAULT_AGENT]) {
    const cwd = agentCwd(workspaceRoot, id);
    fs.mkdirSync(path.join(cwd, ".cursor", "rules"), { recursive: true });
    for (const name of linkShared) {
      const target = [path.join(reposRoot, name), path.join(workspaceRoot, name)].find((dir) => fs.existsSync(path.join(dir, ".git"))) || path.join(workspaceRoot, name);
      linkSharedDir(target, path.join(cwd, name));
    }
    installRules(cwd, { agent: id, caller: "owner", profile: profiles?.[id] || null });
    prepared.push(cwd);
  }
  return prepared;
}

function linkSharedDir(target, link) {
  if (!fs.existsSync(target)) return;
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink() || st.isDirectory() || st.isFile()) {
      try {
        if (fs.realpathSync(link) === fs.realpathSync(target)) return;
      } catch {
        // broken symlink or unreadable — replace
      }
      fs.rmSync(link, { recursive: true, force: true });
    }
  } catch {
    // link does not exist yet
  }
  try {
    fs.symlinkSync(target, link, "dir");
  } catch (error) {
    console.error(`[agents] symlink ${link} → ${target}: ${error.message}`);
  }
}
