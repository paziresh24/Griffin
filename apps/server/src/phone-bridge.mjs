import crypto from "node:crypto";
import net from "node:net";

// The person's Android phone through their browser (WebUSB, the webadb way): the page holds the USB side
// and sends whole ADB packets over a WebSocket; here they are served as an adbd on this machine's loopback,
// so the agent runs real `adb connect 127.0.0.1:<port>` — install, logcat, reverse, screencap — while the
// phone sits on the person's desk. No laptop agent, no adb on their computer. The phone shows its own
// «Allow USB debugging?» for this server's adb key the first time; nothing passes without that tap.
//
// The WebSocket is opened with a one-time ticket from an authenticated POST, so the upgrade needs no
// cookie check of its own. One phone at a time: a new bridge replaces the old one.

const HEADER = 24;
const MAX_PAYLOAD = 1 << 20; // adbd's max_payload; anything bigger is not ADB
const TICKET_MS = 60_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const PHONE_PATH = "/api/phone/ws";

// ---- ADB framing ----------------------------------------------------------------------------------

// Splits a TCP byte stream into whole ADB packets. push(chunk) → [packet, …]; throws on garbage.
export function adbFramer() {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const out = [];
    while (buf.length >= HEADER) {
      const command = buf.readUInt32LE(0);
      if ((buf.readUInt32LE(20) ^ 0xffffffff) >>> 0 !== command) throw new Error("not an ADB stream");
      const len = buf.readUInt32LE(12);
      if (len > MAX_PAYLOAD) throw new Error("ADB payload too large");
      if (buf.length < HEADER + len) break;
      out.push(buf.subarray(0, HEADER + len));
      buf = buf.subarray(HEADER + len);
    }
    if (!buf.length) buf = Buffer.alloc(0);
    return out;
  };
}

// ---- a minimal WebSocket (RFC 6455): binary and text messages, ping/pong, close ------------------------

export function wsAccept(key) {
  return crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

export function wsFrame(payload, opcode = 0x2) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (n >= 126 && n < 65536) { head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
  if (n >= 65536) { head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, data]);
}

// Client frames (always masked). push(chunk) → [{ opcode, data }] with fragments joined.
export function wsReader(maxMessage = MAX_PAYLOAD + HEADER + 1024) {
  let buf = Buffer.alloc(0);
  let parts = [];
  let partOp = 0;
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (buf.length < 2) break;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; const big = buf.readBigUInt64BE(2); if (big > BigInt(maxMessage)) throw new Error("frame too large"); len = Number(big); off = 10; }
      if (len > maxMessage) throw new Error("frame too large");
      if (!masked) throw new Error("unmasked client frame");
      if (buf.length < off + 4 + len) break;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (opcode >= 0x8) { out.push({ opcode, data }); continue; }
      if (opcode !== 0) { parts = [data]; partOp = opcode; } else parts.push(data);
      if (parts.reduce((s, p) => s + p.length, 0) > maxMessage) throw new Error("message too large");
      if (fin) { out.push({ opcode: partOp, data: parts.length === 1 ? parts[0] : Buffer.concat(parts) }); parts = []; }
    }
    if (!buf.length) buf = Buffer.alloc(0);
    return out;
  };
}

// ---- the bridge -----------------------------------------------------------------------------------

export function createPhoneBridge({ store = null, port = Number(process.env.GRIFFIN_PHONE_ADB_PORT) || 15555, host = "127.0.0.1", now = () => Date.now(), log = () => {} } = {}) {
  const tickets = new Map(); // ticket -> expires
  let live = null; // { socket (ws), server (tcp), tcp, phone: { serial, label }, since, sent, received }

  function ticket() {
    const t = now();
    for (const [k, exp] of tickets) if (exp < t) tickets.delete(k);
    const id = crypto.randomBytes(24).toString("base64url");
    tickets.set(id, t + TICKET_MS);
    return id;
  }

  const takeTicket = (id) => {
    const exp = tickets.get(id);
    tickets.delete(id);
    return Boolean(exp && exp >= now());
  };

  function status() {
    if (!live?.phone) return { connected: false, port, host };
    return {
      connected: true,
      host,
      port,
      serial: `${host}:${port}`,
      phone: live.phone,
      since: new Date(live.since).toISOString(),
      adbClient: Boolean(live.tcp),
      bytes: { toPhone: live.sent, fromPhone: live.received },
    };
  }

  function end(rec, why) {
    if (!rec || rec.ended) return;
    rec.ended = true;
    try { rec.tcp?.destroy(); } catch {}
    try { rec.server?.close(); } catch {}
    try { rec.socket.write(wsFrame(Buffer.from([0x03, 0xe8]), 0x8)); } catch {}
    try { rec.socket.destroy(); } catch {}
    if (live === rec) live = null;
    log(`phone bridge closed: ${why}`);
  }

  // The adbd on loopback: one adb client at a time; its packets go to the phone, the phone's come back.
  function listen(rec) {
    const server = net.createServer((tcp) => {
      if (rec.tcp) rec.tcp.destroy(); // a new `adb connect` replaces the old one; its CNXN resets the phone side
      rec.tcp = tcp;
      tcp.setNoDelay(true);
      const frame = adbFramer();
      tcp.on("data", (chunk) => {
        let packets;
        try { packets = frame(chunk); } catch { tcp.destroy(); return; }
        for (const p of packets) { rec.sent += p.length; rec.socket.write(wsFrame(p)); }
      });
      const gone = () => { if (rec.tcp === tcp) rec.tcp = null; };
      tcp.on("close", gone);
      tcp.on("error", () => tcp.destroy());
    });
    server.on("error", (e) => {
      try { rec.socket.write(wsFrame(JSON.stringify({ state: `پورت ${port} روی سرور آزاد نیست (${e.code || e.message}).` }), 0x1)); } catch {}
      end(rec, `listen ${e.code || e.message}`);
    });
    server.listen(port, host, () => {
      try { rec.socket.write(wsFrame(JSON.stringify({ state: "ready", serial: `${host}:${port}` }), 0x1)); } catch {}
    });
    rec.server = server;
  }

  function onMessage(rec, { opcode, data }) {
    if (opcode === 0x8) return end(rec, "browser closed");
    if (opcode === 0x9) return rec.socket.write(wsFrame(data, 0xa));
    if (opcode === 0xa) return;
    if (opcode === 0x1) {
      let m;
      try { m = JSON.parse(data.toString("utf8")); } catch { return; }
      if (m?.hello && !rec.phone) {
        rec.phone = { serial: String(m.hello.serial || "").slice(0, 64), label: String(m.hello.label || "").slice(0, 80) };
        if (live && live !== rec) end(live, "replaced by a new phone");
        live = rec;
        try { store?.setKv("phone:last", { label: rec.phone.label, at: new Date(now()).toISOString() }); } catch {}
        listen(rec);
        log(`phone bridge up: ${rec.phone.label} on ${host}:${port}`);
      }
      return;
    }
    if (opcode === 0x2 && rec.phone) {
      rec.received += data.length;
      if (rec.tcp && !rec.tcp.destroyed) rec.tcp.write(data);
    }
  }

  // http upgrade hook: true when the request was the phone's.
  function handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, "http://x"); } catch { return false; }
    if (url.pathname !== PHONE_PATH) return false;
    const key = req.headers["sec-websocket-key"];
    if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket" || !takeTicket(url.searchParams.get("ticket") || "")) {
      socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return true;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
    socket.setNoDelay(true);
    const rec = { socket, server: null, tcp: null, phone: null, since: now(), sent: 0, received: 0, ended: false };
    const read = wsReader();
    const feed = (chunk) => {
      let msgs;
      try { msgs = read(chunk); } catch { return end(rec, "bad frame"); }
      for (const m of msgs) onMessage(rec, m);
    };
    socket.on("data", feed);
    socket.on("close", () => end(rec, "socket closed"));
    socket.on("error", () => end(rec, "socket error"));
    // Keep proxies from timing the socket out while the phone is idle.
    const ping = setInterval(() => { if (rec.ended) clearInterval(ping); else socket.write(wsFrame(Buffer.alloc(0), 0x9)); }, 25_000);
    ping.unref?.();
    if (head?.length) feed(head);
    return true;
  }

  function close() {
    if (live) end(live, "server stopping");
  }

  // One line for the agent's prompt (owner-rooted chats): how to reach the phone, or where the owner turns it on.
  function promptLine() {
    const s = status();
    if (!s.connected && !store?.getKv("phone:last")) return "";
    if (!s.connected) return "\n\nPhone: none connected now. To work on the owner's Android phone, ask them to open Settings → «گوشی» in Chrome/Edge on the computer the phone is plugged into (USB debugging on) and press «اتصال گوشی»; then adb from your shell reaches it.";
    return `\n\nPhone: connected right now through the owner's browser (${s.phone.label || "Android"}). In your shell: \`adb connect ${s.serial}\`, then \`adb -s ${s.serial} …\` (install, shell, logcat, reverse, exec-out screencap -p). The first connect shows «Allow USB debugging?» on the phone — if adb says unauthorized, ask the owner to tap «Always allow». It stays only while that browser tab is open.`;
  }

  return { ticket, status, handleUpgrade, close, promptLine, port, host };
}
