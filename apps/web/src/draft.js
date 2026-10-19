// What the owner was typing, kept per chat in the browser: a reload or a look at
// another chat does not lose it. An emptied box (sent or cleared) forgets it.
export const MAX_DRAFT_CHARS = 50_000;
const key = (chatId) => `griffin:draft:${chatId || "new"}`;

export function loadDraft(storage, chatId) {
  try {
    return storage?.getItem(key(chatId)) || "";
  } catch {
    return "";
  }
}

export function saveDraft(storage, chatId, text) {
  try {
    if (!storage) return;
    if (!text || !text.trim() || text.length > MAX_DRAFT_CHARS) storage.removeItem(key(chatId));
    else storage.setItem(key(chatId), text);
  } catch {
    /* private mode or a full quota: typing goes on */
  }
}

// A message on its way to the server is held here until the server answers (from Karsara
// f25bb16). A page closed or reloaded mid-send loses the outbox (it lives in the page): the next
// page finds the held text and puts it back in the box. A held message with a client id that the
// chat's timeline already holds did reach the server and is dropped, so nothing is doubled.
const sendingKey = (chatId) => `griffin:sending:${chatId || "new"}`;
const inFlight = new Set(); // ids this page is still sending
let flightSeq = 0;

function readSending(storage, chatId) {
  try {
    const list = JSON.parse(storage?.getItem(sendingKey(chatId)) || "[]");
    return Array.isArray(list) ? list.filter((item) => item && typeof item.text === "string") : [];
  } catch {
    return [];
  }
}

function writeSending(storage, chatId, list) {
  try {
    if (!storage) return;
    if (!list.length) storage.removeItem(sendingKey(chatId));
    else storage.setItem(sendingKey(chatId), JSON.stringify(list));
  } catch {
    /* storage blocked: the in-page restore still works */
  }
}

/** Holds a message being sent; returns the id to release it with. */
export function holdSending(storage, chatId, text, clientId = null) {
  const id = `${Date.now().toString(36)}-${(flightSeq += 1)}`;
  inFlight.add(id);
  if (text && text.trim() && text.length <= MAX_DRAFT_CHARS) {
    writeSending(storage, chatId, [...readSending(storage, chatId), { id, text, ...(clientId ? { clientId } : {}) }]);
  }
  return id;
}

/** The server answered (delivered, refused, or taken back to the box): the held copy goes. */
export function releaseSending(storage, chatId, id) {
  inFlight.delete(id);
  writeSending(storage, chatId, readSending(storage, chatId).filter((item) => item.id !== id));
}

/** Held messages no send of this page owns (the page died mid-send), as one text for the box;
 * landed: client ids the chat's timeline holds (those arrived and are dropped). Returned once. */
export function recoverSending(storage, chatId, landed = new Set()) {
  const held = readSending(storage, chatId);
  const lost = held.filter((item) => !inFlight.has(item.id));
  if (lost.length) writeSending(storage, chatId, held.filter((item) => !lost.includes(item)));
  return lost
    .filter((item) => !(item.clientId && landed.has(item.clientId)))
    .map((item) => item.text)
    .join("\n");
}
