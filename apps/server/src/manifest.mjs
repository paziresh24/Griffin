// Run manifest («چرا؟»): what an engine session started with — the engine and model
// it was routed to, the agent and who called it, the tools it really got (after quotas, guards and
// review), the rules it read (stored once by hash, masked) and the reviewed knowledge in them.
// Recorded when the session is made (agentOptions: a new chat, a restart, a rewind, a fallback),
// not on every message; a reply's «چرا؟» shows the newest one before it and what changed since the
// one before that. Off the answer's path: a few small writes, no model call.
import { maskText } from "./redact.mjs";

export function buildManifest({ route = {}, agent, caller, rootCaller, mode, tools = [], rules = "", knowledge = [], playbook = 0, repo = null, seeded = 0, guards = {} }, putBlob) {
  return {
    engine: { provider: route.provider || null, model: route.model || null, effort: route.effort || null },
    agent: agent || null,
    caller: caller || null,
    rootCaller: rootCaller || caller || null,
    mode: mode || "agent",
    tools: [...new Set(tools)].sort(),
    rules: { hash: putBlob(maskText(rules)), chars: rules.length },
    knowledge: knowledge.map((note) => note.file || note.title).filter(Boolean),
    playbook,
    repo,
    seeded,
    guards,
  };
}

/** Appends the manifest to the chat with prevId + what changed since the previous one. */
export function recordManifest(store, chatId, manifest) {
  const prev = store.latestManifestEvent(chatId);
  const event = store.appendEvent(chatId, null, "manifest", { ...manifest, prevId: prev?.id ?? null, changes: diffManifests(prev?.data ?? null, manifest) });
  store.setKv(`manifest:${chatId}`, event.id);
  return event;
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** [{ kind, key, change, names? }]; prev null → []. */
export function diffManifests(prev, next) {
  if (!prev || !next) return [];
  const out = [];
  for (const key of ["provider", "model", "effort"]) {
    if ((prev.engine?.[key] ?? null) !== (next.engine?.[key] ?? null)) out.push({ kind: "engine", key, change: "changed" });
  }
  for (const key of ["agent", "caller", "mode", "repo"]) {
    if ((prev[key] ?? null) !== (next[key] ?? null)) out.push({ kind: key, key, change: "changed" });
  }
  for (const kind of ["tools", "knowledge"]) {
    const before = new Set(prev[kind] || []);
    const after = new Set(next[kind] || []);
    const added = [...after].filter((n) => !before.has(n));
    const removed = [...before].filter((n) => !after.has(n));
    if (added.length) out.push({ kind, key: "added", change: "added", names: added });
    if (removed.length) out.push({ kind, key: "removed", change: "removed", names: removed });
  }
  if (prev.rules?.hash !== next.rules?.hash) out.push({ kind: "rules", key: "rules", change: "changed" });
  if (!sameJson(prev.guards, next.guards)) out.push({ kind: "guards", key: "guards", change: "changed" });
  return out;
}
