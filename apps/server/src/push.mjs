// Web Push (VAPID, RFC 8291/8292): tells the owner's phone a chat finished, a question waits for an
// answer, or delegated work reported back — even with the page closed. Implemented on
// node:crypto (the Docker build is offline, so no web-push dependency): ES256-signed VAPID JWT and
// aes128gcm payload encryption. Only a short, redacted line reaches the lock screen, never the
// message itself. The key pair is generated once and kept in the data dir, mode 0600.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { finalText, foldEvents } from "@griffin/timeline";
import { maskText } from "./redact.mjs";
import { PERSONA } from "./persona.mjs";

// Lock-screen text: at most 60 characters each for title and body, after redaction.
const MAX_BODY = 60;
const MAX_TITLE = 60;
const KV_KEY = "push_subscriptions";
const MAX_SUBSCRIPTIONS = 10;
const SEND_TIMEOUT_MS = 10_000;
// A push-service host that never answers DNS must not hang the subscribe request.
const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_FAILURES = 5;
// Only the browsers' own push services: FCM (Chrome/Android), Mozilla, Apple, Windows (WNS).
const PUSH_HOST_SUFFIXES = [".googleapis.com", ".mozilla.com", ".push.apple.com", ".notify.windows.com"];
// The delegate wake-up (peers.mjs): a run it starts is a background report, not the owner's turn.
const BACKGROUND_PREFIX = "[گزارش خودکار زیرکارها";

function lookupWithin(lookup, ms) {
  return (hostname, opts) => {
    let timer;
    return Promise.race([
      Promise.resolve().then(() => lookup(hostname, opts)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`dns lookup timed out after ${ms} ms`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
}

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower.startsWith("::ffff:") && net.isIPv4(lower.slice(7))) return isPrivateIP(lower.slice(7));
    return lower === "::1" || lower === "::" || /^fe[89ab][0-9a-f]:/.test(lower) || /^f[cd][0-9a-f]{2}:/.test(lower);
  }
  return true; // not an IP shape: fail closed
}

// Every address the push host resolves to must be public — the server POSTs to it.
async function assertPublicHost(hostname, lookup) {
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`could not resolve host: ${hostname}`);
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (!list.length) throw new Error(`could not resolve host: ${hostname}`);
  for (const entry of list) {
    const address = typeof entry === "string" ? entry : entry?.address;
    if (!address || isPrivateIP(address)) throw new Error(`push host resolves to a non-public address: ${hostname}`);
  }
}

function b64urlBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  return Buffer.from(value.replace(/=+$/, ""), "base64url");
}

// A subscription the server will ever send to: an https endpoint on a known push service that
// resolves to public addresses only, a P-256 public key (65-byte uncompressed point) and a 16-byte
// auth secret.
export async function validateSubscription(sub, { lookup = dns.lookup, lookupTimeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  const endpoint = sub?.endpoint;
  if (typeof endpoint !== "string" || !endpoint || endpoint.length > 2048) throw new Error("endpoint required");
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("endpoint is not a URL");
  }
  if (url.protocol !== "https:") throw new Error("endpoint must be https");
  if (url.username || url.password || (url.port && url.port !== "443")) throw new Error("endpoint must be a plain https URL");
  const host = url.hostname.toLowerCase();
  if (!PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw new Error("endpoint is not a known push service");
  await assertPublicHost(host, lookupWithin(lookup, lookupTimeoutMs));
  const p256dh = b64urlBytes(sub?.keys?.p256dh);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 0x04) throw new Error("keys.p256dh must be a P-256 public key");
  const auth = b64urlBytes(sub?.keys?.auth);
  if (!auth || auth.length !== 16) throw new Error("keys.auth must be 16 bytes");
  return { endpoint: url.href, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}

// --- VAPID + aes128gcm on node:crypto ------------------------------------------------------------

// Same file shape as the web-push package: raw P-256 keys, URL-safe base64.
export function generateVapidKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

export function ensureVapidKeys(dataDir, { generate = generateVapidKeys } = {}) {
  const file = path.join(dataDir, "vapid.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const keys = generate();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

// RFC 8292: a JWT for the push service's origin, signed ES256 with the VAPID private key.
export function vapidAuthorization(endpoint, keys, { subject, now = Date.now() } = {}) {
  const pub = Buffer.from(keys.publicKey, "base64url");
  const key = crypto.createPrivateKey({
    format: "jwk",
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33, 65).toString("base64url") },
  });
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const signature = crypto.sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `vapid t=${unsigned}.${signature}, k=${keys.publicKey}`;
}

const hkdf = (ikm, salt, info, length) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));

// RFC 8291 aes128gcm: one record, an ephemeral ECDH key per message. `salt`/`senderPrivateKey` are
// for the RFC's test vector only.
export function encryptPayload(payload, keys, { salt = crypto.randomBytes(16), senderPrivateKey = null } = {}) {
  const uaPublic = Buffer.from(keys.p256dh, "base64url");
  const authSecret = Buffer.from(keys.auth, "base64url");
  const ecdh = crypto.createECDH("prime256v1");
  if (senderPrivateKey) ecdh.setPrivateKey(Buffer.from(senderPrivateKey, "base64url"));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ikm = hkdf(ecdh.computeSecret(uaPublic), authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

// Token-like strings never reach a lock screen. The text is clipped to MAX_REDACT_INPUT characters
// BEFORE any scan, and every scan is linear: the text is split into whitespace tokens and each
// token is walked by hand or by patterns anchored with a lookbehind (so no pattern restarts inside
// a run it already scanned). What is replaced:
// - a URL keeps only scheme://host — userinfo (user:pass@) and the path/query (webhook secrets) go;
//   a Slack webhook written without a scheme keeps only hooks.slack.com/…;
// - the value after NAME=, NAME:, NAME => or NAME = when NAME contains KEY, SECRET, TOKEN, PASS or
//   PWD; also a quoted NAME (JSON), each NAME= of a connection string, pass=, and the Persian
//   secret names before :, = or the full-width colon;
// - PEM blocks (-----BEGIN ... -----END ...-----);
// - the value after Bearer/Basic in any case; JWTs; sk-/glpat-/gh?_/xox?- keys; AWS access key ids;
// - any 30+ character run of [A-Za-z0-9/+=_-] that holds a digit or a /, and any 24+ character
//   run without / that mixes letters and digits. Safety over precision: a file path of 30+
//   characters is redacted too.
const MAX_REDACT_INPUT = 2048;
const REDACTED = "[redacted]";
// A name holding KEY/SECRET/TOKEN/PASS/PWD counts as a secret's name when it looks like a
// variable (upper case, or with _ or -) or is itself a secret word — so "Tests pass: 42" stays.
// Bare "pass" counts only before "=" ("pass=x"), never before ":". Persian secret names (رمز،
// رمز عبور، کلید، توکن، پسورد، گذرواژه) count before :, = or ：, also written with Arabic ك/ي.
const SECRET_WORD = /KEY|SECRET|TOKEN|PASS|PWD/i;
const SECRET_BARE = /^(?:password|passwd|pwd|secret|token|apikey|api-key|key)$/i;
const PERSIAN_SECRET = /^(?:رمز|رمزعبور|کلید|توکن|پسورد|گذرواژه)$/;
const persianName = (name) => name.replace(/‌/g, "").replace(/ك/g, "ک").replace(/ي/g, "ی");
const isSecretName = (name, sepChar = ":", afterRamz = false) => {
  if (name.length > 200) return false;
  const fa = persianName(name);
  if (PERSIAN_SECRET.test(fa) || (afterRamz && fa === "عبور")) return true;
  if (sepChar === "=" && /^pass$/i.test(name)) return true;
  return SECRET_WORD.test(name) && (SECRET_BARE.test(name) || /[_-]/.test(name) || name === name.toUpperCase());
};
const isNameChar = (c) => /[A-Za-z0-9_؀-ۿ‌-]/.test(c || "");
const isSepChar = (c) => c === "=" || c === ":" || c === "：";
const SEP_TOKEN = /^(?:[=:：]+>?)$/;
const isQuote = (c) => c === '"' || c === "'";
const isSchemeChar = (c) => /[A-Za-z0-9+.-]/.test(c || "");
const isLetter = (c) => /[A-Za-z]/.test(c || "");
const mixed = (s) => /[A-Za-z]/.test(s) && /[0-9]/.test(s);
const PREFIXED = /(?<![A-Za-z0-9_-])(?:eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*|[sS][kK]-[A-Za-z0-9_-]{8,}|glpat-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}(?![A-Za-z0-9]))/g;
const RUN = /[A-Za-z0-9/+=_-]+/g;
const redactRun = (run) => {
  if (run.length >= 30 && /[0-9/]/.test(run)) return REDACTED;
  if (run.length >= 24 && !run.includes("/") && mixed(run)) return REDACTED;
  return run;
};
const MIN_COLON_VALUE = 8;
const isColonSecret = (value) => value != null && value.length >= MIN_COLON_VALUE && !/\s/.test(value);
// No bare-hex exemption: a 40/64-character hex string is also the shape of an `openssl rand -hex`
// secret, so a git SHA in a question or plan is masked too (review 2026-09-29: safety wins).
const redactFree = (text) => text.replace(PREFIXED, REDACTED).replace(RUN, redactRun);
const SLACK_HOOK = "hooks.slack.com/services/";

// A token with no URL in it; returns [text, pending] where pending says the next token(s) carry
// a secret value ("sep": a separator may follow, "value": the value follows, or a quote char).
// Every separator in the token is tried (JSON's later fields, a connection string's Password=);
// the name before each one is walked back only to the previous separator, so the scan is linear.
// A name may be quoted ("password":). A quoted value ends at its closing quote; an unquoted
// value runs to the end of the token.
function redactPlain(tok, { afterRamz = false } = {}) {
  const hook = tok.toLowerCase().indexOf(SLACK_HOOK);
  if (hook >= 0) return [`${redactPlain(tok.slice(0, hook))[0]}hooks.slack.com/…`, null];
  let out = "";
  let start = 0;
  let floor = 0; // the name walk never goes back past the previous separator
  for (let i = 0; i < tok.length; i++) {
    if (!isSepChar(tok[i])) continue;
    const walkFloor = floor;
    floor = i + 1;
    let e = i;
    const q = isQuote(tok[e - 1]) ? tok[e - 1] : null;
    if (q) e--;
    let k = e;
    while (k > walkFloor && isNameChar(tok[k - 1])) k--;
    const nameStart = q ? k - 1 : k;
    if (k === e || k < start || (q && (nameStart < start || tok[nameStart] !== q))) continue;
    if (!isSecretName(tok.slice(k, e), tok[i], afterRamz && k === 0)) continue;
    let v = i;
    while (v < tok.length && (isSepChar(tok[v]) || tok[v] === ">")) v++;
    const value = tok.slice(v);
    const quote = isQuote(value[0]) ? value[0] : null;
    const close = quote ? value.indexOf(quote, 1) : -1;
    // After a colon only a single token of MIN_COLON_VALUE+ characters is a secret («کلید: فایل…»
    // is a sentence); a quoted value that runs past this token has spaces, so it is not one.
    const colon = tok[i] !== "=";
    if (colon && value && !isColonSecret(quote ? (close < 0 ? null : value.slice(1, close)) : value)) continue;
    out += `${redactFree(tok.slice(start, nameStart))}${tok.slice(nameStart, v)}`;
    if (!value) return [out, colon ? "colon-value" : "value"];
    if (!quote) return [`${out}${REDACTED}`, null];
    if (close < 0) return [`${out}${REDACTED}`, quote];
    out += REDACTED;
    start = v + close + 1;
    floor = start;
    i = start - 1;
  }
  const bare = tok.length <= 200 && start === 0 ? tok.replace(/^(["'])(.*)\1$/, "$2") : "";
  const name = bare && [...bare].every(isNameChar) && isSecretName(bare, ":", afterRamz);
  return [`${out}${redactFree(tok.slice(start))}`, name ? "sep" : null];
}

function redactToken(tok, opts) {
  const u = tok.indexOf("://");
  if (u > 0) {
    let s = u;
    while (s > 0 && isSchemeChar(tok[s - 1])) s--;
    while (s < u && !isLetter(tok[s])) s++;
    if (s < u) {
      const rest = tok.slice(u + 3);
      let end = 0;
      while (end < rest.length && rest[end] !== "/" && rest[end] !== "?" && rest[end] !== "#") end++;
      const authority = rest.slice(0, end);
      const host = authority.slice(authority.lastIndexOf("@") + 1);
      return [`${redactPlain(tok.slice(0, s))[0]}${tok.slice(s, u)}://${host}${end < rest.length ? "/…" : ""}`, null];
    }
  }
  return redactPlain(tok, opts);
}

export function redactSecrets(text, { maxLength = MAX_REDACT_INPUT } = {}) {
  const src = String(text || "");
  const parts = (src.length > maxLength ? src.slice(0, maxLength) : src).split(/(\s+)/);
  let pending = null;
  let prev = "";
  // The last token holding an END line: a BEGIN after it has no END and redacts only its own line.
  let lastEnd = -1;
  for (let i = 0; i < parts.length; i += 2) if (parts[i].includes("-----END")) lastEnd = i;
  for (let i = 0; i < parts.length; i += 2) {
    const tok = parts[i];
    if (!tok) continue;
    const afterRamz = persianName(prev) === "رمز";
    prev = tok;
    // A PEM block (-----BEGIN … through the END line's closing -----, or to the end of the text
    // when it was cut off) becomes one [redacted].
    if (pending === "pem" || pending === "pem-end") {
      if (pending === "pem" && tok.startsWith("-----END")) pending = "pem-end";
      if (pending === "pem-end" && tok.endsWith("-----") && tok !== "-----END") pending = null;
      parts[i] = "";
      parts[i - 1] = "";
      continue;
    }
    if (pending === "pem-line") {
      if (/[\r\n]/.test(parts[i - 1])) {
        pending = null;
      } else {
        parts[i] = "";
        parts[i - 1] = "";
        continue;
      }
    }
    const pem = tok.indexOf("-----BEGIN");
    if (pem >= 0) {
      parts[i] = `${redactToken(tok.slice(0, pem))[0]}${REDACTED}`;
      pending = lastEnd > i || tok.indexOf("-----END", pem) > pem ? "pem" : "pem-line";
      continue;
    }
    if (pending === '"' || pending === "'") {
      const close = tok.indexOf(pending);
      parts[i] = close < 0 ? REDACTED : `${REDACTED}${tok.slice(close + 1)}`;
      if (close >= 0) pending = null;
      continue;
    }
    if (pending === "sep") {
      pending = null;
      if (SEP_TOKEN.test(tok)) {
        pending = tok[0] === "=" ? "value" : "colon-value";
        continue;
      }
      if (isSepChar(tok[0])) {
        let v = 0;
        while (isSepChar(tok[v]) || tok[v] === ">") v++;
        const value = tok.slice(v);
        const quote = isQuote(value[0]) ? value[0] : null;
        const close = quote ? value.indexOf(quote, 1) : -1;
        if (tok[0] === "=" || isColonSecret(quote ? (close < 0 ? null : value.slice(1, close)) : value)) {
          parts[i] = `${tok.slice(0, v)}${REDACTED}${quote && close > 0 ? value.slice(close + 1) : ""}`;
          continue;
        }
      }
    }
    if (pending === "colon-value") {
      pending = null;
      const quote = isQuote(tok[0]) ? tok[0] : null;
      const close = quote ? tok.indexOf(quote, 1) : -1;
      if (isColonSecret(quote ? (close < 0 ? null : tok.slice(1, close)) : tok)) {
        parts[i] = quote ? `${REDACTED}${tok.slice(close + 1)}` : REDACTED;
        continue;
      }
    }
    if (pending === "value" || pending === "bearer") {
      const quote = isQuote(tok[0]) ? tok[0] : null;
      if (pending === "bearer" && tok.length < 8) {
        pending = null;
      } else {
        pending = quote && tok.indexOf(quote, 1) < 0 ? quote : null;
        parts[i] = REDACTED;
        continue;
      }
    }
    const lower = tok.toLowerCase();
    if (lower === "bearer" || lower === "basic") {
      pending = "bearer";
      continue;
    }
    [parts[i], pending] = redactToken(tok, { afterRamz });
  }
  return parts.join("");
}


function clip(text, max = MAX_BODY) {
  // Redact before whitespace is folded: a PEM BEGIN with no END stops at its own line end. maskText
  // also drops any secret value a tool result showed earlier (redact.mjs).
  const s = redactSecrets(maskText(String(text || "").slice(0, MAX_REDACT_INPUT))).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

// The short line shown on the lock screen for each kind — a clipped, redacted snippet at most.
function describe(kind, chat, extra = {}) {
  const title = clip(chat?.title || PERSONA.name, MAX_TITLE);
  if (kind === "finished") return { title, body: clip(extra.summary || "گفتگو تمام شد") };
  if (kind === "question") return { title, body: clip(extra.question ? `سؤال: ${extra.question}` : "منتظر جواب توست") };
  if (kind === "background") return { title, body: clip(extra.summary || "یک کار پس‌زمینه گزارش داد") };
  return { title, body: clip(extra.summary || "به‌روزرسانی تازه") };
}

export function createPush({
  store,
  dataDir,
  timelines = null,
  subject = "mailto:owner@griffin.local",
  sendImpl = null,
  generate = null,
  log = console,
  lookup = dns.lookup,
  sendTimeoutMs = SEND_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  const keys = ensureVapidKeys(dataDir, generate ? { generate } : undefined);

  const subscriptions = () => store.getKv(KV_KEY) || [];
  const saveSubscriptions = (list) => store.setKv(KV_KEY, list);

  // Validated, then kept newest-last; beyond MAX_SUBSCRIPTIONS the oldest is dropped.
  async function subscribe(sub) {
    const valid = await validateSubscription(sub, { lookup });
    const list = subscriptions().filter((s) => s.endpoint !== valid.endpoint);
    list.push({ ...valid, failures: 0 });
    while (list.length > MAX_SUBSCRIPTIONS) list.shift();
    saveSubscriptions(list);
    return list.length;
  }

  function unsubscribe(endpoint) {
    const list = subscriptions();
    const next = list.filter((s) => s.endpoint !== endpoint);
    saveSubscriptions(next);
    return list.length !== next.length;
  }

  const rawSend =
    sendImpl ||
    (async (sub, body) => {
      const response = await fetchImpl(sub.endpoint, {
        method: "POST",
        headers: {
          authorization: vapidAuthorization(sub.endpoint, keys, { subject }),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: "3600",
        },
        body: encryptPayload(body, sub.keys),
        signal: AbortSignal.timeout(sendTimeoutMs),
      });
      if (!response.ok) {
        const error = new Error(`push service http ${response.status}`);
        error.statusCode = response.status;
        throw error;
      }
    });
  const send = (sub, body) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`push send timed out after ${sendTimeoutMs}ms`)), sendTimeoutMs);
    });
    return Promise.race([Promise.resolve().then(() => rawSend(sub, body)), timeout]).finally(() => clearTimeout(timer));
  };

  // Sends to every subscription. Drops one the push service says is gone (404/410) at once, and any
  // endpoint after MAX_FAILURES consecutive failures of any kind (timeouts, 5xx, DNS …).
  async function sendToAll(payload) {
    const list = subscriptions();
    if (!list.length) return { sent: 0, dropped: 0 };
    let dropped = 0;
    let sent = 0;
    const keep = new Map();
    await Promise.all(
      list.map(async (sub) => {
        try {
          await send({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload));
          sent += 1;
          keep.set(sub.endpoint, { ...sub, failures: 0 });
        } catch (error) {
          const status = error?.statusCode;
          const failures = (Number(sub.failures) || 0) + 1;
          if (status === 404 || status === 410 || failures >= MAX_FAILURES) {
            dropped += 1;
            log.error?.(`[push] dropping a subscription (${status || error?.message}; ${failures} failures)`);
          } else {
            log.error?.(`[push] send failed (${status || error?.message}): keeping subscription`);
            keep.set(sub.endpoint, { ...sub, failures });
          }
        }
      }),
    );
    // Re-read: a subscribe during the sends must not be lost; keep the stored (oldest-first) order.
    saveSubscriptions(
      subscriptions()
        .filter((s) => keep.has(s.endpoint) || !list.some((old) => old.endpoint === s.endpoint))
        .map((s) => keep.get(s.endpoint) || s),
    );
    return { sent, dropped };
  }

  function notify(kind, chat, extra = {}) {
    const { title, body } = describe(kind, chat, extra);
    return sendToAll({ title, body, url: `/#/c/${chat?.id || ""}`, kind }).catch((error) => log.error?.(`[push] ${error.message}`));
  }

  async function lastAnswer(chatId) {
    const { messages } = timelines ? (await timelines.get(chatId)).timeline : foldEvents(store.allEvents(chatId));
    const run = messages.findLast((m) => m.role === "assistant");
    return run ? finalText(run).trim() : "";
  }

  // The owner-facing moments, from the store's event bus, each ringing exactly once:
  //  - a run in the owner's own chat (web chat or its side chat): "finished" at run.finished
  //    (cancelled stays silent), or "background" when the run was started by the delegate report;
  //  - a question for the owner (ask.pending, audience owner) in any chat: "question".
  // Job, colleague, peer, ops and simulated chats deliver elsewhere and stay silent here.
  function attach() {
    const backgroundNext = new Set(); // chatId whose next run is a background report
    const backgroundRuns = new Set();
    const rung = new Set();
    const once = (key) => {
      if (rung.has(key)) return false;
      rung.add(key);
      if (rung.size > 5000) rung.delete(rung.values().next().value);
      return true;
    };
    const onEvent = (chatId, event) => {
      if (!["user", "run.started", "run.finished", "ask.pending"].includes(event.type)) return;
      const chat = store.getChat(chatId);
      if (!chat || chat.sim || chat.parent_chat_id) return;
      if (event.type === "ask.pending") {
        if (event.data?.audience !== "requester" && once(`ask:${event.id}`)) notify("question", chat, { question: event.data?.question });
        return;
      }
      if ((chat.caller || "owner") !== "owner") return;
      const runId = event.runId ?? event.run_id ?? null;
      if (event.type === "user") {
        if (String(event.data?.text || "").startsWith(BACKGROUND_PREFIX)) backgroundNext.add(chatId);
        else backgroundNext.delete(chatId);
      } else if (event.type === "run.started") {
        if (backgroundNext.delete(chatId) && runId) backgroundRuns.add(runId);
      } else if (event.type === "run.finished") {
        const background = runId != null && backgroundRuns.delete(runId);
        if (event.data?.status === "cancelled") return;
        if (runId != null && !once(`run:${runId}`)) return;
        lastAnswer(chatId)
          .then((text) => {
            if (background) return text ? notify("background", chat, { summary: text }) : null;
            return notify("finished", chat, { summary: text || (event.data?.status === "error" ? "با خطا تمام شد" : "") });
          })
          .catch((error) => log.error?.(`[push] ${error.message}`));
      }
    };
    store.bus.on("event", onEvent);
    return () => store.bus.off("event", onEvent);
  }

  // The owner's routes (mounted under the owner-only /api/* auth).
  function routes(api) {
    api.get("/api/push/key", (c) => c.json({ publicKey: keys.publicKey }));
    api.post("/api/push/subscribe", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        await subscribe(body);
      } catch (error) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ ok: true }, 201);
    });
    api.delete("/api/push/subscribe", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const endpoint = String(body?.endpoint || c.req.query("endpoint") || "");
      if (!endpoint) return c.json({ error: "endpoint required" }, 400);
      return c.json({ removed: unsubscribe(endpoint) });
    });
  }

  return { publicKey: keys.publicKey, routes, subscribe, unsubscribe, subscriptions, notify, sendToAll, attach };
}
