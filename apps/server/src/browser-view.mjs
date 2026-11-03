import crypto from "node:crypto";
import net from "node:net";

// Each chat's own browser beside the chat (owner 2026-10-31: «هر چتی اگر نیاز شد مرورگر‌های کوچولو بسازه
// برای خودش و کلا اونتو کنترل بشه»): the chat's headless context in the sandbox (browser.mjs) streamed to
// the panel next to the conversation, and the owner's mouse and keys back into it. No shared screen: one
// chat, one browser, one panel.
//   GET  /api/chats/:id/browser          → does this chat have a browser (never opens one)
//   POST /api/chats/:id/browser/ticket   → a one-time ticket for that chat's stream (60 s)
//   WS   /api/browser-view/ws?t=…        → the daemon's /stream for that chat, bytes both ways
// Owner chats only: a colleague's chain keeps its browser to itself.

export const VIEW_PATH = "/api/browser-view/ws";
const TICKET_MS = 60_000;

export function createBrowserView({ browser, mayView = () => true, now = () => Date.now(), log = () => {} }) {
  const tickets = new Map(); // ticket -> { chatId, expires }

  function ticket(chatId) {
    if (!mayView(chatId)) throw new Error("this chat's browser is not yours to view");
    const t = now();
    for (const [k, v] of tickets) if (v.expires < t) tickets.delete(k);
    const id = crypto.randomBytes(24).toString("base64url");
    tickets.set(id, { chatId, expires: t + TICKET_MS });
    return id;
  }

  const take = (id) => {
    const rec = tickets.get(String(id || ""));
    tickets.delete(String(id || ""));
    return rec && rec.expires >= now() ? rec.chatId : null;
  };

  async function status(chatId) {
    if (!mayView(chatId)) return { exists: false };
    return browser.peek(chatId, { scope: "owner" });
  }

  function handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, "http://x"); } catch { return false; }
    if (url.pathname !== VIEW_PATH) return false;
    const chatId = take(url.searchParams.get("t"));
    if (!chatId || !req.headers["sec-websocket-key"]) {
      socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return true;
    }
    browser.streamTarget(chatId, { scope: "owner" }).then(
      ({ host, port, token, path }) => {
        const up = net.connect({ host, port }, () => {
          const lines = [
            `GET ${path} HTTP/1.1`,
            `Host: localhost:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${req.headers["sec-websocket-key"]}`,
            `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"] || "13"}`,
            `Authorization: Bearer ${token}`,
          ];
          up.write(`${lines.join("\r\n")}\r\n\r\n`);
          if (head?.length) up.write(head);
          socket.pipe(up);
          up.pipe(socket);
        });
        const close = () => { up.destroy(); socket.destroy(); };
        up.on("error", (e) => { log(`view socket: ${e.code || e.message}`); close(); });
        socket.on("error", close);
        up.on("close", () => socket.destroy());
        socket.on("close", () => up.destroy());
      },
      (error) => {
        log(`view: ${error.message}`);
        socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
      },
    );
    return true;
  }

  return { ticket, status, handleUpgrade };
}
