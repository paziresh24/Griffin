import fs from "node:fs";
import path from "node:path";
import { listAgentNotes } from "./knowledge.mjs";
import { projectSlug } from "./shared-memory.mjs";

// What this install's agent knows, for the agents' network (a colleague 2026-10-21: «هر ایجنتی یه
// مهارت‌هایی داشته باشه و بدونه … خودش بره از اون ایجنتی که مهارت داره بپرسه. اینا خودش یه مپی لازم
// داره»). Only names and titles — the owner's role, the repos it works on, the titles of its reviewed
// notes and the names of its memory notes — never a note's body or a value. The owner can add a line
// (kv network:skills).
const MAX = 40;
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 120);

export function buildSkills({ store, owner, reposRoot, knowledgeRoot, agentId, configDir }) {
  const repos = safe(() => fs.readdirSync(reposRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith(".")).map((d) => d.name)) || [];
  const notes = (safe(() => listAgentNotes(knowledgeRoot, agentId)) || []).filter((n) => n.reviewed).map((n) => clean(n.title));
  const memory = [];
  for (const repo of repos) {
    const dir = path.join(configDir || "", "projects", projectSlug(path.join(reposRoot, repo)), "memory");
    for (const name of safe(() => fs.readdirSync(dir)) || []) if (name.endsWith(".md") && name !== "MEMORY.md") memory.push(name.replace(/\.md$/, ""));
  }
  const summary = clean(store?.getKv?.("network:skills")?.text || "");
  return {
    ...(owner?.role ? { role: clean(owner.role) } : {}),
    ...(summary ? { summary } : {}),
    repos: repos.slice(0, MAX),
    knows: [...new Set([...notes, ...memory])].slice(0, MAX * 2),
  };
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
