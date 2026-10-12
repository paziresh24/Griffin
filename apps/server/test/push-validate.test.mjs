// Push subscription validation, send limits and lock-screen redaction.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import * as pushModule from "../src/push.mjs";

const { createPush, redactSecrets } = pushModule;
const fakeGenerate = () => ({ publicKey: "pub", privateKey: "priv" });
const publicLookup = async () => [{ address: "142.250.1.1", family: 4 }];
const privateLookup = async () => [{ address: "10.0.0.5", family: 4 }];
const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
const auth = Buffer.alloc(16, 3).toString("base64url");
const good = (n = 1) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh, auth } });

function setup({ sendImpl, lookup = publicLookup, sendTimeoutMs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-pushv-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sent = [];
  const push = createPush({
    store,
    dataDir: dir,
    generate: fakeGenerate,
    log: { error() {} },
    lookup,
    ...(sendTimeoutMs ? { sendTimeoutMs } : {}),
    sendImpl: sendImpl || (async (_sub, body) => sent.push(JSON.parse(body))),
  });
  const cleanup = () => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { push, store, sent, cleanup };
}

async function rejects(promiseFn) {
  try {
    await promiseFn();
  } catch {
    return true;
  }
  return false;
}

test("push subscribe: only https endpoints on known public push services with valid keys", async () => {
  const { push, cleanup } = setup();
  try {
    assert.ok(await rejects(() => push.subscribe({ ...good(), endpoint: "http://fcm.googleapis.com/fcm/send/1" })), "http refused");
    assert.ok(await rejects(() => push.subscribe({ ...good(), endpoint: "https://127.0.0.1/x" })), "loopback refused");
    assert.ok(await rejects(() => push.subscribe({ ...good(), endpoint: "https://evil.example/x" })), "unknown host refused");
    assert.ok(await rejects(() => push.subscribe({ ...good(), keys: { p256dh: "a", auth: "b" } })), "bad key shapes refused");
    assert.ok(await rejects(() => push.subscribe({ ...good(), keys: { p256dh, auth: "x".repeat(40) } })), "bad auth refused");
    assert.equal(push.subscriptions().length, 0);
    await push.subscribe(good());
    await push.subscribe({ ...good(2), endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc" });
    assert.equal(push.subscriptions().length, 2);
  } finally {
    cleanup();
  }
});

test("push subscribe: a known push host that resolves to a private address is refused (DNS checked)", async () => {
  const { push, cleanup } = setup({ lookup: privateLookup });
  try {
    assert.ok(await rejects(() => push.subscribe(good())));
    assert.equal(push.subscriptions().length, 0);
  } finally {
    cleanup();
  }
});

test("push subscribe: at most 10 subscriptions, the oldest is dropped", async () => {
  const { push, cleanup } = setup();
  try {
    for (let i = 1; i <= 12; i += 1) await push.subscribe(good(i));
    const list = push.subscriptions().map((s) => s.endpoint);
    assert.equal(list.length, 10);
    assert.ok(!list.includes(good(1).endpoint) && !list.includes(good(2).endpoint));
    assert.ok(list.includes(good(12).endpoint));
  } finally {
    cleanup();
  }
});

test("push send: a hung send times out, and an endpoint is dropped after 5 consecutive failures of any kind", async () => {
  const { push, cleanup } = setup({ sendImpl: () => new Promise(() => {}), sendTimeoutMs: 20 });
  try {
    await push.subscribe(good());
    for (let i = 1; i <= 4; i += 1) {
      const started = Date.now();
      await push.sendToAll({ title: "t", body: "b" });
      assert.ok(Date.now() - started < 2000, "the send is bounded by its timeout");
      assert.equal(push.subscriptions().length, 1, `kept after ${i} failures`);
    }
    await push.sendToAll({ title: "t", body: "b" });
    assert.equal(push.subscriptions().length, 0, "dropped after the 5th consecutive failure");
  } finally {
    cleanup();
  }
});

test("push send: the default send timeout is 10 s", () => {
  const source = fs.readFileSync(new URL("../src/push.mjs", import.meta.url), "utf8");
  assert.match(source, /SEND_TIMEOUT_MS = 10_000/);
});

test("push text: token-like strings are redacted from title and body, both capped at 60 characters", async () => {
  const { push, store, sent, cleanup } = setup();
  try {
    await push.subscribe(good());
    const secrets = [
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "password=hunter2secret",
      "0123456789abcdef0123456789abcdef01234567",
    ];
    for (const secret of secrets) {
      const chat = store.createChat({ title: `deploy ${secret}` });
      await push.notify("finished", chat, { summary: `done ${secret}` });
    }
    const long = store.createChat({ title: "x".repeat(10) + " " + "y ".repeat(80) });
    await push.notify("finished", long, { summary: "z ".repeat(100) });
    assert.equal(sent.length, secrets.length + 1);
    for (const [i, msg] of sent.slice(0, secrets.length).entries()) {
      const leaked = secrets[i].includes("=") ? "hunter2secret" : secrets[i].slice(0, 20);
      assert.ok(!msg.title.includes(leaked), `title leaks ${leaked}: ${msg.title}`);
      assert.ok(!msg.body.includes(leaked), `body leaks ${leaked}: ${msg.body}`);
    }
    for (const msg of sent) {
      assert.ok(msg.title.length <= 60, `title ${msg.title.length} chars`);
      assert.ok(msg.body.length <= 60, `body ${msg.body.length} chars`);
    }
  } finally {
    cleanup();
  }
});

test("redactSecrets: GitLab, GitHub, Slack, AWS and generic mixed tokens are redacted; short paths survive", () => {
  const tokens = [
    "glpat-AbCdEfGhIjKlMnOpQrSt",
    "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "gho_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "xoxb-123456789012-abcdefABCDEF",
    "AKIAIOSFODNN7EXAMPLE",
    "a1B2c3D4e5F6g7H8i9J0k1L2m3",
  ];
  for (const t of tokens) {
    const out = redactSecrets(`key ${t} end`);
    assert.ok(!out.includes(t.slice(0, 12)), `${t} leaked: ${out}`);
    assert.match(out, /\[redacted\]/);
  }
  // Short paths survive; a 30+ character run holding a / is redacted even when it is a path
  // (safety over precision: a base64 key looks the same).
  const paths = ["src/providers/claude.mjs", "D:/git-repos/griffin/README.md"];
  for (const p of paths) assert.equal(redactSecrets(`edited ${p}`), `edited ${p}`, "a short file path survives");
  assert.equal(redactSecrets("edited apps/server/test/worktree-archive-with-a-very-long-name.test.mjs"), "edited [redacted].test.mjs");
  assert.equal(redactSecrets("reviewing the_quite_long_identifier_without_digits"), "reviewing the_quite_long_identifier_without_digits");
});

test("redactSecrets: a URL keeps only scheme://host, and base64 keys with / or + are redacted", () => {
  const slack = ["https://hooks.slack.com/services/", "T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"].join("");
  const out = redactSecrets(`posting to ${slack} now`);
  assert.ok(!out.includes("T00000000"), `slack path leaked: ${out}`);
  assert.ok(!out.includes("XXXXXXXXXXXX"), `slack secret leaked: ${out}`);
  assert.match(out, /https:\/\/hooks\.slack\.com\//);
  const withQuery = redactSecrets("see https://example.com/cb?code=abc123def456&state=zz");
  assert.ok(!withQuery.includes("abc123def456"), withQuery);
  const keys = ["aGVsbG8vd29ybGQrZm9vYmFyMTIzNDU2Nzg5MA/x+Yz12Qw==", "Zm9vYmFyYmF6cXV1eDEyMzQ1/Njc4OTBhYmNkZWZnaGlq", "Zm9v/YmFyK2Jhei9xdXV4MTIzNDU2Nzg5MGFi+Q9s"];
  for (const k of keys) {
    const r = redactSecrets(`key ${k} end`);
    assert.ok(!r.includes(k.slice(0, 12)) && !r.includes(k.slice(-12)), `${k} leaked: ${r}`);
    assert.match(r, /\[redacted\]/);
  }
});

test("subscribe: a DNS lookup that never answers fails after the timeout instead of hanging", async () => {
  const hang = () => new Promise(() => {});
  const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") },
  };
  const started = Date.now();
  await assert.rejects(pushModule.validateSubscription(sub, { lookup: hang, lookupTimeoutMs: 50 }), /could not resolve host/);
  assert.ok(Date.now() - started < 2_000);
  const source = fs.readFileSync(new URL("../src/push.mjs", import.meta.url), "utf8");
  assert.match(source, /LOOKUP_TIMEOUT_MS = 5_000/, "the default DNS timeout is 5 s");
});
