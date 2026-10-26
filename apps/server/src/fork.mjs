// «ادامه در گفتگوی تازه از اینجا»: a new chat holding a chat's conversation up to the end of one of
// its runs, in the same working folder. The turns are copied in (shown, and the seed of an
// OpenAI-engine session); a Claude run's session is forked too (SDK forkSession) so Claude keeps its
// full context. Used by POST /api/chats/:id/fork and by a colleague's chat_send into a chat the owner
// is working in (related.mjs).
import { DEFAULT_AGENT } from "./agents/registry.mjs";
import { pdfKey } from "./attachments.mjs";
import { isOwnersMessage } from "./owner-chat-tools.mjs";
import { normalizeProvider } from "./providers/ids.mjs";

// A finished turn added outside a run: the owner's text (when given) and a short answer.
export function addTurn(store, chatId, userText, answer) {
  if (userText) store.appendEvent(chatId, null, "user", { text: userText, images: 0 });
  const runId = store.startRun(chatId);
  store.appendEvent(chatId, runId, "run.started", {});
  store.appendEvent(chatId, runId, "text", { text: answer });
  store.appendEvent(chatId, runId, "run.finished", { status: "finished" });
  store.finishRun(chatId, runId, "finished");
}

// runId: the run to fork after; null = the last finished one (none yet: an empty chat in the same
// folder). Returns the new chat, or { error, status } for an unknown or unfinished run.
export async function forkChat({ store, runner, parent, runId = null, title = null }) {
  if (runId === null) {
    for (const event of store.allEvents(parent.id)) if (event.type === "run.finished" && event.runId) runId = event.runId;
  }
  let endId = 0;
  let finished = false;
  let mark = null;
  if (runId !== null) {
    for (const event of store.allEvents(parent.id)) {
      if (event.runId !== runId) continue;
      endId = event.id;
      if (event.type === "run.finished") finished = true;
      if (event.type === "checkpoint") mark = event.data;
    }
    if (!endId) return { error: "unknown reply", status: 404 };
    if (!finished) return { error: "busy", status: 409 };
  }
  const chat = store.createChat({
    title: (title || `انشعاب: ${parent.title || ""}`).slice(0, 120),
    model: parent.model || null,
    mode: parent.mode || "auto",
    agent: parent.agent || DEFAULT_AGENT,
    provider: normalizeProvider(parent.provider),
  });
  // Same folder (index.mjs agentOptions): Claude Code keeps the forked session by working folder.
  store.setKv(`fork-of:${chat.id}`, parent.id);
  store.updateChat(chat.id, {
    ...(parent.effort ? { effort: parent.effort } : {}),
    ...(parent.repo ? { repo: parent.repo, worktreePath: parent.worktree_path || null } : {}),
  });
  if (!endId) return store.getChat(chat.id);
  for (const turn of store.priorTurns(parent.id, { throughId: endId, withData: true })) {
    // Who wrote it is copied too (owner-chat-tools.mjs: the fork's title and hop read it).
    if (turn.role === "user") store.appendEvent(chat.id, null, "user", { text: turn.content, images: 0, ...(isOwnersMessage(store, turn.event) ? { ownerText: true } : {}), ...(turn.event?.data?.from ? { from: turn.event.data.from } : {}) });
    else addTurn(store, chat.id, null, turn.content);
  }
  if (mark?.lastMessageId) {
    try {
      const sessionId = await runner.forkSession?.(store.getChat(chat.id), { sessionId: mark.sessionId || parent.agent_id, upToMessageId: mark.lastMessageId });
      if (sessionId) {
        store.setAgentId(chat.id, sessionId);
        // The forked session carries the parent's PDFs: so does its budget.
        const pdfs = store.getKv(pdfKey(parent.id));
        if (pdfs) store.setKv(pdfKey(chat.id), pdfs);
      }
    } catch (error) {
      // The copied turns still seed a fresh session.
      console.error(`[fork] ${parent.id} → ${chat.id}: ${error?.message || error}`);
    }
  }
  return store.getChat(chat.id);
}
