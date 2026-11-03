// Files in the message box: any file is attached next to pictures, sent as `files`,
// refused in Persian when the server would refuse it (empty, over 50 MB), and shown by name in the thread.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FILE_TYPES, FileAttachmentAdapter, attachmentPayload, countProblem, createUploads, dragHasFiles, fileMime, fileProblem, filesShown, fitSize, imageRoute, isAttachableFile, ImageAttachmentAdapter, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_PDF_BYTES, overLimit, PIECE_BYTES, sendPieces } from "../src/attachments.js";
import { mergeOutbox } from "../src/outbox.js";

// A server that stores pieces in order; fail(offset) may make one piece's call go wrong.
function fakeServer(fail = () => null) {
  const bytes = { length: 0 };
  const calls = { removed: [] };
  const talk = {
    start: async () => ({ id: "up1" }),
    put: async (id, offset, piece) => {
      const problem = fail(offset);
      if (problem) throw problem;
      if (offset !== bytes.length) throw Object.assign(new Error("409"), { status: 409, body: { received: bytes.length } });
      bytes.length += (await piece.arrayBuffer()).byteLength;
      return { received: bytes.length };
    },
    remove: async (id) => calls.removed.push(id),
  };
  return { talk, bytes, calls };
}
async function last(steps) {
  let out;
  for await (const step of steps) out = step;
  return out;
}

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
  assert.match(countProblem({ images: Array(MAX_IMAGES + 1).fill(1) }), /حداکثر ۲۰ تصویر/);
  assert.equal(countProblem({ images: Array(MAX_IMAGES).fill(1) }), null);
});

test("attachments over a message's limits are the newest ones, picked out as soon as they are added", () => {
  const file = (id) => ({ id, type: "document", contentType: "application/pdf" });
  const image = (id) => ({ id, type: "image", contentType: "image/png" });
  assert.deepEqual(overLimit([file("f1"), image("i1"), file("f2"), file("f3"), file("f4")]), []);
  assert.deepEqual(overLimit([file("f1"), file("f2"), file("f3"), image("i1"), file("f4"), file("f5"), file("f6")]), ["f5", "f6"]);
  const pictures = Array.from({ length: MAX_IMAGES + 1 }, (_, i) => image(String(i)));
  assert.deepEqual(overLimit(pictures.slice(0, MAX_IMAGES)), []);
  assert.deepEqual(overLimit(pictures), [String(MAX_IMAGES)]);
  // A message's files together: 80 MB, checked before sending (a refused send loses them).
  const doc = (id, mb) => ({ id, type: "document", contentType: "application/zip", file: { size: mb * 1024 * 1024 } });
  assert.deepEqual(overLimit([doc("a", 9), doc("b", 9)]), [], "two 9 MB files fit");
  assert.deepEqual(overLimit([doc("a", 40), doc("b", 30), doc("c", 20)]), ["c"]);
  assert.deepEqual(overLimit([doc("a", 40), doc("b", 30), doc("c", 20), doc("d", 5)]), ["c"], "a smaller one after the refused one still fits");
  assert.match(countProblem({ files: [{ mimeType: "application/pdf", bytes: 90 * 1024 * 1024 }] }), /روی هم حداکثر ۸۰/);
  assert.equal(countProblem({ files: [{ mimeType: "application/pdf", bytes: 17 * 1024 * 1024 }] }), null);
  const thread = fs.readFileSync(new URL("../src/components/Thread.jsx", import.meta.url), "utf8");
  assert.match(thread, /const extra = overLimit\(attachedItems \|\| \[\]\);/);
  assert.match(thread, /aui\.composer\(\)\.attachment\(\{ id \}\)\.remove\(\)/);
});

test("the composer's message becomes text, and images and files by their upload id", () => {
  const payload = attachmentPayload({
    content: [{ type: "text", text: " خلاصه کن " }],
    attachments: [
      { name: "p.png", content: [{ type: "image", image: "", filename: "p.png", mimeType: "image/png", uploadId: "u1", bytes: 4 }] },
      { name: "r.pdf", content: [{ type: "file", filename: "r.pdf", mimeType: "application/pdf", uploadId: "u2", bytes: 5 }] },
    ],
  });
  assert.deepEqual(payload, {
    typed: "خلاصه کن",
    text: "خلاصه کن",
    images: [{ uploadId: "u1", name: "p.png", mimeType: "image/png", bytes: 4 }],
    files: [{ uploadId: "u2", name: "r.pdf", mimeType: "application/pdf", bytes: 5 }],
  });
  const fileOnly = attachmentPayload({ content: [], attachments: [{ name: "n.md", content: [{ type: "file", filename: "n.md", mimeType: "text/markdown", uploadId: "u3", bytes: 3 }] }] });
  assert.equal(fileOnly.text, "این فایل را ببین.");
  assert.deepEqual(filesShown(fileOnly.files), [{ name: "n.md", mimeType: "text/markdown", bytes: 3 }]);
});

test("a message on its way shows its files' names, and the thread shows them under the owner's message", () => {
  const merged = mergeOutbox([], [{ clientId: "c1", chatId: "x", text: "t", files: [{ name: "r.pdf", bytes: 10 }], state: "sending", intent: "send" }]);
  assert.deepEqual(merged[0].files, [{ name: "r.pdf", bytes: 10 }]);
  const runtime = fs.readFileSync(new URL("../src/runtime.jsx", import.meta.url), "utf8");
  assert.match(runtime, /new CompositeAttachmentAdapter\(\[new ImageAttachmentAdapter\(uploads\), new FileAttachmentAdapter\(uploads\)\]\)/);
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
  // Where no canvas can shrink it (here, Node), the picture goes as it is: never refused, never lost.
  const { talk } = fakeServer();
  const adapter = new ImageAttachmentAdapter(createUploads(talk));
  const big = new File([Buffer.alloc(MAX_IMAGE_BYTES + 10, 1)], "photo.jpg", { type: "image/jpeg" });
  const sent = await adapter.send(await last(adapter.add({ file: big })));
  assert.equal(sent.content[0].type, "image");
  assert.equal(sent.content[0].mimeType, "image/jpeg");
  const payload = attachmentPayload({ content: [], attachments: [sent] });
  assert.equal(payload.images[0].name, "photo.jpg");
  assert.equal(payload.images[0].bytes, MAX_IMAGE_BYTES + 10);
  await assert.rejects(last(adapter.add({ file: { name: "huge.png", type: "image/png", size: MAX_FILE_BYTES + 1 } })), /۵۰ مگابایت/);
});

test("a file goes in pieces: the percent is what the server confirmed, and a lost piece goes again", async () => {
  const size = PIECE_BYTES * 2 + 10;
  let lost = 0;
  const { talk, bytes } = fakeServer((offset) => (offset === PIECE_BYTES && lost++ < 2 ? new TypeError("Failed to fetch") : null));
  const seen = [];
  const pieces = sendPieces(new Blob([Buffer.alloc(size, 7)]), { name: "a.zip", mimeType: "application/zip" }, talk, undefined, async () => {});
  let step = await pieces.next();
  while (!step.done) {
    seen.push(step.value);
    step = await pieces.next();
  }
  assert.equal(step.value, "up1");
  assert.equal(bytes.length, size);
  assert.deepEqual(seen, [49, 99, 100]);
  assert.equal(lost, 3);
});

test("after a piece stored but unanswered, the server's 409 says where to go on from", async () => {
  const { talk, bytes } = fakeServer();
  const put = talk.put;
  let first = true;
  talk.put = async (...args) => {
    const out = await put(...args);
    if (first) {
      first = false;
      throw new TypeError("Failed to fetch");
    }
    return out;
  };
  await last(sendPieces(new Blob([Buffer.alloc(PIECE_BYTES + 5, 1)]), { name: "a", mimeType: "" }, talk, undefined, async () => {}));
  assert.equal(bytes.length, PIECE_BYTES + 5, "no piece is stored twice");
});

test("a refused piece stops the upload at once; the network gets a few tries", async () => {
  const refused = fakeServer(() => Object.assign(new Error("413"), { status: 413 }));
  await assert.rejects(last(sendPieces(new Blob(["x"]), { name: "a", mimeType: "" }, refused.talk, undefined, async () => {})), /413/);
  const gone = fakeServer(() => new TypeError("Failed to fetch"));
  await assert.rejects(last(sendPieces(new Blob(["x"]), { name: "a", mimeType: "" }, gone.talk, undefined, async () => {})), /Failed to fetch/);
});

test("the chip shows before anything is sent, the message waits for it, and a removed file leaves the server", async () => {
  const { talk, calls } = fakeServer();
  const uploads = createUploads(talk);
  const adapter = new FileAttachmentAdapter(uploads);
  const steps = adapter.add({ file: new File([Buffer.alloc(PIECE_BYTES + 1, 1)], "r.zip", { type: "application/zip" }) });
  const first = (await steps.next()).value;
  assert.deepEqual([first.status.type, first.status.progress, first.name], ["running", 0, "r.zip"]);
  assert.equal(uploads.busy(), true, "the message cannot go yet");
  let done = first;
  for await (const step of steps) done = step;
  assert.equal(done.status.type, "requires-action");
  assert.equal(uploads.busy(), false);
  const sent = await adapter.send(done);
  assert.deepEqual([sent.status.type, sent.content[0].uploadId, sent.content[0].bytes], ["complete", "up1", PIECE_BYTES + 1]);

  const taken = adapter.add({ file: new File(["x"], "s.txt") });
  const kept = await last(taken);
  await adapter.remove(kept);
  assert.deepEqual(calls.removed, ["up1"]);
  assert.equal(uploads.busy(), false);
});

test("a failed upload says so and holds the message until it is removed", async () => {
  const uploads = createUploads(fakeServer(() => Object.assign(new Error("500"), { status: 400 })).talk);
  const adapter = new FileAttachmentAdapter(uploads);
  await assert.rejects(last(adapter.add({ file: new File(["x"], "bad.zip") })), /«bad\.zip» آپلود نشد/);
  assert.equal(uploads.busy(), true);
  uploads.stop();
  assert.equal(uploads.busy(), false);
});
