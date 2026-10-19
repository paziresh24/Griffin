// The Telegram message ids of private-share invites and codes (private-share.mjs) sent from the owner's
// account, per person, kept in kv so they outlive a restart. They are not the owner talking to that
// person: the reconnect catch-up (telegram-account.mjs catchUpTeam) and the inbox's dialog read
// (telegram-inbox.mjs flush) skip them, as the live handler skips them through takeQuiet.
const KEY = (peerId) => `share-sent:${peerId}`;
const KEEP = 50; // per person; a share sends one invite and at most ten codes

export function rememberShareSend(store, peerId, id) {
  if (!store?.setKv || id == null) return;
  const ids = (store.getKv(KEY(String(peerId))) || []).filter((x) => x !== Number(id));
  store.setKv(KEY(String(peerId)), [...ids, Number(id)].slice(-KEEP));
}

export function shareSendIds(store, peerId) {
  return new Set((store?.getKv?.(KEY(String(peerId))) || []).map(Number));
}
