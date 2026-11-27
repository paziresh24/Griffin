import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.mjs";
import { createAuth } from "../src/auth.mjs";
import { openStore } from "../src/db.mjs";
import { resolveEnabledTools } from "../src/agents/profiles.mjs";
import { runAccess } from "../src/jobs/owner-jobs.mjs";

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-users-"));
  const store = openStore(path.join(dir, "griffin.sqlite"));
  const ownerToken = "owner-secret-token-1234567890";
  fs.writeFileSync(path.join(dir, "owner.token"), ownerToken, { mode: 0o600 });
  const auth = createAuth({ dataDir: dir, store });
  const sent = [];
  const runner = {
    activeCount: () => 0,
    isActive: () => false,
    send: async (chatId, input) => {
      sent.push({ chatId, input });
      store.appendEvent(chatId, null, "user", { text: input.text });
      return { queued: false };
    },
    enqueue: async ({ chatId, text }) => {
      sent.push({ chatId, text });
    },
  };
  const app = createApp({
    store,
    runner,
    auth,
    searchMessages: () => true,
    extraRoutes: (api) => {
      api.get("/api/secrets", (c) => c.json({ secrets: ["top-secret"] }));
      api.get("/api/config", (c) => c.json({ config: {} }));
      api.get("/api/providers", (c) =>
        c.json({
          defaultEngine: "openai-codex",
          providers: [
            { id: "openai-codex", label: "Codex", kind: "openai", enabled: true, apiKey: "sk-secret", signedInAs: "boss@example.com", proxyUrl: "socks5://1.2.3.4:1080" },
          ],
        }),
      );
    },
  });
  store.enableSearch?.();
  return { dir, store, auth, app, ownerToken, sent };
}

function cookieFrom(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  return list.map((h) => h.split(";")[0]).filter((kv) => kv && !kv.endsWith("=")).join("; ");
}

async function login(app, token) {
  const res = await app.request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return { res, cookie: cookieFrom(res), body: await res.json() };
}

test("owner creates users, members sign in with personal tokens, and chats/groups/notes/search are strictly isolated", async () => {
  const { app, ownerToken, store } = makeFixture();
  const owner = await login(app, ownerToken);
  assert.equal(owner.res.status, 200);

  // Create two team members
  const c1 = await app.request("http://localhost/api/users", {
    method: "POST",
    headers: { cookie: owner.cookie, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "علی رضایی", username: "ali" }),
  });
  assert.equal(c1.status, 201);
  const { user: aliUser, token: aliToken } = await c1.json();
  assert.equal(aliUser.username, "ali");
  assert.equal(aliUser.displayName, "علی رضایی");
  assert.match(aliToken, /^grf_u_/);

  const c2 = await app.request("http://localhost/api/users", {
    method: "POST",
    headers: { cookie: owner.cookie, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "سارا احمدی" }),
  });
  assert.equal(c2.status, 201);
  const { user: saraUser, token: saraToken } = await c2.json();
  assert.ok(saraUser.username.startsWith("user-"));

  // List users never exposes token_hash or token
  const listRes = await app.request("http://localhost/api/users", { headers: { cookie: owner.cookie } });
  const { users } = await listRes.json();
  assert.equal(users.length, 2);
  assert.equal("token_hash" in users[0], false);
  assert.equal("token" in users[0], false);

  // Sign in as Ali and Sara
  const ali = await login(app, aliToken);
  assert.equal(ali.res.status, 200);
  assert.equal(ali.body.role, "member");
  assert.equal(ali.body.user.username, "ali");

  const sara = await login(app, saraToken);
  assert.equal(sara.res.status, 200);

  // /api/auth/me distinguishes owner vs member
  const meOwner = await (await app.request("http://localhost/api/auth/me", { headers: { cookie: owner.cookie } })).json();
  assert.equal(meOwner.authenticated, true);
  assert.equal(meOwner.role, undefined);

  const meAli = await (await app.request("http://localhost/api/auth/me", { headers: { cookie: ali.cookie } })).json();
  assert.equal(meAli.authenticated, true);
  assert.equal(meAli.role, "member");
  assert.equal(meAli.user.id, aliUser.id);

  // Create chats for Owner, Ali, and Sara
  const ownerChatRes = await app.request("http://localhost/api/chats", {
    method: "POST",
    headers: { cookie: owner.cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "رمز محرمانه سرور اصلی alphasecret" }),
  });
  assert.equal(ownerChatRes.status, 201);
  const { chat: ownerChat } = await ownerChatRes.json();

  const aliChatRes = await app.request("http://localhost/api/chats", {
    method: "POST",
    headers: { cookie: ali.cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "پروژه فرانت علی betatoken", runsOn: "host", sim: true }),
  });
  assert.equal(aliChatRes.status, 201);
  const { chat: aliChat } = await aliChatRes.json();
  assert.equal(store.getChat(aliChat.id).caller, `user:${aliUser.id}`);
  assert.equal(store.getChat(aliChat.id).user_id, aliUser.id);
  assert.equal(store.getChat(aliChat.id).sim, 0);

  const saraChatRes = await app.request("http://localhost/api/chats", {
    method: "POST",
    headers: { cookie: sara.cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "تسک بک‌اند سارا gammatask" }),
  });
  assert.equal(saraChatRes.status, 201);
  const { chat: saraChat } = await saraChatRes.json();

  // Each party sees ONLY their own chats in GET /api/chats
  const ownerChats = (await (await app.request("http://localhost/api/chats", { headers: { cookie: owner.cookie } })).json()).chats;
  assert.deepEqual(ownerChats.map((c) => c.id), [ownerChat.id]);

  const aliChats = (await (await app.request("http://localhost/api/chats", { headers: { cookie: ali.cookie } })).json()).chats;
  assert.deepEqual(aliChats.map((c) => c.id), [aliChat.id]);

  const saraChats = (await (await app.request("http://localhost/api/chats", { headers: { cookie: sara.cookie } })).json()).chats;
  assert.deepEqual(saraChats.map((c) => c.id), [saraChat.id]);

  // Direct ID access across users/owner is blocked with 404
  assert.equal((await app.request(`http://localhost/api/chats/${ownerChat.id}`, { headers: { cookie: ali.cookie } })).status, 404);
  assert.equal((await app.request(`http://localhost/api/chats/${ownerChat.id}/timeline`, { headers: { cookie: ali.cookie } })).status, 404);
  assert.equal((await app.request(`http://localhost/api/chats/${saraChat.id}`, { headers: { cookie: ali.cookie } })).status, 404);
  assert.equal((await app.request(`http://localhost/api/chats/${aliChat.id}/terminal`, { method: "POST", headers: { cookie: ali.cookie } })).status, 403);

  // Full-text search does not leak hits or snippets across users/owner
  const aliSearchLeak = await (await app.request("http://localhost/api/chats/search?q=alphasecret", { headers: { cookie: ali.cookie } })).json();
  assert.deepEqual(aliSearchLeak.ids, []);
  const aliSearchOwn = await (await app.request("http://localhost/api/chats/search?q=betatoken", { headers: { cookie: ali.cookie } })).json();
  assert.deepEqual(aliSearchOwn.ids, [aliChat.id]);
  const ownerSearchMember = await (await app.request("http://localhost/api/chats/search?q=betatoken", { headers: { cookie: owner.cookie } })).json();
  assert.deepEqual(ownerSearchMember.ids, []);

  // Groups and Notes are isolated per user
  const ownerGrp = await (await app.request("http://localhost/api/groups", {
    method: "POST",
    headers: { cookie: owner.cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "پوشه مدیر" }),
  })).json();
  const aliGrp = await (await app.request("http://localhost/api/groups", {
    method: "POST",
    headers: { cookie: ali.cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "پوشه علی" }),
  })).json();
  assert.equal((await (await app.request("http://localhost/api/groups", { headers: { cookie: ali.cookie } })).json()).groups.length, 1);
  assert.equal((await app.request(`http://localhost/api/chats/${aliChat.id}`, {
    method: "PATCH",
    headers: { cookie: ali.cookie, "content-type": "application/json" },
    body: JSON.stringify({ groupId: ownerGrp.group.id }),
  })).status, 400);
  assert.equal((await app.request(`http://localhost/api/chats/${aliChat.id}`, {
    method: "PATCH",
    headers: { cookie: ali.cookie, "content-type": "application/json" },
    body: JSON.stringify({ groupId: aliGrp.group.id }),
  })).status, 200);

  // Owner-only endpoints return 403 for members, and /api/providers strips account secrets
  assert.equal((await app.request("http://localhost/api/users", { headers: { cookie: ali.cookie } })).status, 403);
  assert.equal((await app.request("http://localhost/api/secrets", { headers: { cookie: ali.cookie } })).status, 403);
  assert.equal((await app.request("http://localhost/api/config", { headers: { cookie: ali.cookie } })).status, 403);
  assert.equal((await app.request("http://localhost/api/auth/rotate-token", { method: "POST", headers: { cookie: ali.cookie } })).status, 403);

  const aliProviders = await (await app.request("http://localhost/api/providers", { headers: { cookie: ali.cookie } })).json();
  assert.equal(aliProviders.providers[0].id, "openai-codex");
  assert.equal("apiKey" in aliProviders.providers[0], false);
  assert.equal("signedInAs" in aliProviders.providers[0], false);
  assert.equal("proxyUrl" in aliProviders.providers[0], false);

  // Disabling a user immediately revokes their active session cookie and blocks re-login
  const disableRes = await app.request(`http://localhost/api/users/${aliUser.id}`, {
    method: "PATCH",
    headers: { cookie: owner.cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableRes.status, 200);
  assert.equal((await app.request("http://localhost/api/chats", { headers: { cookie: ali.cookie } })).status, 401);
  assert.equal((await login(app, aliToken)).res.status, 403);

  // Re-enabling + resetting token issues a new token and keeps old cookies dead
  await app.request(`http://localhost/api/users/${aliUser.id}`, {
    method: "PATCH",
    headers: { cookie: owner.cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal((await app.request("http://localhost/api/chats", { headers: { cookie: ali.cookie } })).status, 401);
  const resetRes = await app.request(`http://localhost/api/users/${aliUser.id}/reset-token`, {
    method: "POST",
    headers: { cookie: owner.cookie },
  });
  const { token: newAliToken } = await resetRes.json();
  assert.equal((await login(app, aliToken)).res.status, 401);
  const ali2 = await login(app, newAliToken);
  assert.equal(ali2.res.status, 200);

  // Member can rotate their own token via /api/auth/my-token and stay signed in on current browser
  const selfRot = await app.request("http://localhost/api/auth/my-token", {
    method: "POST",
    headers: { cookie: ali2.cookie },
  });
  assert.equal(selfRot.status, 200);
  const newCookie = cookieFrom(selfRot);
  const { token: selfToken } = await selfRot.json();
  assert.match(selfToken, /^grf_u_/);
  assert.equal((await app.request("http://localhost/api/chats", { headers: { cookie: ali2.cookie } })).status, 401);
  assert.equal((await app.request("http://localhost/api/chats", { headers: { cookie: newCookie } })).status, 200);
});

test("member run permissions: guardMode is refuse, asOwner is false, and sensitive host/secret tools are stripped", () => {
  assert.deepEqual(runAccess({ rootCaller: "user:u1", unattended: false }), { asOwner: false, guardMode: "refuse" });
  const catalog = [
    "web_search",
    "web_fetch",
    "browser_open",
    "visualize",
    "knowledge_list",
    "knowledge_write",
    "debug_exec",
    "ssh_exec",
    "kube_secret",
    "infisical_get",
    "telegram_send",
    "engine_manage",
    "app_settings_set",
    "agent_tools_enable",
  ];
  const allowed = resolveEnabledTools({ meta: { allTools: true }, tools: [] }, { caller: "user:u1", catalogNames: catalog });
  assert.ok(allowed.includes("web_search"));
  assert.ok(allowed.includes("browser_open"));
  assert.ok(allowed.includes("knowledge_list"));
  for (const forbidden of ["knowledge_write", "debug_exec", "ssh_exec", "kube_secret", "infisical_get", "telegram_send", "engine_manage", "app_settings_set", "agent_tools_enable"]) {
    assert.equal(allowed.includes(forbidden), false, `${forbidden} must not be exposed to member users`);
  }
});
