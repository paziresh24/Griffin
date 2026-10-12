import net from "node:net";
import { Duplex } from "node:stream";
import tls from "node:tls";

// Cursor and Anthropic block or degrade Iranian IPs. fetch honours HTTPS_PROXY
// (NODE_USE_ENV_PROXY), but agent streams open their own TLS connections that ignore
// proxy settings. This routes only TLS to those domains through an HTTP CONNECT proxy
// (Xray); everything else is untouched.

const TUNNEL_HOST = /(^|\.)(cursor\.sh|cursor\.com|cursorapi\.com|anthropic\.com|claude\.ai|claude\.com)$/i;

export function isCursorHost(host) {
  return TUNNEL_HOST.test(String(host || ""));
}

export function isAgentHost(host) {
  return isCursorHost(host);
}

// A Duplex that is usable immediately: writes are buffered until the proxy answers CONNECT,
// so tls.connect can start its handshake synchronously on top of it.
export function connectTunnel(proxy, host, port) {
  const raw = net.connect(Number(proxy.port), proxy.hostname);
  let ready = false;
  let pending = [];
  let head = Buffer.alloc(0);

  const duplex = new Duplex({
    write(chunk, encoding, callback) {
      if (ready) raw.write(chunk, callback);
      else pending.push([chunk, callback]);
    },
    read() {
      if (ready) raw.resume();
    },
    final(callback) {
      raw.end();
      callback();
    },
    destroy(error, callback) {
      raw.destroy();
      for (const [, cb] of pending) cb(error || new Error("tunnel closed"));
      pending = [];
      callback(error);
    },
  });

  const onHead = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) {
      if (head.length > 16_384) duplex.destroy(new Error("proxy CONNECT response too large"));
      return;
    }
    raw.off("data", onHead);
    const status = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
    if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
      duplex.destroy(new Error(`proxy CONNECT ${host}:${port} failed: ${status}`));
      return;
    }
    ready = true;
    const rest = head.subarray(end + 4);
    if (rest.length) duplex.push(rest);
    raw.on("data", (data) => {
      if (!duplex.push(data)) raw.pause();
    });
    for (const [data, cb] of pending) raw.write(data, cb);
    pending = [];
  };

  raw.on("connect", () => {
    raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  });
  raw.on("data", onHead);
  raw.on("end", () => duplex.push(null));
  raw.on("error", (error) => duplex.destroy(error));
  raw.on("close", () => {
    if (!duplex.destroyed) duplex.destroy();
  });
  return duplex;
}

function normalizeArgs(args) {
  // tls.connect(options[, cb]) | tls.connect(port[, host][, options][, cb])
  let options = {};
  let callback;
  let port;
  let host;
  for (const arg of args) {
    if (typeof arg === "function") callback = arg;
    else if (typeof arg === "number" || (typeof arg === "string" && /^\d+$/.test(arg) && port === undefined)) port = Number(arg);
    else if (typeof arg === "string") host = arg;
    else if (arg && typeof arg === "object") options = arg;
  }
  return {
    options,
    callback,
    host: options.host ?? host ?? options.servername,
    port: Number(options.port ?? port ?? 443),
  };
}

export function installCursorEgress(proxyUrl, { log = console } = {}) {
  if (!proxyUrl) return false;
  const proxy = new URL(proxyUrl);
  // Installed already: only the proxy changes (the setup wizard sets it at runtime).
  if (tls.connect.__griffinEgress) {
    tls.connect.__proxy = proxy;
    log.info?.(`[egress] Cursor/Anthropic TLS via ${proxy.host}`);
    return true;
  }
  const original = tls.connect;
  const patched = function connect(...args) {
    const { options, callback, host, port } = normalizeArgs(args);
    if (options.socket || !isAgentHost(host)) return original.apply(this, args);
    const socket = connectTunnel(patched.__proxy, host, port);
    return original.call(this, { ...options, host, port, servername: options.servername || host, socket }, callback);
  };
  patched.__griffinEgress = true;
  patched.__proxy = proxy;
  tls.connect = patched;
  log.info?.(`[egress] Cursor/Anthropic TLS via ${proxy.host}`);
  return true;
}

// An engine whose health probe got no HTTP answer at all (timeout, DNS, refused, a dead Xray in
// front) is unreachable from here. Any HTTP status means the path works, and a missing key or URL
// ("no … api key") is a setup gap, not egress — neither should hold scheduled work.
export function egressDown(health) {
  return !health?.ok && health?.status == null && !/^no /.test(String(health?.error || ""));
}
