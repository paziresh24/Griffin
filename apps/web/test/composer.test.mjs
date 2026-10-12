// The composer's send is its one filled (accent) button while it can send; the microphone and the
// other icons stay plain.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("send is the one filled button in the composer, and plain while it cannot send", () => {
  const thread = fs.readFileSync(new URL("../src/components/Thread.jsx", import.meta.url), "utf8");
  const composer = thread.slice(thread.indexOf("function Composer("), thread.indexOf("function ComposerImage("));
  const send = composer.match(/<ComposerPrimitive\.Send className="([^"]+)"/)[1].split(" ");
  assert.ok(send.includes("bg-primary"), "filled with the accent colour");
  assert.ok(send.includes("disabled:bg-transparent"), "an empty box leaves it plain");
  const filled = composer.match(/className="[^"]*\bbg-primary\b[^"]*"/g) || [];
  assert.equal(filled.length, 2, "only send and the quotes-only send are filled");
  const dictate = thread.slice(thread.indexOf("function DictateButton("), thread.indexOf("function Composer("));
  assert.doesNotMatch(dictate, /bg-primary/, "the microphone stays plain");
});
