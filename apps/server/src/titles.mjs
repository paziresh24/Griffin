import { finalText, foldEvents, wholeRun } from "@griffin/timeline";

// Short chat titles like Cursor's sidebar: after a chat's first finished run, a small tool-less agent
// turns the question and answer into 2-5 words. Titles the owner renamed are never touched. A title the
// model could not give (429 from the title provider, owner 2026-10-22) is tried again after the next run.
export const TITLE_PROMPT = `You name chats in a sidebar. Reply with ONLY the title: 2 to 5 words, in the language of the
question (Persian when it is Persian), no quotes, no trailing punctuation, no emoji. Name the subject, not the
request (e.g. "فروش امروز", "فضای دیسک S3", "آخرین فایل باکت").`;

export const STUCK_TITLE = "گفتگو";

export function cleanTitle(raw) {
  const line = String(raw || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  const title = line.replace(/^["'«“]+|["'»”.。!؟?:]+$/g, "").replace(/\s+/g, " ").trim();
  return title.length >= 2 && title.split(" ").length <= 8 ? title.slice(0, 60) : null;
}

export function createTitler({ store, generate, timelines = null, log = console }) {
  const inFlight = new Set();

  return async function maybeTitle(chatId) {
    if (inFlight.has(chatId)) return null;
    const chat = store.getChat(chatId);
    if (!chat) return null;
    const { messages } = timelines ? (await timelines.get(chatId)).timeline : foldEvents(store.allEvents(chatId));
    const firstUser = messages.find((m) => m.role === "user");
    // A run split by a message the owner sent mid-run counts once (its last piece).
    const runs = messages.filter((m) => m.role === "assistant" && m.status !== "running" && !m.continued);
    // only while the title is still the auto one (first line of the question); named from the first run
    // «گفتگو» is what a keyless install wrote in place of a title: still the auto one, renamed now.
    const peer = String(chat.caller || "").startsWith("peer:");
    const auto = chat.title === STUCK_TITLE || (firstUser && (peer ? isPeerAutoTitle(chat.title, firstUser.text) : chat.title === autoTitle(firstUser.text)));
    if (!firstUser || !runs.length || !auto) return null;
    inFlight.add(chatId);
    try {
      const answer = finalText(wholeRun(messages, runs[0].runId) || runs[0]).slice(0, 1500);
      // A colleague's agent's request comes wrapped in the rules for it; the title is about the request.
      const question = peer ? peerRequestText(firstUser.text) : firstUser.text;
      const title = cleanTitle(await generate(`${TITLE_PROMPT}\n\nQuestion:\n${question.slice(0, 1500)}\n\nAnswer:\n${answer}`));
      const current = store.getChat(chatId);
      if (!title || current.title !== chat.title) return null;
      store.updateChat(chatId, { title });
      return title;
    } catch (error) {
      log.error?.(`[titles] ${chatId}: ${error.message}`);
      return null;
    } finally {
      inFlight.delete(chatId);
    }
  };
}

export function autoTitle(text) {
  const line = String(text).split("\n").find((part) => part.trim()) || String(text);
  return line.trim().slice(0, 80);
}

// A colleague's agent's chat (peer-tasks.mjs): until named, the title is its request's first line —
// up to 60 characters, cut at a word. Older ones carried «<agent's name>: » in front (owner 2026-10-20:
// «اول هر چت اسم اون ایجنت نوشته… چتا اسم خلاصه شده ندارن»), and the titler never took them for its own.
export function peerAutoTitle(text) {
  const line = String(text).split("\n").map((part) => part.trim()).find(Boolean) || String(text).trim();
  return line.length > 60 ? `${line.slice(0, 60).replace(/\s+\S*$/, "")}…` : line;
}

/** The request inside the message a colleague's agent's chat starts with (peerRequestMessage). */
export function peerRequestText(text) {
  // The rules above it name the tag too («متن داخل <peer_request> …»): the request is the last one.
  const all = String(text || "");
  const open = all.lastIndexOf("<peer_request>\n");
  const close = all.lastIndexOf("</peer_request>");
  return open >= 0 && close > open ? all.slice(open + "<peer_request>\n".length, close).trim() : all;
}

/** Still the automatic title of a colleague's agent's chat: the request's start, with or without «<name>: » in front. */
export function isPeerAutoTitle(title, firstUserText) {
  const request = peerRequestText(firstUserText).replace(/\s+/g, " ").trim();
  const bare = (t) => String(t || "").replace(/…$/, "").replace(/\s+/g, " ").trim();
  const own = bare(title);
  if (own && request.startsWith(own)) return true;
  const named = /^[^:\n]{1,80}:\s*([\s\S]*)$/.exec(String(title || ""));
  const rest = named ? bare(named[1]) : "";
  return Boolean(rest) && request.startsWith(rest);
}
