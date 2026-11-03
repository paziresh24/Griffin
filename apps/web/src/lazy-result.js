// A tool result the page was sent without (its size; the server's timeline-cache.mjs liteMessages):
// the part holds { lazy: { chat, bytes } } and the card asks for the whole result when it opens.
import { unwrapResult } from "./result.js";

const KEEP = 40;
const held = new Map(); // `${chat} ${callId}` -> promise of { result, isError }; oldest first

/** The whole result of one tool call, unwrapped like any other; fetched once per tab. */
export function loadLazyResult(api, lazy, callId) {
  const key = `${lazy.chat} ${callId}`;
  let work = held.get(key);
  if (!work) {
    work = api(`/api/chats/${lazy.chat}/tool-result?callId=${encodeURIComponent(callId)}`).then((answer) =>
      unwrapResult({ status: answer.status, result: answer.result }),
    );
    // A failed fetch is not kept: opening the card again tries again.
    work.catch(() => held.get(key) === work && held.delete(key));
    held.set(key, work);
    while (held.size > KEEP) held.delete(held.keys().next().value);
  }
  return work;
}
