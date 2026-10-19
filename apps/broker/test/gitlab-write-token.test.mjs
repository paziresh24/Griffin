import test from "node:test";
import assert from "node:assert/strict";
import { gitlabToken } from "../src/gitlab.mjs";

const vault = (items) => ({ async item(slug) { if (!(slug in items)) throw new Error(`no ${slug}`); return items[slug]; } });

test("writes use the owner's write token when the vault has one; reads keep the bot token", async () => {
  const v = vault({ gitlab__token: "bot\n", "gitlab__write-token": "owner\n" });
  assert.equal(await gitlabToken(v, false), "bot");
  assert.equal(await gitlabToken(v, true), "owner");
});

test("without a write token, writes fall back to the bot token", async () => {
  assert.equal(await gitlabToken(vault({ gitlab__token: "bot" }), true), "bot");
});
