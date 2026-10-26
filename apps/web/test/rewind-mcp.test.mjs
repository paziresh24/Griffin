import test from "node:test";
import assert from "node:assert/strict";
import { filesLine, rewindChoices, textBackToBox } from "../src/rewind.js";
import { mcpSourceLine, mcpStatus } from "../src/mcp.js";

test("rewind dialog: the choices the preview allows, and one plain line about files", () => {
  assert.deepEqual(rewindChoices({ files: { canRewind: true, changed: 2 }, conversation: { canRewind: true } }), { both: true, conversation: true, files: true });
  assert.deepEqual(rewindChoices({ files: { canRewind: false, changed: 0 }, conversation: { canRewind: true } }), { both: false, conversation: true, files: false });
  assert.deepEqual(rewindChoices(null), { both: false, conversation: false, files: false });
  assert.match(filesLine({ canRewind: true, changed: 2, insertions: 3 }), /۲ فایل.*۳ خط اضافه/);
  assert.match(filesLine(null), /بررسی/);
});

test("MCP live status: Persian state labels and where the list comes from", () => {
  assert.equal(mcpStatus("needs-auth").label, "نیاز به ورود");
  assert.equal(mcpStatus("weird").label, "weird");
  assert.match(mcpSourceLine({ available: false }), /Claude Code/);
  assert.match(mcpSourceLine({ available: true, chatTitle: "x" }), /«x»/);
});

test("an MCP sign-in card links only to a web page", async () => {
  const { askLink } = await import("../src/ask.js");
  assert.equal(askLink({ link: " https://example.com/login " }), "https://example.com/login");
  assert.equal(askLink({ link: "javascript:alert(1)" }), null);
  assert.equal(askLink({}), null);
});

test("rewind: the rewound message goes back to the composer, not after «فقط فایل‌ها» or an edit", () => {
  assert.equal(textBackToBox({}, "سلام"), "سلام");
  assert.equal(textBackToBox({ files: false }, "سلام"), "سلام");
  assert.equal(textBackToBox({ conversation: false }, "سلام"), "");
  assert.equal(textBackToBox({ text: "ویرایش" }, "سلام"), "");
  assert.equal(textBackToBox({}, "  "), "");
});
