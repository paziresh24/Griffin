// Who is speaking: the product is never the name of the speaker. Each install signs as its
// SIGNATURE setting says (persona.mjs outgoingSignature): «— <name>» by default, or the longer
// shape «— <name>، دستیارِ <owner> · <product>».
import { genv } from "./env.mjs";
import { nameOf } from "./profile.mjs";

// Per install (Settings → Configuration, PRODUCT): which product this install presents itself as.
// Both markers are recognised everywhere, so a Griffin and a Karsara know each other's messages.
export const PRODUCTS = {
  griffin: { id: "griffin", name: "گریفین", latin: "Griffin", skin: "griffin" },
  karsara: { id: "karsara", name: "کارسرا", latin: "Karsara", skin: "karsara" },
};
export const PRODUCT_MARKS = Object.values(PRODUCTS).map((p) => p.name);

export function currentProduct() {
  const id = String(genv("PRODUCT", "griffin") || "").trim().toLowerCase();
  return PRODUCTS[id] || PRODUCTS.griffin;
}

const MAX_AGENT_NAME = 32;
// The name reaches every prompt, the MCP card and every signature, and the agent can set it itself
// (agent_settings_set): so it must be a name, not a sentence that could carry an instruction.
const NOT_A_NAME = /[.!?؟:;؛،,"'«»<>[\]{}()/\\@#`*=+|~^$%&\n\r\t—–·]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Why a label cannot be an agent's name, or null when it can. */
export function agentNameError(label) {
  const name = nameOf(label);
  if (!name) return "the name is empty";
  if (NOT_A_NAME.test(String(label))) return "a name has no punctuation, quotes or line breaks";
  if ([...graphemes.segment(name)].length > MAX_AGENT_NAME) return `a name is at most ${MAX_AGENT_NAME} characters`;
  if (isProductName(name)) return "the product's name is not the assistant's name";
  return null;
}

// «کارسرا», «Karsara», «گریفین», «Griffin» (Arabic kaf/yeh too, «ایجنت …» too) are products, not names.
export function isProductName(name) {
  const flat = String(name ?? "").toLowerCase().replace(/ك/g, "ک").replace(/ي/g, "ی").replace(/^ایجنت\s*/, "").replace(/[\s\u200c\u200d]+/g, "");
  return Object.values(PRODUCTS).some((p) => flat === p.name || flat === p.latin.toLowerCase());
}

// Only what an install writes: the last line is an em dash, then a product name, «ایجنت <product>»
// or «… · <product>», on that one line. A list item «- کارسرا» or a sentence naming it is not.
// Arabic kaf/yeh spellings too («كارسرا»).
const MARKS = PRODUCT_MARKS.map((m) => m.replace(/ک/g, "[کك]").replace(/ی/g, "[یي]")).join("|");
const BIDI_TAIL = /[\s\u200e\u200f\u2066-\u2069]+$/u;
const SIGNED_LINE = new RegExp(`(?:^|\\n)[^\\S\\n]*—[^\\S\\n]*(?:ایجنت[^\\S\\n]*|[^\\n]*?[^\\S\\n]·[^\\S\\n]*)?(?:${MARKS})[^\\S\\n]*$`, "u");

/** Sent by an agent of any install, whatever it is called. */
export function isProductSigned(text) {
  return SIGNED_LINE.test(String(text ?? "").replace(BIDI_TAIL, ""));
}

// The full assistant shape only: «— <name>، دستیارِ <owner> · <product>» or «— دستیارِ <owner> ·
// <product>» on the last line. A person's «سلام\n— کارسرا» (iOS turns -- into —) does not match;
// this one decides whether someone is answered automatically as an agent.
const ASSISTANT_LINE = new RegExp(`(?:^|\\n)[^\\S\\n]*—[^\\n]*دستیار[^\\n]*[^\\S\\n]·[^\\S\\n]*(?:${MARKS})[^\\S\\n]*$`, "u");
export function isAssistantSignature(text) {
  return ASSISTANT_LINE.test(String(text ?? "").replace(BIDI_TAIL, ""));
}

// The model copying a Karsara-shaped signature: the last line «— …، دستیارِ …» or «— … · <product>», with
// a note to itself after it on that line. Returns the text before that line. Only the last line, and
// only «دستیارِ» with its kasre: a list line «— سارا، دستیار دکتر» in the body stays.
const COPIED_LINE = new RegExp(`(?:^|\\n)[^\\S\\n]*—[^\\n]*(?:،[^\\S\\n]*دستیارِ|[^\\S\\n]·[^\\S\\n]*(?:${MARKS}))[^\\n]*\\s*$`, "u");
export function cutCopiedSignature(text) {
  const body = String(text ?? "");
  const match = body.match(COPIED_LINE);
  return match ? body.slice(0, match.index).replace(/\s+$/u, "") : body;
}

/** The text without a trailing product signature line (and the blank line before it). */
export function stripProductSignature(text) {
  const body = String(text ?? "").replace(BIDI_TAIL, "");
  const match = body.match(SIGNED_LINE);
  return match ? body.slice(0, match.index).replace(/\s+$/u, "") : body;
}

// Signatures written freely: matched as a whole line, so a person's «سلام\n— علی»
// or «— علی گفت …» is not one. Arabic kaf/yeh count as Persian.
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const flat = (s) => String(s ?? "").replace(/ك/g, "ک").replace(/ي/g, "ی");

/** The text before `signature` when it starts a line and only a note «(…)» follows it there, else null. */
export function beforeSignature(text, signature) {
  const sig = flat(signature).trim();
  if (!sig) return null;
  const body = flat(text);
  // A signature of letters only («نوا») could open a sentence: then it counts on the last line alone.
  const tail = /^[\p{L}\p{M}\s\u200c]+$/u.test(sig) ? "[^\\S\\n]*(?:\\([^\\n]*)?\\s*$" : "(?=[^\\S\\n]*(?:\\n|$|\\())";
  const match = body.match(new RegExp(`(?:^|\\n)[^\\S\\n]*${esc(sig)}${tail}`, "u"));
  return match ? String(text ?? "").slice(0, match.index).replace(/\s+$/u, "") : null;
}

/** The message ends with this exact signature on its own line(s). */
export function endsWithSignature(text, signature) {
  const sig = flat(signature).trim();
  return Boolean(sig) && new RegExp(`(?:^|\\n)[^\\S\\n]*${esc(sig)}[^\\S\\n]*$`, "u").test(flat(text).replace(BIDI_TAIL, ""));
}

/** The last line is «— <one of these names>» (or «— ایجنت <name>»), nothing else on it. */
export function signedAsOneOf(text, names = []) {
  const list = names.map((n) => flat(n).trim()).filter(Boolean).sort((a, b) => b.length - a.length).map(esc);
  if (!list.length) return false;
  return new RegExp(`(?:^|\\n)[^\\S\\n]*—[^\\S\\n]*(?:ایجنت[^\\S\\n]*)?(?:${list.join("|")})[^\\S\\n]*$`, "u").test(flat(text).replace(BIDI_TAIL, ""));
}
