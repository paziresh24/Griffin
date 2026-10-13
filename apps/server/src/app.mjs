import { COVERAGE_CALLER, coverageOwnerNote } from "./integrations/coverage.mjs";
import { isGlobalChat, motherInfo } from "./integrations/mother.mjs";
import { createTimelineCache } from "./timeline-cache.mjs";
import { usageByModel } from "@griffin/timeline";
import { autoTitle } from "./titles.mjs";
import { servingHeaders } from "./media.mjs";
import { AGENTS, DEFAULT_AGENT } from "./agents/registry.mjs";
import { DEFAULT_PROVIDER, normalizeProvider, PROVIDERS } from "./providers/index.mjs";
import { EFFORTS, effortOf, splitModel } from "./providers/ids.mjs";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { BusyError, fastWanted, keptIds, ownerTyped, setFastWanted } from "./runner.mjs";
import { branchName } from "./worktrees.mjs";
import { thirdPartyKey } from "./related.mjs";
import { materializeTaskChat } from "./tasks.mjs";
import { buildInbox, removeOwnerTask } from "./inbox.mjs";
import { PERSONA } from "./persona.mjs";
import { explainRun } from "./why.mjs";
import { aggregateTokenUsage, ownerTimeZone, tokenUsageSince, TOKEN_USAGE_MAX_DAYS } from "./token-usage.mjs";
import { promptSha, publicSuggestion, settleSuggestion, SUGGEST_NOTE_MAX, withOwnerNote } from "./chat-tools.mjs";

const MAX_TEXT = 20_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 7_000_000; // ~5 MB
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

// What publicChat asks the runner about a chat (set by createApp): Claude's suggested next message,
// the auto-continue time and fast mode.
let live = null;

// onNoteRun(note, { chat } | { error }): a timed note («بعداً») ran or failed; the server tells the owner.
export function createApp({ store, runner, timelines = createTimelineCache({ store }), isValidRepo = () => false, defaultRepo = () => null, folderSwitch = null, asks, models = async () => [], usage = async () => ({ providers: [] }), extraRoutes, auth, version = "dev", movedHosts = [], publicUrl = "", onNoteRun = null }) {
  const app = new Hono();
  const sendingByClientId = new Map(); // "<chatId>:<clientId>" -> the send still in flight

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
  live = {
    suggestion: (id) => runner.suggestion?.(id) ?? null,
    limitResumeAt: (id) => runner.limitResumeAt?.(id) ?? null,
    fastState: (id) => runner.fastState?.(id) ?? null,
    // Parked on a question only the owner answers (in memory: asks keyed by the chain's root) —
    // any open one, not only the queue head.
    waitingForOwner: (id) => Boolean(asks?.ownerWaiting?.(id) ?? asks?.audienceOf?.(id) === "owner"),
  };
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

  // Everything waiting for the owner, from every chain, for the main page (inbox.mjs).
  app.get("/api/inbox", (c) => c.json(buildInbox({ store, asks })));

  // A chore the assistant left him: done or let go, it leaves the board either way.
  app.post("/api/inbox/chores/:id", async (c) => {
    const { action } = await readJson(c);
    if (action !== "done" && action !== "dismiss") return c.json({ error: "action must be done or dismiss" }, 400);
    if (!removeOwnerTask(store, c.req.param("id"))) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  // The owner's chat groups, in their order. A group holds chats only through chats.group_id.
  const groupName = (value) => (typeof value === "string" ? value.trim().slice(0, 60) : "");
  app.get("/api/groups", (c) => c.json({ groups: store.listGroups() }));
  app.post("/api/groups", async (c) => {
    const name = groupName((await readJson(c)).name);
    if (!name) return c.json({ error: "name required" }, 400);
    return c.json({ group: store.createGroup(name) }, 201);
  });
  app.patch("/api/groups/:id", async (c) => {
    if (!store.getGroup(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    const name = groupName((await readJson(c)).name);
    if (!name) return c.json({ error: "name required" }, 400);
    return c.json({ group: store.renameGroup(c.req.param("id"), name) });
  });
  app.delete("/api/groups/:id", (c) => {
    if (!store.deleteGroup(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  // A new chat's settings as the composer sent them: { error } or what createChatWith takes.
  // Shared by POST /api/chats and a note («بعداً») that starts a new chat.
  const newChatSettings = (body) => {
    const agent = typeof body.agent === "string" && knownAgent(body.agent) ? body.agent : DEFAULT_AGENT;
    const profile = store.getAgentProfile?.(agent);
    // sim: a dry-run chat (sim.mjs) — optionally as a colleague's thread (caller team, unlinked).
    const sim = body.sim === true;
    // The repo is fixed before the first run makes the chat's worktree. No repo field = the default
    // repo for an owner chat; "" = none.
    const repo = typeof body.repo === "string" ? body.repo : !sim ? defaultRepo() : null;
    if (repo && !isValidRepo(repo)) return { error: "unknown repo" };
    // «+» on a group's heading: the new chat starts in that group.
    const groupId = typeof body.groupId === "string" && body.groupId ? body.groupId : null;
    if (groupId && !store.getGroup(groupId)) return { error: "unknown group" };
    return {
      fields: {
        model: typeof body.model === "string" && body.model ? body.model : profile?.model || null,
        mode: body.mode === "plan" ? "plan" : "agent",
        agent,
        provider: normalizeProvider(splitModel(body.model)?.provider || profile?.provider),
        sim,
        caller: sim && body.caller === COVERAGE_CALLER ? COVERAGE_CALLER : "owner",
      },
      effort: effortOf(body.effort),
      repo: repo || null,
      groupId,
    };
  };
  const createChatWith = (settings, title) => {
    const chat = store.createChat({ title, ...settings.fields });
    if (settings.effort) store.updateChat(chat.id, { effort: settings.effort });
    if (settings.repo) store.updateChat(chat.id, { repo: settings.repo });
    if (settings.groupId) store.updateChat(chat.id, { groupId: settings.groupId });
    return store.getChat(chat.id);
  };

  app.post("/api/chats", async (c) => {
    const body = await readJson(c);
    const input = parseMessage(body);
    if (input.error) return c.json({ error: input.error }, 400);
    const settings = newChatSettings(body);
    if (settings.error) return c.json({ error: settings.error }, 400);
    const chat = createChatWith(settings, typeof body.title === "string" && body.title ? body.title : titleFrom(input.text));
    const sent = await runner.send(chat.id, input);
    return c.json({ chat: publicChat(store, store.getChat(chat.id)), ...sent }, 201);
  });

  // The owner's text in a colleague's thread goes framed as the owner's note to that colleague —
  // only true when the chat is linked (or a mother chat, linked or not yet); an unlinked team chat (a
  // simulation) takes the text as-is.
  const ownerFramed = (chat, input) =>
    chat.caller === COVERAGE_CALLER && input.text && (motherInfo(store, chat.id) || store.linksForChat(chat.id).length)
      ? { ...input, text: coverageOwnerNote(store.getPerson?.(chat.person_id)?.display_name, input.text) }
      : input;

  // --- Notes («بعداً»): the owner writes a message now and sends it later — by hand,
  // or at a time chosen relative to now. Into an existing chat (queued behind its run if one is
  // active) or as the first message of a new chat with the composer's settings.
  const NOTE_OPTION_KEYS = ["repo", "model", "agent", "mode", "effort", "groupId"];
  const noteOptions = (raw) => {
    if (!raw || typeof raw !== "object") return {};
    const picked = {};
    for (const key of NOTE_OPTION_KEYS) if (typeof raw[key] === "string") picked[key] = raw[key].slice(0, 200);
    return picked;
  };
  // undefined = not given; null = no time; else the normalized ISO time, or { error }.
  const parseRunAt = (value) => {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    const at = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
    if (!at || Number.isNaN(at.getTime())) return { error: "invalid runAt" };
    if (at.getTime() < Date.now() - 60_000) return { error: "runAt is in the past" };
    return at.toISOString();
  };
  const publicNote = (row) =>
    row && {
      id: row.id,
      text: row.text,
      chatId: row.chat_id || null,
      chatTitle: row.chat_title || null,
      runAt: row.run_at || null,
      status: row.status,
      error: row.error || null,
      startedChatId: row.started_chat_id || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

  /** Runs one note (claimed first, so it runs once). Returns { note, chat } or { error, status, note? }. */
  const runNote = async (id, { scheduled = false } = {}) => {
    const row = store.getNote(id);
    if (!row) return { error: "not found", status: 404 };
    if (!store.claimNote(row.id)) return { error: `already ${row.status}`, status: 409 };
    let created = null;
    // A timed note tells the owner (Telegram) that it ran — or that it did not; one run by hand does not.
    const tell = (note, outcome) =>
      scheduled && note ? Promise.resolve().then(() => onNoteRun?.(note, outcome)).catch((failure) => console.error(`[notes] onNoteRun: ${failure.message}`)) : null;
    const fail = async (error, status = 400) => {
      // A new chat made for this attempt goes with it: a retry makes its own, never a second one.
      if (created) store.deleteChat(created.id);
      const note = publicNote(store.finishNote(row.id, { error }));
      await tell(note, { error });
      return { error, status, note };
    };
    try {
      let chat;
      if (row.chat_id) {
        chat = store.getChat(row.chat_id);
        if (!chat) return await fail("چتِ مقصد دیگر وجود ندارد", 404);
        // Through the runner, not the messages route: the owner is not typing now, so a note never
        // answers an open question. "queue" waits behind an active run, else starts one.
        await runner.send(chat.id, { ...ownerFramed(chat, { text: row.text, images: [] }), intent: "queue" });
      } else {
        const settings = newChatSettings(row.options ? JSON.parse(row.options) : {});
        if (settings.error) return await fail(settings.error);
        chat = created = createChatWith(settings, titleFrom(row.text));
        await runner.send(chat.id, { text: row.text, images: [] });
      }
      const note = publicNote(store.finishNote(row.id, { startedChatId: chat.id }));
      const fresh = store.getChat(chat.id);
      await tell(note, { chat: fresh });
      return { note, chat: publicChat(store, fresh) };
    } catch (error) {
      return await fail(error instanceof BusyError ? "چت مشغول بود؛ دوباره اجرا کنید" : String(error?.message || error), 409);
    }
  };

  app.notes = {
    run: runNote,
    /** Runs every open note whose time has come; returns the ids it ran (or tried to). The server ticks this. */
    async runDue(nowMs = Date.now()) {
      const ran = [];
      for (const id of store.dueNotes(new Date(nowMs).toISOString())) {
        const result = await runNote(id, { scheduled: true });
        if (result.error && !result.note) continue; // deleted, or a click got there first
        ran.push(id);
      }
      return ran;
    },
  };

  app.get("/api/notes", (c) => c.json({ notes: store.listNotes().map(publicNote) }));

  app.post("/api/notes", async (c) => {
    const body = await readJson(c);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text required" }, 400);
    if (text.length > MAX_TEXT) return c.json({ error: "text too long" }, 400);
    const chatId = typeof body.chatId === "string" && body.chatId ? body.chatId : null;
    if (chatId && !store.getChat(chatId)) return c.json({ error: "chat not found" }, 404);
    const runAt = parseRunAt(body.runAt);
    if (runAt?.error) return c.json({ error: runAt.error }, 400);
    let options = null;
    if (!chatId) {
      options = noteOptions(body.options);
      // Checked now, so a wrong choice is refused while the owner is still looking.
      const settings = newChatSettings(options);
      if (settings.error) return c.json({ error: settings.error }, 400);
    }
    return c.json({ note: publicNote(store.createNote({ text, chatId, options, runAt: runAt ?? null })) }, 201);
  });

  app.patch("/api/notes/:id", async (c) => {
    const row = store.getNote(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const body = await readJson(c);
    const patch = {};
    if (body.text !== undefined) {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return c.json({ error: "text required" }, 400);
      if (text.length > MAX_TEXT) return c.json({ error: "text too long" }, 400);
      patch.text = text;
    }
    const runAt = parseRunAt(body.runAt);
    if (runAt?.error) return c.json({ error: runAt.error }, 400);
    if (runAt !== undefined) patch.runAt = runAt;
    const updated = store.updateNote(row.id, patch);
    if (!updated) return c.json({ error: `already ${row.status}` }, 409);
    return c.json({ note: publicNote(updated) });
  });

  app.delete("/api/notes/:id", (c) => {
    if (!store.deleteNote(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/notes/:id/run", async (c) => {
    const result = await runNote(c.req.param("id"));
    if (result.error) return c.json({ error: result.error, ...(result.note ? { note: result.note } : {}) }, result.status);
    return c.json(result, 201);
  });

  // «چرا؟» (why.mjs): how one reply came about, from that run's events, the review/guard decisions
  // recorded meanwhile, and the manifest its session started with. Bounded reads only.
  app.get("/api/chats/:id/runs/:runId/why", (c) => {
    const chatId = c.req.param("id");
    const run = store.getRun(c.req.param("runId"));
    if (!run || run.chat_id !== chatId) return c.json({ error: "not found" }, 404);
    const events = store.runEvents(run.id);
    const lastId = events.at(-1)?.id ?? Number.MAX_SAFE_INTEGER;
    const manifestEvent = store.latestManifestEvent(chatId, lastId);
    const manifest = manifestEvent?.data || null;
    const approvals = store.approvalsBetween(chatId, run.started_at, run.ended_at || new Date().toISOString());
    return c.json({ ...explainRun(events, { approvals, manifest }), manifest });
  });

  app.get("/api/blobs/:hash", (c) => {
    const hash = c.req.param("hash");
    if (!/^[0-9a-f]{64}$/.test(hash)) return c.json({ error: "invalid hash" }, 400);
    const text = store.getBlob(hash);
    if (text == null) return c.json({ error: "not found" }, 404);
    return c.text(text);
  });

  app.get("/api/chats/:id", async (c) => {
    const row = store.getChat(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    // getChat has no run columns; the latest run (runs_chat index) gives a chat opened outside the
    // list — a sub-agent, a thread, an old job run — its runStatus, so its error bar shows.
    const last = store.db.prepare("SELECT status, started_at FROM runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1").get(row.id);
    const chat = { ...row, run_status: last?.status ?? null, run_started_at: last?.started_at ?? null };
    // Tokens per model only here, not in the list: summed from the cached fold (the same one the
    // timeline route serves; a warm entry reads only events after it, by events_chat).
    const usage = usageByModel((await timelines.get(chat.id)).timeline.messages);
    return c.json({ chat: { ...publicChat(store, chat, childChatsByParent(store).get(chat.id)), usage }, active: runner.isActive(chat.id) });
  });

  // Context gauge (engine-agnostic): the last run's prompt tokens over the window.
  // ponytail: one window for every model (GRIFFIN_CONTEXT_WINDOW, default 200k); a per-model table
  // when models with other windows are in use. «خلاصه‌سازی» is the existing /compact command.
  app.get("/api/chats/:id/context", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    const last = (await timelines.get(chat.id)).timeline.messages.findLast((m) => m.role === "assistant" && m.usage?.context);
    const window = Number(process.env.GRIFFIN_CONTEXT_WINDOW) || 200_000;
    if (!last) return c.json({ available: false, used: 0, window, percent: 0 });
    const used = Number(last.usage.context) || 0;
    return c.json({ available: true, used, window, percent: Math.min(100, Math.round((used / window) * 100)), model: last.model || null });
  });

  app.patch("/api/chats/:id", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    const body = await readJson(c);
    const patch = {};
    if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim().slice(0, 120);
    if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
    if (typeof body.archived === "boolean") patch.archived = body.archived;
    if (body.groupId === null) patch.groupId = null;
    else if (typeof body.groupId === "string") {
      if (!store.getGroup(body.groupId)) return c.json({ error: "unknown group" }, 400);
      patch.groupId = body.groupId;
    }
    if (body.mode === "agent" || body.mode === "plan") patch.mode = body.mode;
    // A chat's repo changes here only until its worktree exists (the first run makes it); after
    // that it moves with POST /api/chats/:id/folder.
    if ("repo" in body) {
      if (chat.worktree_path) return c.json({ error: "this chat already works in its own worktree; move it with /folder" }, 409);
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
    // Fast mode (Claude, Opus only, billed from extra usage): the chat's switch, from its next run.
    if (typeof body.fast === "boolean" && ownerTyped(store, chat)) {
      setFastWanted(store, chat.id, body.fast);
      store.bus.emit("chats", { type: "live", chatId: chat.id });
    }
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

  // Moving an open chat to another repo («تغییر پوشه» after a confirmation that says
  // what stays behind). GET ?repo= says what a move would leave behind; POST { repo } moves. The old
  // tree is set aside untouched, never deleted. Owner chats with a repo of their own only.
  const folderRequest = (c, repo) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return { response: c.json({ error: "not found" }, 404) };
    if (!folderSwitch) return { response: c.json({ error: "not available" }, 501) };
    if (chat.side_of || chat.parent_chat_id || (chat.caller || "owner") !== "owner" || !chat.repo) {
      return { response: c.json({ error: "this chat has no folder of its own" }, 400) };
    }
    const target = typeof repo === "string" ? repo.trim() : "";
    if (!target || !isValidRepo(target)) return { response: c.json({ error: "unknown repo" }, 400) };
    if (target === chat.repo) return { response: c.json({ error: "already on this repo" }, 400) };
    return { chat, target };
  };
  app.get("/api/chats/:id/folder", async (c) => {
    const { response, chat, target } = folderRequest(c, c.req.query("repo"));
    return response || c.json(await folderSwitch.preview(chat, target));
  });
  app.post("/api/chats/:id/folder", async (c) => {
    const { response, chat, target } = folderRequest(c, (await readJson(c)).repo);
    if (response) return response;
    const outcome = await folderSwitch.apply(chat, target);
    if (outcome.error === "busy") return c.json({ error: "busy" }, 409);
    if (outcome.error) return c.json({ error: outcome.error }, 500);
    return c.json({ chat: publicChat(store, store.getChat(chat.id)), parked: outcome.parked });
  });

  app.post("/api/chats/:id/messages", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    const body = await readJson(c);
    const input = parseMessage(body);
    if (input.error) return c.json({ error: input.error }, 400);
    const intent = ["send", "queue", "steer"].includes(body.intent) ? body.intent : "send";
    // The page's id for this message: a resend (its answer was lost to a restart or a 502) is
    // answered without storing the message again; a copy still in flight shares its answer.
    const clientId = typeof body.clientId === "string" && CLIENT_ID.test(body.clientId) ? body.clientId : null;
    const key = clientId && `${chat.id}:${clientId}`;
    if (clientId && store.userEventIdByClientId?.(chat.id, clientId)) return c.json({ delivered: "duplicate" });
    if (key && sendingByClientId.has(key)) {
      const first = await sendingByClientId.get(key).catch(() => null);
      if (!first) return c.json({ error: "retry" }, 503);
      return first.status < 300 ? c.json({ delivered: "duplicate" }) : c.json(first.body, first.status);
    }
    store.keepJobChat?.(chat.id);
    // The owner moved on: the chat no longer continues by itself after the plan limit resets.
    runner.cancelLimitResume?.(chat.id);
    // «/compact» on the OpenAI-compatible engine (Claude Code has its own): the next run starts a
    // fresh session seeded with the conversation's text only — tool calls and results drop out.
    if (/^\s*\/compact\s*$/.test(input.text || "") && !input.images?.length && runner.engineOf?.(chat) === "openai") {
      if (runner.isActive(chat.id)) return c.json({ error: "busy" }, 409);
      store.setAgentId(chat.id, null);
      addTurn(store, chat.id, input.text.trim(), "گفتگو فشرده شد: نوبت بعد با متن گفتگو (بدون ابزارها و نتیجه‌هایشان) از نو شروع می‌شود.");
      return c.json({ delivered: "compacted" }, 202);
    }
    // The run is parked on a question to the owner: a typed message answers it instead of waiting
    // in the queue for the answer the owner believes they just gave. Not a "/" command.
    if (asks?.isWaiting(chat.id) && !input.images?.length && !/^\s*\/\S/.test(input.text || "") && asks.answer(chat.id, { answer: input.text })) {
      // With the run's id: the thread shows it under the question, not under the final answer.
      store.appendEvent(chat.id, runner.runIdOf?.(chat.id) ?? null, "user", { text: input.text, images: 0, intent: "steer", ...(clientId ? { clientId } : {}) });
      return c.json({ delivered: "answer" }, 202);
    }
    // The owner's own message starting a fresh run moves this chat on from a colleague's text
    // (related.mjs chat_send last hop); a queued/steered one or a "/" command leaves the mark.
    if (!runner.isActive(chat.id) && !/^\s*\/\S/.test(input.text || "")) store.deleteKv?.(thirdPartyKey(chat.id));
    try {
      const framed = ownerFramed(chat, input);
      const sending = (async () => {
        try {
          return { status: 202, body: await runner.send(chat.id, { ...framed, intent, clientId }) };
        } catch (error) {
          if (error instanceof BusyError) return { status: 409, body: { error: "busy" } };
          throw error;
        }
      })();
      if (key) sendingByClientId.set(key, sending);
      const answer = await sending;
      return c.json(answer.body, answer.status);
    } finally {
      if (key) sendingByClientId.delete(key);
    }
  });

  // «دوباره»: the kept message goes again; with nothing kept, a failed last run is asked to continue.
  app.post("/api/chats/:id/retry", async (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    try {
      const kept = runner.retry(chat.id);
      if (kept?.status !== "nothing-kept") return c.json(kept, 202);
      const last = store.db.prepare("SELECT status, error FROM runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1").get(chat.id);
      if (last?.status !== "error") return c.json(kept, 202);
      runner.cancelLimitResume?.(chat.id);
      const text = `کار قبلی با خطا قطع شد${last.error ? `: «${String(last.error).slice(0, 200)}»` : ""}. از همان‌جا که ماند ادامه بده.`;
      return c.json({ ...(await runner.send(chat.id, { ...ownerFramed(chat, { text, images: [] }), intent: "send" })), delivered: "continue" }, 202);
    } catch (error) {
      if (error instanceof BusyError) return c.json({ error: "busy" }, 409);
      throw error;
    }
  });

  // «حل شد»: the owner handled this chat's failure — its kept messages and the desk's failed card go,
  // and it stops reading as an error (runStatusOf) until its next run.
  app.post("/api/chats/:id/resolve", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    if (runner.isActive(chat.id)) return c.json({ error: "busy" }, 409);
    runner.cancelLimitResume?.(chat.id);
    for (const keptId of keptIds(store, chat.id)) runner.dropKept?.(chat.id, keptId);
    const waiting = store.getKv("tgwaiting");
    if (Array.isArray(waiting)) {
      const left = waiting.filter((w) => !(w.kind === "failed" && w.chatId === chat.id));
      if (left.length < waiting.length) {
        store.setKv("tgwaiting", left);
        for (const w of waiting) {
          if (left.includes(w) || store.getKv(`tgstate:${w.personId}`)?.state !== "failed") continue;
          store.setKv(`tgstate:${w.personId}`, { state: "no_reply", line: "حل شد", at: new Date().toISOString() });
        }
      }
    }
    store.setKv(`resolved:${chat.id}`, new Date().toISOString());
    store.bus.emit("chats", { type: "updated", chatId: chat.id });
    return c.json({ ok: true });
  });

  // «حذف»: drops one kept message, named by its stable id (chat.kept), without sending it.
  app.delete("/api/chats/:id/kept/:keptId", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    if (!runner.dropKept(chat.id, c.req.param("keptId"))) return c.json({ error: "not kept" }, 404);
    store.bus.emit("chats", { type: "updated", chatId: chat.id });
    return c.json({ ok: true });
  });

  // «حذف»/«ویرایش» on a «در صف» message (its user event id, web QueuePeek): it leaves the queue and
  // never runs; user.queue «removed» takes it off the thread. 404 when it is not waiting; 409
  // «merged» when it waits merged with others in one kept message (its «حذف» drops them together).
  app.delete("/api/chats/:id/queue/:eventId", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    let removed;
    try {
      removed = runner.unqueue(chat.id, c.req.param("eventId"));
    } catch (error) {
      if (error?.code === "merged") return c.json({ error: "merged" }, 409);
      throw error;
    }
    if (!removed) return c.json({ error: "not queued" }, 404);
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

  // Chats an agent suggested with chat_suggest. Nothing runs until the owner starts one.
  app.get("/api/suggestions", (c) => {
    const status = c.req.query("status") || null;
    if (status && !["open", "started", "dismissed"].includes(status)) return c.json({ error: "invalid status" }, 400);
    return c.json({ suggestions: store.listSuggestions({ status }).map(publicSuggestion) });
  });

  // Starts the suggested chat: its prompt as the first message, on the suggestion's repo and model.
  // The owner may change the model on the card and add a note before or after the prompt; the
  // client sends back the hash of the prompt it showed, so only that prompt can run.
  app.post("/api/suggestions/:id/start", async (c) => {
    const row = store.getSuggestion(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status !== "open") return c.json({ error: `already ${row.status}` }, 409);
    const body = await readJson(c);
    const seen = typeof body.promptSha === "string" ? body.promptSha : "";
    if (!seen) return c.json({ error: "promptSha is required" }, 400);
    if (seen !== promptSha(row.prompt)) return c.json({ error: "the prompt changed since it was shown; reload and read it again" }, 409);
    if (row.repo && !isValidRepo(row.repo)) return c.json({ error: "invalid repo" }, 400);
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > SUGGEST_NOTE_MAX) return c.json({ error: `note is longer than ${SUGGEST_NOTE_MAX} characters` }, 400);
    // "" = the owner picked «خودکار» on the card; absent = the suggested model.
    const model = typeof body.model === "string" ? body.model.slice(0, 200) : row.model || "";
    const profile = store.getAgentProfile?.(DEFAULT_AGENT);
    const chat = store.createChat({
      title: row.title,
      model: model || profile?.model || null,
      agent: DEFAULT_AGENT,
      provider: normalizeProvider(splitModel(model)?.provider || profile?.provider),
    });
    if (row.repo) store.updateChat(chat.id, { repo: row.repo });
    // Claimed before the run starts: a double click starts one chat, not two.
    if (!settleSuggestion(store, row.id, "started", chat.id)) {
      store.deleteChat(chat.id);
      return c.json({ error: "already started" }, 409);
    }
    const sent = await runner.send(chat.id, { text: withOwnerNote(row.prompt, note, body.notePosition), images: [] });
    return c.json({ chat: publicChat(store, store.getChat(chat.id)), suggestion: publicSuggestion(store.getSuggestion(row.id)), ...sent }, 201);
  });

  app.post("/api/suggestions/:id/dismiss", (c) => {
    const row = store.getSuggestion(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status === "started") return c.json({ error: "already started" }, 409);
    if (row.status === "open") settleSuggestion(store, row.id, "dismissed");
    return c.json({ suggestion: publicSuggestion(store.getSuggestion(row.id)) });
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
    const moved = store.getKv(`repomove:${chat.id}`);
    if (moved?.noteId && eventId <= moved.noteId) return c.json({ error: "این گفتگو بعد از آن پیام به ریپوی دیگری رفته؛ برگشت به قبل از آن ممکن نیست" }, 409);
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
    const askId = typeof body.askId === "string" && /^[a-f0-9]{6,16}$/i.test(body.askId) ? body.askId.toLowerCase() : null;
    const selected = Array.isArray(body.selected) ? body.selected.map(String).slice(0, 6) : [];
    const answer = [selected.join("، "), typeof body.text === "string" ? body.text.trim() : ""].filter(Boolean).join(" — ").slice(0, 4000);
    if (!answer) return c.json({ error: "empty answer" }, 400);
    store.keepJobChat?.(chat.id);
    // A card that names its question answers exactly that one. If it is no longer open it was
    // answered elsewhere (Telegram, another tab) or its run ended: no hold, no follow-up message,
    // so a stale card can never start a duplicate run.
    if (askId) {
      if (asks?.answer(chat.id, { answer, selected, askId })) return c.json({ delivered: "tool" });
      return c.json({ error: "این سؤال دیگر باز نیست", gone: true }, 409);
    }
    const asked = typeof body.question === "string" ? body.question : null;
    if (asks?.answer(chat.id, { answer, selected, question: asked })) return c.json({ delivered: "tool" });
    if (asks && runner.isActive(chat.id)) {
      // The card is visible but its tool has not started waiting yet (the engine calls it after a
      // round trip, or after slower tools of the same round): wait for exactly this question — even
      // while another question of the chain is open — instead of queueing a duplicate message.
      const ready = await asks.waitForQuestion(chat.id, { timeoutMs: 15_000, question: asked, stillActive: () => runner.isActive(chat.id) });
      if (ready && asks.answer(chat.id, { answer, selected, question: asked })) return c.json({ delivered: "tool" });
      // Hold it for the question only while nothing is open on the chain: with another one open,
      // this card's own question is gone (stopped, answered elsewhere) and its answer is the
      // follow-up message the card promised — never held for the chain's next question.
      if (runner.isActive(chat.id) && !asks.isWaiting(chat.id)) {
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

  // «لغو» on the auto-continue row: only the wait for the limit ends, nothing else stops.
  app.delete("/api/chats/:id/limit-resume", (c) => {
    const chat = store.getChat(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    runner.cancelLimitResume?.(chat.id);
    return c.json({ ok: true });
  });

  // The composer's «/» list: Griffin's own commands, and on Claude its session's commands and skills.
  // Also the engine of the chat's next run (routing is too costly to run for every chat in the list).
  app.get("/api/commands", (c) => {
    const chat = store.getChat(c.req.query("chat") || "");
    const engine = chat ? runner.engineOf?.(chat) : null;
    const local = [
      { name: "clear", description: "گفتگوی تازه", argumentHint: "", local: true },
      ...(engine === "openai" ? [{ name: "compact", description: "فشرده کردن گفتگو: نوبت بعد فقط با متن گفتگو شروع می‌شود", argumentHint: "", local: true }] : []),
    ];
    const own = engine === "claude" ? runner.commandsFor?.(chat) || [] : [];
    return c.json({ engine, commands: [...own, ...local.filter((l) => !own.some((o) => o.name === l.name))] });
  });

  // «ادامه در گفتگوی تازه از اینجا»: a new chat holding this chat's conversation up to the end of one
  // of its runs, in the same working folder. The turns are copied in (shown, and the seed of an
  // OpenAI-engine session); a Claude run's session is forked too (SDK forkSession) so Claude keeps
  // its full context.
  app.post("/api/chats/:id/fork", async (c) => {
    const parent = store.getChat(c.req.param("id"));
    if (!parent) return c.json({ error: "not found" }, 404);
    if (!ownerTyped(store, parent)) return c.json({ error: "owner's main chats only" }, 403);
    const body = await readJson(c);
    const runId = typeof body.runId === "string" ? body.runId : "";
    let endId = 0;
    let finished = false;
    let mark = null;
    for (const event of store.allEvents(parent.id)) {
      if (event.runId !== runId) continue;
      endId = event.id;
      if (event.type === "run.finished") finished = true;
      if (event.type === "checkpoint") mark = event.data;
    }
    if (!endId) return c.json({ error: "unknown reply" }, 404);
    if (!finished) return c.json({ error: "busy" }, 409);
    const chat = store.createChat({
      title: `انشعاب: ${parent.title || ""}`.slice(0, 120),
      model: parent.model || null,
      mode: "agent",
      agent: parent.agent || DEFAULT_AGENT,
      provider: normalizeProvider(parent.provider),
    });
    // Same folder (index.mjs agentOptions): Claude Code keeps the forked session by working folder.
    store.setKv(`fork-of:${chat.id}`, parent.id);
    store.updateChat(chat.id, {
      ...(parent.effort ? { effort: parent.effort } : {}),
      ...(parent.repo ? { repo: parent.repo, worktreePath: parent.worktree_path || null } : {}),
    });
    for (const turn of store.priorTurns(parent.id, { throughId: endId })) {
      if (turn.role === "user") store.appendEvent(chat.id, null, "user", { text: turn.content, images: 0 });
      else addTurn(store, chat.id, null, turn.content);
    }
    if (mark?.lastMessageId) {
      try {
        const sessionId = await runner.forkSession?.(store.getChat(chat.id), { sessionId: mark.sessionId || parent.agent_id, upToMessageId: mark.lastMessageId });
        if (sessionId) store.setAgentId(chat.id, sessionId);
      } catch (error) {
        // The copied turns still seed a fresh session.
        console.error(`[fork] ${parent.id} → ${chat.id}: ${error?.message || error}`);
      }
    }
    return c.json({ chat: publicChat(store, store.getChat(chat.id)) }, 201);
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

  // Chat list changes (new chat, run started/finished, rename) for the sidebar, and changes of
  // what waits for the owner (Telegram drafts, kept messages, notes, todo steps) for his main page.
  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      let wake = null;
      let dirtyChats = false;
      let dirtyInbox = false;
      const onChats = () => {
        dirtyChats = true;
        wake?.();
      };
      const onInbox = () => {
        dirtyInbox = true;
        wake?.();
      };
      store.bus.on("chats", onChats);
      store.bus.on("inbox", onInbox);
      stream.onAbort(() => wake?.());
      try {
        while (!stream.aborted) {
          await waitFor(15_000, (resolve) => (wake = resolve));
          wake = null;
          if (stream.aborted) break;
          if (!dirtyChats && !dirtyInbox) {
            await stream.writeSSE({ event: "ping", data: "" });
            continue;
          }
          if (dirtyChats) {
            dirtyChats = false;
            await stream.writeSSE({ event: "chats", data: "changed" });
          }
          if (dirtyInbox) {
            dirtyInbox = false;
            await stream.writeSSE({ event: "inbox", data: "changed" });
          }
        }
      } finally {
        store.bus.off("chats", onChats);
        store.bus.off("inbox", onInbox);
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
  // Token consumption over time, by model and by chat (Settings → «مصرف توکن»); spans every chat, so
  // owner-only like the rest of /api/*.
  app.get("/api/usage/tokens", (c) => {
    const asked = Number(c.req.query("days"));
    const days = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, TOKEN_USAGE_MAX_DAYS) : 30;
    const now = new Date();
    const timeZone = ownerTimeZone();
    return c.json({ range: days, timeZone, ...aggregateTokenUsage(store.usageRows(tokenUsageSince({ days, now })), { days, now, timeZone }) });
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

// A page's message id: a short plain token (crypto.randomUUID or its fallback).
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

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

// «حل شد»: the owner marked this chat's failure handled (kv resolved:<chat>, an ISO time). It covers
// runs that started before it; the next run starts later and shows its own status.
function runStatusOf(store, chat) {
  const status = chat.run_status || null;
  if (status !== "error") return status;
  const at = store.getKv?.(`resolved:${chat.id}`);
  return typeof at === "string" && at > (chat.run_started_at || "") ? "resolved" : status;
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
    personId: chat.person_id || null,
    mother: chat.caller === COVERAGE_CALLER && Boolean(motherInfo(store, chat.id)),
    global: isGlobalChat(store, chat.id),
    sideOf: chat.side_of || null,
    // The repo it works on, its own branch, and the worktree once the first run made it.
    repo: chat.repo || null,
    ...(chat.repo ? { branch: chat.worktree_path?.endsWith("-2") ? `${branchName(chat.id)}-2` : branchName(chat.id), worktreePath: chat.worktree_path || null } : {}),
    // Kept messages waiting for «ارسال دوباره» (oldest first); the thread's retry notice follows it.
    kept: keptIds(store, chat.id),
    pinned: Boolean(chat.pinned),
    groupId: chat.group_id || null,
    archived: Boolean(chat.archived),
    runStatus: runStatusOf(store, chat),
    runStartedAt: chat.run_started_at || null,
    // Claude's suggested next message; when it continues by itself after the plan limit resets (ms);
    // the fast-mode switch and what Claude Code last said of it.
    suggestion: chat.archived ? null : live?.suggestion(chat.id) ?? null,
    limitResumeAt: live?.limitResumeAt(chat.id) ?? null,
    waitingForOwner: Boolean(live?.waitingForOwner(chat.id)),
    fast: fastWanted(store, chat.id),
    fastState: live?.fastState(chat.id) ?? null,
    createdAt: chat.created_at,
    updatedAt: chat.updated_at,
    ...(children?.length
      ? {
          childCount: children.total || children.length,
          children: children.map((child) => ({
            id: child.id,
            title: child.title,
            agent: child.agent || DEFAULT_AGENT,
            runStatus: runStatusOf(store, child),
            createdAt: child.created_at,
            updatedAt: child.updated_at,
          })),
        }
      : {}),
  };
}

// A finished turn added outside a run: the owner's text (when given) and a short answer.
function addTurn(store, chatId, userText, answer) {
  if (userText) store.appendEvent(chatId, null, "user", { text: userText, images: 0 });
  const runId = store.startRun(chatId);
  store.appendEvent(chatId, runId, "run.started", {});
  store.appendEvent(chatId, runId, "text", { text: answer });
  store.appendEvent(chatId, runId, "run.finished", { status: "finished" });
  store.finishRun(chatId, runId, "finished");
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
