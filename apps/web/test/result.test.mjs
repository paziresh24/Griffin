import test from "node:test";
import assert from "node:assert/strict";
import { unwrapResult } from "../src/result.js";

const done = (content, isError = false) => ({ status: "success", result: { status: "success", value: { content, isError } } });

test("summary JSON plus the file text for the model (show_media with Markdown)", () => {
  const summary = { title: "گزارش", media: { mediaId: "m1", mimeType: "text/markdown" } };
  const { result } = unwrapResult(done([{ text: { text: JSON.stringify(summary) } }, { text: { text: "# گزارش\n\n| a |" } }]));
  assert.deepEqual(result.media, summary.media);
  assert.equal(result.modelText, "# گزارش\n\n| a |");
});

test("image content has no text; plain JSON and non-JSON text still work", () => {
  assert.equal(unwrapResult(done([{ text: { text: '{"media":{"mediaId":"i"}}' } }, { image: { data: "[binary omitted]" } }])).result.media.mediaId, "i");
  assert.deepEqual(unwrapResult(done([{ type: "text", text: '{"ok":1}' }])).result, { ok: 1 });
  assert.deepEqual(unwrapResult(done([{ type: "text", text: "question is required" }], true)), { result: { text: "question is required" }, isError: true });
  assert.deepEqual(unwrapResult({ status: "running" }), { result: undefined, isError: false });
});
