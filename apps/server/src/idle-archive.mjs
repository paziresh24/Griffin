// Owner chats that work in a worktree and have been idle for a while are archived: the chat goes
// to the archive and the archive gives its worktree back when nothing would be lost (index.mjs).
// Never a pinned chat, nor one whose work is not over: a run (its own or a side chat's), a
// question waiting for an answer, kept messages waiting to be resent, delegated subtasks
// (`isBusy(chatId)`). A side chat's activity counts for its main chat.
export function archiveIdleChats({ store, idleMs, isBusy = () => false, now = Date.now() }) {
  const archived = [];
  for (const row of store.listWorktreeChats()) {
    const last = Math.max(Date.parse(row.updated_at) || now, Date.parse(row.side_updated_at || "") || 0);
    if (now - last < idleMs) continue;
    if ([row.id, ...store.listSideChats(row.id).map((side) => side.id)].some(isBusy)) continue;
    const days = Math.floor((now - last) / 86_400_000).toLocaleString("fa-IR");
    store.appendEvent(row.id, null, "note", { text: `بعد از ${days} روز بی‌کاری بایگانی شد.` });
    store.updateChat(row.id, { archived: true });
    archived.push(row.id);
  }
  return archived;
}
