import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";

// One port, two protocols: LAN clients keep plain HTTP on :3100 while a CDN edge or reverse proxy
// reaches the same port over TLS. The first byte decides: a TLS
// ClientHello starts with 0x16. TLS is enabled only when cert.pem and key.pem exist in tlsDir.
export function loadTls(tlsDir) {
  if (!tlsDir) return null;
  const cert = path.join(tlsDir, "cert.pem");
  const key = path.join(tlsDir, "key.pem");
  if (!fs.existsSync(cert) || !fs.existsSync(key)) return null;
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

// onUpgrade(req, socket, head) answers WebSocket handshakes (the previews' live reload) and returns
// true when it took the connection; any other upgrade request is dropped, as with no listener at all.
export function createDualServer(listener, { tls = null, onUpgrade = null } = {}) {
  const plain = http.createServer(listener);
  const secure = tls ? https.createServer(tls, listener) : null;
  if (onUpgrade) {
    const upgrade = (req, socket, head) => {
      let took = false;
      try {
        took = onUpgrade(req, socket, head);
      } catch {
        took = false;
      }
      if (!took) socket.destroy();
    };
    plain.on("upgrade", upgrade);
    secure?.on("upgrade", upgrade);
  }

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => socket.destroy());
    socket.once("data", (chunk) => {
      socket.pause();
      socket.unshift(chunk);
      const target = secure && chunk[0] === 0x16 ? secure : plain;
      target.emit("connection", socket);
      process.nextTick(() => socket.resume());
    });
  });

  server.tls = Boolean(secure);
  // Let the process exit cleanly: the TCP listener waits on every socket it accepted, and the inner
  // servers do not know a socket that never sent a byte or one handed to onUpgrade (a preview's
  // WebSocket), so every one is dropped here (one kept the port closed 23 minutes, 2026-10-24).
  const close = server.close.bind(server);
  server.close = (callback) => {
    const result = close(callback);
    for (const socket of sockets) socket.destroy();
    return result;
  };
  return server;
}

export function normalizeIp(addr) {
  const s = String(addr || "").trim();
  return s.startsWith("::ffff:") && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}

// GRIFFIN_TRUSTED_PROXIES: comma-separated addresses or CIDR ranges of the proxies in front of this
// server (e.g. a CDN's edge ranges). Unset = loopback only.
export function parseTrustedProxies(value) {
  const list = new net.BlockList();
  const entries = String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const entry of entries.length ? entries : ["127.0.0.1", "::1"]) {
    const [addr, bits] = entry.split("/");
    const ip = normalizeIp(addr);
    const family = net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : null;
    if (!family) throw new Error(`GRIFFIN_TRUSTED_PROXIES: not an address or range: ${entry}`);
    if (bits === undefined) list.addAddress(ip, family);
    else list.addSubnet(ip, Number(bits), family);
  }
  return list;
}

export const DEFAULT_TRUSTED_PROXIES = parseTrustedProxies("");

export const trusts = (list, ip) => net.isIP(ip) > 0 && list.check(ip, net.isIPv4(ip) ? "ipv4" : "ipv6");

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host", "x-forwarded-proto", "true-client-ip", "via"];
// A request from this machine itself: a loopback peer (or the server's own address) that did not come
// through a proxy and is not addressed to the public name. Whoever can send one already holds a shell
// here, and with it the data folder, so a credential from that folder is enough on its own.
export function fromThisMachine(c, { publicHost = null } = {}) {
  const socket = c.env?.incoming?.socket;
  const peer = String(socket?.remoteAddress || "");
  const sameHost = LOOPBACK.test(peer) || (peer !== "" && peer === String(socket?.localAddress || ""));
  if (!sameHost) return false;
  if (PROXY_HEADERS.some((h) => c.req.header(h))) return false;
  return !(publicHost && c.req.header("host") === publicHost);
}

// Behind a CDN every request arrives from the edge's own IP and X-Forwarded-For carries the real
// client. Anyone who reaches the port directly can send that header too, so it is believed only
// when the TCP peer is a trusted proxy, and then read from the right: the first hop that is not a
// trusted proxy is the client (hops further left were written by the client itself). It keys the
// login rate limit, so a forged header must not give a fresh identity per try.
export function clientAddress(incoming, trustedProxies = DEFAULT_TRUSTED_PROXIES) {
  const peer = normalizeIp(incoming?.socket?.remoteAddress);
  if (!trusts(trustedProxies, peer)) return peer || "unknown";
  const hops = String(incoming?.headers?.["x-forwarded-for"] || "").split(",").map(normalizeIp).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    if (!net.isIP(hops[i])) break;
    if (!trusts(trustedProxies, hops[i])) return hops[i];
  }
  return peer;
}
