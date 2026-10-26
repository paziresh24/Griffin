// Files in the message box: any file is attached next to pictures, sent as `files`,
// refused in Persian when the server would refuse it (empty, over 50 MB), and shown by name in the thread.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FILE_TYPES, attachmentPayload, countProblem, dragHasFiles, fileMime, fileProblem, filesShown, fitSize, imageRoute, isAttachableFile, ImageAttachmentAdapter, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_PDF_BYTES, overLimit } from "../src/attachments.js";
import { mergeOutbox } from "../src/outbox.js";

test("a file's type comes from its extension first (empty .md, Windows .csv)", () => {
  assert.equal(fileMime({ name: "notes.md", type: "" }), "text/markdown");
  assert.equal(fileMime({ name: "data.CSV", type: "application/vnd.ms-excel" }), "text/csv");
  assert.equal(fileMime({ name: "a.pdf", type: "" }), "application/pdf");
  assert.equal(fileMime({ name: "x", type: "image/png" }), "image/png");
  assert.equal(isAttachableFile("application/yaml"), true);
  assert.equal(isAttachableFile("application/zip"), false);
});

test("any file up to 50 MB is taken; an empty or bigger one is refused with the reason in Persian", () => {
  assert.equal(fileProblem({ name: "a.pdf", size: 10, type: "application/pdf" }), null);
  assert.match(fileProblem({ name: "a.pdf", size: 0 }), /خالی است/);
  assert.equal(MAX_FILE_BYTES, 50 * 1024 * 1024);
  assert.match(fileProblem({ name: "a.pdf", size: MAX_FILE_BYTES + 1 }), /بزرگ‌تر از ۵۰ مگابایت/);
  // Mr. Nouri, 2026-10-23: a 9 MB file was refused at 5 MB; the server now keeps it for the agent.
  assert.equal(fileProblem({ name: "big.pdf", size: 9 * 1024 * 1024, type: "application/pdf" }), null);
  assert.equal(fileProblem({ name: "big.pdf", size: MAX_PDF_BYTES + 1 }), null);
  assert.equal(fileProblem({ name: "a.zip", size: 5, type: "application/zip" }), null);
  assert.equal(fileProblem({ name: "sheet.xlsx", size: 20 * 1024 * 1024, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), null);
  assert.equal(FILE_TYPES, "*", "the picker offers every file");
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
  // A message's files together: 80 MB, checked before sending (a refused send loses them).
  const doc = (id, mb) => ({ id, type: "document", contentType: "application/zip", file: { size: mb * 1024 * 1024 } });
  assert.deepEqual(overLimit([doc("a", 9), doc("b", 9)]), [], "two 9 MB files fit");
  assert.deepEqual(overLimit([doc("a", 40), doc("b", 30), doc("c", 20)]), ["c"]);
  assert.deepEqual(overLimit([doc("a", 40), doc("b", 30), doc("c", 20), doc("d", 5)]), ["c"], "a smaller one after the refused one still fits");
  assert.match(countProblem({ files: [{ mimeType: "application/pdf", data: "A".repeat(110 * 1024 * 1024) }] }), /روی هم حداکثر ۸۰/);
  assert.equal(countProblem({ files: [{ mimeType: "application/pdf", data: "A".repeat(17 * 1024 * 1024) }] }), null);
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
  assert.match(runtime, /new CompositeAttachmentAdapter\(\[new ImageAttachmentAdapter\(\), new FileAttachmentAdapter\(\)\]\)/);
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

test("a picture Claude cannot take inline is shrunk, or sent as a file the server keeps", async () => {
  assert.equal(imageRoute({ type: "image/png", size: 1000 }), "image");
  assert.equal(imageRoute({ type: "image/jpeg", size: MAX_IMAGE_BYTES + 1 }), "shrink");
  assert.equal(imageRoute({ type: "image/gif", size: MAX_IMAGE_BYTES + 1 }), "file", "an animated GIF is not flattened");
  assert.equal(imageRoute({ type: "image/heic", size: 1000 }), "file");
  assert.deepEqual(fitSize(8000, 6000, 2560), { width: 2560, height: 1920 });
  assert.deepEqual(fitSize(800, 600, 2560), { width: 800, height: 600 }, "never enlarged");
  // Where no canvas can shrink it (here, Node), the picture goes as a file: never refused, never lost.
  globalThis.FileReader ??= class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload();
      });
    }
  };
  const adapter = new ImageAttachmentAdapter();
  const big = new File([Buffer.alloc(MAX_IMAGE_BYTES + 10, 1)], "photo.jpg", { type: "image/jpeg" });
  const sent = await adapter.send(await adapter.add({ file: big }));
  assert.equal(sent.content[0].type, "file");
  assert.equal(sent.content[0].mimeType, "image/jpeg");
  const payload = attachmentPayload({ content: [], attachments: [sent] });
  assert.equal(payload.images.length, 0);
  assert.equal(payload.files[0].name, "photo.jpg");
  const small = new File([Buffer.from("png")], "s.png", { type: "image/png" });
  const sentSmall = await adapter.send(await adapter.add({ file: small }));
  assert.match(sentSmall.content[0].image, /^data:image\/png;base64,/);
  await assert.rejects(adapter.add({ file: { name: "huge.png", type: "image/png", size: MAX_FILE_BYTES + 1 } }), /۵۰ مگابایت/);
});
