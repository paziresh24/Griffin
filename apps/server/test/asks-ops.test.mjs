import assert from "node:assert/strict";
import { it } from "node:test";
import { createAsks } from "../src/asks.mjs";

it("ops room: its own question reaches the owner (scheduler roots are still refused)", async () => {
  const chats = { ops1: { id: "ops1", caller: "ops" }, job1: { id: "job1", caller: "scheduler" } };
  const events = [];
  const store = { getChat: (id) => chats[id], rootChatId: (id) => id, appendEvent: (id, run, type, data) => (events.push({ id, type, data }), { id: events.length }) };
  const asks = createAsks({ store, log: {} });
  const refused = JSON.parse((await asks.tool("job1").execute({ question: "؟" })).content[0].text);
  assert.equal(refused.answered, false);
  const pending = asks.tool("ops1").execute({ question: "فضای ذخیره‌سازی پر می‌شود؛ امشب اجرا شود؟" });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(events.some((e) => e.id === "ops1" && e.type === "ask.pending"));
  assert.equal(asks.answer("ops1", { answer: "بله" }), true);
  assert.equal(JSON.parse((await pending).content[0].text).answer, "بله");
});
