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

export function createDualServer(listener, { tls = null } = {}) {
  const plain = http.createServer(listener);
  const secure = tls ? https.createServer(tls, listener) : null;

  const server = net.createServer((socket) => {
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
  // Let the process exit cleanly: closing the TCP listener is not enough while keep-alive
  // connections are still parked on the inner servers.
  const close = server.close.bind(server);
  server.close = (callback) => {
    plain.closeAllConnections?.();
    secure?.closeAllConnections?.();
    return close(callback);
  };
  return server;
}

// Behind NSIN every request arrives from an edge IP; the first X-Forwarded-For hop is the client.
// It can be spoofed by anyone who reaches the origin port directly, so it is used only for the
// login rate limit (the owner token is 24 random bytes; the limit is not what protects it).
export function clientAddress(incoming) {
  const forwarded = String(incoming?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || incoming?.socket?.remoteAddress || "unknown";
}
