// Multi-user accounts on a single Griffin install: the owner remains the administrator, while
// invited team members sign in with their own personal access token, see only their own chats,
// folders and «بعداً» notes, and share the install's configured AI engines.
import crypto from "node:crypto";
import { nameOf } from "./profile.mjs";

export const USER_CALLER_PREFIX = "user:";
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/;

export const userCaller = (userId) => `${USER_CALLER_PREFIX}${userId}`;
export const isUserCaller = (caller) => typeof caller === "string" && caller.startsWith(USER_CALLER_PREFIX);
export const userIdFromCaller = (caller) => (isUserCaller(caller) ? caller.slice(USER_CALLER_PREFIX.length) : null);

export function hashUserToken(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return "";
  return crypto.createHash("sha256").update(trimmed).digest("hex");
}

export function mintUserToken() {
  return `grf_u_${crypto.randomBytes(24).toString("base64url")}`;
}

export function normalizeUsername(raw, fallbackName = "") {
  const direct = String(raw || "").trim().toLowerCase();
  if (direct) return USERNAME_RE.test(direct) ? direct : null;
  const ascii = String(fallbackName || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (ascii.length >= 2 && USERNAME_RE.test(ascii)) return ascii;
  return `user-${crypto.randomBytes(3).toString("hex")}`;
}

export function publicAppUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role || "member",
    enabled: Boolean(row.enabled),
    chatCount: Number(row.chat_count || 0),
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Does `user` (a logged-in member) own `chatId`? Side chats inherit their parent's owner; sub-agent
 * child chats inherit their root chat's owner. Returns false for any unknown, owner, or peer chat.
 */
export function canUserAccessChat(store, user, chatId) {
  if (!user?.id || !chatId) return false;
  const direct = store.getChat(chatId);
  if (!direct) return false;
  if (direct.user_id === user.id) return true;
  if (direct.side_of) {
    const sideParent = store.getChat(direct.side_of);
    if (sideParent && sideParent.user_id === user.id) return true;
  }
  const rootId = store.rootChatId?.(direct.side_of || direct.id);
  if (rootId && rootId !== direct.id) {
    const root = store.getChat(rootId);
    if (root && root.user_id === user.id) return true;
  }
  return false;
}

// Strip sensitive account fields from GET /api/providers when read by a member user.
function sanitizeProvidersPayload(data) {
  if (!data || typeof data !== "object") return data;
  const cleanProvider = (p) => {
    if (!p || typeof p !== "object") return p;
    const { apiKey: _k, proxyUrl: _px, signedInAs: _sa, orgName: _org, email: _em, ...rest } = p;
    return rest;
  };
  return {
    ...data,
    ...(Array.isArray(data.providers) ? { providers: data.providers.map(cleanProvider) } : {}),
    ...(Array.isArray(data.accounts) ? { accounts: data.accounts.map(cleanProvider) } : {}),
  };
}

// Routes a signed-in member (`role: "member"`) is allowed to call. Everything else under `/api/*`
// is denied by default so new administrative endpoints stay owner-only without extra wiring.
function isMemberAllowedRoute(method, path) {
  if (path === "/api/auth/me" && method === "GET") return true;
  if (path === "/api/auth/logout" && method === "POST") return true;
  if (path === "/api/auth/my-token" && method === "POST") return true;
  if (method === "GET" && (
    path === "/api/health" ||
    path === "/api/version" ||
    path === "/api/brand" ||
    path === "/api/public/brand/info" ||
    path === "/api/announcement" ||
    path === "/api/models" ||
    path === "/api/providers" ||
    path === "/api/agents" ||
    path === "/api/repos" ||
    path === "/api/commands" ||
    path === "/api/stt" ||
    path === "/api/stream"
  )) return true;
  if (path === "/api/transcribe" && method === "POST") return true;
  if (path === "/api/clicks" && method === "POST") return true;
  if (path === "/api/profile" && (method === "GET" || method === "PUT")) return true;
  if (path === "/api/ui-prefs" && (method === "GET" || method === "PUT" || method === "DELETE")) return true;
  if (path === "/api/list-prefs" && (method === "GET" || method === "PUT")) return true;
  if (path === "/api/seen" && (method === "GET" || method === "PUT")) return true;
  if (path === "/api/uploads" && method === "POST") return true;
  if (/^\/api\/uploads\/[^/]+$/.test(path) && (method === "PUT" || method === "DELETE")) return true;
  if (/^\/api\/(media|charts)\/[^/]+$/.test(path) && method === "GET") return true;
  if (path === "/api/groups" && (method === "GET" || method === "POST")) return true;
  if (path === "/api/groups/order" && method === "PUT") return true;
  if (/^\/api\/groups\/[^/]+$/.test(path) && (method === "PATCH" || method === "DELETE")) return true;
  if (path === "/api/notes" && (method === "GET" || method === "POST")) return true;
  if (/^\/api\/notes\/[^/]+(\/run)?$/.test(path) && ["GET", "PATCH", "DELETE", "POST"].includes(method)) return true;
  if (path === "/api/chats" && (method === "GET" || method === "POST")) return true;
  if (path === "/api/chats/search" && method === "GET") return true;
  if (path === "/api/chats/delete-archived" && method === "POST") return true;
  if (path.startsWith("/api/chats/")) {
    // Interactive host/sandbox terminal and Telegram private-shares are owner-only.
    if (/^\/api\/chats\/[^/]+\/(terminal|private-shares)(\/|$)/.test(path)) return false;
    return true;
  }
  return false;
}

/**
 * Default-deny API boundary for non-owner users (`c.get("authUser")`). Also answers shell-wide
 * status polls (modules, inbox, setup, update, usage) with clean member-scoped empty payloads so
 * the chat UI loads cleanly with zero 403 noise or owner-data leakage.
 */
export function memberApiGuard() {
  return async (c, next) => {
    const user = c.get("authUser");
    if (!user) return next();
    const path = c.req.path;
    const method = c.req.method;
    if (!path.startsWith("/api/")) return next();

    // Shell polls that belong to the owner's install: return harmless empty views for members.
    if (method === "GET") {
      if (path === "/api/modules") return c.json({ modules: [] });
      if (path === "/api/modules/badges") return c.json({ badges: {} });
      if (path === "/api/inbox") return c.json({ items: [], counts: {} });
      if (path === "/api/inbox/status") return c.json({ mode: "off", count: 0 });
      if (path === "/api/suggestions") return c.json({ suggestions: [] });
      if (path === "/api/setup/status") return c.json({ complete: true, steps: [] });
      if (path === "/api/update") return c.json({ available: false, update: null });
      if (path === "/api/engines/alerts") return c.json({ alerts: [] });
      if (path === "/api/usage/limits") return c.json({ windows: [] });
      if (path === "/api/usage/resets") return c.json({ resets: [] });
    }
    if (method === "POST" && path === "/api/clicks") return c.json({ ok: true });

    if (!isMemberAllowedRoute(method, path)) {
      return c.json({ error: "این بخش فقط برای مدیر نصب (Owner) در دسترس است." }, 403);
    }

    await next();

    if (method === "GET" && path === "/api/providers" && c.res?.headers?.get("content-type")?.includes("application/json")) {
      try {
        const cloned = c.res.clone();
        const body = await cloned.json();
        c.res = c.json(sanitizeProvidersPayload(body), c.res.status);
      } catch {
        // keep original response if non-JSON
      }
    }
  };
}

/** Owner-only CRUD routes for managing team users (`/api/users*`). */
export function registerUserRoutes(app, { store, readJson }) {
  const ownerOnly = (c) => (c.get("authUser") ? c.json({ error: "owner access required" }, 403) : null);

  app.get("/api/users", (c) => {
    const denied = ownerOnly(c);
    if (denied) return denied;
    return c.json({ users: store.listAppUsers().map(publicAppUser) });
  });

  app.post("/api/users", async (c) => {
    const denied = ownerOnly(c);
    if (denied) return denied;
    const body = await readJson(c);
    const displayName = nameOf(body?.displayName ?? body?.name);
    if (!displayName) return c.json({ error: "نام نمایشی کاربر الزامی است." }, 400);
    let username = normalizeUsername(body?.username, displayName);
    if (!username) return c.json({ error: "نام کاربری باید ۲ تا ۴۰ نویسه از حروف انگلیسی کوچک، عدد، نقطه یا خط تیره باشد." }, 400);
    if (!body?.username) {
      let attempt = username;
      let suffix = 2;
      while (store.getAppUserByUsername(attempt)) attempt = `${username.slice(0, 35)}-${suffix++}`;
      username = attempt;
    } else if (store.getAppUserByUsername(username)) {
      return c.json({ error: "این نام کاربری قبلاً ثبت شده است." }, 409);
    }
    const token = mintUserToken();
    const created = store.createAppUser({
      username,
      displayName,
      tokenHash: hashUserToken(token),
      role: "member",
    });
    return c.json({ user: publicAppUser(created), token }, 201);
  });

  app.patch("/api/users/:id", async (c) => {
    const denied = ownerOnly(c);
    if (denied) return denied;
    const existing = store.getAppUser(c.req.param("id"));
    if (!existing) return c.json({ error: "کاربر پیدا نشد." }, 404);
    const body = await readJson(c);
    const patch = {};
    if ("displayName" in body || "name" in body) {
      const displayName = nameOf(body.displayName ?? body.name);
      if (!displayName) return c.json({ error: "نام نمایشی نمی‌تواند خالی باشد." }, 400);
      patch.displayName = displayName;
    }
    if ("username" in body) {
      const username = normalizeUsername(body.username);
      if (!username) return c.json({ error: "نام کاربری نامعتبر است." }, 400);
      const conflict = store.getAppUserByUsername(username);
      if (conflict && conflict.id !== existing.id) return c.json({ error: "این نام کاربری قبلاً ثبت شده است." }, 409);
      patch.username = username;
    }
    if (typeof body.enabled === "boolean") {
      patch.enabled = body.enabled;
      if (!body.enabled && existing.enabled) patch.bumpSessionVersion = true;
    }
    const updated = store.updateAppUser(existing.id, patch);
    return c.json({ user: publicAppUser(updated) });
  });

  app.post("/api/users/:id/reset-token", (c) => {
    const denied = ownerOnly(c);
    if (denied) return denied;
    const existing = store.getAppUser(c.req.param("id"));
    if (!existing) return c.json({ error: "کاربر پیدا نشد." }, 404);
    const token = mintUserToken();
    const updated = store.updateAppUser(existing.id, {
      tokenHash: hashUserToken(token),
      bumpSessionVersion: true,
    });
    return c.json({ user: publicAppUser(updated), token });
  });

  app.delete("/api/users/:id", (c) => {
    const denied = ownerOnly(c);
    if (denied) return denied;
    const existing = store.getAppUser(c.req.param("id"));
    if (!existing) return c.json({ error: "کاربر پیدا نشد." }, 404);
    const deleteChats = c.req.query("deleteChats") === "1" || c.req.query("deleteChats") === "true";
    store.deleteAppUser(existing.id, { deleteChats });
    return c.json({ ok: true });
  });
}
