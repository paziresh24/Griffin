// Files in the message box: PDFs and text files are attached next to pictures, sent
// as `files`, refused in Persian when the server would refuse them, and shown by name in the thread.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { attachmentPayload, countProblem, dragHasFiles, fileMime, fileProblem, filesShown, isAttachableFile, MAX_FILE_BYTES, MAX_PDF_BYTES, overLimit } from "../src/attachments.js";
import { mergeOutbox } from "../src/outbox.js";

test("a file's type comes from its extension first (empty .md, Windows .csv)", () => {
  assert.equal(fileMime({ name: "notes.md", type: "" }), "text/markdown");
  assert.equal(fileMime({ name: "data.CSV", type: "application/vnd.ms-excel" }), "text/csv");
  assert.equal(fileMime({ name: "a.pdf", type: "" }), "application/pdf");
  assert.equal(fileMime({ name: "x", type: "image/png" }), "image/png");
  assert.equal(isAttachableFile("application/yaml"), true);
  assert.equal(isAttachableFile("application/zip"), false);
});

test("an empty, huge or unsupported file is refused with the reason in Persian", () => {
  assert.equal(fileProblem({ name: "a.pdf", size: 10, type: "application/pdf" }), null);
  assert.match(fileProblem({ name: "a.pdf", size: 0 }), /خالی است/);
  assert.match(fileProblem({ name: "a.pdf", size: MAX_FILE_BYTES + 1 }), /بزرگ‌تر از/);
  assert.match(fileProblem({ name: "a.zip", size: 5, type: "application/zip" }), /پیوست نمی‌شود/);
  assert.match(fileProblem({ name: "big.pdf", size: MAX_PDF_BYTES + 1 }), /سقف PDF/);
  assert.equal(fileProblem({ name: "big.log", size: MAX_PDF_BYTES + 1 }), null, "a text file may be larger than a PDF");
  assert.equal(countProblem({ files: [1, 2, 3, 4] }), null);
  assert.match(countProblem({ files: [1, 2, 3, 4, 5] }), /حداکثر ۴ فایل/);
  assert.match(countProblem({ images: [1, 2, 3, 4, 5] }), /حداکثر ۴ تصویر/);
});

test("attachments over a message's limits are the newest ones, picked out as soon as they are added", () => {
  const file = (id) => ({ id, type: "document", contentType: "application/pdf" });
  const image = (id) => ({ id, type: "image", contentType: "image/png" });
  assert.deepEqual(overLimit([file("f1"), image("i1"), file("f2"), file("f3"), file("f4")]), []);
  assert.deepEqual(overLimit([file("f1"), file("f2"), file("f3"), image("i1"), file("f4"), file("f5"), file("f6")]), ["f5", "f6"]);
  assert.deepEqual(overLimit([image("1"), image("2"), image("3"), image("4"), image("5")]), ["5"]);
  // The PDFs of one message together: 12 MB, checked before sending (a refused send loses them).
  const pdf = (id, mb) => ({ id, type: "document", contentType: "application/pdf", file: { size: mb * 1024 * 1024 } });
  assert.deepEqual(overLimit([pdf("a", 5), pdf("b", 5), pdf("c", 5)]), ["c"]);
  assert.deepEqual(overLimit([pdf("a", 5), pdf("b", 5), pdf("c", 5), pdf("d", 1)]), ["c"], "a smaller one after the refused one still fits");
  assert.match(countProblem({ files: [{ mimeType: "application/pdf", data: "A".repeat(17 * 1024 * 1024) }] }), /روی هم حداکثر/);
  const thread = fs.readFileSync(new URL("../src/components/Thread.jsx", import.meta.url), "utf8");
  assert.match(thread, /const extra = overLimit\(attachedItems \|\| \[\]\);/);
  assert.match(thread, /aui\.composer\(\)\.attachment\(\{ id \}\)\.remove\(\)/);
});

test("the composer's message becomes text, images and files", () => {
  const payload = attachmentPayload({
    content: [{ type: "text", text: " خلاصه کن " }],
    attachments: [
      { name: "p.png", content: [{ type: "image", image: "data:image/png;base64,AAAA" }] },
      { name: "r.pdf", content: [{ type: "file", filename: "r.pdf", mimeType: "application/pdf", data: "JVBERi0=" }] },
    ],
  });
  assert.deepEqual(payload, {
    typed: "خلاصه کن",
    text: "خلاصه کن",
    images: [{ mimeType: "image/png", data: "AAAA" }],
    files: [{ name: "r.pdf", mimeType: "application/pdf", data: "JVBERi0=" }],
  });
  const fileOnly = attachmentPayload({ content: [], attachments: [{ name: "n.md", content: [{ type: "file", filename: "n.md", data: "eA==" }] }] });
  assert.equal(fileOnly.text, "این فایل را ببین.");
  assert.equal(fileOnly.files[0].mimeType, "text/markdown");
  assert.deepEqual(filesShown(fileOnly.files), [{ name: "n.md", mimeType: "text/markdown", bytes: 3 }]);
});

test("a message on its way shows its files' names, and the thread shows them under the owner's message", () => {
  const merged = mergeOutbox([], [{ clientId: "c1", chatId: "x", text: "t", files: [{ name: "r.pdf", bytes: 10 }], state: "sending", intent: "send" }]);
  assert.deepEqual(merged[0].files, [{ name: "r.pdf", bytes: 10 }]);
  const runtime = fs.readFileSync(new URL("../src/runtime.jsx", import.meta.url), "utf8");
  assert.match(runtime, /new CompositeAttachmentAdapter\(\[new SimpleImageAttachmentAdapter\(\), new FileAttachmentAdapter\(\)\]\)/);
  assert.match(runtime, /adapters: \{ attachments: attachmentAdapter \}/);
  assert.match(runtime, /files: message\.files \|\| null/);
  const thread = fs.readFileSync(new URL("../src/components/Thread.jsx", import.meta.url), "utf8");
  assert.equal((thread.match(/<ComposerPrimitive\.Attachments components=\{\{ Attachment: ComposerAttachment \}\} \/>/g) || []).length, 2, "both composers (both skins)");
  assert.match(thread, /custom\?\.files\?\.length \? <SentFiles files=\{custom\.files\} \/>/);
  assert.match(thread, /useAuiEvent\("composer\.attachmentAddError"/);
});

test("a file dropped anywhere on the chat is attached; a dragged text or link is not a drop", () => {
  assert.equal(dragHasFiles({ types: ["Files"] }), true);
  assert.equal(dragHasFiles({ types: ["text/plain", "text/uri-list"] }), false);
  assert.equal(dragHasFiles(null), false);
  const thread = fs.readFileSync(new URL("../src/components/Thread.jsx", import.meta.url), "utf8");
  assert.match(thread, /data-griffin-chat=""/);
  assert.match(thread, /zone\.addEventListener\("drop", onDrop\)/);
  assert.match(thread, /aui\.composer\(\)\.addAttachment\(file\)/);
});
