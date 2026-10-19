// Owner jobs with the owner's tools: a job the owner made can run with his full toolset. Each job
// has a mode: the chat's mode list plus «محدود» (one picker for chats and jobs, and a «بدون پرسیدن»
// job must not answer «I have no access»; this replaces the install switch OWNER_JOBS_FULL_TOOLS).
// For a job whose prompt the owner wrote himself:
//   agent («بدون پرسیدن»): the tools of his attended chats, and nothing asks, as in his own chat.
//   auto / ask / edits / plan: the same tools, but a gated call asks him (the guard's approval
//     question, closed unanswered after OWNER_JOB_ASK_MS, or earlier when the job's own timeout ends
//     the run) and is never approved without his yes; a yes covers that one call only (no chain
//     blessing, index.mjs).
//   limited: "unattended" as before: the scheduler's lean quota, no built-in file tools, and every
//     gated call refused.
// A job anyone else wrote always runs limited. No owner job gets profile-editing tools.
//
// "The owner wrote the prompt" is read from jobs options.promptChatId (jobs/index.mjs): "owner"
// when the prompt came from the jobs page, else the chat whose agent wrote it with jobs_create /
// jobs_update — and that chat's chain, from its root, must be the owner's own (knowledge-trust.mjs ownerRooted: not a
// colleague's, a peer's, a job's, the ops room, the Telegram desk or a Telegram-linked chat). A job
// with no recorded writer (made before writers were recorded) or written by any other chain stays
// unattended, exactly as today.
//
// The verdict is taken twice: when the job is written (jobWriterOf records "unknown" for a chat
// that is not the owner's at that moment) and again when it runs (fullTools).
//
// Hook point (Telegram origin): `writerVerdict(rootChatId, writerChatId)` may only VETO
// a writer chat that already passed the structural checks — false for, e.g., a chain made out of
// someone else's Telegram message. Any other answer changes nothing; it can never make a chat the
// owner's.

import path from "node:path";
import { thirdPartyKey } from "../related.mjs";

// The install switch the modes replaced: read once, by migrateJobModes, to keep each old job as it ran.
export const OWNER_JOBS_FLAG = "OWNER_JOBS_FULL_TOOLS";
export const OWNER_JOB_ASK_MS = 30 * 60_000;
// A job's modes: the chat's (Controls.jsx MODES) and «limited». A new job: «بدون پرسیدن», as a chat.
export const JOB_MODES = ["agent", "auto", "ask", "edits", "plan", "limited"];
export const DEFAULT_JOB_MODE = "agent";
export const jobMode = (value, fallback = DEFAULT_JOB_MODE) => (JOB_MODES.includes(value) ? value : JOB_MODES.includes(fallback) ? fallback : DEFAULT_JOB_MODE);
// The mode the job's run chat gets: «limited» runs as «بدون پرسیدن» inside its lean quota.
export const jobChatMode = (mode) => (jobMode(mode) === "limited" ? "agent" : jobMode(mode));

/** Once per install (kv migr:job-modes): a job stored before modes existed ran limited, or with his
 *  tools and asking where OWNER_JOBS_FULL_TOOLS=1. It keeps running exactly so; «plan» stays. */
export function migrateJobModes(store, { fullToolsFlag = false } = {}) {
  if (store.getKv?.("migr:job-modes")) return 0;
  let changed = 0;
  for (const job of store.listJobs?.() || []) {
    if (job.mode === "plan") continue;
    store.updateJob(job.id, { mode: fullToolsFlag ? "ask" : "limited" });
    changed += 1;
  }
  store.setKv?.("migr:job-modes", { at: new Date().toISOString(), changed });
  return changed;
}

/** Whether chat `id` is the owner's at this moment: its root is his own conversation
 *  (ownerRooted), neither it nor its root holds a colleague's words (related.mjs third-party mark,
 *  set by chat_send), and writerVerdict does not veto it. */
export function ownerChat(store, id, { ownerRooted = () => false, writerVerdict = () => null } = {}) {
  if (!id || id === "owner" || id === "unknown") return false;
  const root = store?.rootChatId?.(id) || id;
  if (store?.getKv?.(thirdPartyKey(id)) || store?.getKv?.(thirdPartyKey(root))) return false;
  if (!ownerRooted(root)) return false;
  return writerVerdict(root, id) !== false;
}

/** The writer a jobs tool records for chatId, decided now: the chat itself when it is the owner's
 *  (ownerChat), else "unknown". */
export function jobWriterOf(store, checks = {}) {
  return (chatId) => {
    const id = String(chatId || "");
    return ownerChat(store, id, checks) ? id : "unknown";
  };
}

/** Whether a recorded writer (or a run's starter) is the owner: "owner" (the jobs page) or a chat
 *  that is still the owner's (ownerChat). */
export function ownerWroteJob(job, { store = null, ownerRooted = () => false, writerVerdict = () => null } = {}) {
  const writer = job?.options?.promptChatId;
  if (!writer) return false;
  if (writer === "owner") return true;
  return ownerChat(store, String(writer), { ownerRooted, writerVerdict });
}

/**
 * createOwnerJobs({ store, ownerRooted, writerVerdict }).fullTools(chatId): true when chatId's chain
 * is rooted in a scheduler job chat whose job the owner wrote and whose mode is not «limited».
 * bypass(chatId): fullTools, and the job's mode is «بدون پرسیدن» (agent): nothing asks him.
 */
export function createOwnerJobs({ store, ownerRooted = () => false, writerVerdict = () => null } = {}) {
  function ownerJobOf(chatId) {
    if (!chatId) return null;
    const rootId = store?.rootChatId?.(chatId) || chatId;
    const root = store?.getChat?.(rootId);
    if (!root?.job_id || root.caller !== "scheduler" || root.sim) return null;
    const job = store.getJob?.(root.job_id);
    if (!job || jobMode(job.mode) === "limited") return null;
    // A delegated sub-chat carries its parent agent as caller, so the writer's chain is judged
    // from its root (the conversation the owner started), not from the sub-chat's own row.
    const checks = { store, ownerRooted, writerVerdict };
    if (!ownerWroteJob(job, checks)) return null;
    // A run started by hand (jobs_run, the jobs page) is judged by who started it too: the same
    // verdict as for a writer. A scheduled run has no starter (kv absent).
    const by = store.getKv?.(`jobrunby:${rootId}`);
    if (by != null && !ownerWroteJob({ options: { promptChatId: by } }, checks)) return null;
    return job;
  }
  const fullTools = (chatId) => Boolean(ownerJobOf(chatId));
  const bypass = (chatId) => jobMode(ownerJobOf(chatId)?.mode, "limited") === "agent";
  return { fullTools, bypass };
}

/**
 * What Claude Code is started with (index.mjs). fileAccess comes from runAccess: an owner job has
 * it like his attended chats, so with CLAUDE_CODE=on it gets full Claude Code — Bash included,
 * which no approval gates — and the same state guard (STATE_GUARD, on by
 * default). ownerJob tells the provider to say "the owner's scheduled job, unattended" instead of
 * "the owner's own chat".
 */
//
// In an owner job the guard also refuses commands that NAME the data folder (owner token, database,
// secrets.key, engine keys) or `jobClosed` (the broker socket) as a literal path, reads included.
// This is a speed bump, NOT a boundary (a deliberate choice): a path built at run time
// (string concatenation, base64, shell variables) passes, so an owner job's Bash runs with the
// owner's full authority — his token, his database, the platform tools, every setting. A real
// boundary would be running job Bash in the sandbox container (no data folder, no broker socket).
/** The broker socket, and its own folder unless that folder is a shared one (/tmp, /run, …). */
export function brokerPaths(socketPath) {
  if (!socketPath) return [];
  const dir = path.dirname(path.resolve(socketPath));
  return ["/", "/tmp", "/run", "/var/run", "/var/tmp"].includes(dir) ? [path.resolve(socketPath)] : [path.resolve(socketPath), dir];
}
export const JOB_READ_REASON = "This is the owner's scheduled job: do not touch the app's data folder (owner token, keys, database) or the broker socket, not even to read them. Use Griffin's own tools for platform work; their gated calls ask the owner.";
export function claudeCodeOptions({ fileAccess, claudeCodeOn, stateGuardOn, statePaths, ownerJob = false, dataDir = null, jobClosed = [] }) {
  const claudeCode = Boolean(fileAccess) && Boolean(claudeCodeOn);
  if (!claudeCode) return { claudeCode };
  // Writes into the knowledge store and the data folder: the STATE_GUARD, as in his own chats — but
  // always on in a job, whatever STATE_GUARD says.
  const out = { claudeCode, ...(stateGuardOn || ownerJob ? { stateGuard: statePaths() } : {}) };
  if (!ownerJob) return out;
  const except = out.stateGuard?.except || [];
  return { ...out, ownerJob: true, readGuard: { protect: [dataDir, ...jobClosed].filter(Boolean), except, readable: false, reason: JOB_READ_REASON } };
}

/**
 * What a run gets, from its root caller and whether it is unattended / an owner job.
 *  asOwner: the owner's attended tool set (chat tools, consult, inbox, chores, file tools).
 *  guardMode: null (no guard: the owner's attended chats), "ask" or "refuse".
 */
// bypass: an owner job in «بدون پرسیدن» — no guard question, as in his own chat.
export function runAccess({ rootCaller, unattended, ownerJob = false, bypass = false, coverage = false }) {
  const attendedOwner = rootCaller === "owner" && !unattended;
  const asOwner = attendedOwner || Boolean(ownerJob);
  const guardMode = rootCaller === "owner" || coverage || (ownerJob && bypass) ? null : unattended && !ownerJob ? "refuse" : "ask";
  return { asOwner, guardMode };
}
