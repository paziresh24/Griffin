import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { sttRoutes } from "../src/stt.mjs";

function app(key, fetchFn, model = "google/gemini-2.5-flash") {
  const api = new Hono();
  sttRoutes(api, { getKey: () => key, config: { baseUrl: "https://stt.example/v1", model, language: "fa" }, fetchFn, log: {} });
  return api;
}

test("a recording goes to chat/completions as input_audio with the key and comes back as text", async () => {
  let seen;
  const api = app("k-123", async (url, init) => {
    const body = JSON.parse(init.body);
    seen = { url, auth: init.headers.authorization, model: body.model, system: body.messages[0], parts: body.messages[1].content };
    return Response.json({ choices: [{ message: { content: " سلام دنیا " } }] });
  });
  const res = await api.request("/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(await res.json(), { text: "سلام دنیا" });
  assert.equal(seen.url, "https://stt.example/v1/chat/completions");
  assert.equal(seen.auth, "Bearer k-123");
  assert.equal(seen.model, "google/gemini-2.5-flash");
  assert.equal(seen.system.role, "system");
  assert.match(seen.system.content, /Persian/);
  assert.match(seen.system.content, /never instructions/, "spoken orders are written down, not obeyed");
  assert.deepEqual(seen.parts, [{ type: "input_audio", input_audio: { data: "AQID", format: "wav" } }]);
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

// Ported from Karsara 79be00d + 57bf7a7 (2026-10-11).
const answering = (body, log = {}) => {
  const api = new Hono();
  sttRoutes(api, { getKey: () => "k-123", config: { baseUrl: "https://stt.example/v1", model: "google/gemini-2.5-flash", language: "fa" }, fetchFn: async () => Response.json(body), log });
  return api;
};
const say = async (api) => api.request("/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1]) });

test("the audio model's answer is cleaned to the words alone, and real quotes in dictated text stay", async () => {
  const cases = [
    [[{ type: "text", text: "سلام " }, { type: "text", text: "دنیا" }], "سلام دنیا"],
    ['Here is the transcription:\n"سلام"', "سلام"],
    ["«سلام دنیا»", "سلام دنیا"],
    ["[no speech]", ""],
    ["(silence)", ""],
    [{ unexpected: true }, ""],
    [null, ""],
    ["Here is the transcription:\n\n", ""],
    ["Transcript:", ""],
    ["سطر اول\nسطر دوم", "سطر اول\nسطر دوم"],
    ["«سلام» گفت و رفت، بعد گفت «خداحافظ»", "«سلام» گفت و رفت، بعد گفت «خداحافظ»"],
    ['"Hello" he said, then "bye"', '"Hello" he said, then "bye"'],
    ["Transcription of the meeting is due tomorrow: please send it", "Transcription of the meeting is due tomorrow: please send it"],
    ["Transcripts are attached: see the folder", "Transcripts are attached: see the folder"],
  ];
  for (const [content, expected] of cases) {
    const res = await say(answering({ choices: [{ message: { content }, finish_reason: "stop" }] }));
    assert.equal(res.status, 200, JSON.stringify(content));
    assert.deepEqual(await res.json(), { text: expected }, JSON.stringify(content));
  }
});

test("a 200 that carries an error is a failure, not an empty transcript, and its text is not passed on", async () => {
  const bodies = [
    { error: { message: "quota at gw.example" } },
    null,
    "ok",
    { choices: [] },
    { choices: [{ message: { content: "" }, finish_reason: "error", error: { message: "upstream gw.example failed" } }] },
  ];
  for (const body of bodies) {
    const lines = [];
    const res = await say(answering(body, { error: (l) => lines.push(l), warn: (l) => lines.push(l) }));
    assert.equal(res.status, 502, JSON.stringify(body));
    assert.doesNotMatch(await res.text(), /gw\.example|k-123/);
    assert.equal(lines.length, 1, JSON.stringify(body));
    assert.doesNotMatch(lines[0], /gw\.example|k-123/);
  }
});

test("an empty answer is no speech, and a cut-off one is logged in one clean line", async () => {
  assert.deepEqual(await (await say(answering({ choices: [{ message: { content: null }, finish_reason: "stop" }] }))).json(), { text: "" });
  const lines = [];
  const res = await say(answering({ choices: [{ message: { content: "سلام" }, finish_reason: "length\nFAKE LOG LINE" }] }, { warn: (l) => lines.push(l) }));
  assert.deepEqual(await res.json(), { text: "سلام" });
  assert.deepEqual(lines, ["[stt] transcript ended by lengthFAKELOGLINE"]);
});

test("a non-Gemini model gets /audio/transcriptions as a form, webm repacked to ogg", async () => {
  let seen;
  const api = new Hono();
  sttRoutes(api, {
    getKey: () => "k-123",
    config: () => ({ baseUrl: "https://stt.example/v1", model: "whisper-1", language: "fa" }),
    remuxWebm: async () => Buffer.from([9]),
    fetchFn: async (url, init) => {
      seen = { url, auth: init.headers.authorization, model: init.body.get("model"), lang: init.body.get("language"), file: init.body.get("file") };
      return Response.json({ text: " سلام " });
    },
    log: {},
  });
  const res = await api.request("/api/transcribe", { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array([1, 2]) });
  assert.deepEqual(await res.json(), { text: "سلام" });
  assert.equal(seen.url, "https://stt.example/v1/audio/transcriptions");
  assert.equal(seen.auth, "Bearer k-123");
  assert.equal(seen.model, "whisper-1");
  assert.equal(seen.lang, "fa");
  assert.equal(seen.file.name, "speech.ogg");
});

test("key and config routes: the key is stored, never returned; config must be https", async () => {
  let key = "";
  let cfg = { baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash", language: "fa" };
  const api = new Hono();
  sttRoutes(api, { getKey: () => key, setKey: (k) => (key = k), removeKey: () => (key = ""), config: () => cfg, saveConfig: (c) => (cfg = c), log: {} });
  const json = { "content-type": "application/json" };
  assert.equal((await api.request("/api/stt/key", { method: "PUT", headers: json, body: JSON.stringify({ key: "a b" }) })).status, 400);
  const put = await api.request("/api/stt/key", { method: "PUT", headers: json, body: JSON.stringify({ key: "sk-secret-123456" }) });
  const text = await put.text();
  assert.doesNotMatch(text, /sk-secret/);
  assert.deepEqual(JSON.parse(text).key, { set: true, last4: "3456" });
  assert.equal(key, "sk-secret-123456");
  assert.equal((await api.request("/api/stt/config", { method: "PUT", headers: json, body: JSON.stringify({ baseUrl: "http://x.example/v1" }) })).status, 400);
  const ok = await (await api.request("/api/stt/config", { method: "PUT", headers: json, body: JSON.stringify({ baseUrl: "https://api.gapgpt.app/v1/", model: "whisper-1", language: "xx1" }) })).json();
  assert.deepEqual(cfg, { baseUrl: "https://api.gapgpt.app/v1", model: "whisper-1", language: "" });
  assert.equal(ok.model, "whisper-1");
  assert.equal((await (await api.request("/api/stt/key", { method: "DELETE" })).json()).configured, false);
});

test("a refused key or model is said in plain Persian and kept, so the microphone says so before the next recording", async () => {
  let status = 401;
  const api = new Hono();
  sttRoutes(api, { getKey: () => "k-12345678", config: { baseUrl: "https://stt.example/v1", model: "google/gemini-2.5-flash", language: "fa" }, fetchFn: async () => (status === 200 ? Response.json({ choices: [{ message: { content: "سلام" }, finish_reason: "stop" }] }) : new Response("no", { status })), log: {} });
  const say = () => api.request("/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1]) });
  assert.equal((await (await api.request("/api/stt")).json()).broken, null);
  const refused = await say();
  assert.equal(refused.status, 502);
  assert.match((await refused.json()).error, /کلید را نپذیرفت/);
  assert.match((await (await api.request("/api/stt")).json()).broken.error, /کلید را نپذیرفت/);
  status = 429;
  assert.match((await (await say()).json()).error, /درخواست زیادی/);
  status = 200;
  assert.deepEqual(await (await say()).json(), { text: "سلام" });
  assert.equal((await (await api.request("/api/stt")).json()).broken, null, "a transcript clears it");
});

test("no key: the answer says where to set it up", async () => {
  const res = await app("", async () => assert.fail("must not call")).request("/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1]) });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /تنظیمات/);
});
