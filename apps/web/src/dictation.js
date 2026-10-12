// Voice dictation in the composer: record a clip, POST it to /api/transcribe, add
// the text to the box. Nothing is sent by itself.

// A forgotten microphone stops by itself.
export const MAX_RECORD_MS = 5 * 60_000;
const FORMATS = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const WAV_RATE = 16_000; // what speech models resample to anyway; 5 min ≈ 9.6 MB

// The first recording format this browser supports ("" lets the browser choose).
export function pickAudioMime(isSupported) {
  if (typeof isSupported !== "function") return "";
  return FORMATS.find((mime) => isSupported(mime)) || "";
}

// What was said joins what is already typed.
export function joinDictation(value, text) {
  const said = String(text || "").trim();
  const before = String(value || "");
  if (!said) return before;
  if (!before) return said;
  return /\n$/.test(before) ? `${before}${said}` : `${before.replace(/[ \t]+$/, "")} ${said}`;
}

// m:ss in the UI language's digits.
export function recordClock(ms, locale = "en-US") {
  const s = Math.floor(ms / 1000);
  const n = (v, digits) => v.toLocaleString(locale, { minimumIntegerDigits: digits, useGrouping: false });
  return `${n(Math.floor(s / 60), 1)}:${n(s % 60, 2)}`;
}

// 16-bit mono PCM WAV from float samples.
export function encodeWav(samples, rate = WAV_RATE) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at, s) => [...s].forEach((ch, i) => out.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([out.buffer], { type: "audio/wav" });
}

// Chrome records a streamed webm some speech services refuse; decoded and resampled here it goes
// as WAV, so the server needs no ffmpeg. A browser that cannot decode its own clip sends it as is.
export async function toWav(blob) {
  try {
    const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * WAV_RATE), WAV_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    return encodeWav((await offline.startRendering()).getChannelData(0));
  } catch {
    return blob;
  }
}
