import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { sttRoutes } from "../src/stt.mjs";

function app(key, fetchFn) {
  const api = new Hono();
  sttRoutes(api, { getKey: () => key, config: { baseUrl: "https://stt.example/v1", model: "whisper-1", language: "fa" }, fetchFn, log: {} });
  return api;
}

test("a recording goes to chat/completions as input_audio with the key and comes back as text", async () => {
  let seen;
  const api = app("k-123", async (url, init) => {
    const body = JSON.parse(init.body);
    seen = { url, auth: init.headers.authorization, model: body.model, parts: body.messages[0].content };
    return Response.json({ choices: [{ message: { content: " سلام دنیا " } }] });
  });
  const res = await api.request("/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(await res.json(), { text: "سلام دنیا" });
  assert.equal(seen.url, "https://stt.example/v1/chat/completions");
  assert.equal(seen.auth, "Bearer k-123");
  assert.equal(seen.model, "whisper-1");
  assert.match(seen.parts[0].text, /Persian/);
  assert.deepEqual(seen.parts[1], { type: "input_audio", input_audio: { data: "AQID", format: "wav" } });
});

test("no key, a non-audio body, an empty body and a service error are refused without the key", async () => {
  const none = await app("", async () => assert.fail("must not call")).request("/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1]) });
  assert.equal(none.status, 503);
  const api = app("k-123", async () => new Response("nope k-123", { status: 401 }));
  assert.equal((await api.request("/api/transcribe", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status, 415);
  assert.equal((await api.request("/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array() })).status, 400);
  const bad = await api.request("/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1]) });
  assert.equal(bad.status, 502);
  assert.doesNotMatch(await bad.text(), /k-123/);
});
