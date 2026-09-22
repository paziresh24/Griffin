import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBrokerServer } from "../../broker/src/server.mjs";
import { createToolSource } from "../src/tools.mjs";

test("customTools forward to the broker socket and surface failures as tool errors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-"));
  const socketPath = path.join(dir, "broker.sock");
  const tools = {
    echo: {
      description: "echo",
      inputSchema: { type: "object", properties: { v: { type: "string" } } },
      execute: async (args) => ({ v: args.v, source: "test" }),
    },
    down: {
      description: "always fails",
      inputSchema: { type: "object" },
      execute: async () => {
        throw Object.assign(new Error("all paths failed for prod"), { attempts: [{ path: "public-api", ok: false }] });
      },
    },
  };
  const server = createBrokerServer({ tools, log: {} });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const custom = await createToolSource({ socketPath }).customTools();
    assert.deepEqual(Object.keys(custom), ["echo", "down"]);

    const ok = await custom.echo.execute({ v: "سلام" }, {});
    assert.deepEqual(JSON.parse(ok.content[0].text), { v: "سلام", source: "test" });

    const failed = await custom.down.execute({}, {});
    assert.equal(failed.isError, true);
    assert.equal(JSON.parse(failed.content[0].text).attempts.length, 1);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing broker leaves the agent without custom tools instead of crashing", async () => {
  const source = createToolSource({ socketPath: path.join(os.tmpdir(), "does-not-exist.sock") });
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await source.customTools(), undefined);
  } finally {
    console.error = original;
  }
});

test("image results are stored as media; the model gets the picture, the event log only an id", async () => {
  const saved = [];
  const store = { saveMedia: (m) => { saved.push(m); return "media-1"; } };
  const request = async (_socket, method) => method === "GET"
    ? { status: 200, body: [{ name: "s3_get", description: "x", inputSchema: {} }] }
    : { status: 200, body: { ok: true, result: { bucket: "b", key: "k.jpg", image: { mimeType: "image/jpeg", data: Buffer.from("jpg").toString("base64") } } } };
  const { createToolSource } = await import("../src/tools.mjs");
  const tools = await createToolSource({ socketPath: "/x", exists: () => true, request, store }).customTools("chat-1");
  const result = await tools.s3_get.execute({});
  assert.equal(saved[0].chatId, "chat-1");
  assert.equal(saved[0].data.toString(), "jpg");
  assert.deepEqual(JSON.parse(result.content[0].text).media, { mediaId: "media-1", mimeType: "image/jpeg", name: "k.jpg", bytes: 3 });
  assert.equal(JSON.parse(result.content[0].text).image, undefined, "raw image payload is not echoed in the summary");
  assert.deepEqual(result.content[1], { type: "image", data: Buffer.from("jpg").toString("base64"), mimeType: "image/jpeg" });

  const { clip } = await import("../src/updates.mjs");
  const stored = clip({ value: { content: [{ image: { data: "A".repeat(5000), mimeType: "image/jpeg" } }] } });
  assert.match(stored.value.content[0].image.data, /^\[image omitted: 5000 base64 chars\]$/);
});

test("byte-array image data from the SDK is not stored in events", async () => {
  const { clip } = await import("../src/updates.mjs");
  const bytes = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [String(i), i % 256]));
  const stored = clip({ value: { content: [{ text: { text: "{}" } }, { image: { data: bytes, mimeType: "image/jpeg" } }] } });
  assert.equal(stored.value.content[1].image.data, "[binary omitted: 5000 bytes]");
  assert.equal(clip({ data: new Uint8Array(100) }).data, "[binary omitted: 100 bytes]");
  assert.deepEqual(clip({ counts: { 0: 1, 1: 2 } }), { counts: { 0: 1, 1: 2 } }, "small numeric maps stay");
});
