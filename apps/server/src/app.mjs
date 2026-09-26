import { COVERAGE_CALLER, coverageOwnerNote } from "./integrations/coverage.mjs";
import { foldEvents } from "@griffin/timeline";
import { autoTitle } from "./titles.mjs";
import { servingHeaders } from "./media.mjs";
import { AGENTS, DEFAULT_AGENT } from "./agents/registry.mjs";
import { DEFAULT_PROVIDER, normalizeProvider, PROVIDERS } from "./providers/index.mjs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { BusyError } from "./runner.mjs";
import { materializeTaskChat } from "./tasks.mjs";

const MAX_TEXT = 20_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 7_000_000; // ~5 MB
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function createApp({ store, runner, asks, models = async () => [], extraRoutes, auth, version = "dev" }) {
  const app = new Hono();
  const knownAgent = (id) => Boolean(id && (store.getAgentProfile?.(id) || AGENTS[id]));

  app.get("/healthz", (c) =>
    c.json({ ok: true, version, activeRuns: runner.activeCount() }),
  );

  // Public read-only view of a shared chat. Registered before auth; everything is scoped to the
  // chat the token belongs to (media and charts of other chats are not reachable through it).
  const shared = (c) => store.chatForShare(c.req.param("token"));
  app.get("/api/public/:token", (c) => {
    const chat = shared(c);
    if (!chat) return c.json({ error: "not found" }, 404);
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
    return c.json({ chat: { title: chat.title, createdAt: chat.created_at }, timeline: foldEvents(store.allEvents(chat.id)) });
  });
  app.get("/api/public/:token/media/:id", (c) => {
    const chat = shared(c);
    const media = chat && store.getMedia?.(c.req.param("id"));
    if (!media || media.chat_id !== chat.id) return c.json({ error: "not found" }, 404);
    return sendMedia(c, media);
  });
  app.get("/api/public/:token/charts/:id", (c) => {
    const chat = shared(c);
    const chart = chat && store.getChart(c.req.param("id"));
    if (!chart || chart.chat_id !== chat.id) return c.json({ error: "not found" }, 404);
    return c.json({ chart });
  });

  if (auth) {
    auth.routes(app);
    app.use("/api/*", auth.middleware);
  } else {
    // Local demo / AUTH=off: UI still calls /api/auth/me; answer as already signed in.
    app.get("/api/auth/me", (c) => c.json({ authenticated: true }));
    app.post("/api/auth/login", (c) => c.json({ ok: true }));
    app.post("/api/auth/logout", (c) => c.json({ ok: true }));
  }
  if (extraRoutes) extraRoutes(app);

  app.get("/api/chats", (c) => {
    const archived = c.req.query("archived") === "1";
    const personId = c.req.query("person") || null;
    const childrenByParent = childChatsByParent(store);
    const withChildren = (chat) => publicChat(store, chat, childrenByParent.get(chat.id));
    if (personId) return c.json({ chats: store.listChatsForPerson(personId, { archived }).map(withChildren) });
    return c.json({ chats: store.listChatsBySource({ archived }).map(withChildren) });
  });

  app.post("/api/chats", async (c) => {
    const body = await readJson(c);
    const input = parseMessage(body);
    if (input.error) return c.json({ error: input.error }, 400);
    const agent = typeof body.agent === "string" && knownAgent(body.agent) ? body.agent : DEFAULT_AGENT;
    const profile = store.getAgentProfile?.(agent);
    // sim: a dry-run chat (sim.mjs) — optionally as a colleague's thread (caller team, unlinked).
    const sim = body.sim === true;
    const chat = store.createChat({
      title: typeof body.title === "string" && body.title ? body.title : titleFrom(input.text),
      model: typeof body.model === "string" && body.model ? body.model : profile?.model || null,
      mode: body.mode === "plan" ? "plan" : "agent",
      agent,
      provider: normalizeProvider(profile?.provider),
      sim,
      caller: sim && body.caller === COVERAGE_CALLER ? COVERAGE_CALLER : "owner",
    });
    const sent = await runner.send(chat.id, input);
    return c.json({ chat: publicChat(store, store.getChat(chat.id)), ...sent }, 201);
  });

  app.get("/api/chats/:id", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json({ chat: publicChat(store, chat, childChatsByParent(store).get(chat.id)), active: runner.isActive(chat.id) });
  });

  app.patch("/api/chats/:id", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    const body = await readJson(c);
    const patch = {};
    if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim().slice(0, 120);
    if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
    if (typeof body.archived === "boolean") patch.archived = body.archived;
    if (body.mode === "agent" || body.mode === "plan") patch.mode = body.mode;
    if (typeof body.model === "string") patch.model = body.model || null;
    if (typeof body.personId === "string" && body.personId.trim()) patch.personId = body.personId.trim();
    if (typeof body.agent === "string" && knownAgent(body.agent) && body.agent !== chat.agent) {
      if (runner.isActive(chat.id)) return c.json({ error: "busy" }, 409);
      patch.agent = body.agent;
      const profile = store.getAgentProfile?.(body.agent);
      if (profile) {
        patch.provider = normalizeProvider(profile.provider);
        if (!("model" in patch)) patch.model = profile.model || null;
      }
    }
    // Provider lives on the agent profile — ignore chat-level provider patches from old clients.
    if (typeof body.provider === "string" && PROVIDERS.includes(body.provider)) {
      /* no-op: use PATCH /api/agents/:id */
    }
    return c.json({ chat: publicChat(store, store.updateChat(chat.id, patch)) });
  });

  app.post("/api/chats/:id/messages", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    const body = await readJson(c);
    const input = parseMessage(body);
    if (input.error) return c.json({ error: input.error }, 400);
    const intent = ["send", "queue", "steer"].includes(body.intent) ? body.intent : "send";
    try {
      // The note says "this goes to the colleague on Telegram" — only true when the chat is linked.
      // An unlinked team chat (a simulation) takes the text as-is.
      const framed = chat.caller === COVERAGE_CALLER && input.text && store.linksForChat(chat.id).length
        ? { ...input, text: coverageOwnerNote(store.getPerson?.(chat.person_id)?.display_name, input.text) }
        : input;
      return c.json(await runner.send(chat.id, { ...framed, intent }), 202);
    } catch (error) {
      if (error instanceof BusyError) return c.json({ error: "busy" }, 409);
      throw error;
    }
  });

  // Answer to an ask_owner question. Delivered to the waiting tool call when there is one;
  // otherwise (run already over) it becomes a normal message so the answer is never lost.
  app.post("/api/chats/:id/answer", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    const body = await readJson(c);
    const selected = Array.isArray(body.selected) ? body.selected.map(String).slice(0, 6) : [];
    const answer = [selected.join("، "), typeof body.text === "string" ? body.text.trim() : ""].filter(Boolean).join(" — ").slice(0, 4000);
    if (!answer) return c.json({ error: "empty answer" }, 400);
    if (asks?.answer(chat.id, { answer, selected })) return c.json({ delivered: "tool" });
    if (asks && runner.isActive(chat.id)) {
      // The card is visible but the agent has not started waiting yet: hold the answer for it instead
      // of queueing a duplicate message. If the run ends without asking, the runner sends it as a message.
      const ready = await asks.waitForQuestion(chat.id, { timeoutMs: 15_000, stillActive: () => runner.isActive(chat.id) });
      if (ready && asks.answer(chat.id, { answer, selected })) return c.json({ delivered: "tool" });
      if (runner.isActive(chat.id)) {
        asks.holdEarly(chat.id, { answer, selected, question: body.question });
        return c.json({ delivered: "held" });
      }
    }
    const question = typeof body.question === "string" ? body.question.slice(0, 500) : "";
    const text = question ? `پاسخ به سؤالت «${question}»: ${answer}` : answer;
    const intent = runner.isActive(chat.id) ? "queue" : "send";
    return c.json(await runner.send(chat.id, { text, images: [], intent }), 202);
  });

  app.get("/api/media/:id", (c) => {
    const media = store.getMedia?.(c.req.param("id"));
    if (!media) return c.json({ error: "not found" }, 404);
    return sendMedia(c, media);
  });

  app.post("/api/chats/:id/share", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json({ share: store.shareChat(chat.id) });
  });

  app.get("/api/chats/:id/share", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json({ share: store.getShareForChat(chat.id) });
  });

  app.delete("/api/chats/:id/share", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json({ revoked: store.revokeShare(chat.id) });
  });

  app.get("/api/chats/:id/media", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json({ media: store.listMedia?.(chat.id) || [] });
  });

  app.get("/api/charts/:id", (c) => {
    const chart = store.getChart(c.req.param("id"));
    if (!chart) return c.json({ error: "not found" }, 404);
    return c.json({ chart });
  });

  app.get("/api/chats/:id/charts", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json({ charts: store.listCharts(chat.id) });
  });

  app.post("/api/chats/:id/cancel", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json(await runner.cancel(chat.id));
  });

  // Initial load: the folded timeline in one response (thousands of stream events made big chats
  // take tens of seconds to appear). The client then streams from lastEventId.
  app.get("/api/chats/:id/timeline", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json({ timeline: foldEvents(store.allEvents(chat.id)) });
  });

  // Open a Cursor `task` (زیرایجنت) transcript as a hidden child chat.
  app.post("/api/chats/:id/tasks", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    const body = await readJson(c);
    const callId = typeof body.callId === "string" ? body.callId : "";
    if (!callId) return c.json({ error: "callId required" }, 400);
    try {
      const child = materializeTaskChat(store, chat.id, callId);
      return c.json({ chat: publicChat(store, child) }, 201);
    } catch (error) {
      return c.json({ error: error.message || "task materialize failed" }, 400);
    }
  });

  app.get("/api/chats/:id/events", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    const after = Number(c.req.query("after") || 0);
    return c.json({ events: store.eventsAfter(chat.id, after) });
  });

  // Replays everything after Last-Event-ID (or ?after=), then streams live events.
  app.get("/api/chats/:id/stream", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    const after = Number(c.req.header("last-event-id") || c.req.query("after") || 0);
    return streamSSE(c, async (stream) => {
      const pending = [];
      let wake = null;
      const onEvent = (event) => {
        pending.push(event);
        wake?.();
      };
      store.bus.on(`chat:${chat.id}`, onEvent);
      stream.onAbort(() => {
        store.bus.off(`chat:${chat.id}`, onEvent);
        wake?.();
      });
      try {
        let last = after;
        for (const event of store.eventsAfter(chat.id, after)) {
          await writeEvent(stream, event);
          last = event.id;
        }
        while (!stream.aborted) {
          while (pending.length) {
            const event = pending.shift();
            if (event.id <= last) continue;
            await writeEvent(stream, event);
            last = event.id;
          }
          await waitFor(15_000, (resolve) => (wake = resolve));
          wake = null;
          if (!pending.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
        }
      } finally {
        store.bus.off(`chat:${chat.id}`, onEvent);
      }
    });
  });

  // Chat list changes (new chat, run started/finished, rename) for the sidebar.
  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      let wake = null;
      let dirty = false;
      const onChange = () => {
        dirty = true;
        wake?.();
      };
      store.bus.on("chats", onChange);
      stream.onAbort(() => wake?.());
      try {
        while (!stream.aborted) {
          await waitFor(15_000, (resolve) => (wake = resolve));
          wake = null;
          if (stream.aborted) break;
          if (dirty) {
            dirty = false;
            await stream.writeSSE({ event: "chats", data: "changed" });
          } else {
            await stream.writeSSE({ event: "ping", data: "" });
          }
        }
      } finally {
        store.bus.off("chats", onChange);
      }
    }),
  );

  app.get("/api/models", async (c) => {
    const provider = c.req.query("provider") || null;
    const list = await models(provider);
    return c.json({ models: list, provider: provider || null });
  });

  app.onError((error, c) => {
    console.error("[http]", error);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}

function writeEvent(stream, event) {
  return stream.writeSSE({ id: String(event.id), event: "event", data: JSON.stringify(event) });
}

function waitFor(ms, register) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    register(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function readJson(c) {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function parseMessage(body) {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return { error: "text required" };
  if (text.length > MAX_TEXT) return { error: "text too long" };
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length > MAX_IMAGES) return { error: "too many images" };
  for (const image of images) {
    if (!IMAGE_TYPES.has(image?.mimeType) || typeof image?.data !== "string") {
      return { error: "invalid image" };
    }
    if (image.data.length > MAX_IMAGE_BASE64) return { error: "image too large" };
  }
  return { text, images: images.map(({ data, mimeType }) => ({ data, mimeType })) };
}

const titleFrom = autoTitle;

// Peer-call child chats (ask_agent/delegate) grouped by parent, newest first, capped per parent so
// long-lived chats do not flood the sidebar nest.
function childChatsByParent(store, { perParent = 30 } = {}) {
  const map = new Map();
  for (const child of store.listChildChatsAll?.() || []) {
    const list = map.get(child.parent_chat_id) || Object.assign([], { total: 0 });
    list.total += 1;
    if (list.length < perParent) list.push(child);
    map.set(child.parent_chat_id, list);
  }
  return map;
}

function publicChat(store, chat, children = null) {
  if (!chat) return null;
  const agentId = chat.agent || DEFAULT_AGENT;
  const profile = store.getAgentProfile?.(agentId);
  return {
    id: chat.id,
    title: chat.title,
    model: chat.model ?? profile?.model ?? null,
    mode: chat.mode,
    agent: agentId,
    provider: profile?.provider || chat.provider || DEFAULT_PROVIDER,
    agents: store.agentsWorked(chat),
    caller: chat.caller || "owner",
    source: chat.source || null,
    ownerKey: chat.owner_key || null,
    ownerLabel: chat.owner_label || null,
    parentChatId: chat.parent_chat_id || null,
    pinned: Boolean(chat.pinned),
    archived: Boolean(chat.archived),
    runStatus: chat.run_status || null,
    createdAt: chat.created_at,
    updatedAt: chat.updated_at,
    ...(children?.length
      ? {
          childCount: children.total || children.length,
          children: children.map((child) => ({
            id: child.id,
            title: child.title,
            agent: child.agent || DEFAULT_AGENT,
            runStatus: child.run_status || null,
            createdAt: child.created_at,
            updatedAt: child.updated_at,
          })),
        }
      : {}),
  };
}

function sendMedia(c, media) {
  const headers = servingHeaders(media);
  const data = Buffer.from(media.data);
  // Range requests let video/audio seek (Safari refuses to play without them).
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") || "");
  if (range && (range[1] || range[2])) {
    const size = data.length;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) return c.body(null, 416, { "content-range": `bytes */${size}` });
    return c.body(data.subarray(start, end + 1), 206, { ...headers, "content-range": `bytes ${start}-${end}/${size}` });
  }
  return c.body(data, 200, headers);
}
