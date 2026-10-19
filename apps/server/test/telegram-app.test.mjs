import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { integrationRoutes } from "../src/integrations/manager.mjs";
import { readTelegramApp } from "../src/integrations/telegram-app.mjs";

const APP = { apiId: "1234567", apiHash: "0123456789abcdef0123456789abcdef" };

function dataDir(app) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tgapp-"));
  if (app !== undefined) fs.writeFileSync(path.join(dir, "telegram-app.json"), typeof app === "string" ? app : JSON.stringify(app), { mode: 0o600 });
  return dir;
}

function routes(dir) {
  const calls = [];
  const integrations = {
    telegramApp: () => readTelegramApp(dir),
    login: { start: async (args) => (calls.push(args), { loginId: "L1", viaApp: true }) },
  };
  const app = new Hono();
  integrationRoutes(app, integrations);
  const post = (body) => app.request("/api/integrations/telegram-account/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, calls, post };
}

test("readTelegramApp: valid file → ids; missing, malformed or invalid → null", () => {
  assert.deepEqual(readTelegramApp(dataDir(APP)), APP);
  assert.equal(readTelegramApp(dataDir()), null);
  assert.equal(readTelegramApp(dataDir("{not json")), null);
  assert.equal(readTelegramApp(dataDir({ apiId: "x", apiHash: APP.apiHash })), null);
  assert.equal(readTelegramApp(dataDir({ apiId: APP.apiId, apiHash: "short" })), null);
});

test("GET app says whether a default exists and never returns the ids", async () => {
  for (const [dir, preset] of [[dataDir(APP), true], [dataDir(), false]]) {
    const res = await routes(dir).app.request("/api/integrations/telegram-account/app");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { preset });
    assert.ok(!text.includes(APP.apiHash) && !text.includes(APP.apiId));
  }
});

test("login with only a phone uses the server's default app", async () => {
  const r = routes(dataDir(APP));
  const res = await r.post({ phone: "+98 912 000-0000" });
  assert.equal(res.status, 200);
  assert.deepEqual(r.calls, [{ apiId: APP.apiId, apiHash: APP.apiHash, phone: "+989120000000" }]);
});

test("a pasted phone with hidden direction marks, spaces or Persian digits still works", async () => {
  const r = routes(dataDir(APP));
  assert.equal((await r.post({ phone: "\u200e+98 ۹۱۲ 000-0000\u200e" })).status, 200);
  assert.deepEqual(r.calls, [{ apiId: APP.apiId, apiHash: APP.apiHash, phone: "+989120000000" }]);
});

test("a bad phone with a default app says the phone is wrong, not the ids", async () => {
  const r = routes(dataDir(APP));
  const res = await r.post({ phone: "+98912" });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.ok(!error.includes("api_id") && error.includes("شماره"), error);
  assert.equal(r.calls.length, 0);
});

test("ids typed in the form still win over the default", async () => {
  const r = routes(dataDir(APP));
  const own = { apiId: "7654321", apiHash: "fedcba9876543210fedcba9876543210" };
  assert.equal((await r.post({ ...own, phone: "+989120000000" })).status, 200);
  assert.deepEqual(r.calls, [{ ...own, phone: "+989120000000" }]);
});

test("no default and no ids → 400, Telegram is never called", async () => {
  const r = routes(dataDir());
  assert.equal((await r.post({ phone: "+989120000000" })).status, 400);
  assert.equal(r.calls.length, 0);
});
