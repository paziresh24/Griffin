import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionRows, ownAgents, recentChats } from "../src/mention-pick.js";

test("own agents: no mother agent, no chat's own agent", () => {
  const profiles = [{ id: "griffin", label: "نوا" }, { id: "platform", label: "پلتفرم‌بان", domain: "پلتفرم" }, { id: "arvan-ban", label: "آروان‌بان" }];
  assert.deepEqual(ownAgents(profiles, "platform").map((a) => a.id), ["arvan-ban"]);
  assert.deepEqual(ownAgents(profiles).map((a) => a.id), ["platform", "arvan-ban"]);
});

test("recent chats: owner's own, newest first, not this one, no side/archived/colleague threads", () => {
  const chats = [
    { id: "a", title: "قدیمی", updatedAt: "2026-10-18 10:00:00" },
    { id: "b", title: "تازه", updatedAt: "2026-10-20T10:00:00.000Z" },
    { id: "c", title: "این گفتگو", updatedAt: "2026-10-20T11:00:00.000Z" },
    { id: "d", title: "کنار", sideOf: "b" },
    { id: "e", title: "همکار", caller: "peer:x" },
    { id: "f", title: "بایگانی", archived: true },
    { id: "g", title: "تلگرام", personId: "p1" },
  ];
  assert.deepEqual(recentChats(chats, "c").map((c) => c.id), ["b", "a"]);
});

test("rows: sections in order, each filtered", () => {
  const rows = mentionRows({
    own: [{ kind: "agent", id: "platform", name: "پلتفرم‌بان" }],
    network: [{ id: "n1", name: "یارا", owner: "صدر" }],
    chats: [{ kind: "chat", id: "c1", name: "پلتفرم و دیسک" }, { kind: "chat", id: "c2", name: "دیگر" }],
    query: "پلتفرم",
  });
  assert.deepEqual(rows.map((r) => r.id), ["platform", "c1"]);
  assert.equal(mentionRows({ chats: Array.from({ length: 10 }, (_, i) => ({ kind: "chat", id: `c${i}`, name: `t${i}` })) }).length, 6);
});
