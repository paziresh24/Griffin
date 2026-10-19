// A long message between two assistants goes out as numbered, signed parts «(بخش ۱ از ۳)» and is
// joined into one request on the other side before it is answered (as Karsara does, 2026-10-15).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { agentFooter, partOf, signedParts, withAgentFooter } from "../src/integrations/format.mjs";

test("a long signed message is cut into numbered parts, each signed; a short one stays whole", () => {
  const footer = agentFooter();
  const short = withAgentFooter("سلام");
  assert.deepEqual(signedParts(short), [short]);
  const paragraphs = Array.from({ length: 60 }, (_, i) => `بند ${i}: ${"متن ".repeat(60).trim()}`);
  const parts = signedParts(withAgentFooter(paragraphs.join("\n\n")));
  assert.ok(parts.length >= 3, `${parts.length} parts`);
  parts.forEach((part, i) => {
    assert.ok(part.length <= 4000, `part ${i + 1} fits one Telegram message`);
    assert.ok(part.endsWith(`\n\n${footer}`), `part ${i + 1} is signed`);
    const read = partOf(part);
    assert.equal(read.index, i + 1);
    assert.equal(read.total, parts.length);
  });
  assert.equal(partOf(parts[0]).body.split("\n")[0].startsWith("بند 0"), true);
  // Every paragraph survives, once.
  const joined = parts.map((p) => partOf(p).body).join("\n\n");
  for (const p of paragraphs) assert.equal(joined.split(p).length - 1, 1);
  // A long text not ending in this install's footer (a hand-signed «— ایجنت دیگر») is not numbered, but
  // still cut to Telegram's size, as before (review 2026-10-15).
  const hand = signedParts(`${paragraphs.join("\n\n")}\n\n— ایجنت دیگر`);
  assert.ok(hand.length >= 3 && hand.every((part) => part.length <= 4000 && !partOf(part)));
  assert.equal(signedParts("x".repeat(9000)).length, 3);
});

test("partOf reads «(بخش i از n)» only at the head, with sane numbers", () => {
  assert.deepEqual(partOf("(بخش ۲ از ۳)\nمتن"), { index: 2, total: 3, body: "متن" });
  assert.deepEqual(partOf("(بخش 1 از 2)\nx"), { index: 1, total: 2, body: "x" });
  assert.equal(partOf("سلام (بخش ۱ از ۲)\nx"), null);
  assert.equal(partOf("(بخش ۳ از ۲)\nx"), null);
  assert.equal(partOf("(بخش ۱ از ۱)\nx"), null);
});

async function peerHarness() {
  const { createIntegrations } = await import("../src/integrations/manager.mjs");
  const { createPeerAuth } = await import("../src/peer-auth.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-parts-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  const sends = [];
  const runner = { send: async (chatId, input) => (sends.push({ chatId, text: input.text }), {}), isActive: () => false, cancel: async () => {} };
  const integrations = createIntegrations({ store, runner, asks: {}, peerAuth: createPeerAuth({ store }), log: {} });
  const person = store.upsertPerson({ externalId: "777", name: "Kiani", username: "kiani", data: { platform: "telegram" } });
  const { user } = await integrations.bridge.bindPeerAgentPerson(person, "777");
  const tg = store.createIntegration({ kind: "telegram_account", name: "acc", secret: "{}", settings: {} });
  const sig = "— کارسرا، دستیارِ کیانی";
  // As the account channel does: the message joins the person's history, then is routed.
  const receive = (text) => {
    store.addPersonMessage({ personId: person.id, direction: "in", text });
    return integrations.bridge.receivePeerAgent(tg.id, "777", { text, userId: user, label: "Kiani", personId: person.id });
  };
  const request = (i) => sends[i].text.match(/<peer_request>\n([\s\S]*)\n<\/peer_request>/)[1];
  const close = async () => {
    integrations.stopAll();
    await new Promise((r) => setTimeout(r, 30));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, person, sends, receive, request, sig, close };
}

test("another assistant's parts are held until all are in, then answered once as one request", async () => {
  const h = await peerHarness();
  try {
    h.store.addPersonMessage({ personId: h.person.id, direction: "in", text: "پیام قدیمی دربارهٔ کلاستر" });
    assert.equal(await h.receive(`(بخش ۱ از ۳)\nاول\n\n${h.sig}`), null);
    assert.equal(await h.receive(`(بخش ۲ از ۳)\nدوم\n\n${h.sig}`), null);
    assert.equal(h.sends.length, 0, "nothing answered while parts are missing");
    await h.receive(`(بخش ۳ از ۳)\nسوم\n\n${h.sig}`);
    assert.equal(h.sends.length, 1, "answered once");
    assert.equal(h.request(0), `اول\n\nدوم\n\nسوم\n\n${h.sig}`, "joined in order, one signature");
    assert.match(h.sends[0].text, /پیام قدیمی دربارهٔ کلاستر/, "the history before it stays");
    assert.doesNotMatch(h.sends[0].text.split("<peer_request>")[0], /بخش ۱ از ۳/, "its own parts are not history");
    // A whole (unnumbered) message is answered at once, as before.
    await h.receive(`سلام\n\n${h.sig}`);
    assert.equal(h.sends.length, 2);
  } finally {
    await h.close();
  }
});

test("a lost part: the message is answered with the gap said, and the next message is not touched", async () => {
  const h = await peerHarness();
  try {
    await h.receive(`(بخش ۱ از ۳)\nالف-یک\n\n${h.sig}`);
    await h.receive(`(بخش ۳ از ۳)\nالف-سه\n\n${h.sig}`); // part 2 never comes
    assert.equal(h.sends.length, 0);
    await h.receive(`(بخش ۱ از ۳)\nب-یک\n\n${h.sig}`); // the next message starts
    assert.equal(h.sends.length, 1, "the broken one is answered when the next begins");
    assert.equal(h.request(0), `الف-یک\n\n[بخش 2 از 3 نرسید]\n\nالف-سه\n\n${h.sig}`);
    await h.receive(`(بخش ۲ از ۳)\nب-دو\n\n${h.sig}`);
    assert.equal(h.sends.length, 1, "B is not answered early with A's last part");
    await h.receive(`(بخش ۳ از ۳)\nب-سه\n\n${h.sig}`);
    assert.equal(h.request(1), `ب-یک\n\nب-دو\n\nب-سه\n\n${h.sig}`);
  } finally {
    await h.close();
  }
});
