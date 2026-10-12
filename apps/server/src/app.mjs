import { COVERAGE_CALLER, coverageOwnerNote } from "./integrations/coverage.mjs";
import { createTimelineCache } from "./timeline-cache.mjs";
import { autoTitle } from "./titles.mjs";
import { servingHeaders } from "./media.mjs";
import { AGENTS, DEFAULT_AGENT } from "./agents/registry.mjs";
import { DEFAULT_PROVIDER, normalizeProvider, PROVIDERS } from "./providers/index.mjs";
import { EFFORTS, effortOf, splitModel } from "./providers/ids.mjs";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { BusyError, keptIds } from "./runner.mjs";
import { branchName } from "./worktrees.mjs";
import { materializeTaskChat } from "./tasks.mjs";
import { PERSONA } from "./persona.mjs";

const MAX_TEXT = 20_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 7_000_000; // ~5 MB
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function createApp({ store, runner, timelines = createTimelineCache({ store }), isValidRepo = () => false, defaultRepo = () => null, asks, models = async () => [], usage = async () => ({ providers: [] }), extraRoutes, auth, version = "dev", movedHosts = [], publicUrl = "" }) {
  const app = new Hono();

  // The public name moved (GRIFFIN_OLD_HOSTS → GRIFFIN_PUBLIC_URL): a browser on an old
  // name gets a permanent redirect. Only GET/HEAD — MCP clients and Telegram webhooks POST and do not
  // follow redirects, so they keep being served on the old name.
  if (movedHosts.length && publicUrl) {
    app.use("*", async (c, next) => {
      const host = String(c.req.header("x-forwarded-host") || c.req.header("host") || "").split(",")[0].trim().split(":")[0].toLowerCase();
      if ((c.req.method === "GET" || c.req.method === "HEAD") && movedHosts.includes(host)) {
        const url = new URL(c.req.url);
        return c.redirect(`${publicUrl.replace(/\/+$/, "")}${url.pathname}${url.search}`, 301);
      }
      return next();
    });
  }
  const knownAgent = (id) => Boolean(id && (store.getAgentProfile?.(id) || AGENTS[id]));

  app.get("/healthz", (c) =>
    c.json({ ok: true, version, activeRuns: runner.activeCount(), workingRuns: runner.workingCount?.() ?? runner.activeCount() }),
  );

  // The CDN (NSIN) in front must never cache or buffer an API response — each can be session-scoped
  // or live. no-store is set before the handler (media may override it); an SSE stream gets
  // no-transform and x-accel-buffering after, so an intermediary does not hold its events back.
  app.use("/api/*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
    if (c.res.headers.get("content-type")?.startsWith("text/event-stream")) {
      c.res.headers.set("cache-control", "no-cache, no-transform");
      c.res.headers.set("x-accel-buffering", "no");
    }
  });

  // The assistant's name for this install (persona.mjs); the login page needs it before auth.
  app.get("/api/public/brand/info", (c) => c.json(PERSONA));

  // Public read-only view of a shared chat. Registered before auth; everything is scoped to the
  // chat the token belongs to (media and charts of other chats are not reachable through it).
  const shared = (c) => store.chatForShare(c.req.param("token"));
  app.get("/api/public/:token", async (c) => {
    const chat = shared(c);
    if (!chat) return c.json({ error: "not found" }, 404);
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
    const { timeline } = await timelines.get(chat.id);
    return c.json({ chat: { title: chat.title, createdAt: chat.created_at }, timeline });
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

  // A colleague's own scoreboard (owner, 2026-10-05: trust comes back from numbers, not promises):
  // their recent requests to Griffin with outcome and duration. Link-only, no login, no chat content.
  app.get("/api/public/peer-status/:token", (c) => {
    const userId = store.getKv(`peerstatus:${c.req.param("token")}`);
    const peer = userId && store.getPeerUser?.(userId);
    if (!peer) return c.json({ error: "not found" }, 404);
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
    const weekAgo = Date.now() - 7 * 86400_000;
    const tasks = store.listTasks(userId, { limit: 200 }).filter((t) => Date.parse(t.created_at) > weekAgo);
    const minutes = (t) => Math.max(0, Math.round((Date.parse(t.updated_at) - Date.parse(t.created_at)) / 6_000) / 10);
    const done = tasks.filter((t) => ["completed", "failed", "canceled", "rejected"].includes(t.state));
    const sorted = done.map(minutes).sort((a, b) => a - b);
    return c.json({
      label: peer.label || userId,
      stats: {
        total: tasks.length,
        completed: tasks.filter((t) => t.state === "completed").length,
        failed: tasks.filter((t) => ["failed", "canceled", "rejected"].includes(t.state)).length,
        open: tasks.length - done.length,
        medianMinutes: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
        within5: done.filter((t) => minutes(t) <= 5).length,
      },
      tasks: tasks.slice(0, 100).map((t) => ({
        at: t.created_at,
        state: t.state,
        minutes: done.includes(t) ? minutes(t) : null,
        title: String(store.getChat(t.chat_id)?.title || "").replace(/^[^:]*:\s*/, "").slice(0, 140),
        reason: t.state_reason || null,
        checkpoints: Number(store.getKv(`peerck:${t.id}`) || 0),
      })),
    });
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
      provider: normalizeProvider(splitModel(body.model)?.provider || profile?.provider),
      sim,
      caller: sim && body.caller === COVERAGE_CALLER ? COVERAGE_CALLER : "owner",
    });
    if (effortOf(body.effort)) store.updateChat(chat.id, { effort: effortOf(body.effort) });
    // The repo is fixed before the first run makes the chat's worktree. No repo field = the default
    // repo for an owner chat; "" = none.
    const repo = typeof body.repo === "string" ? body.repo : !sim ? defaultRepo() : null;
    if (repo) {
      if (!isValidRepo(repo)) return c.json({ error: "unknown repo" }, 400);
      store.updateChat(chat.id, { repo });
    }
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
    // A chat's repo changes only until its worktree exists (the first run makes it).
    if ("repo" in body) {
      if (chat.worktree_path) return c.json({ error: "this chat already works in its own worktree; start a new chat for another repo" }, 409);
      if (body.repo && !isValidRepo(body.repo)) return c.json({ error: "unknown repo" }, 400);
      patch.repo = body.repo || null;
    }
    if (typeof body.model === "string") {
      patch.model = body.model || null;
      // A model from another provider ("claude:haiku") moves the chat there; the session handle
      // is provider-specific, so updateChat drops it when the provider changes.
      const profile = store.getAgentProfile?.(chat.agent || DEFAULT_AGENT);
      const next = normalizeProvider(splitModel(patch.model)?.provider || profile?.provider || chat.provider);
      if (next !== chat.provider) {
        if (runner.isActive(chat.id)) return c.json({ error: "busy" }, 409);
        patch.provider = next;
      }
    }
    if ("effort" in body) patch.effort = effortOf(body.effort);
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
    // The run is parked on a question to the owner: a typed message answers it instead of waiting
    // in the queue for the answer the owner believes they just gave. Not a "/" command.
    if (asks?.isWaiting(chat.id) && !input.images?.length && !/^\s*\/\S/.test(input.text || "") && asks.answer(chat.id, { answer: input.text })) {
      store.appendEvent(chat.id, null, "user", { text: input.text, images: 0, intent: "steer" });
      return c.json({ delivered: "answer" }, 202);
    }
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

  // «ارسال دوباره»: the oldest kept message (a run that failed before anything reached the owner) goes again.
  app.post("/api/chats/:id/retry", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    try {
      return c.json(runner.retry(chat.id), 202);
    } catch (error) {
      if (error instanceof BusyError) return c.json({ error: "busy" }, 409);
      throw error;
    }
  });

  // «حذف»: drops one kept message, named by its stable id (chat.kept), without sending it.
  app.delete("/api/chats/:id/kept/:keptId", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    if (!runner.dropKept(chat.id, c.req.param("keptId"))) return c.json({ error: "not kept" }, 404);
    store.bus.emit("chats", { type: "updated", chatId: chat.id });
    return c.json({ ok: true });
  });

  // Side chats: an aside next to an owner's chat. It starts with that chat's
  // conversation as context (index.mjs seedMessages) and never writes into it.
  app.get("/api/chats/:id/sides", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json({ chats: store.listSideChats(chat.id).map((side) => publicChat(store, side)) });
  });

  app.post("/api/chats/:id/side", async (c) => {
    const parent = store.getChat(c.req.param("id"));
    if (!parent) return c.json({ error: "not found" }, 404);
    if (parent.side_of) return c.json({ error: "a side chat cannot have a side chat" }, 400);
    const body = await readJson(c);
    const input = parseMessage(body);
    if (input.error) return c.json({ error: input.error }, 400);
    // Titled by the question, not by the quote it may start with.
    const asked = input.text.split("\n").filter((line) => !line.startsWith(">")).join("\n").trim();
    const chat = store.createChat({
      title: titleFrom(asked || input.text),
      model: parent.model || null,
      mode: "agent",
      agent: parent.agent || DEFAULT_AGENT,
      provider: normalizeProvider(parent.provider),
      sideOf: parent.id,
    });
    if (parent.effort) store.updateChat(chat.id, { effort: parent.effort });
    const sent = await runner.send(chat.id, input);
    return c.json({ chat: publicChat(store, store.getChat(chat.id)), ...sent }, 201);
  });

  // Rewind: truncate the chat back to a user message (eventId), then optionally re-ask with edited
  // text. The transcript after that point is dropped and the model session is reseeded from the rest.
  app.post("/api/chats/:id/rewind", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    if (chat.caller === "task" || chat.parent_chat_id) return c.json({ error: "read-only chat" }, 400);
    if (runner.isActive(chat.id)) return c.json({ error: "busy" }, 409);
    const body = await readJson(c);
    const eventId = Number(body.eventId);
    if (!Number.isInteger(eventId) || eventId <= 0) return c.json({ error: "eventId required" }, 400);
    const edited = typeof body.text === "string" ? body.text.trim() : "";
    store.rewindChat(chat.id, eventId);
    if (!edited) return c.json({ ok: true });
    const input = parseMessage({ ...body, text: edited });
    if (input.error) return c.json({ error: input.error }, 400);
    try {
      return c.json(await runner.send(chat.id, input), 202);
    } catch (error) {
      if (error instanceof BusyError) return c.json({ error: "busy" }, 409);
      throw error;
    }
  });

  // Owner: mint (or return) the colleague's status link; DELETE revokes it.
  app.post("/api/peers/:id/status-link", (c) => {
    const userId = c.req.param("id");
    if (!store.getPeerUser?.(userId)) return c.json({ error: "unknown peer" }, 404);
    let token = store.getKv(`peerstatus-of:${userId}`);
    if (!token) {
      token = randomBytes(24).toString("base64url");
      store.setKv(`peerstatus:${token}`, userId);
      store.setKv(`peerstatus-of:${userId}`, token);
    }
    return c.json({ token, path: `#/ps/${token}` });
  });
  app.delete("/api/peers/:id/status-link", (c) => {
    const userId = c.req.param("id");
    const token = store.getKv(`peerstatus-of:${userId}`);
    if (token) {
      store.deleteKv?.(`peerstatus:${token}`);
      store.deleteKv?.(`peerstatus-of:${userId}`);
    }
    return c.json({ ok: true });
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
  // take tens of seconds to appear). The client then streams from lastEventId. A client that
  // still holds this chat sends ?have=<its lastEventId>&rev=<rev> and gets a one-line answer.
  app.get("/api/chats/:id/timeline", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    const entry = await timelines.get(chat.id);
    if (c.req.query("rev") === entry.rev && Number(c.req.query("have")) === entry.timeline.lastEventId) {
      return c.json({ unchanged: true, rev: entry.rev });
    }
    const headers = { "content-type": "application/json; charset=UTF-8", vary: "accept-encoding" };
    if (/\bgzip\b/i.test(c.req.header("accept-encoding") || "") && entry.body.length > 1024) {
      return c.body(await entry.gzip(), 200, { ...headers, "content-encoding": "gzip" });
    }
    return c.body(entry.body, 200, headers);
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
        for (const event of store.allEvents(chat.id, after)) {
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
    // provider=all: every provider's models, each tagged, for the cross-provider picker.
    const list = await models(provider === "all" ? null : provider);
    return c.json({ models: list, provider: provider || null, effortLevels: EFFORTS });
  });

  app.get("/api/usage", async (c) => c.json(await usage()));

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
    effort: chat.effort || null,
    mode: chat.mode,
    agent: agentId,
    provider: splitModel(chat.model)?.provider || profile?.provider || chat.provider || DEFAULT_PROVIDER,
    agents: store.agentsWorked(chat),
    caller: chat.caller || "owner",
    source: chat.source || null,
    ownerKey: chat.owner_key || null,
    ownerLabel: chat.owner_label || null,
    parentChatId: chat.parent_chat_id || null,
    sideOf: chat.side_of || null,
    // The repo it works on, its own branch, and the worktree once the first run made it.
    repo: chat.repo || null,
    ...(chat.repo ? { branch: chat.worktree_path?.endsWith("-2") ? `${branchName(chat.id)}-2` : branchName(chat.id), worktreePath: chat.worktree_path || null } : {}),
    // Kept messages waiting for «ارسال دوباره» (oldest first); the thread's retry notice follows it.
    kept: keptIds(store, chat.id),
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
