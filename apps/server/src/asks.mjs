// ask_owner: lets the agent stop and ask the owner a question mid-run. The Cursor SDK has no
// ask mode, so this is a custom tool whose execute() waits for the answer posted from the UI.
// If the tool call is gone by the time the owner answers (run finished, cancelled, restart),
// the caller sends the answer as a normal follow-up message instead.
//
// Peer children (ask_agent): the question is routed to the root chat so the owner sees and
// answers it there. If the root is a scheduler/job chat, nobody is watching — auto-reject.
//
// Audience: who is allowed to answer. Anything that needs permission is for the owner — even in a
// chain a peer agent started, because the peer must never approve its own request. Only a plain
// clarification ("which cluster did you mean?") goes back to the requester, and only when the
// agent says so with audience:"requester". The owner may answer either kind.
//
// onSettled(rootChatId) fires the moment a question stops being open — answered from any
// surface (UI or Telegram), held early, or the run ended — so a caller (integrations manager)
// can delete the mirrored Telegram question and keep only genuinely open ones visible there.

import { maskText } from "./redact.mjs";

export const ASK_TOOL = "ask_owner";

export const ASK_REQUESTER_TOOL = "ask_requester";

export const OWNER = "owner";
export const REQUESTER = "requester";

/** Who should answer this question. Used both here and by the Telegram bridge, which sees only
 *  the tool.started event (the SDK calls execute() a while later). */
export function audienceFor(chat, args = {}) {
  if (args?.audience === REQUESTER && chat && chat.caller && chat.caller !== OWNER) return REQUESTER;
  return OWNER;
}

const inputSchema = {
  type: "object",
  properties: {
    question: { type: "string", description: "One clear question in Persian." },
    options: {
      type: "array",
      maxItems: 6,
      description: "2-6 concrete choices; put the recommended one first. Omit for a free-text answer.",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "short choice label" },
          description: { type: "string", description: "what choosing it means" },
        },
        required: ["label"],
        additionalProperties: false,
      },
    },
    multiSelect: { type: "boolean", description: "owner may pick several options" },
    audience: {
      type: "string",
      enum: [OWNER, REQUESTER],
      description:
        "Who answers. Default \"owner\": anything that needs permission, approval, or a decision about access — the requester may never approve their own request. Use \"requester\" only for a plain clarification about what they meant.",
    },
  },
  required: ["question"],
  additionalProperties: false,
};

const requesterSchema = {
  ...inputSchema,
  properties: Object.fromEntries(Object.entries(inputSchema.properties).filter(([key]) => key !== "audience")),
};

export function createAsks({ store = null, onSettled = () => {}, log = console } = {}) {
  const pending = new Map(); // targetChatId -> [{ question, resolve, sourceChatId, mirrorIds }]
  // Answers that arrived while the question card was visible but the SDK had not called execute() yet
  // (seen up to 12 minutes on 2026-09-15). The next question of that run takes it immediately.
  const early = new Map(); // targetChatId -> answer
  const listeners = new Map(); // targetChatId -> Set<() => void>, woken when a question starts waiting
  // The last settled owner question per chat, for the nag guard: re-asking something just answered
  // gets the previous answer back instead of buzzing the owner again (2026-09-29: a merge approval
  // was re-asked seven times over four hours, each in fresh wording).
  const NAG_MS = Math.max(0, Number(process.env.GRIFFIN_ASK_NAG_MS) || 5 * 60 * 1000);
  const settled = new Map(); // targetChatId -> { question, answer, at }

  // Token overlap between two questions: Persian digits normalized, words ≥ 3 chars plus numbers,
  // common filler dropped. The re-asked variants of one approval share its identifiers
  // (MR, 966, finmodel, مرج …) while a genuinely different question does not; and when both
  // questions carry numbers, different numbers mean different changes — never a nag match.
  const STOP = new Set(["شود", "است", "بود", "میشود", "میکنید", "دوباره", "هنوز", "باز", "برای", "را", "از", "با", "که", "این", "آن", "همان", "بشه", "کن", "کنید", "what", "the"]);
  function tokens(text) {
    const norm = String(text || "")
      .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
      .replace(/[؟?!.،؛:«»"']/g, " ")
      .toLowerCase();
    const out = new Set(
      (norm.match(/[a-z0-9_\u0600-\u06FF]+/g) || []).filter((t) => (t.length >= 3 || /^\d+$/.test(t)) && !STOP.has(t)),
    );
    return [...out];
  }
  function similar(a, b) {
    const A = tokens(a);
    const B = tokens(b);
    if (!A.length || !B.length) return false;
    const numsOf = (ts) => new Set(ts.filter((t) => /^\d+$/.test(t)));
    const na = numsOf(A);
    const nb = numsOf(B);
    if (na.size && nb.size) {
      for (const n of na) if (!nb.has(n)) return false;
    }
    let hit = 0;
    for (const t of A) if (B.includes(t)) hit += 1;
    return hit / Math.min(A.length, B.length) >= 0.5;
  }

  function targetOf(chatId) {
    if (!store?.rootChatId) return chatId;
    return store.rootChatId(chatId);
  }

  function rootIsUnwatched(rootId) {
    const root = store?.getChat?.(rootId);
    if (!root) return false;
    return root.caller === "scheduler" || root.caller === "ops" || Boolean(root.job_id);
  }

  function enqueue(chatId, question, args = {}) {
    const target = targetOf(chatId);
    const audience = args.audience === REQUESTER ? REQUESTER : OWNER;
    if (rootIsUnwatched(target)) {
      return Promise.resolve({
        answered: false,
        reason: "nobody is watching this chain (scheduler/job/ops root) — decide yourself or refuse",
      });
    }
    if (early.has(target)) {
      const answer = early.get(target);
      early.delete(target);
      return Promise.resolve(answer);
    }

    // Everything from here reaches chat timelines and Telegram (ask.pending is what the messenger
    // bridge delivers from): mask at the source. 2026-09-27: a GitLab glpat- travelled to the
    // owner's Telegram inside a model-written approval question.
    question = maskText(String(question || ""));

    // Nag guard: an owner-audience question that matches one just answered is refused with the
    // previous answer in hand — never auto-accepted (a similar-looking different change must never
    // inherit a yes), the model applies the owner's real answer through the guarded call or asks a
    // genuinely different question.
    const prior = settled.get(target);
    if (NAG_MS && audience === OWNER && args.via !== "guard" && prior && Date.now() - prior.at < NAG_MS && similar(question, prior.question)) {
      const mins = Math.max(1, Math.round((Date.now() - prior.at) / 60_000));
      log?.log?.(`[ask] ${target.slice(0, 8)} nag guard: similar question answered ${mins}m ago — refusing the duplicate`);
      return Promise.resolve({
        answered: false,
        duplicate: true,
        reason: `این سؤال ${mins} دقیقه پیش جواب گرفته: «${String(prior.answer?.answer || "").slice(0, 160)}». همان جواب معتبر است و دوباره پرسیدن ممنوع — اگر منظورت همان کار قبلی است، ابزارش را صدا بزن (تأییدش را خود سیستم می‌پوشاند)؛ اگر واقعاً سؤال/تغییر دیگری است، جزئیات متمایزش را واضح بنویس و یک‌بار بپرس.`,
      });
    }
    const options = Array.isArray(args.options)
      ? args.options.map((option) =>
          option && typeof option === "object"
            ? { ...option, label: maskText(String(option.label ?? "")), ...(option.description ? { description: maskText(String(option.description)) } : {}) }
            : option,
        )
      : args.options;
    args = { ...args, options };

    // Mirror the question onto the root chat so AskCard appears where the owner is looking.
    const mirrorIds = [];
    if (store && target !== chatId) {
      const started = store.appendEvent(target, null, "tool.started", {
        callId: `peer-ask-${Date.now()}`,
        name: ASK_TOOL,
        args: { question, options: args.options, multiSelect: args.multiSelect, audience },
        fromChatId: chatId,
      });
      mirrorIds.push(started.id);
    }

    const item = { question, audience, sourceChatId: chatId, mirrorIds, by: null, options: Array.isArray(options) ? options : null };
    return new Promise((resolve) => {
      if (!pending.has(target)) pending.set(target, []);
      Object.assign(item, {
        resolve: (answer) => {
          if (store && mirrorIds.length) {
            store.appendEvent(target, null, "tool.done", {
              callId: `peer-ask-done`,
              name: ASK_TOOL,
              args: { question, options: args.options, multiSelect: args.multiSelect },
              result: answer,
              answeredBy: item.by || null,
              fromChatId: chatId,
            });
          }
          resolve(answer);
        },
      });
      pending.get(target).push(item);
      // The messenger bridge delivers from this, not from tool.started: providers that stream
      // tool arguments (openai-compatible) log tool.started with empty args, so no question ever reached
      // Telegram after 2026-09-24's engine switch. This carries the real text and audience.
      store?.appendEvent?.(target, null, "ask.pending", {
        question, options: args.options, multiSelect: args.multiSelect, audience, fromChatId: chatId,
      });
      for (const wake of listeners.get(target) || []) wake();
    });
  }

  function settle(chatId, text, { by = OWNER } = {}) {
    const target = targetOf(chatId);
    const queue = pending.get(target);
    const next = queue?.[0];
    if (!next) return false;
    // A question for the owner can only be settled by the owner: the peer agent that asked for
    // the work must not be able to approve it by answering its own task's question.
    if (next.audience === OWNER && by !== OWNER) return false;
    queue.shift();
    if (!queue.length) pending.delete(target);
    next.by = by;
    next.resolve(text);
    if (text?.answered) {
      // Who answered an approval matters after the fact; without this the log cannot say whether
      // the owner tapped it or the requester replied.
      log?.log?.(`[ask] ${target.slice(0, 8)} ${next.audience} question answered by ${by}: ${String(text.answer || "").slice(0, 80)}`);
    }
    // by/question/options let a caller (the guard's owner-answer bridge) tell an approval apart
    // from a clarification without re-reading the event log.
    if (text?.answered) settled.set(target, { question: next.question, answer: text, at: Date.now() });
    onSettled(target, {
      answer: text?.answered ? text.answer : null,
      cancelled: !text?.answered,
      by,
      question: next.question,
      options: next.options,
    }); // no longer open — e.g. close the mirrored Telegram message
    return true;
  }

  return {
    tool(chatId) {
      return {
        description:
          "Ask the owner a question and wait for the answer. Use it when the request is ambiguous, when several reasonable paths exist, or before a risky/irreversible action. Do not use it for things you can find out with other tools.",
        inputSchema,
        async execute(args) {
          const question = String(args?.question || "").trim();
          if (!question) return { isError: true, content: [{ type: "text", text: "question is required" }] };
          const audience = audienceFor(store?.getChat?.(chatId), args || {});
          const answer = await enqueue(chatId, question, { ...(args || {}), audience });
          return { content: [{ type: "text", text: JSON.stringify(answer) }] };
        },
      };
    },

    // Talking to whoever asked (a colleague's agent over /mcp, a teammate in a coverage chat)
    // instead of the owner. Real work often needs a word with them — which namespace, which
    // repo, is this the app you meant — and that is not the owner's question. In the owner's own
    // chats there is nobody else to ask, so it is the same as ask_owner.
    requesterTool(chatId) {
      return {
        description:
          "Ask the person or agent who sent this request a question and wait for their answer. Use it for anything only they can answer: what they meant, which system/app/branch, what they already tried. Never use it to get permission — approval and access decisions go to the owner with ask_owner.",
        // Built without the audience key at all: the SDK serializes the schema through protobuf,
        // where a present-but-undefined property is a decode error, not an omission.
        inputSchema: requesterSchema,
        async execute(args) {
          const question = String(args?.question || "").trim();
          if (!question) return { isError: true, content: [{ type: "text", text: "question is required" }] };
          const audience = audienceFor(store?.getChat?.(chatId), { audience: REQUESTER });
          const answer = await enqueue(chatId, question, { ...(args || {}), audience });
          return { content: [{ type: "text", text: JSON.stringify(answer) }] };
        },
      };
    },

    // Same waiting mechanism for tools that need the owner's go-ahead (e.g. telegram_send); resolves with
    // { answered, answer, selected } or { answered: false, reason }.
    // The options travel with the question: a delegated child's confirm is delivered from its
    // mirror on the root chat, and without them it reached Telegram with no buttons.
    confirm(chatId, { question, options = [{ label: "بله" }, { label: "نه" }] }) {
      // via:"guard" — the guard's own approval flow manages its own repeats (decision cache +
      // unanswered map), so the nag guard must not swallow its questions.
      return enqueue(chatId, String(question || ""), { audience: OWNER, options, via: "guard" });
    },

    // Returns true when a waiting tool call received the answer. `by` says who answered: the
    // owner (UI or their Telegram) or the requester (a peer agent replying to its own task).
    answer(chatId, { answer, selected = [], by = OWNER }) {
      return settle(chatId, { answered: true, answer: String(answer || ""), selected }, { by });
    },

    // Who may answer the question currently open on this chain (null when none is open).
    audienceOf(chatId) {
      return pending.get(targetOf(chatId))?.[0]?.audience || null;
    },

    // Keep an answer for the question that is about to start waiting in this run.
    holdEarly(chatId, { answer, selected = [] }) {
      const target = targetOf(chatId);
      early.set(target, { answered: true, answer: String(answer || ""), selected });
      onSettled(target, { answer: String(answer || "") }); // answered already, even though the tool hasn't picked it up yet
    },

    // Called when a run ends: releases waiting questions and returns an early answer nobody took.
    cancel(chatId) {
      const target = targetOf(chatId);
      // Only questions this chat itself raised. A parent ending its turn (delegate hands the work
      // to a child and returns) must not cancel the question its child is still waiting on —
      // seen live 2026-09-21: an approval that had just reached the owner's Telegram was killed
      // two minutes later because the parent finished its turn.
      const queue = pending.get(target) || [];
      const keep = [];
      let cancelled = false;
      for (const item of queue) {
        if (item.sourceChatId === chatId) {
          item.resolve({ answered: false, reason: "the owner stopped the run before answering" });
          cancelled = true;
        } else keep.push(item);
      }
      if (keep.length) pending.set(target, keep);
      else pending.delete(target);
      const leftover = early.get(target) || null;
      if (chatId === target || cancelled) early.delete(target);
      // Only tell the bridge the chain is quiet when nothing of it is open any more.
      if (!keep.length) onSettled(target, { cancelled });
      return leftover;
    },

    // The UI shows the question as soon as the model starts the tool call, but the SDK runs
    // execute() only after its MCP round trip (about a minute on the capsule). An answer in that
    // gap waits here for the question instead of becoming a duplicate follow-up run.
    waitForQuestion(chatId, { timeoutMs = 120_000, stillActive = () => true, pollMs = 1_000 } = {}) {
      const target = targetOf(chatId);
      if (pending.get(target)?.length) return Promise.resolve(true);
      return new Promise((resolve) => {
        const set = listeners.get(target) || new Set();
        listeners.set(target, set);
        let timer;
        let poll;
        const done = (value) => {
          clearTimeout(timer);
          clearInterval(poll);
          set.delete(wake);
          if (!set.size) listeners.delete(target);
          resolve(value);
        };
        const wake = () => done(true);
        set.add(wake);
        timer = setTimeout(() => done(false), timeoutMs);
        poll = setInterval(() => {
          if (!stillActive()) done(false);
        }, pollMs);
      });
    },

    isWaiting(chatId) {
      return Boolean(pending.get(targetOf(chatId))?.length);
    },
  };
}
