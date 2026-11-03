// Which chats a browser has open right now: the chat page keeps one live stream (/api/chats/:id/stream)
// per chat it shows. A question asked in a chat the person is looking at is answered there; it reaches
// their Telegram only if it stays open (integrations/manager.mjs deliverOwnerAsk).
const open = new Map();

/** Count one open page of the chat; the returned function closes it (call it exactly once). */
export function watchChat(chatId) {
  const id = String(chatId);
  open.set(id, (open.get(id) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (open.get(id) || 1) - 1;
    if (left > 0) open.set(id, left);
    else open.delete(id);
  };
}

export const isWatched = (chatId) => chatId != null && (open.get(String(chatId)) || 0) > 0;
