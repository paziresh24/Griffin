import { OWNER_NAME } from "../owner.mjs";
import { CALL_WORD } from "../persona.mjs";

// Threads in the owner's 1:1 Telegram chats with teammates (owner 2026-09-24).
//
// A chat is either idle or locked to one Griffin thread (the existing coverage lock). While idle,
// every message — the teammate's or one the owner types by hand in Telegram — is shown to a small
// model that decides whether it opens something Griffin should take on. No assistant signature is
// needed. Once a thread is open, every message in the chat, both directions, feeds that thread.
// Griffin closes it with end_agent when the other side wraps up, and says how to reopen it
// (write «گریفین»), which works for the teammate and for their assistant alike.
// Groups never open threads on their own; they stay manual (/agent).

const REOPEN = new RegExp(`^\\s*(?:\\/griffin\\b|@?${CALL_WORD})`, "iu");

/** The teammate (or their assistant) calling Griffin back into a closed chat. */
export function wantsGriffin(text) {
  return REOPEN.test(String(text || ""));
}

// The owner's own line in a colleague thread hands the work to Griffin only when it says so
// («گریفین …», «بهتون کمک می‌کنه»); anything else («الان», an answer, a question) is the owner
// taking the conversation himself.
const HANDS_TO_GRIFFIN = new RegExp(`${CALL_WORD}|کمک\\S*\\s*می[\\u200c\\s]?کن`, "iu");
export function handsToGriffin(text) {
  return HANDS_TO_GRIFFIN.test(String(text || ""));
}

// Jev (TypeSafe System One) answers typed questions about a state with calibrated confidence, the
// same service the agentic-search project uses. Measured 2026-09-24 on real samples, ~1.1s each:
// «سلام خوبی؟» 0.02 · «ممنون حله» 0.02 · a failing-pipeline report 0.95 · an access request 0.95 ·
// «فردا جلسه ساعت چنده؟» 0.16 · «اشتباه نمیکنه؟» after the push-token alert 0.68.
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const OPEN_AT = 0.6;
const CLOSED_KINDS = new Set(["thanks", "social", "unclear"]);
const JEV_QUESTIONS = {
  open: {
    type: "noul",
    instructions:
      "Does `newest_message` open a new request, question, problem report, access request or task that Griffin " +
      "(the owner's operations agent: clusters, GitLab, databases, secrets, CDN, n8n) should take on now? " +
      "Greetings, thanks, jokes, acknowledgements, personal or scheduling talk are not.",
  },
  kind: {
    type: "choice",
    instructions: "What is `newest_message` mainly?",
    criteria: {
      request: "Asks for something to be done, fixed, changed or granted (کار، رفع، دسترسی)",
      question: "A technical or operational question that needs a checked answer",
      problem: "Reports something broken, failing or wrong",
      thanks: "Thanks, OK, done, closing the conversation (ممنون، حله، اوکی)",
      social: "Greeting, small talk, joke, personal or scheduling talk",
      unclear: "Too short or vague to act on",
    },
  },
};

/**
 * Ask Jev whether the newest message opens a thread. Fails closed: any error means "no thread".
 */
const topicOf = (text) => text.replace(/\s+/g, " ").split(" ").slice(0, 6).join(" ");

// A small LLM we control, used when Jev is unavailable so one external outage never silences every
// teammate reply (2026-10-12: TypeSafe started returning HTTP 451 and every teammate DM was skipped
// — a colleague's messages went unanswered). `ask` is a plain text->text completion (GLM); returns a
// decision or null so the caller can fall through to "no thread".
export async function classifyWithLLM({ history = [], message, from }, ask) {
  const text = String(message || "").trim();
  if (!ask || !text) return null;
  const prompt = `You decide if a Telegram message to ${OWNER_NAME} should open a task for ${OWNER_NAME}'s AI agent.
OPEN it for a request, question, problem report, access request or task to act on now.
Do NOT open for greetings, thanks, acknowledgements ("ممنون", "حله", "اوکی"), jokes, small talk, or scheduling chatter.
Sender: ${from === "owner" ? `${OWNER_NAME} (the owner)` : "a teammate"}.
Recent chat (old→new):
${history.filter(Boolean).slice(-10).join("\n").slice(-2000)}
Newest message:
${text.slice(0, 2000)}
Reply with ONLY JSON: {"open": true|false, "kind": "request|question|problem|thanks|social|unclear"}`;
  try {
    const raw = await ask(prompt);
    const json = String(raw || "").match(/\{[\s\S]*\}/)?.[0];
    const v = JSON.parse(json);
    const kind = String(v.kind || "unclear");
    const start = v.open === true && !CLOSED_KINDS.has(kind);
    return { start, topic: start ? topicOf(text) : "", reason: `glm open=${v.open} kind=${kind}` };
  } catch (error) {
    return { start: false, reason: `glm classify error: ${String(error.message).slice(0, 80)}` };
  }
}

/**
 * Ask Jev whether the newest message opens a thread. On any Jev failure, fall back to `fallbackAsk`
 * (a GLM completion) so a classifier outage does not silence teammates. If neither works, fails
 * closed ("no thread").
 */
export async function classifyThread({ history = [], message, from }, { apiKey, url = JEV_URL, fetchImpl = fetch, timeoutMs = 20_000, fallbackAsk = null } = {}) {
  const text = String(message || "").trim();
  if (!text) return { start: false, reason: "empty" };
  const fallback = async (why) => {
    if (!fallbackAsk) return { start: false, reason: why };
    const r = await classifyWithLLM({ history, message, from }, fallbackAsk);
    return r ? { ...r, reason: `${why} → ${r.reason}` } : { start: false, reason: why };
  };
  if (!apiKey) return fallback("jev not configured");
  const state = {
    sender: from === "owner" ? "owner" : "teammate",
    chat_history: history.filter(Boolean).slice(-15).join("\n"),
    newest_message: text.slice(0, 2000),
  };
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ state, model: "jev-latest", questions: JEV_QUESTIONS }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return fallback(`jev http ${response.status}`);
    const { answers } = await response.json();
    const open = Number(answers?.open?.noul);
    const kind = answers?.kind?.choice || "unclear";
    const reason = `jev open=${Number.isFinite(open) ? open.toFixed(2) : "?"} kind=${kind}(${Number(answers?.kind?.confidence || 0).toFixed(2)})`;
    const start = open >= OPEN_AT && !CLOSED_KINDS.has(kind);
    return { start, topic: start ? topicOf(text) : "", reason };
  } catch (error) {
    return fallback(`jev error: ${String(error.message).slice(0, 80)}`);
  }
}

/** First run of a new thread: announce briefly, then handle it. */
export function threadStartPrompt({ name, history = [], message, from, topic = "" }) {
  const who = name || "همکار";
  const transcript = history.filter(Boolean).slice(-20).join("\n");
  return (
    `[رشتهٔ تازه با «${who}»${topic ? ` — موضوع: ${topic}` : ""}]\n\n` +
    (transcript ? `تاریخچهٔ اخیر (قدیمی→جدید):\n${transcript}\n\n` : "") +
    (from === "owner" ? threadOwnerPrompt({ name, text: message }) : threadInboundPrompt({ name, text: message }))
  );
}

// How a message is framed is the only thing a message carries. What to do with it — reply as the
// owner, one progress line, [NO_REPLY], end_agent — is in the run's rules once (prompt.mjs
// TEAM_CONTEXT), not repeated on every message (owner 2026-09-24: «چرا هر بار باید بهش بگیم؟»).

/** A teammate's message inside an open thread. */
export function threadInboundPrompt({ name, text }) {
  return `«${name || "همکار"}»: ${String(text || "").trim()}`;
}

/** A message the owner typed by hand in Telegram while the thread is open. */
export function threadOwnerPrompt({ name, text }) {
  return `«${OWNER_NAME} در تلگرام به ${name || "همکار"}»: ${String(text || "").trim()}`;
}
