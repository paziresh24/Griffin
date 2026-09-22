import { finalText, foldEvents } from "@griffin/timeline";

// Short chat titles like Cursor's sidebar: after a chat's first finished run, a small tool-less agent
// turns the question and answer into 2-5 words. Titles the owner renamed are never touched.
export const TITLE_PROMPT = `You name chats in a sidebar. Reply with ONLY the title: 2 to 5 words, in the language of the
question (Persian when it is Persian), no quotes, no trailing punctuation, no emoji. Name the subject, not the
request (e.g. "فروش امروز", "فضای دیسک S3", "آخرین فایل باکت").`;

export function cleanTitle(raw) {
  const line = String(raw || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  const title = line.replace(/^["'«“]+|["'»”.。!؟?:]+$/g, "").replace(/\s+/g, " ").trim();
  return title.length >= 2 && title.split(" ").length <= 8 ? title.slice(0, 60) : null;
}

export function createTitler({ store, generate, log = console }) {
  const inFlight = new Set();

  return async function maybeTitle(chatId, { backfill = false } = {}) {
    if (inFlight.has(chatId)) return null;
    const chat = store.getChat(chatId);
    if (!chat) return null;
    const { messages } = foldEvents(store.allEvents(chatId));
    const firstUser = messages.find((m) => m.role === "user");
    const runs = messages.filter((m) => m.role === "assistant" && m.status !== "running");
    // only the first finished run, and only while the title is still the auto one (first line of the question)
    if (!firstUser || !runs.length || (!backfill && runs.length !== 1) || chat.title !== autoTitle(firstUser.text)) return null;
    inFlight.add(chatId);
    try {
      const answer = finalText(runs[0]).slice(0, 1500);
      const title = cleanTitle(await generate(`${TITLE_PROMPT}\n\nQuestion:\n${firstUser.text.slice(0, 1500)}\n\nAnswer:\n${answer}`));
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
