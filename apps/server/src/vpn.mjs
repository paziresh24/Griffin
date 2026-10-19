import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { connectTunnel } from "./egress.mjs";

// The built-in VPN (owner 2026-10-17: «توی ویزارد بدون ایجنت هیچ جایی نمیتونن لینک ساب یا وی تو ری بدن»):
// the wizard takes a vless/vmess/trojan/ss/http/socks link, several of them, a subscription URL or a
// whole v2ray JSON config, and this server runs Xray itself — no agent, no shell, no Python. Only
// Griffin's own traffic uses it (HTTP 127.0.0.1:18118, SOCKS :11080, the same ports and NO_PROXY as
// deploy/self's kit); a link is tested before it replaces a working one. The link, the config and
// Xray's output never leave <data>/vpn (0600); errors carry fixed reasons, never decoded link parts.
// Xray: GRIFFIN_XRAY, else <data>/vpn/xray, else xray on PATH.

export const HTTP_PORT = Number(process.env.GRIFFIN_VPN_HTTP_PORT) || 18118;
export const SOCKS_PORT = Number(process.env.GRIFFIN_VPN_SOCKS_PORT) || 11080;
export const VPN_ENV = {
  CURSOR_PROXY: `http://127.0.0.1:${HTTP_PORT}`,
  HTTPS_PROXY: `http://127.0.0.1:${HTTP_PORT}`,
  HTTP_PROXY: `http://127.0.0.1:${HTTP_PORT}`,
  NO_PROXY: "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
  GRIFFIN_TELEGRAM_SOCKS: `socks5://127.0.0.1:${SOCKS_PORT}`,
};
const PROXY_PROTOCOLS = new Set(["vless", "vmess", "trojan", "shadowsocks", "socks", "http", "hysteria", "hysteria2", "wireguard"]);
const MAX_INPUT = 256 * 1024;
const MAX_SERVERS = 64;

// Where Griffin's traffic goes (owner 2026-10-19: «آیپی‌های لوکال و ایران از پروکسی رد نشن، فقط پروایدرها
// و تلگرام»). Decided inside Xray, not by NO_PROXY: Node's NO_PROXY does not understand CIDRs and an
// Iranian IP literal is on no list. In order: private networks → direct; internal / Iranian names →
// direct; Telegram and the AI providers → the VPN; everything else → direct. The first and the
// last rule are what keep a LAN address or an Iranian IP off the VPN whatever the caller sends.
export const PRIVATE_CIDRS = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "::1/128", "fc00::/7", "fe80::/10"];
export const DIRECT_DOMAINS = ["domain:ir", "domain:localhost", "domain:local", "domain:internal", "full:host.docker.internal"];
export const PROVIDER_DOMAINS = ["anthropic.com", "claude.ai", "claude.com", "cursor.sh", "cursor.com", "cursorapi.com", "openai.com", "openrouter.ai", "x.ai", "generativelanguage.googleapis.com", "telegram.org", "telegram.me", "t.me", "telegra.ph"];
// Telegram's data centres (the account client connects to these by IP).
export const TELEGRAM_CIDRS = ["91.108.4.0/22", "91.108.8.0/22", "91.108.12.0/22", "91.108.16.0/22", "91.108.20.0/22", "91.108.56.0/22", "109.239.140.0/24", "149.154.160.0/20", "185.76.151.0/24", "2001:67c:4e8::/48", "2001:b28:f23c::/48", "2001:b28:f23d::/48", "2001:b28:f23f::/48", "2a0a:f280::/32"];

/** The host of an engine's base URL if it belongs on the VPN (not an IP, not internal, not .ir), else null. */
export function proxiedHost(value) {
  let host;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(String(value)) ? String(value) : `https://${value}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
  if (!host || !host.includes(".") || net.isIP(host)) return null;
  if (/(^|\.)ir$/.test(host) || /(^|\.)(paziresh24\.com|localhost|local|internal)$/.test(host)) return null;
  return host;
}

export class VpnError extends Error {}

const b64 = (s) => {
  const t = String(s).trim().replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(t + "=".repeat((4 - (t.length % 4)) % 4), "base64").toString("utf8");
};

function stream(q, host) {
  const net = q.type || q.net || "tcp";
  const sec = q.security || (q.tls === "tls" ? "tls" : q.tls || "none");
  const s = { network: net, security: sec === "tls" || sec === "reality" ? sec : "none" };
  const sni = q.sni || q.host || host;
  if (s.security === "tls") {
    s.tlsSettings = { serverName: sni, ...(q.fp ? { fingerprint: q.fp } : {}), ...(q.alpn ? { alpn: q.alpn.split(",") } : {}), ...(q.allowInsecure === "1" || q.allowInsecure === "true" ? { allowInsecure: true } : {}) };
  }
  if (s.security === "reality") {
    s.realitySettings = { serverName: q.sni || "", fingerprint: q.fp || "chrome", publicKey: q.pbk || "", shortId: q.sid || "", spiderX: q.spx || "" };
  }
  const p = q.path || "/";
  const h = q.host || "";
  if (net === "ws") s.wsSettings = { path: p, ...(h ? { headers: { Host: h } } : {}) };
  else if (net === "grpc") s.grpcSettings = { serviceName: q.serviceName || q.path || "" };
  else if (net === "xhttp" || net === "splithttp") Object.assign(s, { network: "xhttp", xhttpSettings: { path: p, ...(h ? { host: h } : {}), ...(q.mode ? { mode: q.mode } : {}) } });
  else if (net === "httpupgrade") s.httpupgradeSettings = { path: p, ...(h ? { host: h } : {}) };
  else if (net === "tcp" && q.headerType === "http") s.tcpSettings = { header: { type: "http", request: { path: [p], headers: { Host: h ? [h] : [] } } } };
  return s;
}

// The server's own name (the link's #fragment, a vmess "ps", a JSON outbound's tag) for the list. Not
// enumerable: it is never part of the Xray config or of the server's id.
const remarkOf = (s) => String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 60);
const withRemark = (out, remark) => (remarkOf(remark) ? Object.defineProperty(out, "remark", { value: remarkOf(remark), enumerable: false }) : out);

/** One share link → one Xray outbound (the port of deploy/self/vpn/link2config.py). */
export function linkToOutbound(link) {
  link = link.trim();
  const out = linkToOutboundRaw(link);
  let remark = "";
  if (link.toLowerCase().startsWith("vmess://")) {
    try {
      remark = JSON.parse(b64(link.slice(8).split("#", 1)[0])).ps;
    } catch {
      /* no name */
    }
  } else {
    const at = link.indexOf("#");
    if (at >= 0) {
      try {
        remark = decodeURIComponent(link.slice(at + 1));
      } catch {
        remark = link.slice(at + 1);
      }
    }
  }
  return withRemark(out, remark);
}

function linkToOutboundRaw(link) {
  const scheme = link.split("://", 1)[0].toLowerCase();
  if (scheme === "vmess") {
    const j = JSON.parse(b64(link.slice(8).split("#", 1)[0]));
    const q = Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]));
    return {
      protocol: "vmess",
      settings: { vnext: [{ address: q.add, port: Number(q.port), users: [{ id: q.id, alterId: Number(q.aid || 0), security: q.scy || "auto" }] }] },
      streamSettings: stream(q, q.add),
    };
  }
  let u = new URL(link);
  const q = Object.fromEntries(u.searchParams);
  let host = u.hostname.replace(/^\[|\]$/g, "");
  let port = Number(u.port);
  const user = decodeURIComponent(u.username || "");
  if (scheme === "vless") {
    return { protocol: "vless", settings: { vnext: [{ address: host, port, users: [{ id: user, encryption: q.encryption || "none", ...(q.flow ? { flow: q.flow } : {}) }] }] }, streamSettings: stream(q, host) };
  }
  if (scheme === "trojan") {
    q.security ||= "tls";
    return { protocol: "trojan", settings: { servers: [{ address: host, port, password: user }] }, streamSettings: stream(q, host) };
  }
  if (scheme === "ss") {
    let cred;
    const body = link.slice(5).split("#", 1)[0];
    if (!body.split("?", 1)[0].includes("@")) {
      // Old form: ss://BASE64(method:password@host:port)
      u = new URL(`ss://${b64(body.split("?", 1)[0])}`);
      host = u.hostname;
      port = Number(u.port);
      cred = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    } else if (u.password) cred = `${user}:${decodeURIComponent(u.password)}`;
    else cred = user.includes(":") ? user : b64(user);
    const i = cred.indexOf(":");
    return { protocol: "shadowsocks", settings: { servers: [{ address: host, port, method: cred.slice(0, i), password: cred.slice(i + 1) }] } };
  }
  if (["http", "https", "socks", "socks5"].includes(scheme)) {
    const users = user ? [{ user, pass: decodeURIComponent(u.password || "") }] : [];
    const out = { protocol: scheme.startsWith("http") ? "http" : "socks", settings: { servers: [{ address: host, port, ...(users.length ? { users } : {}) }] } };
    if (scheme === "https") out.streamSettings = { security: "tls", tlsSettings: { serverName: host } };
    return out;
  }
  throw new VpnError("unsupported");
}

const SHARE = /^(vless|vmess|trojan|ss|socks5?):\/\/\S+$/i;
// http(s) with only host:port is a proxy; with a path or a query it is a subscription to fetch.
const PROXY_URL = /^https?:\/\/[^/\s?#]+\/?$/i;
const SUB_URL = /^https?:\/\/\S+$/i;

/** The outbounds a paste stands for. fetchText(url) loads a subscription (injected for tests). */
export async function outboundsOf(input, { fetchText } = {}) {
  const text = String(input || "").replace(/^﻿/, "").trim();
  if (!text) throw new VpnError("empty");
  if (text.length > MAX_INPUT) throw new VpnError("too_large");
  if (text.startsWith("{")) {
    let cfg;
    try {
      cfg = JSON.parse(text);
    } catch {
      throw new VpnError("bad_json");
    }
    const outs = (Array.isArray(cfg.outbounds) ? cfg.outbounds : []).filter((o) => PROXY_PROTOCOLS.has(String(o?.protocol)));
    if (!outs.length) throw new VpnError("no_servers");
    return outs.map(({ tag, ...o }) => withRemark(o, tag));
  }
  const lines = text.split(/\s+/).filter((l) => l && !l.startsWith("#"));
  // A subscription body pasted as is (one base64 block).
  if (lines.length === 1 && !lines[0].includes("://") && /^[A-Za-z0-9+/=_-]{16,}$/.test(lines[0])) return outboundsOf(b64(lines[0]), { fetchText });
  const outs = [];
  for (const line of lines) {
    if (SHARE.test(line) || PROXY_URL.test(line)) {
      try {
        outs.push(linkToOutbound(line));
      } catch {
        /* one broken line in a subscription does not sink the rest */
      }
    } else if (SUB_URL.test(line)) {
      if (!fetchText) throw new VpnError("subscription");
      let body;
      try {
        body = await fetchText(line);
      } catch {
        throw new VpnError("subscription_unreachable");
      }
      outs.push(...(await outboundsOf(body, { fetchText: null }).catch(() => [])));
    }
  }
  if (!outs.length) throw new VpnError("no_servers");
  return outs.slice(0, 64);
}

/** An Xray config: our two inbounds, every server, the fastest one picked by Xray itself. */
// The owner's own routes (owner 2026-10-19: «تو بخش پروکسی اونی که میخوایم دایرکت بشه رو مشخص کنیم»):
// a domain (example.com, *.example.com, a pasted URL), an IP or a CIDR, kept as typed in its clean form.
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const MAX_RULES = 200;
/** One route as the clean string kept (a domain, an IP or a CIDR), or null when it is none of them. */
export function normalizeRule(input) {
  let text = String(input || "").trim().toLowerCase().replace(/^\*\./, "").replace(/^\./, "");
  if (!text) return null;
  const cidr = text.match(/^([0-9a-f:.]+)\/(\d{1,3})$/);
  if (cidr) {
    const version = net.isIP(cidr[1]);
    return version && Number(cidr[2]) <= (version === 4 ? 32 : 128) ? text : null;
  }
  if (net.isIP(text)) return text;
  // A pasted URL, host:port or [v6]:port: the host is what counts.
  try {
    const host = new URL(/^[a-z]+:\/\//.test(text) ? text : `http://${text}`).hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host)) return host;
    return DOMAIN.test(host) ? host : null;
  } catch {
    return null;
  }
}
/** A list typed one per line (or separated by commas / spaces) → clean, unique routes. Throws VpnError("bad_rule") with .entry. */
export function parseRules(input) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/[\s,;،]+/);
  const out = [];
  for (const item of raw.map((x) => String(x).trim()).filter(Boolean)) {
    const rule = normalizeRule(item);
    if (!rule) throw Object.assign(new VpnError("bad_rule"), { entry: item.slice(0, 80) });
    if (!out.includes(rule)) out.push(rule);
  }
  if (out.length > MAX_RULES) throw new VpnError("too_many_rules");
  return out;
}
const isAddress = (rule) => rule.includes("/") || net.isIP(rule) > 0;
const ruleTargets = (rules) => ({ ips: rules.filter(isAddress), domains: rules.filter((r) => !isAddress(r)).map((d) => `domain:${d}`) });
// Routing rules for a list of the owner's routes, each kind (names, addresses) only when it has any.
const rulesFor = (rules, target) => {
  const { ips, domains } = ruleTargets(rules);
  return [domains.length ? { type: "field", domain: domains, ...target } : null, ips.length ? { type: "field", ip: ips, ...target } : null].filter(Boolean);
};

export function xrayConfig(outbounds, { hosts = [], direct = [], proxied = [] } = {}) {
  const proxies = outbounds.map((o, i) => ({ ...o, tag: `proxy-${i}` }));
  const many = proxies.length > 1;
  const via = many ? { balancerTag: "best" } : { outboundTag: "proxy-0" };
  const domains = [...new Set([...PROVIDER_DOMAINS, ...hosts.map(proxiedHost).filter(Boolean)])].map((d) => `domain:${d}`);
  const cfg = {
    log: { loglevel: "warning" },
    inbounds: [
      { tag: "http-in", listen: "127.0.0.1", port: HTTP_PORT, protocol: "http" },
      { tag: "socks-in", listen: "127.0.0.1", port: SOCKS_PORT, protocol: "socks", settings: { udp: true } },
    ],
    outbounds: [...proxies, { tag: "direct", protocol: "freedom" }],
    routing: {
      domainStrategy: "AsIs",
      ...(many ? { balancers: [{ tag: "best", selector: ["proxy-"], fallbackTag: "proxy-0", strategy: { type: "leastLoad", settings: { expected: 2, maxRTT: "4s", tolerance: 0.3 } } }] } : {}),
      // Order matters, the first match wins: the LAN and internal names, then what the owner pinned
      // direct (it beats the provider list: api.z.ai can be sent direct), then what he pinned to the
      // VPN, then the providers and Telegram, then everything else direct.
      rules: [
        { type: "field", ip: PRIVATE_CIDRS, outboundTag: "direct" },
        { type: "field", domain: DIRECT_DOMAINS, outboundTag: "direct" },
        ...rulesFor(direct, { outboundTag: "direct" }),
        ...rulesFor(proxied, via),
        { type: "field", domain: domains, ...via },
        { type: "field", ip: TELEGRAM_CIDRS, ...via },
        { type: "field", network: "tcp,udp", outboundTag: "direct" },
      ],
    },
  };
  if (many) cfg.burstObservatory = { subjectSelector: ["proxy-"], pingConfig: { destination: "https://www.gstatic.com/generate_204", interval: "1m", sampling: 3, timeout: "8s" } };
  return cfg;
}

// The id of a server in the list: its protocol, settings and transport (not its name).
const sha = (x) => crypto.createHash("sha1").update(x).digest("hex").slice(0, 10);
export const outboundId = (o) => sha(JSON.stringify([o.protocol, o.settings, o.streamSettings]));
/** What the list may show about a server: where it is and how it connects, never its id or password. */
export function describeOutbound(o) {
  const hop = o.settings?.vnext?.[0] || o.settings?.servers?.[0] || {};
  return { protocol: String(o.protocol || ""), address: String(hop.address || ""), port: Number(hop.port) || 0, network: o.streamSettings?.network || "tcp", security: o.streamSettings?.security || "none" };
}

const REASONS = {
  empty: "چیزی نچسباندید.",
  too_large: "متن خیلی بلند است.",
  bad_json: "این JSON خوانده نشد.",
  no_servers: "در این متن هیچ سروری (vless/vmess/trojan/ss) پیدا نشد.",
  unsupported: "این نوع لینک پشتیبانی نمی‌شود.",
  subscription: "لینک اشتراک اینجا باز نمی‌شود.",
  subscription_unreachable: "لینک اشتراک از این سرور باز نشد؛ متن خود اشتراک یا یکی از لینک‌های vless/vmess را بچسبانید.",
  no_xray: "Xray روی این سرور نیست.",
  invalid: "Xray این کانفیگ را قبول نکرد (لینک ناقص است).",
  busy: "یک لینک دیگر همین حالا در حال بررسی است.",
  not_working: "از این سرور به Claude یا تلگرام نرسیدیم (سرور قطع است یا این لینک کار نمی‌کند).",
  none_working: "هیچ‌کدام از سرورهای این لینک الان به Claude یا تلگرام نمی‌رسد.",
  unknown: "این سرور در فهرست نیست.",
  bad_rule: "این آدرس درست نیست (دامنه مثل example.com، یک IP یا یک رنج مثل 10.0.0.0/8 بنویسید):",
  too_many_rules: "تعداد آدرس‌ها زیاد است (حداکثر ۲۰۰ تا برای هر فهرست).",
};
export const reasonOf = (error) => REASONS[error?.message] || "انجام نشد؛ کمی بعد دوباره امتحان کنید.";

/** Through the HTTP inbound: a TLS handshake with host only finishes when a server really carries it. */
export function reachableThrough(proxyUrl, host = "api.telegram.org", timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const socket = tls.connect({ socket: connectTunnel(new URL(proxyUrl), host, 443), servername: host }, () => finish(true));
    socket.on("error", () => finish(false));
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// Where a server's traffic really comes out (owner 2026-10-19: «کشور vpn ها هم دید کنارش»): Cloudflare's
// trace page answers loc=<country> for the address that reached it. The server's own address says
// little — most are behind a CDN — so this is asked through the server itself.
const TRACE_HOST = "www.cloudflare.com";
export function exitCountry(proxyUrl, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    let done = false;
    let body = "";
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(code);
    };
    const socket = tls.connect({ socket: connectTunnel(new URL(proxyUrl), TRACE_HOST, 443), servername: TRACE_HOST }, () => {
      socket.write(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${TRACE_HOST}\r\nUser-Agent: griffin\r\nConnection: close\r\n\r\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      body += chunk;
      const m = body.match(/\nloc=([A-Z]{2})\b/);
      if (m) finish(m[1] === "XX" || m[1] === "T1" ? null : m[1]);
      else if (body.length > 16_384) finish(null);
    });
    socket.on("end", () => finish(null));
    socket.on("error", () => finish(null));
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}
/** A flag in the server's name (🇩🇪 → DE): what the seller says, shown until the server is reached. */
export function countryOfName(name) {
  const flag = String(name || "").match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
  return flag ? [...flag[0]].map((c) => String.fromCharCode(c.codePointAt(0) - 0x1f1e6 + 65)).join("") : null;
}

export function createVpn({ dataDir, env = process.env, fetchText = defaultFetch, log = console } = {}) {
  const dir = path.join(dataDir, "vpn");
  const configFile = path.join(dir, "config.json");
  const inputFile = path.join(dir, "input.txt");
  const bookFile = path.join(dir, "servers.json");
  const xrayBin = () => [env.GRIFFIN_XRAY, path.join(dir, "xray")].find((p) => p && fs.existsSync(p)) || "xray";
  let child = null;
  let stopping = false;
  let restartTimer = null;
  let hostsTimer = null;
  let applying = false;
  let lastReach = null;

  const configured = () => fs.existsSync(configFile);

  // Every server ever added, working or not (owner 2026-10-19: «نمیشه ببینیم تا الان چیا اد کردیم و
  // کدوما دارن کار میکنن»): { servers: [{ id, outbound, remark, addedAt, live, ms, claude, telegram,
  // checkedAt, country, off }], used: [ids in the running config], hosts: [engine hosts that ride the VPN] }.
  // off = the owner turned it off (owner 2026-10-19: «سرور و یا سرورهایی رو فعال و غیرفعال کرد»): it is
  // still tested and shown, but never enters the config.
  // Same 0600 folder as the Xray config; the API only ever shows describeOutbound() of a server.
  let book = null;
  const byMs = (a, b) => (a.ms ?? 1e9) - (b.ms ?? 1e9);
  function loadBook() {
    if (book) return book;
    try {
      book = JSON.parse(fs.readFileSync(bookFile, "utf8"));
    } catch {
      book = null;
    }
    if (!book || !Array.isArray(book.servers)) {
      book = { servers: [], used: [], hosts: [], rules: { direct: [], proxied: [] } };
      // An install from before the list existed: what its running config holds.
      try {
        const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
        for (const o of cfg.outbounds || []) {
          if (!PROXY_PROTOCOLS.has(String(o?.protocol))) continue;
          const { tag, ...outbound } = o;
          book.servers.push({ id: outboundId(outbound), outbound, remark: "", addedAt: Date.now(), live: true, ms: null, claude: null, telegram: null, checkedAt: 0 });
        }
        book.used = book.servers.map((s) => s.id);
      } catch {
        /* nothing configured yet */
      }
    }
    book.used = Array.isArray(book.used) ? book.used : [];
    book.hosts = Array.isArray(book.hosts) ? book.hosts : [];
    // The owner's routes: re-read through the same rules, a hand-edited file cannot put junk in the config.
    const clean = (list) => (Array.isArray(list) ? list.map(normalizeRule).filter(Boolean) : []);
    book.rules = { direct: clean(book.rules?.direct), proxied: clean(book.rules?.proxied) };
    return book;
  }
  function saveBook() {
    if (!book) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${bookFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(book), { mode: 0o600 });
    fs.renameSync(tmp, bookFile);
  }
  const usable = (s) => s.live && !s.off;
  const liveServers = () => loadBook().servers.filter(usable).sort(byMs);
  const configOf = () => xrayConfig(liveServers().map((s) => s.outbound), { hosts: loadBook().hosts, ...loadBook().rules });

  // The app image has no /etc/ssl/certs: Xray (Go) gets Node's own root CAs, or every TLS server fails.
  const xrayEnv = () => {
    if (fs.existsSync("/etc/ssl/certs/ca-certificates.crt")) return process.env;
    const ca = path.join(dir, "ca.pem");
    if (!fs.existsSync(ca)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(ca, tls.rootCertificates.join("\n"), { mode: 0o600 });
    }
    return { ...process.env, SSL_CERT_FILE: ca };
  };
  // Xray is this server's child: it must not outlive it and hold the ports from the next start.
  process.once("exit", () => child?.kill("SIGTERM"));
  function run(args, timeoutMs = 20_000) {
    return new Promise((resolve) => {
      let p;
      try {
        p = spawn(xrayBin(), args, { stdio: ["ignore", "pipe", "pipe"], env: xrayEnv() });
      } catch {
        resolve({ code: 127 });
        return;
      }
      const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
      p.on("error", () => resolve({ code: 127 }));
      p.on("close", (code) => {
        clearTimeout(t);
        resolve({ code });
      });
      p.stdout.resume();
      p.stderr.resume();
    });
  }
  // A config written before the routing rules existed sends every request to the VPN: rewritten once
  // (from the list, no probing) before Xray starts with it.
  function ensureCurrentConfig() {
    try {
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
      if (cfg.routing?.rules?.some((r) => r.outboundTag === "direct" && r.ip)) return;
    } catch {
      return;
    }
    if (!liveServers().length) return;
    const tmp = `${configFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(configOf(), null, 1), { mode: 0o600 });
    fs.renameSync(tmp, configFile);
    log.info?.("[vpn] config rewritten with routing rules");
  }
  function start() {
    if (!configured() || child) return;
    stopping = false;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    ensureCurrentConfig();
    const out = fs.openSync(path.join(dir, "xray.log"), "a", 0o600);
    try {
      child = spawn(xrayBin(), ["run", "-config", configFile], { stdio: ["ignore", out, out], env: xrayEnv() });
    } catch (error) {
      log.error?.(`[vpn] xray did not start: ${error.message}`);
      return;
    } finally {
      fs.closeSync(out);
    }
    child.on("error", (error) => log.error?.(`[vpn] xray: ${error.message}`));
    child.on("exit", (code) => {
      child = null;
      if (stopping) return;
      log.error?.(`[vpn] xray exited (${code}); restarting in 5s`);
      restartTimer = setTimeout(start, 5_000);
      restartTimer.unref?.();
    });
  }
  function stop() {
    stopping = true;
    clearTimeout(restartTimer);
    const c = child;
    child = null;
    if (!c) return Promise.resolve();
    return new Promise((resolve) => {
      c.once("exit", resolve);
      c.kill("SIGTERM");
      setTimeout(resolve, 3_000).unref?.();
    });
  }
  // Working = Claude's API or Telegram opens through it (some servers carry one and not the other).
  async function reach() {
    if (!child) return { claude: false, telegram: false };
    const [claude, telegram] = await Promise.all([reachableThrough(VPN_ENV.HTTPS_PROXY, "api.anthropic.com"), reachableThrough(VPN_ENV.HTTPS_PROXY, "api.telegram.org")]);
    lastReach = { claude, telegram };
    return lastReach;
  }
  async function working() {
    const r = await reach();
    return r.claude || r.telegram;
  }

  // Each server on its own throwaway Xray (a free high port): only the ones that really carry Claude or
  // Telegram go into the config, fastest first — a subscription full of dead servers still works.
  // A server that carries neither is still answered (live: false), so the list can show it.
  async function probe(outbound, port) {
    const file = path.join(dir, `probe-${port}.json`);
    // A dead server keeps the country it was last seen in.
    const dead = { live: false, ms: null, claude: false, telegram: false };
    fs.writeFileSync(file, JSON.stringify({ log: { loglevel: "none" }, inbounds: [{ listen: "127.0.0.1", port, protocol: "http" }], outbounds: [outbound] }), { mode: 0o600 });
    let p;
    try {
      p = spawn(xrayBin(), ["run", "-config", file], { stdio: "ignore", env: xrayEnv() });
    } catch {
      fs.rmSync(file, { force: true });
      return dead;
    }
    p.on("error", () => {});
    const started = Date.now();
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const via = `http://127.0.0.1:${port}`;
      // Twice each: CDN-fronted servers drop a first connection now and then.
      const twice = async (host) => (await reachableThrough(via, host, 8_000)) || reachableThrough(via, host, 8_000);
      // Asked alongside, but not counted in the server's time.
      const country = exitCountry(via);
      const [claude, telegram] = await Promise.all([twice("api.anthropic.com"), twice("api.telegram.org")]);
      const ms = Date.now() - started;
      const where = await country;
      return claude || telegram ? { live: true, ms, claude, telegram, ...(where ? { country: where } : {}) } : dead;
    } finally {
      p.kill("SIGKILL");
      fs.rmSync(file, { force: true });
    }
  }
  // Sixteen at a time, so a long subscription does not start hundreds of Xray processes at once.
  async function probeAll(entries) {
    const base = 30_000 + Math.floor(Math.random() * 20_000);
    const out = [];
    for (let i = 0; i < entries.length; i += 16) {
      const batch = entries.slice(i, i + 16);
      out.push(...(await Promise.all(batch.map((e, j) => probe(e.outbound, base + j)))));
    }
    const now = Date.now();
    return entries.map((e, i) => ({ ...e, ...out[i], checkedAt: now }));
  }

  /** The working servers become the running config; Xray restarts only if that set (or the hosts) changed. */
  async function install({ force = false } = {}) {
    const b = loadBook();
    const live = liveServers();
    if (!live.length) return "none";
    const ids = live.map((s) => s.id);
    if (!force && child && configured() && ids.length === b.used.length && ids.every((id, i) => id === b.used[i])) {
      saveBook();
      return "unchanged";
    }
    const stage = path.join(dir, "config.new.json"); // xray -test wants a .json name
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stage, JSON.stringify(configOf(), null, 1), { mode: 0o600 });
    const tested = await run(["run", "-test", "-config", stage]);
    if (tested.code !== 0) {
      fs.rmSync(stage, { force: true });
      throw new VpnError(tested.code === 127 ? "no_xray" : "invalid");
    }
    await stop();
    fs.renameSync(stage, configFile);
    b.used = ids;
    saveBook();
    start();
    return "installed";
  }
  async function settle() {
    let r = { claude: false, telegram: false };
    for (let i = 0; i < 4 && !(r.claude && r.telegram); i++) {
      await new Promise((resolve) => setTimeout(resolve, i ? 2_500 : 1_500));
      r = await reach();
    }
    return r;
  }
  async function exclusive(fn) {
    if (applying) throw new VpnError("busy");
    applying = true;
    try {
      return await fn();
    } finally {
      applying = false;
    }
  }

  /** Paste → tested servers added to the list → running Xray. Throws VpnError. */
  function apply(input, { replace = false } = {}) {
    return exclusive(async () => {
      const pasted = await outboundsOf(input, { fetchText });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(xrayBin()) && xrayBin() !== "xray") throw new VpnError("no_xray");
      const b = loadBook();
      const known = new Map((replace ? [] : b.servers).map((s) => [s.id, s]));
      const seen = new Set();
      const targets = [];
      for (const o of pasted) {
        const id = outboundId(o);
        if (seen.has(id)) continue;
        seen.add(id);
        const old = known.get(id);
        targets.push({ id, outbound: o, remark: o.remark || old?.remark || "", addedAt: old?.addedAt || Date.now(), ...(old?.off ? { off: true } : {}), fresh: !old });
      }
      const probed = await probeAll(targets.slice(0, 24));
      const tested = new Map(probed.map((e) => [e.id, e]));
      const kept = (replace ? [] : b.servers).filter((s) => !tested.has(s.id));
      const merged = [...kept, ...probed.map(({ fresh, ...e }) => e), ...targets.slice(24).map(({ fresh, ...e }) => ({ ...e, live: false, ms: null, claude: false, telegram: false, checkedAt: 0 }))].slice(0, MAX_SERVERS);
      if (!merged.some(usable)) throw new VpnError(pasted.length > 1 ? "none_working" : "not_working");
      const before = { servers: b.servers, used: b.used };
      book = { ...b, servers: merged };
      try {
        await install();
      } catch (error) {
        book = { ...book, ...before };
        throw error;
      }
      const r = await settle();
      const fresh = probed.filter((e) => e.fresh);
      return { working: r.claude || r.telegram, ...r, servers: loadBook().used.length, total: merged.length, added: fresh.length, addedLive: fresh.filter((e) => e.live).length };
    });
  }

  /** Every server tested again (the panel's «بررسی دوباره»); the running config follows what works now. */
  function recheck({ rewrite = true } = {}) {
    if (applying) return Promise.resolve(list());
    return exclusive(async () => {
      const b = loadBook();
      if (!b.servers.length) return list();
      b.servers = (await probeAll(b.servers.slice(0, MAX_SERVERS))).map(({ fresh, ...e }) => e);
      saveBook();
      if (rewrite && b.servers.some(usable)) await install();
      await reach();
      return list();
    });
  }

  // The list changed: the running config follows its usable servers, or Xray stops when none is left.
  // On a failure the list goes back to what it was.
  async function follow(servers) {
    const before = loadBook().servers;
    book = { ...book, servers };
    try {
      if (servers.some(usable)) await install();
      else {
        await stop();
        fs.rmSync(configFile, { force: true });
        book.used = [];
        saveBook();
      }
    } catch (error) {
      book = { ...book, servers: before };
      throw error;
    }
    saveBook();
    if (child) await reach();
    else lastReach = null;
    return list();
  }

  function removeServer(id) {
    return exclusive(async () => {
      const b = loadBook();
      const left = b.servers.filter((s) => s.id !== id);
      if (left.length === b.servers.length) throw new VpnError("unknown");
      return follow(left);
    });
  }

  /** Turn one or several servers on or off. An off server stays in the list and is still tested. */
  function setEnabled(ids, enabled) {
    return exclusive(async () => {
      const b = loadBook();
      const want = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
      if (!b.servers.some((s) => want.has(s.id))) throw new VpnError("unknown");
      const turn = ({ off, ...s }) => (enabled ? s : { ...s, off: true });
      return follow(b.servers.map((s) => (want.has(s.id) ? turn(s) : s)));
    });
  }

  async function remove() {
    await stop();
    fs.rmSync(configFile, { force: true });
    fs.rmSync(inputFile, { force: true });
    book = { servers: [], used: [], hosts: loadBook().hosts, rules: loadBook().rules };
    if (fs.existsSync(bookFile)) saveBook();
    lastReach = null;
  }

  /** The hosts of the engines in use ride the VPN too. A changed set rewrites the config a moment later. */
  function setHosts(urls) {
    const next = [...new Set((urls || []).map(proxiedHost).filter(Boolean))].sort();
    const b = loadBook();
    if (JSON.stringify(next) === JSON.stringify(b.hosts)) return false;
    b.hosts = next;
    if (!b.servers.length) return true;
    saveBook();
    clearTimeout(hostsTimer);
    hostsTimer = setTimeout(() => {
      if (applying || !liveServers().length) return;
      exclusive(() => install({ force: true })).catch((error) => log.error?.(`[vpn] hosts: ${error.message}`));
    }, 2_000);
    hostsTimer.unref?.();
    return true;
  }

  /** The owner's own routes (direct / via the VPN). Saved at once; the running config follows if a server works. */
  function setRules({ direct, proxied } = {}) {
    return exclusive(async () => {
      const b = loadBook();
      const next = { direct: direct === undefined ? b.rules.direct : parseRules(direct), proxied: proxied === undefined ? b.rules.proxied : parseRules(proxied) };
      const before = b.rules;
      b.rules = next;
      try {
        if (liveServers().length) await install({ force: true });
        else saveBook();
      } catch (error) {
        b.rules = before;
        throw error;
      }
      return list();
    });
  }

  const nameOf = (s) => {
    const d = describeOutbound(s.outbound);
    return s.remark || `${d.protocol} ${d.address}${d.port ? `:${d.port}` : ""}`;
  };
  /** What the panel shows: every server and how it did last time, and where traffic goes. No secret in it. */
  function list() {
    const b = loadBook();
    const used = new Set(b.used);
    const checks = b.servers.map((s) => s.checkedAt || 0);
    return {
      builtin: true,
      configured: configured(),
      running: Boolean(child),
      working: lastReach ? lastReach.claude || lastReach.telegram : null,
      claude: lastReach?.claude ?? null,
      telegram: lastReach?.telegram ?? null,
      checkedAt: Math.max(0, ...checks) || null,
      servers: b.servers.map((s) => ({
        id: s.id,
        name: nameOf(s),
        ...describeOutbound(s.outbound),
        state: !s.checkedAt && !s.live ? "unknown" : s.live ? "live" : "dead",
        enabled: !s.off,
        // exit = measured through the server; name = only the flag in its name.
        country: s.country || countryOfName(s.remark),
        countryFrom: s.country ? "exit" : countryOfName(s.remark) ? "name" : null,
        claude: s.claude ?? null,
        telegram: s.telegram ?? null,
        ms: s.ms ?? null,
        checkedAt: s.checkedAt || null,
        addedAt: s.addedAt || null,
        inUse: Boolean(child) && used.has(s.id),
      })),
      routing: { providers: [...new Set([...PROVIDER_DOMAINS, ...b.hosts])], telegram: true, hosts: b.hosts, direct: b.rules.direct, proxied: b.rules.proxied },
    };
  }
  async function status() {
    const set = configured();
    const r = set ? await reach() : null;
    return { builtin: true, configured: set, running: Boolean(child), working: r ? r.claude || r.telegram : null, ...(r || {}) };
  }
  return { configured, start, stop, apply, recheck, removeServer, setEnabled, remove, setHosts, setRules, list, status, working };
}

// A subscription is fetched directly first (most panels are inside Iran), then through whatever proxy fetch already has.
async function defaultFetch(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "v2rayNG/1.9" } });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return (await res.text()).slice(0, MAX_INPUT);
}
