import test from "node:test";
import assert from "node:assert/strict";
import { decideSend, isAgentPerson, matchNetworkAgent, nameTokens, routeFor } from "../src/network-first.mjs";

// Owner 2026-10-20: colleagues' agents wrote to the owner on Telegram and the assistant answered them there.
// Agents talk to agents on the network; Telegram is for people.

const karimiBot = { external_id: "10000001", name: "ابوالفضل کریمی", display_name: "Abolfazl Karimi BOT", username: "akarimibot", access: { peerAgent: { user: "akarimibot" } } };
const karimiAgent = { id: "griffin-karimi-example-org", owner: "ابوالفضل کریمی", connected: true };

test("names compare by their tokens: ي/ك, ZWNJ and titles do not matter", () => {
  assert.deepEqual(nameTokens("آقای ابوالفضل کریمی (ربات)"), ["ابوالفضل", "کریمی"]);
  assert.deepEqual(nameTokens("كيوان‌پور"), ["کیوان", "پور"]);
});

test("an assistant that signed, or a bot, is an agent; a human, a group and a channel are not", () => {
  assert.equal(isAgentPerson(karimiBot), true);
  assert.equal(isAgentPerson({ external_id: "9", name: "x", username: "some_bot" }), true);
  assert.equal(isAgentPerson({ external_id: "9", name: "امیرحسین توکلی", username: "Amir_hossein_tavakoli" }), false);
  assert.equal(isAgentPerson({ external_id: "-1001", name: "گروه ربات‌ها", display_name: "ربات ها" }), false);
  assert.equal(isAgentPerson({ external_id: "55", name: "کانال", meta: { chatType: "channel" }, access: { peerAgent: { user: "z" } } }), false);
});

test("the agent of a colleague is found by the owner's name, or by an explicit id", () => {
  assert.equal(matchNetworkAgent(karimiBot, [karimiAgent])?.id, karimiAgent.id);
  // Two tokens of the owner's name must both be there, and the match must be unique.
  assert.equal(matchNetworkAgent({ ...karimiBot, name: "کریمی", display_name: "Karimi" }, [karimiAgent]), null);
  assert.equal(matchNetworkAgent(karimiBot, [karimiAgent, { ...karimiAgent, id: "other" }]), null);
  assert.equal(matchNetworkAgent({ ...karimiBot, access: { networkAgent: "other" } }, [karimiAgent, { ...karimiAgent, id: "other" }])?.id, "other");
  assert.equal(matchNetworkAgent(karimiBot, [{ ...karimiAgent, connected: false }]), null);
});

test("routes: a human goes to Telegram, a known agent to the network, an unknown signed agent is stopped", () => {
  assert.deepEqual(routeFor({ external_id: "1", name: "امیرحسین توکلی" }, [karimiAgent]), { route: "telegram" });
  assert.equal(routeFor(karimiBot, [karimiAgent]).route, "network");
  assert.equal(routeFor(karimiBot, []).route, "none");
  // A bot nobody's assistant (never signed) with no match is not held: it is just a bot.
  assert.equal(routeFor({ external_id: "9", name: "x", username: "foxy_bot" }, []).route, "telegram");
});

test("decideSend: the network first; Telegram for an agent only with a stated reason", () => {
  assert.equal(decideSend({ person: karimiBot, agents: [karimiAgent] }).go, "network");
  const blocked = decideSend({ person: karimiBot, agents: [], name: "کریمی" });
  assert.equal(blocked.go, "blocked");
  assert.match(blocked.result.error, /network_connect/);
  assert.equal(blocked.result.sent, false);
  assert.equal(decideSend({ person: karimiBot, agents: [], because: "ok" }).go, "blocked", "a one-word reason is none");
  const allowed = decideSend({ person: karimiBot, agents: [], because: "network_agents has no install under his name; network_connect found none" });
  assert.equal(allowed.go, "telegram");
  assert.ok(allowed.because);
  assert.equal(decideSend({ person: null, agents: [] }).go, "telegram");
});

// The owner's own chats send with the raw tool: it passes through the same decision.
import { createAccountTools } from "../src/integrations/telegram-account.mjs";

test("telegram_send to a colleague's agent goes over the network; to a human it goes as before", async () => {
  const sentTo = [];
  const client = {
    getEntity: async (id) => ({ id: BigInt(id) }),
    getDialogs: async () => [],
    getPeerId: async (entity) => String(entity.id),
    sendMessage: async (entity, { message }) => (sentTo.push([String(entity.id), message]), { id: 5 }),
  };
  const people = { 10000001: karimiBot, 10000002: { external_id: "10000002", name: "امیرحسین توکلی" } };
  const said = [];
  const tools = createAccountTools({
    getClient: () => client,
    networkFirst: async ({ peer, text, because, title }) => {
      const d = decideSend({ person: people[peer] || null, agents: [karimiAgent], because, name: title });
      if (d.go === "blocked") return d.result;
      if (d.go !== "network") return null;
      said.push([d.agent.id, text]);
      return { sent: true, via: "network", agent: d.agent.id };
    },
  });
  const parse = (r) => JSON.parse(r.content[0].text);
  const toBot = parse(await tools.telegram_send.execute({ chat: "10000001", text: "ضبط‌ها را دوباره می‌فرستم" }));
  assert.deepEqual([toBot.sent, toBot.via], [true, "network"]);
  assert.deepEqual(said, [[karimiAgent.id, "ضبط‌ها را دوباره می‌فرستم"]]);
  assert.deepEqual(sentTo, [], "nothing went to the bot's Telegram");
  const toHuman = parse(await tools.telegram_send.execute({ chat: "10000002", text: "سلام آقای توکلی" }));
  assert.equal(toHuman.sent, true);
  assert.deepEqual(sentTo, [["10000002", "سلام آقای توکلی"]]);
});
