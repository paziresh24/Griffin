import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The detector reads the owner's name from the persona at load time, so it is set before the imports.
process.env.GRIFFIN_OWNER_NAME = "Sara";
process.env.GRIFFIN_OWNER_NAME_FA = "سارا";
process.env.GRIFFIN_OWNER_FULL_NAME_FA = "سارا احمدی";
const { openStore } = await import("../src/db.mjs");
const { createIntegrations } = await import("../src/integrations/manager.mjs");
const { createMotherTools, motherContext } = await import("../src/integrations/mother.mjs");
const { markOwnerReached, ownerClaim, ownerReached, REACH_WINDOW_MS, trackOwnerReach, unbackedAnswerNudge } = await import("../src/owner-reach.mjs");
const { buildRules } = await import("../src/prompt.mjs");
const { createRunner } = await import("../src/runner.mjs");

// Owner 2026-10-27: «خیلی زیاد پیام میده به بچه ها که به سارا سپردم ولی نه پیام میده نه هیچی … چند تاشم
// گفته تصمیم با سارا است ولی چیزی نپرسیده». The lines below are real messages of that week.

const fresh = () => openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-reach-")), "db.sqlite"));
const parse = (out) => JSON.parse(out.content[0].text);

test("ownerClaim finds «told him» and «his decision», not other mentions of him", () => {
  for (const text of [
    "خیلی ممنون آقای نوری که پیگیری کردید و شارژ کردید. به سارا می‌گم که هم تسویه کنه.",
    "به سارا گفتم که تصمیم بگیره.",
    "منظورتان کدام APISIX است؟ به سارا هم خبر دادم.",
    "زمان صحبت را به سارا می‌سپارم تا هماهنگ کنند.",
    "برای ریستارت سرور به سارا سپردم، انجام شد خبر میدم.",
    "پیشنهادتان را خواندم و برای سارا ثبت کردم.",
    "این تغییر در کد خود محصول است و تصمیمش با سارا است.",
    "دادن RoleBinding به شما تصمیم سارا است.",
    "دسترسی پرومتئوس چیزی است که سارا باید تصمیمش را بگیرد.",
    "باز کردن این پراکسی تصمیم آقای احمدی است، نه من.",
    "هنوز نه، دست سارا است.",
    "راهش همان مسیر از گیت‌وی شمال است که منتظر تأیید سارا است.",
    "وضعیت اکانت رو نمی‌بینم، از سارا پرسیدم و خبرتون میدم.",
  ]) assert.ok(ownerClaim(text), text);
  for (const text of [
    "از سارا نپرسیدم و چیزی هم عوض نکردم.",
    "این تصمیم را معین با سارا هماهنگ کند.",
    "سارا خودش داره پیگیری می‌کنه؛ لطفاً مستقیم با خودشون هماهنگ کنید.",
    "دیتابیس clinic مال آقای کاظمی است و این تصمیم با ایشان است.",
    "رمز سیراف شما ریست شد.",
  ]) assert.equal(ownerClaim(text), null, text);
});

test("trackOwnerReach marks the conversation on a call that went through, not on a refused one", async () => {
  const store = fresh();
  const root = store.createChat({ title: "👤 x", caller: "team" });
  const tools = trackOwnerReach(
    {
      ask_owner: { description: "a", execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ answer: "بله" }) }] }) },
      handoff_to_owner: { description: "h", execute: async () => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: "cap" }) }] }) },
      kube_get: { description: "k", execute: async () => ({ content: [{ type: "text", text: "{}" }] }) },
    },
    { store, rootChatId: root.id },
  );
  await tools.kube_get.execute({});
  await tools.handoff_to_owner.execute({});
  assert.equal(ownerReached(store, root.id), false);
  await tools.ask_owner.execute({ question: "q" });
  assert.equal(ownerReached(store, root.id), true);
  assert.equal(ownerReached(store, root.id, { now: Date.now() + REACH_WINDOW_MS + 60_000 }), false, "an old ask does not back a new claim");
});

test("ownerReached also counts a handoff card, an approval question in a subtask, and the owner's own line", () => {
  const store = fresh();
  const root = store.createChat({ title: "👤 y", caller: "team" });
  assert.equal(ownerReached(store, root.id), false);
  assert.equal(ownerReached(store, root.id, { ownerWroteAt: new Date().toISOString() }), true);
  store.createSuggestion({ fromChatId: root.id, title: "t", tldr: "w", prompt: "p", repo: null, model: null });
  assert.equal(ownerReached(store, root.id), true);

  const other = store.createChat({ title: "👤 z", caller: "team" });
  const sub = store.createChat({ title: "رشته", caller: "platform", parentChatId: other.id });
  assert.equal(ownerReached(store, other.id), false);
  store.db.prepare("INSERT INTO approvals (at, chat_id, caller, tool, args_json, decision) VALUES (?, ?, 'team', 'x', '{}', 'pending')").run(new Date().toISOString(), sub.id);
  assert.equal(ownerReached(store, other.id), true);
});

test("send_to_person refuses «به سارا سپردم» until the conversation reached him, then sends it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-reach-desk-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sends = [];
  const runner = {
    isActive: () => false,
    send: async (chatId, input) => {
      sends.push({ chatId, ...input });
      store.appendEvent(chatId, null, "user", { text: input.text });
      return { delivered: "run" };
    },
    cancel: async () => {},
    retry: () => ({ status: "nothing-kept" }),
  };
  const delivered = [];
  let nextId = 0;
  const fake = {
    kind: "telegram_account", status: { state: "polling" }, start() {}, stop() {},
    deliver: async (chat, message) => (delivered.push({ chat, ...message }), ++nextId),
    edit: async () => {}, remove: async () => {}, react: async () => {}, picked: () => {},
  };
  const acc = store.createIntegration({ kind: "telegram_account", name: "acc", secret: JSON.stringify({ session: "s", apiId: 1, apiHash: "h" }), settings: {} });
  const integrations = createIntegrations({ store, runner, asks: null, channelFactories: { telegram_account: () => fake }, burstMs: 0, log: {} });
  integrations.startAll();
  integrations.desk.caughtUp(acc.id);
  try {
    const p = store.upsertPerson({ integrationId: acc.id, externalId: "3001", name: "نوری", data: { platform: "telegram" } });
    const nouri = store.updatePerson(p.id, { access: { watch: true } });
    await integrations.desk.colleague(acc.id, "3001", { person: nouri, text: "کی وقت دارید صحبت کنیم؟", messageId: 9 });
    const mother = sends[0].chatId;
    const tools = createMotherTools({ store, runner, chatId: mother, name: "نوری", sendToPerson: (t) => integrations.desk.sendToPerson(mother, t) });
    store.startRun(mother);

    const refused = parse(await tools.send_to_person.execute({ text: "سلام، زمان صحبت را به سارا می‌سپارم تا هماهنگ کنند." }));
    assert.match(refused.error, /پیام نرفت/);
    assert.match(refused.error, /request_full_access/);
    assert.match(refused.error, /ask_owner/);
    assert.equal(delivered.length, 0, "nothing reached the colleague");

    // A line that does not claim anything about him goes as before.
    assert.equal(parse(await tools.send_to_person.execute({ text: "سلام، دارم بررسی می‌کنم." })).sent, true);

    markOwnerReached(store, mother);
    assert.equal(parse(await tools.send_to_person.execute({ text: "زمان صحبت را به سارا سپردم؛ خبرتان می‌کنم." })).sent, true);
    assert.equal(delivered.length, 2);
  } finally {
    integrations.stopAll();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the rules say a mention of him needs ask_owner or handoff_to_owner first", () => {
  const peer = buildRules({ caller: "peer:sara-jafari" });
  assert.match(peer, /is true only after you asked him in this conversation/);
  assert.match(motherContext("نوری"), /does not reach him either/);
  assert.match(motherContext("نوری"), /hands it to YOU, not a\s+sign he does it himself/);
  assert.match(motherContext("نوری"), /leaves the fix to nobody/);
  assert.match(unbackedAnswerNudge("تصمیمش با سارا"), /ask_owner/);
});

// The runner (index.mjs ownerClaimCheck): a colleague's agent's answer that leaves a decision with
// him, with nothing asked, goes on once in the same run before it is delivered.
function runnerSetup(texts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-reach-runner-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sends = [];
  const agent = {
    agentId: "agent-1",
    async send(message, options) {
      const leg = sends.length;
      sends.push({ message, model: options.model?.id || null });
      return {
        id: `sdk-${leg}`,
        supports: () => true,
        async cancel() {},
        async wait() {
          await options.onDelta?.({ update: { type: "text-delta", text: texts[leg] ?? "?" } });
          return { status: "finished" };
        },
      };
    },
    close() {},
  };
  const sdk = { create: async () => agent, resume: async () => agent };
  const ownerClaimCheck = (chat, tail) => {
    const phrase = ownerClaim(tail);
    return phrase && !ownerReached(store, chat.id) ? { nudge: unbackedAnswerNudge(phrase), note: `«${phrase}»` } : null;
  };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), runLabel: () => ({ provider: "claude", model: "sonnet" }), ownerClaimCheck, log: { error() {} } });
  const chat = store.createChat({ title: "t", caller: "peer:net-x" });
  return { store, runner, chat, sends };
}
const finished = async (store, chatId, runId) => {
  const end = Date.now() + 2000;
  while (!store.eventsAfter(chatId).some((e) => e.type === "run.finished" && e.runId === runId)) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("runner: «تصمیمش با سارا است» with nothing asked goes on once, in the same run, on the same model", async () => {
  const { store, runner, chat, sends } = runnerSetup(["این تغییر در خود محصول است و تصمیمش با سارا است.", "از سارا پرسیدم؛ گفت فعلاً نه."]);
  const { runId } = await runner.send(chat.id, { text: "این را اضافه می‌کنید؟" });
  await finished(store, chat.id, runId);
  assert.equal(sends.length, 2, "one more leg, not a loop: the second answer is not checked again");
  assert.equal(sends[1].model, "sonnet");
  assert.match(String(sends[1].message), /تذکر سیستمی/);
  assert.match(String(sends[1].message), /ask_owner/);
  const events = store.eventsAfter(chat.id);
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1, "one answer for the colleague");
  assert.ok(events.some((e) => e.type === "note" && /تصمیمش با سارا/.test(e.data.text)));
});

test("runner: the same answer after an ask, or one that names nobody, is delivered as is", async () => {
  const asked = runnerSetup(["تصمیمش با سارا است و از او پرسیدم."]);
  markOwnerReached(asked.store, asked.chat.id);
  const a = await asked.runner.send(asked.chat.id, { text: "q" });
  await finished(asked.store, asked.chat.id, a.runId);
  assert.equal(asked.sends.length, 1);

  const plain = runnerSetup(["سرویس سالم است."]);
  const b = await plain.runner.send(plain.chat.id, { text: "q" });
  await finished(plain.store, plain.chat.id, b.runId);
  assert.equal(plain.sends.length, 1);
});
