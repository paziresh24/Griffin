import assert from "node:assert/strict";
import { it } from "node:test";
import { mediaImages, mediaLabel } from "../src/integrations/telegram-account.mjs";

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
