import assert from "node:assert/strict";
import test from "node:test";
import { createBotApi } from "../src/integrations/bots.mjs";

// The capsule cannot reach api.telegram.org directly; a Telegram bot must be able to go through a
// Bot API mirror (GRIFFIN_TELEGRAM_BOT_API). Bale keeps its own host.
function recorder() {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: "x_bot", file_path: "photos/a.jpg" } }), arrayBuffer: async () => new ArrayBuffer(1) };
  };
  return { urls, fetchImpl };
}

test("telegram bot calls go to the configured Bot API base, files included", async () => {
  const { urls, fetchImpl } = recorder();
  const api = createBotApi({ kind: "telegram_bot", token: "1:abc", fetchImpl, apiBase: "https://mirror.example/" });
  await api.getMe();
  await api.downloadFile("f1");
  assert.deepEqual(urls, [
    "https://mirror.example/bot1:abc/getMe",
    "https://mirror.example/bot1:abc/getFile",
    "https://mirror.example/file/bot1:abc/photos/a.jpg",
  ]);
});

test("without a configured base a telegram bot uses api.telegram.org", async () => {
  const { urls, fetchImpl } = recorder();
  await createBotApi({ kind: "telegram_bot", token: "1:abc", fetchImpl, apiBase: "" }).getMe();
  assert.deepEqual(urls, ["https://api.telegram.org/bot1:abc/getMe"]);
});

test("the telegram base never applies to a bale bot", async () => {
  const { urls, fetchImpl } = recorder();
  await createBotApi({ kind: "bale_bot", token: "1:abc", fetchImpl, apiBase: "https://mirror.example" }).getMe();
  assert.deepEqual(urls, ["https://tapi.bale.ai/bot1:abc/getMe"]);
});

test("a bot added in Settings is checked and run through the configured base", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { openStore } = await import("../src/db.mjs");
  const { createIntegrations } = await import("../src/integrations/manager.mjs");
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-botbase-")), "db.sqlite"));
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const method = String(url).split("/").pop();
    if (method === "getUpdates") await new Promise((r) => setTimeout(r, 20));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: method === "getUpdates" ? [] : { username: "x_bot", first_name: "x" } }) };
  };
  const runner = { isActive: () => false, send: async () => {} };
  const integrations = createIntegrations({ store, runner, asks: null, fetchImpl, log: {}, telegramBotApi: "https://mirror.example" });
  try {
    await integrations.addBot({ kind: "telegram_bot", token: "123:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    integrations.stopAll();
  }
  assert.ok(urls.length >= 2, "the bot was checked and started");
  assert.deepEqual(urls.filter((u) => !u.startsWith("https://mirror.example/bot123:")), []);
});

test("a base that is not an http(s) URL is refused without the token in the message", () => {
  for (const apiBase of ["mirror.example", "ftp://mirror.example", "not a url", "https://mirror example", "https://host:99999", "https://[bad", "https://mirror.example/?x=1", "https://mirror.example/#a"]) {
    assert.throws(
      () => createBotApi({ kind: "telegram_bot", token: "123456:SECRETSECRETSECRETSECRETSECRET", apiBase }),
      (error) => /GRIFFIN_TELEGRAM_BOT_API/.test(error.message) && !error.message.includes("SECRET"),
    );
  }
});

test("calls through a mirror never follow a redirect (a redirected POST loses its body)", async () => {
  const inits = [];
  const fetchImpl = async (url, init) => {
    inits.push(init);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  await createBotApi({ kind: "telegram_bot", token: "1:abc", fetchImpl, apiBase: "https://mirror.example" }).getMe();
  await createBotApi({ kind: "telegram_bot", token: "1:abc", fetchImpl }).getMe();
  assert.equal(inits[0].redirect, "error");
  assert.equal(inits[1].redirect, undefined);
});

test("the server reads the mirror from GRIFFIN_TELEGRAM_BOT_API, and nothing else changes when it is unset", async () => {
  const { TELEGRAM_BOT_API_CONFIG } = await import("../src/integrations/bots.mjs");
  const { genv } = await import("../src/env.mjs");
  assert.equal(TELEGRAM_BOT_API_CONFIG, "TELEGRAM_BOT_API");
  assert.equal(genv(TELEGRAM_BOT_API_CONFIG, "", { GRIFFIN_TELEGRAM_BOT_API: "https://mirror.example" }), "https://mirror.example");
  assert.equal(genv(TELEGRAM_BOT_API_CONFIG, "", {}), "");
});

test("a mirror base that cannot be parsed never stops the server: it is reported and api.telegram.org is used", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { openStore } = await import("../src/db.mjs");
  const { createIntegrations } = await import("../src/integrations/manager.mjs");
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-botbase-bad-")), "db.sqlite"));
  const urls = [];
  const errors = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: "x_bot", first_name: "x" } }) };
  };
  const integrations = createIntegrations({ store, runner: { isActive: () => false, send: async () => {} }, asks: null, fetchImpl, log: { error: (m) => errors.push(m) }, telegramBotApi: "mirror.example" });
  try {
    await integrations.addBot({ kind: "telegram_bot", token: "123:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
  } finally {
    integrations.stopAll();
  }
  assert.ok(errors.some((m) => /GRIFFIN_TELEGRAM_BOT_API/.test(m) && !m.includes("ABCDEFGHIJ")));
  assert.ok(urls[0].startsWith("https://api.telegram.org/bot123:"));
});
