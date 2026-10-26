// Side chats and forks work in their main chat's worktree (index.mjs agentOptions): Claude Code
// keeps a forked session by working folder. So the tree belongs to the chain's root, and an archived
// root still has a live user while one of its side chats or forks is open.
// 2026-10-24 (a colleague): a fork of an archived chat failed every message with «Can't access
// working directory» — each run re-made the root's tree, the update that stored its path woke the
// archive listener, and the listener removed the clean tree before Claude Code started in it.

const MAX_HOPS = 20;

const upOf = (store, chat) => chat?.side_of || store.getKv?.(`fork-of:${chat?.id}`) || null;

// The chat whose worktree this chat works in: up through side_of / fork-of to the first chat that
// has neither (a fork of a fork works where its source did).
export function treeOwnerId(store, chatId) {
  let id = chatId;
  const seen = new Set([id]);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const up = upOf(store, store.getChat(id));
    if (!up || seen.has(up) || !store.getChat(up)) return id;
    seen.add(up);
    id = up;
  }
  return id;
}

// Every chat working in this chat's tree (side chats, forks, and theirs), with archived.
export function treeBorrowers(store, chatId) {
  const out = [];
  const seen = new Set([chatId]);
  const queue = [chatId];
  while (queue.length && out.length < 500) {
    for (const row of store.listTreeBorrowers(queue.shift())) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
      queue.push(row.id);
    }
  }
  return out;
}

export const hasLiveBorrower = (store, chatId) => treeBorrowers(store, chatId).some((row) => !row.archived);

// After a change to chatId: the chat whose tree may be given back now — its tree's owner, once that
// owner is archived and nobody working in its tree is still open — or null.
export function treeToRelease(store, chatId) {
  const ownerId = treeOwnerId(store, chatId);
  const owner = store.getChat(ownerId);
  if (!owner?.archived || !owner.repo) return null;
  return hasLiveBorrower(store, ownerId) ? null : ownerId;
}
