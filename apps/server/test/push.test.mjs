import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createPush, encryptPayload, ensureVapidKeys, generateVapidKeys, vapidAuthorization } from "../src/push.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "griffin-push-"));

test("encryptPayload reproduces the RFC 8291 Appendix A test vector byte for byte", () => {
  const body = encryptPayload(
    "When I grow up, I want to be a watermelon",
    { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), senderPrivateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw" },
  );
  assert.equal(
    body.toString("base64url"),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});

test("the VAPID header is an ES256 JWT for the push service's origin that verifies with the public key", () => {
  const keys = generateVapidKeys();
  const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, { subject: "https://griffin.example", now: 1_700_000_000_000 });
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(k, keys.publicKey);
  const [h, c, sig] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  assert.deepEqual(claims, { aud: "https://fcm.googleapis.com", exp: 1_700_000_000 + 12 * 3600, sub: "https://griffin.example" });
  const pub = Buffer.from(keys.publicKey, "base64url");
  const key = crypto.createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") } });
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
});

test("VAPID keys are generated once, persisted, and the file is mode 0600", () => {
  const dir = tmp();
  const first = ensureVapidKeys(dir);
  assert.equal(Buffer.from(first.publicKey, "base64url").length, 65);
  assert.deepEqual(ensureVapidKeys(dir), first);
  assert.equal(fs.statSync(path.join(dir, "vapid.json")).mode & 0o777, 0o600);
});

test("the default send POSTs an encrypted aes128gcm body with the VAPID header; 410 drops the subscription", async () => {
  const dir = tmp();
  const store = openStore(path.join(dir, "db.sqlite"));
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
  const calls = [];
  let status = 201;
  const push = createPush({
    store, dataDir: dir, log: { error() {} },
    lookup: async () => [{ address: "142.250.1.1", family: 4 }],
    fetchImpl: async (url, init) => (calls.push({ url, init }), { ok: status < 300, status }),
  });
  await push.subscribe(sub);
  assert.deepEqual(await push.sendToAll({ title: "t", body: "b" }), { sent: 1, dropped: 0 });
  const { url, init } = calls[0];
  assert.equal(url, sub.endpoint);
  assert.equal(init.headers["content-encoding"], "aes128gcm");
  assert.match(init.headers.authorization, /^vapid t=.+, k=/);
  // The phone can open it: decrypt with the subscription's private key.
  const body = init.body;
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 86);
  const hkdf = (ikm, s, info, n) => Buffer.from(crypto.hkdfSync("sha256", ikm, s, info, n));
  const ikm = hkdf(ua.computeSecret(asPublic), Buffer.from(sub.keys.auth, "base64url"), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]), 32);
  const decipher = crypto.createDecipheriv("aes-128-gcm", hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16), hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  decipher.setAuthTag(body.subarray(-16));
  const plain = Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()]);
  assert.deepEqual(JSON.parse(plain.subarray(0, -1)), { title: "t", body: "b" });

  status = 410;
  assert.deepEqual(await push.sendToAll({ title: "t", body: "b" }), { sent: 0, dropped: 1 });
  assert.equal(push.subscriptions().length, 0);
});

function lifecycle() {
  const dir = tmp();
  const store = openStore(path.join(dir, "db.sqlite"));
  const sent = [];
  const push = createPush({ store, dataDir: dir, generate: () => ({ publicKey: "p", privateKey: "q" }), log: { error() {} }, sendImpl: async (_s, b) => sent.push(JSON.parse(b)) });
  store.setKv("push_subscriptions", [{ endpoint: "https://fcm.googleapis.com/x", keys: {}, failures: 0 }]);
  push.attach();
  const turn = (chatId, userText, answer, status = "finished") => {
    store.appendEvent(chatId, null, "user", { text: userText });
    const runId = store.startRun(chatId);
    store.appendEvent(chatId, runId, "run.started", { model: "glm" });
    for (let i = 0; i < 50; i += 1) store.appendEvent(chatId, runId, "text", { text: i === 0 ? answer : "" });
    store.appendEvent(chatId, runId, "run.finished", { status });
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  return { store, sent, turn, settle };
}

test("push glue: an owner turn rings once at its end; a delegate report turn rings as background", async () => {
  const { store, sent, turn, settle } = lifecycle();
  const chat = store.createChat({ title: "دیسک S3" });
  turn(chat.id, "دیسک چقدر پره؟", "۹۹٪ پر است");
  await settle();
  assert.deepEqual(sent.map((m) => [m.kind, m.title, m.body]), [["finished", "دیسک S3", "۹۹٪ پر است"]]);
  assert.equal(sent[0].url, `/#/c/${chat.id}`);
  turn(chat.id, "[گزارش خودکار زیرکارها — …]\n\nپلتفرم — finished", "زیرکار تمام شد: پادها سالم‌اند");
  await settle();
  assert.deepEqual(sent.map((m) => m.kind), ["finished", "background"]);
  turn(chat.id, "ادامه بده", "باشه", "cancelled");
  await settle();
  assert.equal(sent.length, 2, "a cancelled turn stays silent");
});

test("push glue: an owner question rings once in any chat; job, colleague and child chats do not ring on finish", async () => {
  const { store, sent, turn, settle } = lifecycle();
  const job = store.createChat({ title: "جاب", caller: "scheduler" });
  const team = store.createChat({ title: "رشته", caller: "team" });
  const parent = store.createChat({ title: "والد" });
  const child = store.createChat({ title: "فرزند", parentChatId: parent.id, caller: "griffin" });
  for (const c of [job, team, child]) turn(c.id, "x", "y");
  await settle();
  assert.equal(sent.length, 0);
  const ask = store.appendEvent(team.id, null, "ask.pending", { question: "merge کنم؟", audience: "owner" });
  store.bus.emit("event", team.id, ask); // a replay of the same event
  store.appendEvent(team.id, null, "ask.pending", { question: "از همکار", audience: "requester" });
  await settle();
  assert.deepEqual(sent.map((m) => [m.kind, m.body]), [["question", "سؤال: merge کنم؟"]]);
});

test("push routes: key, subscribe and unsubscribe", async () => {
  const dir = tmp();
  const store = openStore(path.join(dir, "db.sqlite"));
  const push = createPush({ store, dataDir: dir, lookup: async () => [{ address: "142.250.1.1", family: 4 }], log: { error() {} } });
  const { Hono } = await import("hono");
  const api = new Hono();
  push.routes(api);
  assert.equal((await (await api.request("/api/push/key")).json()).publicKey, push.publicKey);
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/1", keys: { p256dh: push.publicKey, auth: Buffer.alloc(16, 1).toString("base64url") } };
  const post = (body) => api.request("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ endpoint: "https://10.0.0.1/x", keys: sub.keys })).status, 400);
  assert.equal((await post(sub)).status, 201);
  const del = await api.request("/api/push/subscribe", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
  assert.deepEqual(await del.json(), { removed: true });
});
