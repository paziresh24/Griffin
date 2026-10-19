import assert from "node:assert/strict";
import { it } from "node:test";
import { mediaFiles, mediaImages, mediaLabel } from "../src/integrations/telegram-account.mjs";

it("takes a text file or PDF a colleague sent as an attachment, and nothing else", async () => {
  const client = { downloadMedia: async () => Buffer.from("خطا در ساخت\nline 2") };
  const text = { media: {}, document: { mimeType: "text/plain", size: 20, attributes: [{ fileName: "log.txt" }] } };
  const [file] = await mediaFiles(client, text);
  assert.equal(file.name, "log.txt");
  assert.equal(Buffer.from(file.data, "base64").toString("utf8"), "خطا در ساخت\nline 2");
  assert.deepEqual(await mediaFiles(client, { media: {}, document: { mimeType: "application/zip", size: 20 } }), []);
  assert.deepEqual(await mediaFiles(client, { media: {}, document: { mimeType: "text/plain", size: 50 * 1024 * 1024 } }), []);
  assert.deepEqual(await mediaFiles(client, { media: {}, photo: {} }), []);
  const fake = { media: {}, document: { mimeType: "application/pdf", size: 20 } };
  assert.deepEqual(await mediaFiles({ downloadMedia: async () => Buffer.from("not a pdf") }, fake), []);
});

it("labels media and turns photos / GIF previews into images", async () => {
  assert.equal(mediaLabel({ media: {}, gif: {} }), "[گیف]");
  assert.equal(mediaLabel({}), "");
  const calls = [];
  const client = { downloadMedia: async (_m, opts) => (calls.push(opts), Buffer.alloc(300, 1)) };
  assert.equal((await mediaImages(client, { media: {}, photo: {} }))[0].mimeType, "image/jpeg");
  const gif = { media: {}, gif: {}, document: { mimeType: "video/mp4", thumbs: [{}, {}] } };
  assert.equal((await mediaImages(client, gif)).length, 1);
  assert.deepEqual(calls[1], { thumb: 1 });
  assert.deepEqual(await mediaImages(client, { media: {}, document: { mimeType: "video/mp4", thumbs: [] } }), []);
});
