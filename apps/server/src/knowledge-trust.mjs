import crypto from "node:crypto";
import { isGlobalChat, motherInfo } from "./integrations/mother.mjs";
import { thirdPartyKey } from "./related.mjs";
import { telegramOriginKey } from "./db.mjs";

// Which chats may auto-trust the notes they wrote (GRIFFIN_KNOWLEDGE_AUTO_TRUST=1, knowledge.mjs
// injectableNotes). The review gate exists against knowledge poisoning: text
// from someone other than the owner (a colleague, a Telegram message, a web page, another chat)
// must not become a standing instruction. So a chat is CLEAN only when nothing visible in it could
// have carried such text into the model's context — decided from the chat row and its stored
// events. Reading files (repo_list, repo_read, repo_search, show_media {path}) taints too: a repo or the
// workspace can hold anyone's words.
//
// A note is judged by what the database recorded when knowledge_write saved it (kv
// knote:<agent>/<file>: its chat, that chat's last event id, and the file's sha256), never by its
// frontmatter: a model with Write/Edit can rewrite a note file, and an edited or hand-made file no
// longer matches its record, so it waits for the owner's review.
//
// Tools are judged by an ALLOWLIST: a tool.started event whose name is not below taints the chat,
// so a new tool, another MCP server's tool or an empty name counts as third-party until someone
// decides otherwise here. Names as stored (claude-events.mjs strips mcp__griffin__).
export const SAFE_TOOLS = Object.freeze([
  // Claude Code built-ins whose result carries no file content. Read / Grep / Glob / Edit are left
  // out: they reach any path, including notes waiting for review and other chats' files; WebSearch /
  // WebFetch bring in the web.
  "Write", "TodoWrite", "ToolSearch",
  // Griffin's own tools whose result is the owner's own data or only an acknowledgement.
  // knowledge_list is safe because, with auto-trust on, it names and serves only trusted notes.
  // Left out on purpose (other people's words, the web, or run output): telegram_*, jobs_list
  // and jobs_update (prompts and run summaries), repo_list / repo_read / repo_search (a repo's
  // file names and files hold anyone's words: others' commits, vendored text), repo_git / repo_push (others' commits, remote answers),
  // related_chat_send, ask_agent, delegate, subtasks, feed_read, team_threads, incidents_*.
  "knowledge_write", "knowledge_list", "ask_owner", "visualize", "show_media", "chat_suggest",
  "chat_dismiss_suggestion", "chat_chapter", "todo_write", "owner_task", "jobs_create",
  "jobs_delete", "jobs_run", "agent_tools_list", "agent_tools_enable",
  "agent_tools_disable", "agent_settings_get", "agent_settings_set", "list_agents",
  "repo_edit", "repo_write",
]);
// Safe tools that still taint with some arguments: show_media {url} fetches a public URL, and
// show_media {path} hands a workspace file's text to the model, the same as a read.
export const TAINTING_ARGS = Object.freeze([["show_media", "url"], ["show_media", "path"]]);
// A user message that is not the owner's own words: a colleague's chat_send «📥 محتوای شخص ثالث از …»,
// anything marked third-party, or a hand-over from the requester's other conversation.
export const THIRD_PARTY_MARK = "محتوای شخص ثالث";
export const THIRD_PARTY_USER_PREFIXES = Object.freeze(["📥", "[همان درخواست‌کننده"]);
// A hand-off another owner chat sent with chat_send (owner-chat-tools.mjs): that chat's agent wrote
// it, maybe from content this chat never saw, so it taints like a colleague's text.
export const CHAT_SEND_PREFIX = "پیام از چت «";
const TAINT_PREFIXES = Object.freeze([...THIRD_PARTY_USER_PREFIXES, CHAT_SEND_PREFIX]);
// A user event carrying `from` was written by someone else (runner.send); only owner_web is his.
const OWNER_FROM = ["owner_web"];

const TAINT_SQL = `
  SELECT id FROM events
  WHERE chat_id = ? AND id > ? AND (
    (type = 'user' AND (
      (json_extract(data, '$.from') IS NOT NULL AND COALESCE(json_extract(data, '$.from.kind'), '') NOT IN (${OWNER_FROM.map(() => "?").join(", ")}))
      OR ${TAINT_PREFIXES.map(() => "COALESCE(json_extract(data, '$.text'), '') LIKE ? || '%'").join(" OR ")}
      OR instr(COALESCE(json_extract(data, '$.text'), ''), ?) > 0))
    OR (type = 'tool.started' AND COALESCE(json_extract(data, '$.name'), '') NOT IN (${SAFE_TOOLS.map(() => "?").join(", ")}))
    OR (type IN ('tool.started', 'tool.updated', 'tool.done') AND (
      ${TAINTING_ARGS.map(() => "(json_extract(data, '$.name') = ? AND COALESCE(json_extract(data, '$.args.' || ?), '') <> '')").join(" OR ")}))
  )
  ORDER BY id
  LIMIT 1`;
const TAINT_PARAMS = [...OWNER_FROM, ...TAINT_PREFIXES, THIRD_PARTY_MARK, ...SAFE_TOOLS, ...TAINTING_ARGS.flat()];

/**
 * isCleanChat(chatId): true only for an existing chat the owner started (not a colleague's,
 * a job's, a simulation, the global desk or a Telegram-linked one), whose parent / side-of chain is
 * clean, which — if started from a suggestion — came from a clean chat, and none of whose events
 * (up to the note's record, for isTrustedNote) show third-party content.
 */
export function createChatTrust({ store } = {}) {
  // The chat row is read fresh on every call (it can change); only the event scan is cached: the
  // first tainting event once found is final, a chat without one is re-scanned over new events.
  const taintCache = new Map(); // chatId -> { first: id | null, scanned: id }
  let taintStmt = null;
  let suggestionStmt = null;
  const taintQuery = () => (taintStmt ||= store.db.prepare(TAINT_SQL));
  const suggestionOf = (id) =>
    (suggestionStmt ||= store.db.prepare("SELECT from_chat_id FROM suggestions WHERE started_chat_id = ? LIMIT 1")).get(id);

  function chatRowClean(chat) {
    if ((chat.caller || "owner") !== "owner") return false;
    if (chat.job_id || chat.person_id || chat.sim) return false;
    if (isGlobalChat(store, chat.id) || motherInfo(store, chat.id)) return false;
    if (store.getKv?.(thirdPartyKey(chat.id))) return false;
    if (store.linksForChat?.(chat.id)?.length || store.getKv?.(telegramOriginKey(chat.id))) return false;
    return true;
  }

  function firstTaint(id) {
    const known = taintCache.get(id);
    if (known && known.first != null) return known.first;
    const lastId = store.lastEventId(id);
    if (known && known.scanned === lastId) return null;
    const hit = taintQuery().get(id, known ? known.scanned : 0, ...TAINT_PARAMS);
    taintCache.set(id, { first: hit ? hit.id : null, scanned: lastId });
    return hit ? hit.id : null;
  }

  // Clean up to event id `bound` (events.id is global, so one bound serves the parent chain too).
  function cleanUntil(chatId, bound, depth = 0) {
    if (!chatId || depth > 10) return false;
    const id = String(chatId);
    const chat = store.getChat(id);
    if (!chat || !chatRowClean(chat)) return false;
    const suggestion = suggestionOf(id);
    if (suggestion && !suggestion.from_chat_id) return false;
    // A fork (app.mjs, kv fork-of:) carries its source's whole model context.
    for (const up of [chat.parent_chat_id, chat.side_of, store.getKv?.(`fork-of:${id}`), suggestion?.from_chat_id]) {
      if (up && !cleanUntil(up, bound, depth + 1)) return false;
    }
    const first = firstTaint(id);
    return first == null || first > bound;
  }

  // The owner's own chat chain by its rows alone (no event scan): who may be shown auto-trusted notes.
  function ownerRooted(chatId, depth = 0) {
    if (!chatId || depth > 10) return false;
    const chat = store.getChat(String(chatId));
    if (!chat || (chat.caller || "owner") !== "owner" || chat.job_id || chat.person_id || chat.sim) return false;
    if (isGlobalChat(store, chat.id) || motherInfo(store, chat.id) || store.linksForChat?.(chat.id)?.length || store.getKv?.(telegramOriginKey(chat.id))) return false;
    for (const up of [chat.parent_chat_id, chat.side_of, store.getKv?.(`fork-of:${chat.id}`)]) {
      if (up && !ownerRooted(up, depth + 1)) return false;
    }
    return true;
  }

  return {
    isCleanChat: (chatId) => (chatId ? cleanUntil(chatId, Infinity) : false),
    ownerRooted,
    // Called by knowledge_write right after it saved `text` as <agent>/<file> in chat `chatId`.
    recordNote(agentId, file, chatId, text) {
      store.setKv(noteKey(agentId, file), { chat: String(chatId), event: store.lastEventId(chatId), sha: sha256(text) });
    },
    // Auto-trusted: the file is exactly what knowledge_write saved, and its chat was clean up to then.
    isTrustedNote(agentId, file, text) {
      const record = store.getKv(noteKey(agentId, file));
      if (!record?.chat || !Number.isFinite(record.event) || record.sha !== sha256(text)) return false;
      return cleanUntil(record.chat, record.event);
    },
  };
}

const noteKey = (agentId, file) => `knote:${agentId}/${file}`;
const sha256 = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");
