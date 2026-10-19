import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { openStore } from "../src/db.mjs";
import { cutUnits, signedParts, splitMarkdown, withAgentFooter } from "../src/integrations/format.mjs";
import { createBotChannel, BotApiError } from "../src/integrations/bots.mjs";
import { createAccountChannel, createAccountLogin } from "../src/integrations/telegram-account.mjs";
import { createIntegrations, integrationRoutes } from "../src/integrations/manager.mjs";

// Messenger behaviour brought over when the Karsara codebase was merged into Griffin.

test("splitMarkdown: a long code block is closed and reopened, every part fits, no emoji is cut", () => {
  const code = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const parts = splitMarkdown(`intro\n\n\`\`\`sh\n${code}\n\`\`\`\n\noutro`, 1000);
  assert.ok(parts.length > 3);
  for (const part of parts) {
    assert.ok(part.length <= 1000, String(part.length));
    assert.equal((part.match(/^\s*```/gm) || []).length % 2, 0, part.slice(0, 80));
  }
  const emoji = "😀".repeat(10);
  assert.equal(cutUnits(emoji, 5), "😀😀"); // never half a surrogate pair
  for (const part of signedParts(`${"😀".repeat(3000)}\n\n— x`, 1000)) assert.ok(!/[\uD800-\uDBFF]$/.test(part.split("\n")[0]));
});

test("withAgentFooter closes an unclosed code block so the signature is not swallowed by it", () => {
  const out = withAgentFooter("see:\n```\nkubectl get pods", "— گریفین");
  assert.match(out, /kubectl get pods\n```\n\n— گریفین$/);
});

test("bot: a long answer is cut before HTML, one bad part falls back alone, buttons ride on the last part", async () => {
  const calls = [];
  const api = {
    spec: { html: true },
    async call(method, params) {
      calls.push({ method, params });
      if (params.parse_mode === "HTML" && params.text.includes("BAD")) throw new BotApiError("sendMessage: Bad Request: can't parse entities");
      return { message_id: calls.length };
    },
  };
  const bridge = { integration: () => ({ settings: { pairedChats: ["55"] } }) };
  const channel = createBotChannel({ integration: { id: "b", kind: "telegram_bot", settings: {} }, api, bridge, log: {} });
  const para = (tag) => `${tag} ${"word ".repeat(600)}`;
  await channel.deliver("55", { question: { question: `${para("A")}\n\n${para("BAD")}\n\n${para("C")}`, askId: "q1", options: [{ label: "بله" }] } });
  const sends = calls.filter((c) => c.method === "sendMessage").map((c) => c.params);
  assert.ok(sends.length >= 3);
  for (const s of sends) assert.ok(s.text.length <= 4096);
  // Only the bad part went as plain text; the others kept HTML.
  assert.equal(sends.filter((s) => !s.parse_mode).length, 1);
  assert.ok(!sends.find((s) => !s.parse_mode).text.startsWith("A "));
  assert.deepEqual(sends.map((s) => Boolean(s.reply_markup)), sends.map((_, i) => i === sends.length - 1));
});

test("bot: a stranger is signed with the assistant's name only, never the configured SIGNATURE", async () => {
  process.env.GRIFFIN_SIGNATURE = "— {name}، دستیارِ مالکِ‌محرمانه";
  try {
    const sent = [];
    const api = { spec: { html: false }, async call(_m, params) { sent.push(params); return { message_id: 1 }; } };
    const bridge = { integration: () => ({ settings: { pairedChats: ["1"] } }) };
    const channel = createBotChannel({ integration: { id: "b", kind: "telegram_bot", settings: {} }, api, bridge, log: {} });
    await channel.deliver("999", { text: "سلام" });
    await channel.deliver("1", { text: "سلام" });
    assert.ok(!sent[0].text.includes("مالکِ‌محرمانه"), sent[0].text);
    assert.ok(sent[1].text.includes("مالکِ‌محرمانه"), sent[1].text);
  } finally {
    delete process.env.GRIFFIN_SIGNATURE;
  }
});

test("account: a send Telegram never answers times out instead of hanging the delivery", async () => {
  const client = {
    connect: async () => {}, checkAuthorization: async () => true, getMe: async () => ({ id: 100, username: "me" }),
    addEventHandler: () => {}, getDialogs: async () => [], getMessages: async () => [], getEntity: async (k) => k,
    deleteMessages: async () => {}, disconnect: async () => {},
    sendMessage: () => new Promise(() => {}),
  };
  const load = async () => ({ TelegramClient: function () { return client; }, StringSession: function () {}, NewMessage: function () {}, CustomFile: function () {} });
  const bridge = { receive: async () => {}, answer: async () => false, answerOwnerAsk: async () => false, isCovered: () => false, coverageName: () => null, startCoverage: async () => ({}), endCoverage: async () => null };
  const channel = createAccountChannel({ integration: { id: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} }, bridge, load, log: {}, sendTimeoutMs: 50 });
  await channel.start();
  await assert.rejects(channel.deliver("@someone", { text: "hi" }), /timed out/);
  await channel.stop?.();
});

test("account login: a 2FA account returns the password hint the owner set in Telegram", async () => {
  class SignIn {}
  class GetPassword {}
  const client = {
    connect: async () => {},
    sendCode: async () => ({ phoneCodeHash: "h", isCodeViaApp: true }),
    invoke: async (req) => {
      if (req instanceof SignIn) throw Object.assign(new Error("x"), { errorMessage: "SESSION_PASSWORD_NEEDED" });
      if (req instanceof GetPassword) return { hint: "اسم گربه" };
      return null;
    },
    disconnect: async () => {},
  };
  const load = async () => ({ TelegramClient: function () { return client; }, StringSession: function () {}, Api: { auth: { SignIn }, account: { GetPassword } } });
  const login = createAccountLogin({ proxy: null, load });
  const { loginId } = await login.start({ apiId: 1, apiHash: "h", phone: "+989120000000" });
  assert.deepEqual(await login.code(loginId, "12345"), { needPassword: true, hint: "اسم گربه" });
});

test("login route: the same Telegram user signing in again renews his integration instead of adding a second", async () => {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-relogin-")), "db.sqlite"));
  const fake = { kind: "telegram_account", status: { state: "polling" }, start: async () => {}, stop: () => {}, deliver: async () => {} };
  const me = { id: "77", name: "E", username: "e" };
  const login = { code: async () => ({ secret: "new-session", me }) };
  const integrations = createIntegrations({ store, runner: { isActive: () => false, send: async () => ({}) }, asks: null, login, channelFactories: { telegram_account: () => fake }, log: {} });
  const old = integrations.add("telegram_account", { name: "E", secret: "old", settings: { me, pairedChats: ["me"] } });
  store.linkChat(old.id, "me", store.createChat({ title: "t" }).id);
  const app = new Hono();
  integrationRoutes(app, integrations);
  const res = await app.request(`/api/integrations/telegram-account/login/x`, { method: "POST", body: JSON.stringify({ code: "1" }), headers: { "content-type": "application/json" } });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).integration.id, old.id);
  assert.equal(store.listIntegrations().filter((i) => i.kind === "telegram_account").length, 1);
  assert.equal(store.getIntegration(old.id).secret, "new-session");
  assert.ok(store.linkedChat(old.id, "me"));
  integrations.stopAll?.();
  store.close();
});
