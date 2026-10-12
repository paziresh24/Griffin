import test from "node:test";
import assert from "node:assert/strict";
import { requesterKey, openWorkFor, relatedRules, createRelatedTool } from "../src/related.mjs";

// A colleague's agent asked over MCP; their Telegram bot then wrote about the same work.
function store() {
  const chats = [
    { id: "mcp", caller: "peer:alice", title: "خانم الف: زیرساخت تماس صوتی", updated_at: "t1" },
    { id: "tg", caller: "peer:alice", person_id: "bot", title: "🤖 خانم الف: ممنون از گزارشت", updated_at: "t2" },
    { id: "human", caller: "team", person_id: "alice-human", title: "🧵 alice", updated_at: "t0" },
    { id: "other", caller: "peer:bob", title: "باب", updated_at: "t3" },
    { id: "child", caller: "griffin", parent_chat_id: "mcp", title: "← sub", updated_at: "t4" },
    { id: "done", caller: "peer:alice", title: "old finished", updated_at: "t-1" },
  ];
  const persons = { bot: { access: { peerAgent: { user: "alice" } } }, "alice-human": { access: { peerAgent: { user: "alice" } } } };
  return {
    listChats: () => chats,
    getPerson: (id) => persons[id],
    linksForChat: (id) => (id === "tg" || id === "human" ? [{}] : []),
  };
}
const isOpen = (id) => id !== "done";

test("the same requester is one key across MCP and Telegram", () => {
  const s = store();
  assert.equal(requesterKey(s, s.listChats()[0]), "peer:alice");
  assert.equal(requesterKey(s, s.listChats()[1]), "peer:alice");
  assert.equal(requesterKey(s, s.listChats()[2]), "peer:alice");
  assert.equal(requesterKey(s, { caller: "owner" }), null);
});

test("a new Telegram chat sees only that requester's open root conversations", () => {
  const s = store();
  const open = openWorkFor(s, s.listChats()[1], { isOpen });
  assert.deepEqual(open.map((o) => o.id), ["mcp", "human"]);
  assert.equal(open[0].channel, "اتصال MCP ایجنت همکار");
  const rules = relatedRules(open, "تلگرام");
  assert.match(rules, /related_chat_send/);
  assert.match(rules, /chat mcp/);
});

test("the hand-over reaches the open chat with where it came from; other chats are refused", async () => {
  const s = store();
  const sent = [];
  const runner = { isActive: (id) => id === "mcp", send: async (id, msg) => { sent.push({ id, msg }); return { delivered: "steer" }; } };
  const open = openWorkFor(s, s.listChats()[1], { isOpen });
  const tool = createRelatedTool({ store: s, runner, chat: s.listChats()[1], open });
  const ok = await tool.execute({ chat: "mcp", text: "اصلاحات طراحی چی بود؟" });
  assert.match(ok.content[0].text, /"chat":"mcp"/);
  assert.equal(sent[0].msg.intent, "steer");
  assert.match(sent[0].msg.text, /از مسیر تلگرام/);
  assert.equal((await tool.execute({ chat: "other", text: "x" })).isError, true);
});
