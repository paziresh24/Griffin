import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { adbFramer, createPhoneBridge, PHONE_PATH, wsAccept, wsFrame, wsReader } from "../src/phone-bridge.mjs";

// An ADB packet: command, args, payload; magic = command ^ 0xffffffff.
function packet(cmd, payload = Buffer.alloc(0), arg0 = 1, arg1 = 0) {
  const h = Buffer.alloc(24);
  const command = Buffer.from(cmd).readUInt32LE(0);
  h.writeUInt32LE(command, 0);
  h.writeUInt32LE(arg0, 4);
  h.writeUInt32LE(arg1, 8);
  h.writeUInt32LE(payload.length, 12);
  h.writeUInt32LE(0, 16);
  h.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([h, payload]);
}

test("adbFramer splits a TCP stream into whole packets, across any chunking", () => {
  const a = packet("CNXN", Buffer.from("host::\0"));
  const b = packet("OKAY");
  const c = packet("WRTE", Buffer.alloc(5000, 7));
  const all = Buffer.concat([a, b, c]);
  for (const size of [1, 7, 24, 25, 100, all.length]) {
    const frame = adbFramer();
    const got = [];
    for (let i = 0; i < all.length; i += size) got.push(...frame(all.subarray(i, i + size)));
    assert.deepEqual(got.map((p) => Buffer.from(p)), [a, b, c], `chunk ${size}`);
  }
});

test("adbFramer refuses a stream that is not ADB", () => {
  const frame = adbFramer();
  assert.throws(() => frame(Buffer.from("GET / HTTP/1.1\r\nhost: x\r\n\r\n")), /not an ADB stream/);
});

// A browser's frame: masked.
function clientFrame(data, opcode = 0x2) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(data);
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 255]) : null;
  const masked = Buffer.from(body.map((x, i) => x ^ mask[i & 3]));
  return Buffer.concat([head, mask, masked]);
}

test("wsReader unmasks frames, joins fragments, and wsFrame writes what a reader reads back", () => {
  const read = wsReader();
  const big = Buffer.alloc(70_000, 9);
  // Fragmented: first frame without FIN, then a continuation with FIN.
  const f1 = clientFrame(Buffer.from("he"), 0x1);
  f1[0] &= 0x7f;
  const f2 = clientFrame(Buffer.from("llo"), 0x0);
  const out = [...read(Buffer.concat([f1, f2.subarray(0, 3)])), ...read(f2.subarray(3))];
  assert.deepEqual(out.map((m) => [m.opcode, m.data.toString()]), [[0x1, "hello"]]);
  const server = wsFrame(big);
  assert.equal(server[1], 127);
  assert.equal(Number(server.readBigUInt64BE(2)), big.length);
  assert.equal(wsAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("wsReader refuses an unmasked client frame", () => {
  assert.throws(() => wsReader()(Buffer.from([0x82, 0x01, 0x00])), /unmasked/);
});

async function withServer(bridge, fn) {
  const server = http.createServer((_, res) => res.end());
  server.on("upgrade", (req, socket, head) => { if (!bridge.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(server.address().port);
  } finally {
    bridge.close();
    server.close();
  }
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("without a valid one-time ticket the upgrade is refused", async () => {
  const bridge = createPhoneBridge({ port: await freePort() });
  await withServer(bridge, async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PHONE_PATH}?ticket=nope`);
    const result = await new Promise((r) => { ws.onopen = () => r("open"); ws.onerror = () => r("error"); });
    assert.equal(result, "error");
    const t = bridge.ticket();
    const ok = new WebSocket(`ws://127.0.0.1:${port}${PHONE_PATH}?ticket=${t}`);
    assert.equal(await new Promise((r) => { ok.onopen = () => r("open"); ok.onerror = () => r("error"); }), "open");
    ok.close();
    // used once: the same ticket no longer opens
    const again = new WebSocket(`ws://127.0.0.1:${port}${PHONE_PATH}?ticket=${t}`);
    assert.equal(await new Promise((r) => { again.onopen = () => r("open"); again.onerror = () => r("error"); }), "error");
  });
});

test("an adb client on the loopback port talks to the browser's phone, packet by packet", async () => {
  const adbPort = await freePort();
  const kv = new Map();
  const store = { getKv: (k) => kv.get(k), setKv: (k, v) => kv.set(k, v) };
  const bridge = createPhoneBridge({ port: adbPort, store });
  assert.equal(bridge.promptLine(), "", "never connected: nothing in the prompt");
  await withServer(bridge, async (port) => {
    // The "browser": answers every packet from adb with an OKAY carrying the same payload length.
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PHONE_PATH}?ticket=${bridge.ticket()}`);
    ws.binaryType = "arraybuffer";
    const fromAdb = [];
    let ready = false;
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") { if (JSON.parse(ev.data).state === "ready") ready = true; return; }
      const p = Buffer.from(ev.data);
      fromAdb.push(p);
      ws.send(packet("OKAY", Buffer.alloc(p.readUInt32LE(12), 1)));
    };
    await new Promise((r) => { ws.onopen = r; });
    ws.send(JSON.stringify({ hello: { serial: "R5CY", label: "Samsung SM-S918" } }));
    await until(() => ready);
    assert.equal(bridge.status().connected, true);
    assert.equal(bridge.status().phone.label, "Samsung SM-S918");
    assert.match(bridge.promptLine(), new RegExp(`adb connect 127\\.0\\.0\\.1:${adbPort}`));

    const tcp = net.connect(adbPort, "127.0.0.1");
    const back = [];
    const frame = adbFramer();
    tcp.on("data", (c) => back.push(...frame(c)));
    await new Promise((r) => tcp.on("connect", r));
    const cnxn = packet("CNXN", Buffer.from("host::features=shell_v2\0"), 0x01000001, 1 << 20);
    const big = packet("WRTE", Buffer.alloc(200_000, 3));
    // Sent in odd pieces: the browser still gets whole packets.
    const both = Buffer.concat([cnxn, big]);
    for (let i = 0; i < both.length; i += 4093) tcp.write(both.subarray(i, i + 4093));
    await until(() => back.length === 2);
    assert.deepEqual(fromAdb, [cnxn, big]);
    assert.equal(back[1].readUInt32LE(12), 200_000);
    assert.equal(back[0].toString("latin1", 0, 4), "OKAY");
    tcp.destroy();

    ws.close();
    await until(() => !bridge.status().connected);
    assert.match(bridge.promptLine(), /none connected now/, "once used, the prompt says where to turn it on");
    await assert.rejects(new Promise((resolve, reject) => { const c = net.connect(adbPort, "127.0.0.1"); c.on("connect", () => { c.destroy(); resolve(); }); c.on("error", reject); }));
  });
});
