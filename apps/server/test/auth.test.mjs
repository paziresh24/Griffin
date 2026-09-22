import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { createAuth } from "../src/auth.mjs";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-auth-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const runner = createRunner({ store, sdk: {}, agentOptions: () => ({}), log: {} });
  const app = createApp({ store, runner, auth: createAuth({ dataDir: dir, store }) });
  const token = fs.readFileSync(path.join(dir, "owner.token"), "utf8").trim();
  const cleanup = () => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, store, token, dir, cleanup };
}

const origin = "http://localhost";
const login = (app, token) =>
  app.request(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token }),
  });

test("API requires a session; login sets a signed HttpOnly cookie", async () => {
  const { app, token, dir, cleanup } = setup();
  try {
    assert.equal(fs.statSync(path.join(dir, "owner.token")).mode & 0o777, 0o600);
    assert.equal((await app.request(`${origin}/api/chats`)).status, 401);
    assert.equal((await app.request(`${origin}/healthz`)).status, 200);

    const ok = await login(app, token);
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const session = cookie.split(";")[0];
    assert.equal((await app.request(`${origin}/api/chats`, { headers: { cookie: session } })).status, 200);

    const tampered = session.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));
    assert.equal((await app.request(`${origin}/api/chats`, { headers: { cookie: tampered } })).status, 401);

    // revoke-all invalidates existing cookies
    const revoke = await app.request(`${origin}/api/auth/revoke-all`, { method: "POST", headers: { cookie: session, origin } });
    assert.equal(revoke.status, 200);
    assert.equal((await app.request(`${origin}/api/chats`, { headers: { cookie: session } })).status, 401);
  } finally {
    cleanup();
  }
});

test("cross-origin writes are rejected and brute force is rate limited", async () => {
  const { app, token, cleanup } = setup();
  try {
    const session = (await login(app, token)).headers.get("set-cookie").split(";")[0];
    const cross = await app.request(`${origin}/api/chats`, {
      method: "POST",
      headers: { cookie: session, origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    assert.equal(cross.status, 403);

    for (let i = 0; i < 5; i += 1) assert.equal((await login(app, "wrong")).status, 401);
    assert.equal((await login(app, token)).status, 429);
  } finally {
    cleanup();
  }
});

test("public share: read-only, scoped to its chat, revocable", async () => {
  const { app, store, token, cleanup } = setup();
  try {
    const session = (await login(app, token)).headers.get("set-cookie").split(";")[0];
    const chat = store.createChat({ title: "فروش امروز", mode: "agent" });
    const other = store.createChat({ title: "خصوصی", mode: "agent" });
    store.appendEvent(chat.id, null, "user", { text: "فروش؟" });
    const mine = store.saveMedia({ chatId: chat.id, mimeType: "image/png", data: Buffer.from("png"), meta: {} });
    const foreign = store.saveMedia({ chatId: other.id, mimeType: "image/png", data: Buffer.from("secret"), meta: {} });

    assert.equal((await app.request(`${origin}/api/chats/${chat.id}/share`, { method: "POST", headers: { origin } })).status, 401, "creating a link needs a session");
    const { share } = await (await app.request(`${origin}/api/chats/${chat.id}/share`, { method: "POST", headers: { cookie: session, origin } })).json();
    assert.match(share.token, /^[A-Za-z0-9_-]{32}$/);
    const again = await (await app.request(`${origin}/api/chats/${chat.id}/share`, { method: "POST", headers: { cookie: session, origin } })).json();
    assert.equal(again.share.token, share.token, "one active link per chat");

    const view = await app.request(`${origin}/api/public/${share.token}`);
    assert.equal(view.status, 200);
    const body = await view.json();
    assert.equal(body.chat.title, "فروش امروز");
    assert.equal(body.timeline.messages[0].text, "فروش؟");
    assert.equal(body.chat.id, undefined, "no internal ids");
    assert.equal((await app.request(`${origin}/api/public/${share.token}/media/${mine}`)).status, 200);
    assert.equal((await app.request(`${origin}/api/public/${share.token}/media/${foreign}`)).status, 404, "other chats' files stay private");
    assert.equal((await app.request(`${origin}/api/public/${share.token}/../chats`)).status, 404);
    assert.equal((await app.request(`${origin}/api/public/not-a-token`)).status, 404);

    await app.request(`${origin}/api/chats/${chat.id}/share`, { method: "DELETE", headers: { cookie: session, origin } });
    assert.equal((await app.request(`${origin}/api/public/${share.token}`)).status, 404, "revoked");
    const fresh = await (await app.request(`${origin}/api/chats/${chat.id}/share`, { method: "POST", headers: { cookie: session, origin } })).json();
    assert.notEqual(fresh.share.token, share.token);
  } finally {
    cleanup();
  }
});
