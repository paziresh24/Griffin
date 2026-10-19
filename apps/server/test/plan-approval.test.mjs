// Plan approval (config PLAN_APPROVAL, from Karsara): in plan mode Claude Code's ExitPlanMode waits on
// the owner's question card; his approval — or an exact approval word typed in his Telegram — moves
// the chat to agent mode. Without the setting nothing changes: no permission handler at all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createAsks, isPlanApprovalText } from "../src/asks.mjs";
import { createClaudeProvider, PLAN_APPROVE, PLAN_KEEP, PLANS_DIR } from "../src/providers/claude.mjs";
import { createIntegrations } from "../src/integrations/manager.mjs";

const tick = () => new Promise((r) => setTimeout(r, 5));

function setupStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-plan-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  return { store, done: () => (store.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

// A fake Claude Code like 2.1.x: in plan mode the model writes its plan to the plans folder
// (settings.plansDirectory) and ExitPlanMode carries no text; an agent-mode turn only asks for what
// bypassPermissions still asks about (a safety check).
function fakeClaude({ planFile = "۱. فایل را بساز\n۲. تست بزن" } = {}) {
  const seen = { options: [], decisions: [] };
  const queryImpl = ({ prompt, options }) => {
    seen.options.push(options);
    return (async function* () {
      for await (const _ of prompt) break;
      const id = options.resume || options.sessionId;
      yield { type: "system", subtype: "init", session_id: id, mcp_servers: [] };
      const ctx = (toolUseID, extra = {}) => ({ toolUseID, signal: new AbortController().signal, ...extra });
      if (options.permissionMode === "plan" && options.canUseTool) {
        seen.decisions.push(["ask_owner", await options.canUseTool("mcp__griffin__ask_owner", { question: "?" }, ctx("tu0"))]);
        seen.decisions.push(["Write", await options.canUseTool("Write", { file_path: "/tmp/x", content: "x" }, ctx("tu1"))]);
        if (planFile !== null) {
          const dir = path.join(options.cwd, options.settings.plansDirectory);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "plan.md"), planFile);
        }
        // The CLI reads the plan file and puts its text and path into the tool input.
        const input = planFile === null ? {} : { plan: planFile, planFilePath: path.join(options.settings.plansDirectory, "plan.md") };
        seen.decisions.push(["ExitPlanMode", await options.canUseTool("ExitPlanMode", input, ctx("tu2"))]);
      }
      if (options.permissionMode !== "plan" && options.canUseTool) {
        seen.decisions.push(["Bash", await options.canUseTool("Bash", { command: 'rm -rf "$X/"' }, ctx("tu3", { decisionReason: "safetyCheck" }))]);
      }
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: id };
    })();
  };
  return { queryImpl, seen };
}

const tmpCwd = () => fs.mkdtempSync(path.join(os.tmpdir(), "griffin-plan-cwd-"));
const behaviors = (seen) => seen.decisions.map(([name, d]) => [name, d.behavior]);

test("only an exact approval word approves a plan", () => {
  for (const word of ["برو", " تأیید ", "مرج کن", "GO", "approve"]) assert.equal(isPlanApprovalText(word), true, word);
  for (const text of ["برو جلو ولی اول تست", "نه", "", "approved?", "go ahead"]) assert.equal(isPlanApprovalText(text), false, text);
});

test("without PLAN_APPROVAL the Claude session has no permission handler (as before)", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create({ cwd: tmpCwd(), fileAccess: { read: ["/tmp"], write: ["/tmp"] } });
  await (await agent.send("برنامه بده", { mode: "plan" })).wait();
  const o = fake.seen.options[0];
  assert.equal(o.canUseTool, undefined);
  assert.equal(o.allowDangerouslySkipPermissions, undefined);
  assert.equal(o.tools.includes("ExitPlanMode"), false);
  assert.equal(o.settings, undefined);
  assert.deepEqual(o.disallowedTools, ["Bash", "BashOutput", "KillShell", "NotebookEdit"]);
});

test("with PLAN_APPROVAL the plan file goes to the owner's card; his approval moves the session to agent mode", async () => {
  const fake = fakeClaude();
  const asked = [];
  let approved = 0;
  const updates = [];
  const planApproval = {
    ask: async (args) => (asked.push(args), { answered: true, answer: PLAN_APPROVE, selected: [PLAN_APPROVE] }),
    onApproved: () => (approved += 1),
  };
  const cwd = tmpCwd();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create({ cwd, fileAccess: { read: ["/tmp"], write: ["/tmp"] }, planApproval });
  const result = await (await agent.send("برنامه بده", { mode: "plan", onDelta: async ({ update }) => updates.push(update) })).wait();
  assert.equal(result.status, "finished");
  const o = fake.seen.options[0];
  assert.equal(typeof o.canUseTool, "function");
  assert.equal(o.allowDangerouslySkipPermissions, true, "needed to switch to bypassPermissions on approval");
  assert.ok(o.tools.includes("ExitPlanMode"), "file-scoped chats can call ExitPlanMode");
  assert.ok(o.disallowedTools.includes("AskUserQuestion"), "Claude Code's own question tool stays off");
  assert.ok(o.disallowedTools.includes("EnterPlanMode"), "the model cannot put itself into plan mode");
  assert.equal(o.settings.plansDirectory, PLANS_DIR);
  assert.deepEqual(behaviors(fake.seen), [["ask_owner", "allow"], ["Write", "deny"], ["ExitPlanMode", "allow"]]);
  assert.deepEqual(fake.seen.decisions[2][1].updatedPermissions, [{ type: "setMode", mode: "bypassPermissions", destination: "session" }]);
  assert.equal(asked.length, 1);
  assert.match(asked[0].question, /فایل را بساز/, "the whole plan is on the card");
  assert.deepEqual(asked[0].options.map((o) => o.label), [PLAN_APPROVE, PLAN_KEEP]);
  assert.equal(approved, 1);
  assert.equal(fs.existsSync(path.join(cwd, PLANS_DIR)), false, "the approved plan's file does not stay in the chat's folder");
  // The card shows in the chat as an ask_owner call that hides the native ExitPlanMode twin.
  const started = updates.find((u) => u.type === "tool-call-started");
  assert.equal(started.callId, "tu2:ask:plan");
  assert.equal(started.toolCall.args.toolName, "ask_owner");
});

test("with PLAN_APPROVAL an agent-mode turn still refuses what bypassPermissions asks about (as main)", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create({ cwd: tmpCwd(), planApproval: { ask: async () => assert.fail("no card in agent mode") } });
  await (await agent.send("پاک کن", { mode: "agent" })).wait();
  assert.deepEqual(behaviors(fake.seen), [["Bash", "deny"]]);
});

test("no plan written: the owner is never asked to approve an empty card", async () => {
  const fake = fakeClaude({ planFile: null });
  let asked = 0;
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create({ cwd: tmpCwd(), planApproval: { ask: async () => ((asked += 1), { answered: true, answer: PLAN_APPROVE, selected: [PLAN_APPROVE] }) } });
  await (await agent.send("برنامه بده", { mode: "plan" })).wait();
  assert.deepEqual(behaviors(fake.seen).at(-1), ["ExitPlanMode", "deny"]);
  assert.equal(asked, 0, "no card without a plan");
});

test("«Keep planning» or a change request keeps plan mode", async () => {
  for (const answer of [{ answered: true, answer: PLAN_KEEP, selected: [PLAN_KEEP] }, { answered: true, answer: "مرحلهٔ ۲ را حذف کن", selected: [] }, { answered: false, reason: "no answer" }]) {
    const fake = fakeClaude();
    let approved = 0;
    const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create({ cwd: tmpCwd(), planApproval: { ask: async () => answer, onApproved: () => (approved += 1) } });
    await (await agent.send("برنامه بده", { mode: "plan" })).wait();
    const [, exit] = fake.seen.decisions.at(-1);
    assert.equal(exit.behavior, "deny");
    assert.equal(exit.updatedPermissions, undefined);
    assert.equal(approved, 0);
    if (answer.answer === "مرحلهٔ ۲ را حذف کن") assert.match(exit.message, /مرحلهٔ ۲ را حذف کن/, "the owner's note reaches the model");
  }
});

test("asks: an approval word settles this chat's one plan card, never an ordinary question", async () => {
  const { store, done } = setupStore();
  try {
    const asks = createAsks({ store, log: {} });
    const chat = store.createChat({ title: "t" });
    const question = asks.tool(chat.id).execute({ question: "کدام شاخه؟", options: [{ label: "main" }, { label: "dev" }] });
    await tick();
    assert.equal(asks.approvePlanByText(chat.id, "برو"), false, "an ordinary question is not a plan");
    const plan = asks.plan(chat.id, { question: "Approve this plan?\n\nA", options: [{ label: PLAN_APPROVE }, { label: PLAN_KEEP }] });
    await tick();
    assert.equal(asks.approvePlanByText(chat.id, "برو ولی صبر کن"), false, "free text is not an approval");
    assert.equal(asks.approvePlanByText(chat.id, "برو"), true);
    assert.deepEqual(await plan, { answered: true, answer: PLAN_APPROVE, selected: [PLAN_APPROVE] });
    assert.equal(asks.isWaiting(chat.id), true, "the ordinary question is still open");
    asks.answer(chat.id, { answer: "main" });
    await question;
  } finally {
    done();
  }
});

test("asks: «برو» typed in the root chat never approves a child's plan card", async () => {
  const { store, done } = setupStore();
  try {
    const asks = createAsks({ store, log: {} });
    const root = store.createChat({ title: "root" });
    const child = store.createChat({ title: "child", parentChatId: root.id });
    assert.equal(store.rootChatId(child.id), root.id);
    const plan = asks.plan(child.id, { question: "Approve this plan?\n\nB", options: [{ label: PLAN_APPROVE }, { label: PLAN_KEEP }] });
    await tick();
    assert.equal(asks.approvePlanByText(root.id, "برو"), false);
    assert.equal(asks.approvePlanByText(child.id, "برو"), true);
    await plan;
  } finally {
    done();
  }
});

test("asks: an answer held early for another question does not approve the next plan", async () => {
  const { store, done } = setupStore();
  try {
    const asks = createAsks({ store, log: {} });
    const chat = store.createChat({ title: "t" });
    asks.holdEarly(chat.id, { answer: "go", selected: [] });
    const plan = asks.plan(chat.id, { question: "Approve this plan?\n\nC", options: [{ label: PLAN_APPROVE }, { label: PLAN_KEEP }] });
    await tick();
    assert.equal(asks.isWaiting(chat.id), true, "the plan waits for the owner");
    asks.cancel(chat.id);
    assert.equal((await plan).answered, false);
  } finally {
    done();
  }
});

test("asks: a plan shown again right after «Keep planning» still reaches the owner (no nag guard)", async () => {
  const { store, done } = setupStore();
  try {
    const asks = createAsks({ store, log: {} });
    const chat = store.createChat({ title: "t" });
    const card = { question: "Approve this plan?\n\nstep one deploy 966", options: [{ label: PLAN_APPROVE }, { label: PLAN_KEEP }] };
    const first = asks.plan(chat.id, card);
    await tick();
    asks.answer(chat.id, { answer: PLAN_KEEP, selected: [PLAN_KEEP] });
    await first;
    const second = asks.plan(chat.id, card);
    await tick();
    assert.equal(asks.isWaiting(chat.id), true, "the revised plan waits for the owner");
    assert.equal(asks.approvePlanByText(chat.id, "approve"), true);
    assert.equal((await second).answer, PLAN_APPROVE);
  } finally {
    done();
  }
});

test("Telegram: the owner's approval word approves the open plan instead of queueing; a colleague's does not", async () => {
  const { store, done } = setupStore();
  const sent = [];
  const runner = { send: async (chatId, input) => (sent.push({ chatId, text: input.text }), { delivered: "queued" }), isActive: () => true, cancel: async () => {} };
  const asks = createAsks({ store, log: {} });
  const integrations = createIntegrations({ store, runner, asks, log: {} });
  try {
    const acc = store.createIntegration({ kind: "telegram_account", name: "acc", secret: "{}", settings: { me: { id: "777", name: "Owner" } } });
    await integrations.bridge.receive(acc.id, "me", { text: "یک برنامه بنویس" });
    const own = store.linkedChat(acc.id, "me");
    await integrations.bridge.receive(acc.id, "555", { text: "سلام" });
    const theirs = store.linkedChat(acc.id, "555");
    sent.length = 0;

    const card = { question: "Approve this plan?\n\nA", options: [{ label: PLAN_APPROVE }, { label: PLAN_KEEP }] };
    const mine = asks.plan(own, card);
    const colleague = asks.plan(theirs, card);
    await tick();

    assert.deepEqual(await integrations.bridge.receive(acc.id, "555", { text: "برو" }), { delivered: "queued" }, "someone else's «برو» is an ordinary message");
    assert.equal(asks.isWaiting(theirs), true);
    assert.deepEqual(await integrations.bridge.receive(acc.id, "me", { text: "برو" }), { delivered: "tool" });
    assert.deepEqual(await mine, { answered: true, answer: PLAN_APPROVE, selected: [PLAN_APPROVE] });
    assert.deepEqual(sent.map((s) => s.chatId), [theirs], "the owner's approval word was not queued as a message");
    asks.cancel(theirs);
    await colleague;
  } finally {
    integrations.stopAll();
    done();
  }
});

test("with PLAN_APPROVAL the manual (ask) mode still shows main's yes/no card for a permission request", async () => {
  const fake = fakeClaude();
  const asked = [];
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create({
    cwd: tmpCwd(),
    planApproval: { ask: async () => assert.fail("no plan card outside plan mode") },
    approve: async (question) => (asked.push(question), true),
  });
  await (await agent.send("پاک کن", { mode: "ask" })).wait();
  assert.equal(asked.length, 1);
  assert.deepEqual(behaviors(fake.seen), [["Bash", "allow"]]);
});
