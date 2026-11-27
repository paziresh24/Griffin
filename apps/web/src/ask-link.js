// A link that opens a new chat with a question already in the box: «#/new?ask=<text>» (a report line's
// «جزئیات» on Telegram opens the reader's own assistant ready to ask; 2026-11-24). The text is only
// written in the box: the person reads it and sends it. A link never sends anything by itself.
//
// main.jsx catches the link as the page opens (or when the hash changes), keeps the text in this tab
// and turns the address into «#/», so a reload or «back» does not fill the box again. The text waits
// across the sign-in form (it replaces the app in place); the new chat's composer takes it once.
export const ASK_LINK_MAX = 4000;
export const ASK_EVENT = "griffin:ask-link";
// A text not taken within this time (the tab stayed on another page) is let go.
export const ASK_LINK_TTL_MS = 60 * 60 * 1000;
const KEY = "griffin:ask-link";

/** The text of a «#/new?ask=…» hash: "" for a bare «#/new», null for any other hash. */
export function parseAskLink(hash) {
  const match = /^#\/new\/?(?:\?(.*))?$/s.exec(String(hash || ""));
  if (!match) return null;
  let text = "";
  try {
    text = new URLSearchParams(match[1] || "").get("ask") || "";
  } catch {
    return "";
  }
  // No control characters but line breaks and tabs; at most ASK_LINK_MAX characters, never half an emoji.
  text = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  const chars = Array.from(text);
  return chars.length > ASK_LINK_MAX ? chars.slice(0, ASK_LINK_MAX).join("").trimEnd() : text;
}

/** If `hash` is an ask link, keep its text for the new chat's box; true = the address should become «#/». */
export function catchAskLink(storage, hash, now = Date.now()) {
  const text = parseAskLink(hash);
  if (text == null) return false;
  try {
    if (text) storage?.setItem(KEY, JSON.stringify({ text, at: now }));
  } catch {
    /* private mode or a full quota: the new chat still opens, with an empty box */
  }
  return true;
}

/** The waiting text, once: it is forgotten as it is taken. "" when nothing (fresh) waits. */
export function takeAskLink(storage, now = Date.now()) {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return "";
    storage.removeItem(KEY);
    const item = JSON.parse(raw);
    if (typeof item?.text !== "string" || !(now - Number(item.at) < ASK_LINK_TTL_MS)) return "";
    return item.text;
  } catch {
    return "";
  }
}

/** The box after the link's text arrives: what was typed stays, below it; the same link twice is not doubled. */
export function joinAskLink(text, typed = "") {
  if (!typed.trim()) return text;
  if (typed.includes(text)) return typed;
  return `${text}\n\n${typed}`;
}
