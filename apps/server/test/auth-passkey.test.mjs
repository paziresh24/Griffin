import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { createAuth } from "../src/auth.mjs";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";
import { createSecretStore } from "../src/secrets.mjs";
import { stepAt, totpCode } from "../src/totp.mjs";

const ORIGIN = "https://griffin-test.example.ir";
const RP_ID = "griffin-test.example.ir";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-passkey-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const secrets = createSecretStore({ dataDir: dir });
  const runner = createRunner({ store, sdk: {}, agentOptions: () => ({}), log: {} });
  const events = [];
  const app = createApp({ store, runner, auth: createAuth({ dataDir: dir, store, secrets, publicUrl: ORIGIN, onEvent: (e) => events.push(e) }) });
  const token = fs.readFileSync(path.join(dir, "owner.token"), "utf8").trim();
  const cleanup = () => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, store, token, events, cleanup };
}

const env = { incoming: { socket: { remoteAddress: "203.0.113.7", localAddress: "192.168.1.2" } } };
const call = (app, method, url, { body, cookie, origin = ORIGIN } = {}) =>
  app.request(
    `${ORIGIN}${url}`,
    { method, headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) },
    env,
  );
const cookieOf = (res) => res.headers.getSetCookie().find((c) => c.startsWith("griffin_session=")).split(";")[0];

// Just enough CBOR for an attestation object and a COSE key.
function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error("cbor: unsupported");
}

// A software authenticator (ES256, user verified) — what Windows Hello does, minus the face.
function authenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = crypto.randomBytes(16);
  const rpHash = crypto.createHash("sha256").update(RP_ID).digest();
  let counter = 0;
  const clientData = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: credId.toString("base64url"),
    create(options, origin = ORIGIN) {
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credId.length);
      const count = Buffer.alloc(4);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), count, Buffer.alloc(16), len, credId, cose]);
      const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return {
        id: this.id,
        rawId: this.id,
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: clientData("webauthn.create", options.challenge, origin).toString("base64url"), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] },
      };
    },
    get(options, origin = ORIGIN) {
      counter += 1;
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), count]);
      const cd = clientData("webauthn.get", options.challenge, origin);
      const signature = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(cd).digest()]), privateKey);
      return {
        id: this.id,
        rawId: this.id,
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: cd.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") },
      };
    },
  };
}

async function addPasskey(app, cookie, device, proof) {
  const opts = await call(app, "POST", "/api/auth/passkeys/options", { cookie, body: proof });
  assert.equal(opts.status, 200, await opts.clone().text());
  const { challengeId, options } = await opts.json();
  assert.equal(options.rp.id, RP_ID);
  assert.equal(options.authenticatorSelection.userVerification, "required");
  return call(app, "POST", "/api/auth/passkeys", { cookie, body: { challengeId, response: device.create(options), name: "Surface — Windows Hello" } });
}

async function passkeyLogin(app, device, tamper = (r) => r) {
  const opts = await (await call(app, "POST", "/api/auth/passkey/options", { body: {} })).json();
  if (!opts.challengeId) return { status: 0, opts };
  return call(app, "POST", "/api/auth/passkey/login", { body: { challengeId: opts.challengeId, response: tamper(device.get(opts.options)) } });
}

test("a passkey added in settings signs in on its own — no token, no code", async () => {
  const { app, token, events, cleanup } = setup();
  try {
    const cookie = cookieOf(await call(app, "POST", "/api/auth/login", { body: { token } }));
    assert.deepEqual(await (await call(app, "POST", "/api/auth/passkey/options", { body: { probe: true } })).json(), { available: false });

    const device = authenticator();
    // Adding needs fresh proof besides the cookie: here (two-step off) the token.
    assert.equal((await call(app, "POST", "/api/auth/passkeys/options", { cookie, body: {} })).status, 400);
    const added = await addPasskey(app, cookie, device, { token });
    assert.equal(added.status, 200, await added.clone().text());
    assert.ok(events.some((e) => e.kind === "passkey-added"));
    assert.deepEqual(await (await call(app, "POST", "/api/auth/passkey/options", { body: { probe: true } })).json(), { available: true });

    const ok = await passkeyLogin(app, device);
    assert.equal(ok.status, 200);
    assert.equal((await call(app, "GET", "/api/chats", { cookie: cookieOf(ok) })).status, 200);
    assert.ok(events.some((e) => e.kind === "login" && e.via === "passkey"));

    const list = await (await call(app, "GET", "/api/auth/passkeys", { cookie })).json();
    assert.equal(list.passkeys.length, 1);
    assert.equal(list.passkeys[0].name, "Surface — Windows Hello");
    assert.ok(list.passkeys[0].lastUsedAt);
    assert.equal(list.passkeys[0].publicKey, undefined);

    // Removed: it no longer signs in.
    assert.equal((await call(app, "DELETE", `/api/auth/passkeys/${encodeURIComponent(device.id)}`, { cookie })).status, 200);
    assert.equal((await passkeyLogin(app, device)).status, 0);
  } finally {
    cleanup();
  }
});

test("a wrong signature, another site's response or a reused challenge does not sign in", async () => {
  const { app, token, cleanup } = setup();
  try {
    const cookie = cookieOf(await call(app, "POST", "/api/auth/login", { body: { token } }));
    const device = authenticator();
    assert.equal((await addPasskey(app, cookie, device, { token })).status, 200);

    const badSig = await passkeyLogin(app, device, (r) => ({ ...r, response: { ...r.response, signature: Buffer.alloc(70, 1).toString("base64url") } }));
    assert.equal(badSig.status, 401);

    const opts = await (await call(app, "POST", "/api/auth/passkey/options", { body: {} })).json();
    const phished = device.get(opts.options, "https://evil.example");
    assert.equal((await call(app, "POST", "/api/auth/passkey/login", { body: { challengeId: opts.challengeId, response: phished } })).status, 401);
    // The challenge was spent by that try.
    assert.equal((await call(app, "POST", "/api/auth/passkey/login", { body: { challengeId: opts.challengeId, response: device.get(opts.options) } })).status, 401);

    // A stranger's key is not this owner's.
    const stranger = authenticator();
    const o2 = await (await call(app, "POST", "/api/auth/passkey/options", { body: {} })).json();
    assert.equal((await call(app, "POST", "/api/auth/passkey/login", { body: { challengeId: o2.challengeId, response: stranger.get(o2.options) } })).status, 401);
  } finally {
    cleanup();
  }
});

test("with two-step on, adding a passkey needs the authenticator code; and an IP gets no passkeys", async () => {
  const { app, token, cleanup } = setup();
  try {
    const first = cookieOf(await call(app, "POST", "/api/auth/login", { body: { token } }));
    const { secret } = await (await call(app, "POST", "/api/auth/2fa/setup", { cookie: first })).json();
    const on = await call(app, "POST", "/api/auth/2fa/enable", { cookie: first, body: { code: totpCode(secret, stepAt() - 1) } });
    const cookie = cookieOf(on);
    const tokenOnly = await call(app, "POST", "/api/auth/passkeys/options", { cookie, body: { token } });
    assert.deepEqual([tokenOnly.status, (await tokenOnly.json()).error], [400, "invalid code"]);
    const device = authenticator();
    assert.equal((await addPasskey(app, cookie, device, { code: totpCode(secret, stepAt()) })).status, 200);
    // A passkey sign-in is enough even while two-step is on.
    assert.equal((await passkeyLogin(app, device)).status, 200);

    // Opened on the LAN IP: a passkey cannot be bound to an address.
    const lan = "http://192.168.1.2:3100";
    const byIp = await app.request(`${lan}/api/auth/passkeys/options`, { method: "POST", headers: { "content-type": "application/json", origin: lan, cookie }, body: "{}" }, env);
    assert.equal(byIp.status, 400);
    assert.match((await byIp.json()).error, /not an IP/);
    const probeIp = await app.request(`${lan}/api/auth/passkey/options`, { method: "POST", headers: { "content-type": "application/json", origin: lan }, body: "{}" }, env);
    assert.deepEqual(await probeIp.json(), { available: false });
    // Without a cookie nothing about passkeys is listed or changed.
    assert.equal((await call(app, "GET", "/api/auth/passkeys")).status, 401);
    assert.equal((await call(app, "DELETE", `/api/auth/passkeys/${device.id}`)).status, 401);
  } finally {
    cleanup();
  }
});
