import test from "node:test";
import assert from "node:assert/strict";
import { MAX_RECORD_MS, encodeWav, joinDictation, pickAudioMime, recordClock } from "../src/dictation.js";

test("dictation: the first recording format the browser supports is used", () => {
  assert.equal(pickAudioMime((m) => m.startsWith("audio/webm")), "audio/webm;codecs=opus");
  assert.equal(pickAudioMime((m) => m === "audio/mp4"), "audio/mp4", "Safari");
  assert.equal(pickAudioMime(() => false), "", "let the browser choose");
  assert.equal(pickAudioMime(null), "");
});

test("dictation: the text is added to what is already in the box, never replacing it", () => {
  assert.equal(joinDictation("", "سلام"), "سلام");
  assert.equal(joinDictation("اول این", "بعد آن"), "اول این بعد آن");
  assert.equal(joinDictation("خط اول\n", "خط دوم"), "خط اول\nخط دوم");
  assert.equal(joinDictation("متن", "   "), "متن", "nothing heard: the box stays as it was");
  assert.equal(joinDictation("متن ", " گفته "), "متن گفته");
});

test("dictation: the recording clock, and a cap so a forgotten microphone stops by itself", () => {
  assert.equal(recordClock(0, "fa-IR"), "۰:۰۰");
  assert.equal(recordClock(65_400, "fa-IR"), "۱:۰۵");
  assert.equal(recordClock(65_400), "1:05");
  assert.ok(MAX_RECORD_MS >= 60_000 && MAX_RECORD_MS <= 10 * 60_000);
});

test("dictation: the clip goes as 16 kHz mono 16-bit WAV", async () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
  const view = new DataView(await wav.arrayBuffer());
  assert.equal(wav.type, "audio/wav");
  assert.equal(view.byteLength, 44 + 8);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.deepEqual([1, 2, 3].map((i) => view.getInt16(44 + i * 2, true)), [32767, -32767, 32767], "clipped to [-1, 1]");
});
