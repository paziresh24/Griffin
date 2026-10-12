// Voice dictation: the composer records a clip, this asks an audio-capable model on any
// OpenAI-compatible chat endpoint (OpenRouter by default; GRIFFIN_STT_BASE_URL / _MODEL / _LANGUAGE)
// for its transcript and returns the text. OpenRouter has no /audio/transcriptions, so the clip goes
// to chat/completions as an `input_audio` part. The audio is not stored and the key
// (<data>/stt.api-key or GRIFFIN_STT_API_KEY) never leaves the server. The browser sends 16 kHz WAV.

export const STT_DEFAULTS = { baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash", language: "" };
const INSTRUCTION = (language) =>
  `Transcribe this audio verbatim${language === "fa" ? " (it is Persian; write it in Persian script, keep English words as spoken)" : ""}. ` +
  "Reply with only the transcript — no quotes, notes or translation. If nothing is said, reply with nothing.";
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const EXTENSIONS = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "webm", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/ogg": "ogg", "audio/mpeg": "mp3" };

const fail = (message, status) => Object.assign(new Error(message), { status });

export function sttRoutes(api, { getKey, config = STT_DEFAULTS, fetchFn = fetch, log = console }) {
  api.get("/api/stt", (c) => c.json({ configured: Boolean(getKey()) }));

  api.post("/api/transcribe", async (c) => {
    try {
      const key = getKey();
      if (!key) throw fail("speech to text is not set up", 503);
      const type = String(c.req.header("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!Object.hasOwn(EXTENSIONS, type)) throw fail("not an audio recording", 415);
      if (Number(c.req.header("content-length")) > MAX_AUDIO_BYTES) throw fail("recording too long", 413);
      // Read with the cap in force: a body that states no length (or a false one) stops here.
      const chunks = [];
      let size = 0;
      const reader = c.req.raw.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_AUDIO_BYTES) {
          await reader.cancel().catch(() => {});
          throw fail("recording too long", 413);
        }
        chunks.push(value);
      }
      if (!size) throw fail("empty recording", 400);
      const audio = { data: Buffer.concat(chunks).toString("base64"), format: EXTENSIONS[type] };
      let res;
      try {
        res = await fetchFn(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: config.model,
            temperature: 0,
            messages: [{ role: "user", content: [{ type: "text", text: INSTRUCTION(config.language) }, { type: "input_audio", input_audio: audio }] }],
          }),
          redirect: "error",
          signal: AbortSignal.timeout(90_000),
        });
      } catch (error) {
        // Only the error class: its text can carry a host or a header.
        log.error?.(`[stt] request failed: ${error?.name || "error"}`);
        throw fail("the speech service did not answer", 502);
      }
      if (!res.ok) {
        log.error?.(`[stt] service answered ${res.status}`);
        // OpenRouter wants at least $0.50 of credit before it takes audio.
        throw fail(res.status === 402 ? "اعتبار OpenRouter کافی نیست (برای صدا دست‌کم ۰٫۵ دلار)" : `the speech service answered ${res.status}`, 502);
      }
      const body = await res.json().catch(() => null);
      return c.json({ text: String(body?.choices?.[0]?.message?.content || "").trim() });
    } catch (error) {
      return c.json({ error: error.message }, error.status || 502);
    }
  });
}
