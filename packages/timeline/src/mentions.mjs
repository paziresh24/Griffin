// «@» in the composer (owner 2026-10-20: «@ به چت ها اضافه کن که بشه ایجنتای همکارا رو توی محیط چت
// تگ کرد و صدا زده بشه و کارا اونجا پیش بره» — then «کاربرد @ رو فراتر از ایجنت های همکارا کن، با @
// بشه چت های اخیر رو دید و صدا زد»). Three kinds can be tagged, each written into the message:
//   - a colleague's agent on the agents' network (kind "network", the default): @<name> → network_ask;
//   - one of this install's own agents (kind "agent"): @<label> → delegate / ask_agent;
//   - one of the owner's recent chats (kind "chat"): @«<title>» → chat_read / chat_send.
// The server finds them in the sent text and tells the chat's agent (a note on the model's copy of
// the message only). Shared by the web composer and the server so both read a handle the same way.

const ENDS = "\\s.,،:;؛!?؟)»\"'";
const word = (s) => String(s || "").trim().replace(/\s+/g, "_");
const lastWord = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).at(-1) || "";
const kindOf = (item) => item?.kind || "network";
/** A chat's title as its handle carries it: one line, no «», spaces kept. */
export const chatHandleTitle = (title) => String(title || "").replace(/[«»\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

/**
 * The handle an item is tagged by. An agent: its name (spaces → «_»); two agents of one name get their
 * owner's last name. A chat: «its title».
 */
export function mentionHandle(item, all = []) {
  if (kindOf(item) === "chat") return `«${chatHandleTitle(item?.name || item?.title) || "گفتگو"}»`;
  const base = word(item?.name || item?.id);
  const twins = all.filter((a) => a && kindOf(a) !== "chat" && a.id !== item?.id && word(a.name || a.id) === base);
  const owner = word(lastWord(item?.owner));
  return twins.length && owner ? `${base}_${owner}` : base;
}

/** The «@…» being typed right before the caret, or null: { start, query } (start = index of «@»). */
export function mentionQuery(text, caret = String(text || "").length) {
  const before = String(text || "").slice(0, caret);
  const match = /(^|\s)@([^\s@«]*)$/.exec(before);
  return match ? { start: before.length - match[2].length - 1, query: match[2] } : null;
}

/** Items whose name, handle, owner, domain or address holds the typed text; names that start with it first. */
export function filterMentionables(items, query, limit = 20) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query || "").trim().toLowerCase().replace(/_/g, " ");
  if (!q) return list.slice(0, limit);
  const flat = (s) => String(s || "").toLowerCase().replace(/_/g, " ");
  const hay = (a) => flat(`${a.name || ""} ${mentionHandle(a, list)} ${a.latin || ""} ${a.owner || ""} ${a.url || ""} ${a.domain || ""} ${kindOf(a) === "agent" ? a.id : ""}`);
  const starts = (a) => [a.name, a.latin, kindOf(a) === "chat" ? "" : mentionHandle(a, list)].some((s) => flat(s).startsWith(q));
  return list.filter((a) => hay(a).includes(q)).sort((a, b) => Number(starts(b)) - Number(starts(a))).slice(0, limit);
}

/** The text with the typed «@query» replaced by the item's handle and a space; { text, caret }. */
export function insertMention(text, caret, item, all = []) {
  const t = String(text || "");
  const at = mentionQuery(t, caret);
  if (!at) return { text: t, caret };
  const handle = `@${mentionHandle(item, all)} `;
  const rest = t.slice(caret).replace(/^\S+/, "").replace(/^ /, "");
  return { text: t.slice(0, at.start) + handle + rest, caret: at.start + handle.length };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The agents (and chats, when listed) tagged in a message — each once, in the order of the list. */
export function findMentions(text, items) {
  const list = Array.isArray(items) ? items : [];
  const t = String(text || "");
  return list.filter((a) => {
    const handle = escape(mentionHandle(a, list));
    return new RegExp(kindOf(a) === "chat" ? `(^|\\s)@${handle}` : `(^|\\s)@${handle}(?=$|[${ENDS}])`, "u").test(t);
  });
}

/** The chat titles tagged as @«…» in a message (each once), for the server to look the chats up. */
export function chatMentionTitles(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/(?:^|\s)@«([^«»\n]{1,120})»/gu)) {
    const title = chatHandleTitle(m[1]);
    if (title && !out.includes(title)) out.push(title);
  }
  return out;
}

/** What the chat's agent is told about what was tagged (rides on the message, not shown in the thread). */
export function mentionNote(found, all = found) {
  if (!found?.length) return "";
  const of = (kind) => found.filter((a) => kindOf(a) === kind);
  const parts = [];
  const own = of("agent");
  if (own.length) {
    parts.push(
      "[تگِ ایجنت‌های خودمان — Owner در این پیام این ایجنت‌ها را با @ صدا زده]\n" +
        `${own.map((a) => `- @${mentionHandle(a, all)} → delegate {agent: "${a.id}"}${a.name ? ` · ${a.name}` : ""}${a.domain ? ` (${a.domain})` : ""}`).join("\n")}\n` +
        "سهمِ آن‌ها از کار را همین‌جا با delegate به خودشان بسپار (درخواست کامل و خودبسنده، فارسی)؛ برای یک خواندنِ سریع ask_agent کافی است. گزارششان خودش به همین گفتگو برمی‌گردد — منتظر نمان، نوبت را ببند.",
    );
  }
  const network = of("network");
  if (network.length) {
    parts.push(
      "[تگِ ایجنت همکار — Owner در این پیام این ایجنت‌های شبکه را با @ صدا زده]\n" +
        `${network.map((a) => `- @${mentionHandle(a, all)} → network_ask {agent: "${a.id}"}${a.name ? ` · ${a.name}` : ""}${a.owner ? ` (ایجنتِ ${a.owner})` : ""}`).join("\n")}\n` +
        "سهمِ آن‌ها از کار را همین‌جا با network_ask به خودشان بده (پیام کامل و خودبسنده، فارسی) و جوابشان را در همین گفتگو بیاور و دنبال کن؛ " +
        "سؤالِ برگشتی را با network_reply جواب بده. جوابی که دیر برسد خودش به همین گفتگو برمی‌گردد — دوباره نپرس، نوبت را ببند.",
    );
  }
  const chats = of("chat");
  if (chats.length) {
    parts.push(
      "[تگِ گفتگو — Owner در این پیام به این گفتگوهای خودش با @ اشاره کرده]\n" +
        `${chats.map((a) => `- @${mentionHandle(a, all)} → chatId "${a.id}" (لینک: #/c/${a.id})`).join("\n")}\n` +
        "اگر برای زمینه به آن اشاره شده، با chat_read بخوانش و از همان ادامه بده؛ اگر پیام کاری یا خبری برای آن گفتگو دارد، با chat_send به آن بفرست (پیام خودبسنده). " +
        "آن گفتگو جوابش را همان‌جا می‌نویسد؛ در پاسخت بگو چه فرستادی.",
    );
  }
  return parts.join("\n\n");
}

/**
 * The text cut into plain runs and «@» tags, for drawing each tag as a chip (owner 2026-10-21: «مثل
 * دیسکورد وقتی @ فلان میزنیم اون تیکه کادر داشته باشه»): [{ text, tag }], joined back = the text.
 * A tag starts the text or follows a space: @«a chat title» once closed, or @word. With `handles`
 * (the known handles, no «@») a word is a tag only when it is one of them, so a half-typed «@so» is not.
 */
export function mentionSpans(text, handles = null) {
  const t = String(text || "");
  const known = handles ? new Set([...handles].map(String)) : null;
  const out = [];
  let last = 0;
  for (const m of t.matchAll(new RegExp(`(^|\\s)@(«[^«»\\n]{1,120}»|[^${ENDS}@«]+)`, "gu"))) {
    const handle = m[2];
    if (known && !handle.startsWith("«") && !known.has(handle)) continue;
    const start = m.index + m[1].length;
    if (start > last) out.push({ text: t.slice(last, start), tag: false });
    out.push({ text: `@${handle}`, tag: true });
    last = start + handle.length + 1;
  }
  if (last < t.length || !out.length) out.push({ text: t.slice(last), tag: false });
  return out;
}
