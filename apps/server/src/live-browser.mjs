import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { LIVE_PORT } from "./browser.mjs";

// The live browser on the server (owner 2026-10-31: «مثل کلاد و zcode و browser.lol یه بروزر داشته باشیم
// روی سرور… هم تستا بره روی اون هم خودمون بتونیم باهاش کار کنیم»). browser.mjs runs it in the sandbox: a
// headed Chromium on Xvfb :99, x11vnc on the sandbox's loopback, websockify + noVNC on LIVE_PORT. This
// module is the owner's only way in:
//   GET /api/livebrowser/open      (signed-in owner) → starts it, mints a ticket, redirects to noVNC
//   GET /api/livebrowser/view/*    (signed-in owner) → noVNC's own files, from the sandbox
//   WS  /api/livebrowser/ws?t=…    (ticket)          → the VNC stream (websockify in the sandbox)
// The WebSocket upgrade never passes the cookie middleware, so it takes a ticket the signed-in page got;
// a ticket lives 12 hours (noVNC reconnects with it), only ever lands in the owner's own address bar.

export const LIVE_PATH = "/api/livebrowser/ws";
const TICKET_MS = 12 * 3600_000;

export function createLiveBrowser({ browser, address, enabled = () => true, now = () => Date.now(), log = () => {} }) {
  const tickets = new Map(); // ticket -> expires

  function ticket() {
    const t = now();
    for (const [k, exp] of tickets) if (exp < t) tickets.delete(k);
    const id = crypto.randomBytes(24).toString("base64url");
    tickets.set(id, t + TICKET_MS);
    return id;
  }
  const validTicket = (id) => {
    const exp = tickets.get(String(id || ""));
    return Boolean(exp && exp >= now());
  };

  // Start (or find) the live browser and the URL of its screen for the owner.
  async function open({ viewOnly = false } = {}) {
    if (!enabled()) throw new Error("the live browser is off on this install (LIVE_BROWSER=off)");
    const up = await browser.liveUp();
    const t = ticket();
    const q = new URLSearchParams({
      autoconnect: "true",
      reconnect: "true",
      reconnect_delay: "1500",
      resize: "scale",
      show_dot: "true",
      view_only: viewOnly ? "true" : "false",
      path: `${LIVE_PATH}?t=${t}`,
      ...(up.vncPassword ? { password: up.vncPassword } : {}),
    });
    return { url: `/api/livebrowser/view/vnc.html?${q}`, tabs: up.tabs || [] };
  }

  // noVNC's static files (GET only), straight from websockify's --web folder in the sandbox.
  async function view(request, rest) {
    if (!/^[A-Za-z0-9._/-]*$/.test(rest) || rest.includes("..")) return new Response("bad path", { status: 400 });
    const addr = await address();
    return new Promise((resolve) => {
      const up = http.request({
        method: "GET",
        path: `/${rest}`,
        headers: { host: `localhost:${LIVE_PORT}` },
        createConnection: () => net.connect({ host: addr, port: LIVE_PORT }),
      });
      up.setTimeout(30_000, () => up.destroy(new Error("timeout")));
      up.on("response", (res) => {
        const headers = new Headers();
        for (const k of ["content-type", "content-length", "last-modified"]) if (res.headers[k]) headers.set(k, String(res.headers[k]));
        headers.set("cache-control", "no-store");
        resolve(new Response(res.statusCode === 304 ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
      });
      up.on("error", (error) => resolve(new Response(`the live browser's screen does not answer (${error.code || error.message}); open it again from «مرورگر سرور»`, { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } })));
      up.end();
    });
  }

  // http upgrade hook: true when the request was the live screen's WebSocket.
  function handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, "http://x"); } catch { return false; }
    if (url.pathname !== LIVE_PATH) return false;
    if (!enabled() || !validTicket(url.searchParams.get("t"))) {
      socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return true;
    }
    address().then(
      (addr) => {
        const up = net.connect({ host: addr, port: LIVE_PORT }, () => {
          const headers = { ...req.headers, host: `localhost:${LIVE_PORT}` };
          delete headers.cookie;
          delete headers.origin;
          const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
          up.write(`GET /websockify HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
          if (head?.length) up.write(head);
          socket.pipe(up);
          up.pipe(socket);
        });
        const close = () => { up.destroy(); socket.destroy(); };
        up.on("error", (e) => { log(`screen socket: ${e.code || e.message}`); close(); });
        socket.on("error", close);
        up.on("close", () => socket.destroy());
        socket.on("close", () => up.destroy());
      },
      () => socket.destroy(),
    );
    return true;
  }

  return { open, view, handleUpgrade, ticket, validTicket };
}
