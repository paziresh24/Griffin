import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccountTools, memoryGroupLog } from "../src/integrations/telegram-account.mjs";
import { FORWARDING_TOOLS, lastHop, thirdPartyKey } from "../src/related.mjs";
import { allowedTools } from "../src/agents/registry.mjs";
import { PEER_NEVER_TOOLS } from "../src/agents/profiles.mjs";
import { approvalQuestion } from "../src/guard.mjs";

// Owner 2026-11-15: «از همان ابزار تلگرام بخواه که گروه را بسازد» — a group made with his own account,
// through the one live client (a second session on the same key kills his session).
class Req {
  constructor(args) {
    Object.assign(this, args);
  }
}
const fakeApi = {
  channels: {
    CreateChannel: class CreateChannel extends Req {},
    InviteToChannel: class InviteToChannel extends Req {},
  },
};

function fakeClient({ missing = [], unknown = [], noChannel = false, api = fakeApi } = {}) {
  const calls = [];
  const channel = { className: "Channel", id: 2345678901n, accessHash: 9n, title: "میزان" };
  return {
    calls,
    channel,
    getInputEntity: async (who) => {
      if (unknown.includes(who)) throw new Error(`Cannot find any entity corresponding to "${who}"`);
      return { className: "InputPeerUser", userId: who.length, who };
    },
    invoke: async (req) => {
      calls.push(req);
      if (req instanceof api.channels.CreateChannel) return noChannel ? { chats: [{ className: "ChatForbidden", id: 5n }], users: [] } : { chats: [{ className: "User", id: 1n }, channel], users: [] };
      if (req instanceof api.channels.InviteToChannel) {
        const who = req.users[0].who;
        return { updates: {}, missingInvitees: missing.includes(who) ? [{ userId: who.length }] : [] };
      }
      throw new Error("unexpected request");
    },
  };
}

const parse = (r) => JSON.parse(r.content[0].text);
const toolsFor = (client, extra = {}) => createAccountTools({ getClient: () => client, loadApi: async () => fakeApi, groupLog: memoryGroupLog(), ...extra });
const creates = (client) => client.calls.filter((r) => r instanceof fakeApi.channels.CreateChannel).length;

test("telegram_create_group makes a megagroup with the live client and returns its Bot API id", async () => {
  const client = fakeClient();
  const tools = toolsFor(client);
  assert.ok(tools.telegram_create_group, "tool exists");
  const out = parse(await tools.telegram_create_group.execute({ title: "میزان", about: "گزارش‌ها", members: ["@khesht_bot", "someone"] }));
  const create = client.calls[0];
  assert.ok(create instanceof fakeApi.channels.CreateChannel);
  assert.equal(create.megagroup, true);
  assert.equal(create.title, "میزان");
  assert.equal(create.about, "گزارش‌ها");
  const invites = client.calls.slice(1);
  assert.equal(invites.length, 2);
  assert.ok(invites.every((r) => r instanceof fakeApi.channels.InviteToChannel && r.channel === client.channel));
  assert.deepEqual(invites.map((r) => r.users[0].who), ["@khesht_bot", "someone"]);
  assert.equal(out.created, true);
  assert.equal(out.chatId, "-1002345678901");
  assert.deepEqual(out.added, ["@khesht_bot", "someone"]);
  assert.deepEqual(out.failed, []);
});

test("telegram_create_group reports members it could not add, and still returns the group", async () => {
  const client = fakeClient({ missing: ["private_person"], unknown: ["@nobody_here"] });
  const out = parse(await toolsFor(client).telegram_create_group.execute({ title: "t", members: ["@nobody_here", "private_person", "@ok_bot"] }));
  assert.equal(out.chatId, "-1002345678901");
  assert.deepEqual(out.added, ["@ok_bot"]);
  assert.deepEqual(out.failed.map((f) => f.member), ["@nobody_here", "private_person"]);
  assert.match(out.failed[1].error, /could not be invited/i);
});

test("telegram_create_group refuses without a connected account and without a title", async () => {
  const none = createAccountTools({ getClient: () => null, loadApi: async () => fakeApi, groupLog: memoryGroupLog() });
  assert.equal((await none.telegram_create_group.execute({ title: "x" })).isError, true);
  const client = fakeClient();
  const r2 = await toolsFor(client).telegram_create_group.execute({ title: "   " });
  assert.equal(r2.isError, true);
  assert.equal(client.calls.length, 0);
});

test("telegram_create_group validates its input in code (some providers ignore schema limits)", async () => {
  const client = fakeClient();
  const tool = toolsFor(client).telegram_create_group;
  const bad = [
    { title: "a", members: "@one_bot" }, // a string, not a list
    { title: "a", members: Array.from({ length: 21 }, (_, i) => `@user_${i}x`) },
    { title: "a", members: ["@ok_bot", "not a username"] },
    { title: "a", members: ["@ab"] }, // too short
    { title: "a", members: ["@9starts_digit"] },
    { title: "x".repeat(129) },
    { title: "a", about: "y".repeat(256) },
    { title: "a", members: [42] },
  ];
  for (const args of bad) {
    const r = await tool.execute(args);
    assert.equal(r.isError, true, JSON.stringify(args).slice(0, 80));
  }
  assert.equal(client.calls.length, 0);
  // Trimmed and de-duplicated (with or without @, any case): one invite.
  const out = parse(await tool.execute({ title: "  dedupe  ", members: [" @Ok_bot ", "ok_bot", "@OK_BOT"] }));
  assert.equal(out.title, "dedupe");
  assert.deepEqual(out.added, ["@Ok_bot"]);
  assert.equal(client.calls.length, 2);
});

test("the same title twice within a day returns the first group, without a second CreateChannel", async () => {
  const client = fakeClient();
  const tool = toolsFor(client).telegram_create_group;
  const first = parse(await tool.execute({ title: "میزان", members: ["@ok_bot"] }));
  const second = parse(await tool.execute({ title: " میزان ", members: ["@ok_bot"] }));
  assert.equal(creates(client), 1);
  assert.equal(second.created, false);
  assert.equal(second.chatId, first.chatId);
});

test("the same title after 24h is a new group; the log is shared across tool sets of one install", async () => {
  let now = Date.parse("2026-11-15T10:00:00Z");
  const log = memoryGroupLog();
  const client = fakeClient();
  const make = () => createAccountTools({ getClient: () => client, loadApi: async () => fakeApi, groupLog: log, now: () => now }).telegram_create_group;
  await make().execute({ title: "g" });
  await make().execute({ title: "g" }); // another chat's tool set: still the same group
  assert.equal(creates(client), 1);
  now += 25 * 3600_000;
  await make().execute({ title: "g" });
  assert.equal(creates(client), 2);
});

test("at most 3 groups an hour per install", async () => {
  let now = Date.parse("2026-11-15T10:00:00Z");
  const client = fakeClient();
  const tool = toolsFor(client, { now: () => now }).telegram_create_group;
  for (const t of ["a", "b", "c"]) assert.equal(parse(await tool.execute({ title: t })).created, true);
  const fourth = await tool.execute({ title: "d" });
  assert.equal(fourth.isError, true);
  assert.match(parse(fourth).error, /3 groups/);
  assert.equal(creates(client), 3);
  now += 61 * 60_000;
  assert.equal(parse(await tool.execute({ title: "d" })).created, true);
});

test("an unattended run (a scheduled job) cannot create a group", async () => {
  const client = fakeClient();
  const r = await toolsFor(client, { unattended: () => true }).telegram_create_group.execute({ title: "x" });
  assert.equal(r.isError, true);
  assert.equal(client.calls.length, 0);
});

test("no channel in Telegram's answer is a soft result, and a retry does not make a duplicate", async () => {
  const client = fakeClient({ noChannel: true });
  const tool = toolsFor(client).telegram_create_group;
  const r = await tool.execute({ title: "maybe", members: ["@ok_bot"] });
  assert.notEqual(r.isError, true);
  const out = parse(r);
  assert.equal(out.chatId, null);
  assert.match(out.note, /telegram_dialogs/);
  await tool.execute({ title: "maybe" });
  assert.equal(creates(client), 1);
});

// Re-review of !495: the record is written before CreateChannel, so a lost reply or a second
// concurrent call never makes a duplicate; only Telegram's own refusal takes the entry back.
function flakyClient(errors = []) {
  const client = fakeClient();
  const invoke = client.invoke;
  client.invoke = async (req) => {
    await new Promise((r) => setImmediate(r)); // a real round trip: other calls run meanwhile
    if (req instanceof fakeApi.channels.CreateChannel && errors.length) {
      client.calls.push(req);
      throw errors.shift();
    }
    return invoke(req);
  };
  return client;
}
const telegramRefusal = (message, code) => Object.assign(new Error(`${code}: ${message}`), { errorMessage: message, code });

test("two concurrent calls with the same title make one group", async () => {
  const client = flakyClient();
  const tool = toolsFor(client).telegram_create_group;
  const [a, b] = (await Promise.all([tool.execute({ title: "هم‌زمان" }), tool.execute({ title: "هم‌زمان" })])).map(parse);
  assert.equal(creates(client), 1);
  assert.equal([a, b].filter((r) => r.created === true).length, 1);
  const other = [a, b].find((r) => r.created !== true);
  assert.match(other.note, /telegram_dialogs/);
});

test("a lost reply (not Telegram's refusal) keeps the record: a retry does not create again", async () => {
  const client = flakyClient([new Error("Maximum reconnection retries")]);
  const tool = toolsFor(client).telegram_create_group;
  const first = await tool.execute({ title: "lost" });
  assert.equal(first.isError, true);
  const retry = parse(await tool.execute({ title: "lost" }));
  assert.equal(creates(client), 1);
  assert.equal(retry.chatId, null);
  assert.match(retry.note, /telegram_dialogs/);
});

test("Telegram's own refusal takes the record back: same title can be tried again, the hourly cap is not used", async () => {
  const client = flakyClient([telegramRefusal("FLOOD_WAIT", 420), telegramRefusal("CHANNELS_TOO_MUCH", 400), telegramRefusal("CHAT_TITLE_EMPTY", 400)]);
  const tool = toolsFor(client).telegram_create_group;
  for (let i = 0; i < 3; i++) assert.equal((await tool.execute({ title: "refused" })).isError, true);
  assert.equal(creates(client), 3);
  for (const t of ["refused", "b", "c"]) assert.equal(parse(await tool.execute({ title: t })).created, true);
  assert.equal(creates(client), 6);
});

test("a chat holding a colleague's text cannot create a group (last hop)", async () => {
  assert.ok(FORWARDING_TOOLS.includes("telegram_create_group"));
  const kv = new Map();
  const store = { getKv: (k) => kv.get(k), setKv: (k, v) => kv.set(k, v) };
  const client = fakeClient();
  const wrapped = lastHop(toolsFor(client), { store, chatId: "c1" });
  assert.equal(parse(await wrapped.telegram_create_group.execute({ title: "before" })).created, true);
  kv.set(thirdPartyKey("c1"), { from: "peer:acme" });
  const refused = await wrapped.telegram_create_group.execute({ title: "after" });
  assert.equal(refused.isError, true);
  assert.equal(creates(client), 1);
});

test("a colleague's chain never gets the tool (team quota, peer callers)", () => {
  const names = ["telegram_send", "telegram_create_group", "kube_get"];
  assert.ok(!allowedTools("griffin", "team", names).includes("telegram_create_group"));
  assert.ok(PEER_NEVER_TOOLS.includes("telegram_create_group"));
});

test("an approval card for the tool names the group and who will be added", () => {
  const q = approvalQuestion(null, "c1", "telegram_create_group", { title: "میزان", members: ["@examplebot", "@someone"] }, "ساخت گروه تلگرام");
  assert.match(q, /میزان/);
  assert.match(q, /@examplebot/);
  assert.match(q, /@someone/);
});

test("the requests are real gramjs requests that serialize offline", async () => {
  const { Api } = await import("telegram");
  const utils = await import("telegram/Utils.js");
  const bigInt = (await import("big-integer")).default;
  const channel = new Api.Channel({ id: bigInt(2345678901), accessHash: bigInt(77), title: "میزان", photo: new Api.ChatPhotoEmpty(), date: 0 });
  const sent = [];
  const client = {
    // Like the real client: a username resolves to the user, an entity object to its input peer
    // (gramjs resolve() passes the channel through here too).
    getInputEntity: async (x) => (typeof x === "string" ? new Api.InputPeerUser({ userId: bigInt(42), accessHash: bigInt(7) }) : utils.getInputPeer(x)),
    invoke: async (req) => {
      if (req.resolve) await req.resolve(client, utils);
      sent.push(req);
      assert.ok(req.getBytes().length > 8);
      if (req instanceof Api.channels.CreateChannel) return new Api.Updates({ updates: [], users: [], chats: [channel], date: 0, seq: 0 });
      return new Api.messages.InvitedUsers({ updates: new Api.Updates({ updates: [], users: [], chats: [], date: 0, seq: 0 }), missingInvitees: [] });
    },
  };
  const tools = createAccountTools({ getClient: () => client, groupLog: memoryGroupLog() });
  const out = parse(await tools.telegram_create_group.execute({ title: "میزان", members: ["@examplebot"] }));
  assert.equal(out.chatId, "-1002345678901");
  assert.deepEqual(out.added, ["@examplebot"]);
  assert.equal(sent[0].megagroup, true);
  assert.equal(sent[1].channel.className, "InputChannel");
  assert.equal(sent[1].users[0].className, "InputUser");
});
