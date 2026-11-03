// A tool result the page came without (timeline-cache.mjs liteMessages) is fetched when its card
// opens: once per tab, unwrapped like any other, and asked again after a failed fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { loadLazyResult } from "../src/lazy-result.js";

test("a left-out tool result is fetched once, unwrapped, and asked again after a failure", async () => {
  const asked = [];
  let fail = true;
  const api = async (path) => {
    asked.push(path);
    if (fail) throw new Error("down");
    return { status: "success", result: { value: { content: [{ type: "text", text: JSON.stringify({ content: "file text", source: "gitlab api" }) }] } } };
  };
  const lazy = { chat: "c1", bytes: 20000 };
  await assert.rejects(loadLazyResult(api, lazy, "call:1"));
  fail = false;
  const first = await loadLazyResult(api, lazy, "call:1");
  assert.deepEqual(first, { result: { content: "file text", source: "gitlab api" }, isError: false });
  await loadLazyResult(api, lazy, "call:1");
  assert.deepEqual(asked, ["/api/chats/c1/tool-result?callId=call%3A1", "/api/chats/c1/tool-result?callId=call%3A1"]);
});

test("a left-out result that was an error shows as one", async () => {
  const api = async () => ({ status: "error", result: { status: "error", error: { message: "boom" } } });
  assert.deepEqual(await loadLazyResult(api, { chat: "c2", bytes: 9000 }, "x"), { result: { error: "boom" }, isError: true });
});
