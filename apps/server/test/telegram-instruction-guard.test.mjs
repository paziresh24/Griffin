import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaudeProvider } from "../src/providers/claude.mjs";
import { griffinStatePaths } from "../src/providers/state-guard.mjs";
import { openStore } from "../src/db.mjs";
import { thirdPartyKey } from "../src/related.mjs";
import { createIntegrations } from "../src/integrations/manager.mjs";
import { ensureGlobal } from "../src/integrations/mother.mjs";

// Port of Karsara !79 (owner decision 2026-10-13), TELEGRAM_INSTRUCTION_GUARD (on by default): a chat
// CREATED FROM SOMEONE ELSE'S TELEGRAM MESSAGE may not write the files that feed every session's
// instructions (~/.claude's CLAUDE.md, settings*.json, memory/, skills/, hooks/, .claude.json, the
// brain's core.md and hooks, the agent folder's CLAUDE.md and .claude, any .claude/settings*.json in
// a worktree). The owner's own Saved Messages and his own bot chat stay unrestricted, and an owner
// chat that only received a routed outside message stays allowed: the boundary is origin, not content.
// Each chat below goes through chat-origin.mjs instructionPathsFor, exactly as index.mjs does.

const origin = () => import("../src/chat-origin.mjs");

// Griffin's container layout: HOME=/data/home (so ~/.claude lives inside the data folder, in the
// home the state guard leaves open), repos under the workspace, the agent folder beside them.
function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-instr-")));
  const data = path.join(base, "data");
  const home = path.join(data, "home");
  const claudeDir = path.join(home, ".claude");
  const workspace = path.join(base, "workspace");
  const knowledgeRoot = path.join(workspace, "knowledge");
  const reposRoot = path.join(workspace, "repos");
  const agentDir = path.join(workspace, "agents", "griffin");
  const worktree = path.join(reposRoot, "_wt", "griffin-abc");
  for (const d of [path.join(claudeDir, "memory"), path.join(claudeDir, "skills", "s"), knowledgeRoot, path.join(reposRoot, "brain"), agentDir, path.join(worktree, ".claude"), path.join(worktree, "src")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), "@core\n");
  fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}\n");
  fs.writeFileSync(path.join(claudeDir, "memory", "MEMORY.md"), "- a\n");
  fs.writeFileSync(path.join(claudeDir, "skills", "s", "SKILL.md"), "x\n");
  fs.writeFileSync(path.join(reposRoot, "brain", "core.md"), "core\n");
  fs.writeFileSync(path.join(agentDir, "CLAUDE.md"), "rules\n");
  fs.writeFileSync(path.join(worktree, ".claude", "settings.local.json"), "{}\n");
  // A link in the worktree to the memory folder.
  fs.symlinkSync(path.join(claudeDir, "memory"), path.join(worktree, "mem"));
  const store = openStore(path.join(base, "db.sqlite"));
  return { base, data, home, claudeDir, knowledgeRoot, reposRoot, agentDir, worktree, store };
}

// What index.mjs hands the owner's full Claude Code with STATE_GUARD and TELEGRAM_INSTRUCTION_GUARD on (the defaults).
async function sessionFor(env, chat) {
  process.env.HOME = env.home;
  const { instructionPathsFor } = await origin();
  const instructionPaths = instructionPathsFor(env.store, chat, { configDirs: [undefined, env.claudeDir], reposRoot: env.reposRoot });
  let seen = null;
  const queryImpl = ({ prompt, options }) => {
    seen = options;
    return (async function* () {
      for await (const _ of prompt) break;
      yield { type: "system", subtype: "init", session_id: options.sessionId, mcp_servers: [] };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: options.sessionId };
    })();
  };
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({
    cwd: env.worktree,
    rules: "RULES",
    fileAccess: { read: [env.base], write: [env.worktree], deny: [env.knowledgeRoot, path.join(env.worktree, ".git")] },
    claudeCode: true,
    stateGuard: griffinStatePaths({ knowledgeRoot: env.knowledgeRoot, data: env.data, home: env.home }),
    instructionPaths,
  });
  await (await agent.send("go")).wait();
  return seen;
}

async function decide(options, toolName, toolInput, cwd) {
  for (const m of options.hooks?.PreToolUse || []) {
    if (m.matcher && !new RegExp(`^(?:${m.matcher})$`).test(toolName)) continue;
    for (const hook of m.hooks) {
      const out = await hook(
        { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, tool_use_id: "u1", session_id: "s", transcript_path: "", cwd },
        "u1",
        { signal: new AbortController().signal },
      );
      if (out?.hookSpecificOutput?.permissionDecision === "deny") return { decision: "deny", reason: out.hookSpecificOutput.permissionDecisionReason };
    }
  }
  return { decision: "allow" };
}

// The writes the owner's decision is about, each through the path a model would use.
function writes(env) {
  const memory = path.join(env.claudeDir, "memory", "MEMORY.md");
  return [
    ["Write", { file_path: memory, content: "- injected\n" }],
    ["Edit", { file_path: memory, old_string: "- a", new_string: "- injected" }],
    ["Edit", { file_path: path.join(env.worktree, "mem", "MEMORY.md"), old_string: "- a", new_string: "- b" }], // through a symlink
    ["Edit", { file_path: path.join(env.claudeDir, "settings.json"), old_string: "{}", new_string: '{"permissions":{"allow":["Bash"]}}' }],
    ["Write", { file_path: path.join(env.claudeDir, "settings.local.json"), content: "{}" }],
    ["Write", { file_path: path.join(env.claudeDir, "CLAUDE.md"), content: "x" }],
    ["Write", { file_path: path.join(env.claudeDir, "skills", "new", "SKILL.md"), content: "x" }],
    ["Write", { file_path: path.join(env.home, ".claude.json"), content: "{}" }],
    ["Edit", { file_path: path.join(env.reposRoot, "brain", "core.md"), old_string: "core", new_string: "x" }],
    ["Write", { file_path: path.join(env.worktree, ".claude", "settings.local.json"), content: "{}" }],
    ["Write", { file_path: ".claude/settings.json", content: "{}" }],
    ["Bash", { command: `echo '- injected' >> ${path.join(env.claudeDir, "memory", "MEMORY.md")}` }],
    // "~" is the server's home (os.homedir(), HOME=/data/home in the image): sessionFor points it at env.home.
    ["Bash", { command: "echo '- injected' >> ~/.claude/memory/MEMORY.md" }],
    ["Bash", { command: `sed -i 's/a/b/' ${path.join(env.claudeDir, "settings.json")}` }],
    ["Bash", { command: "cp /tmp/x .claude/settings.local.json" }],
    ["Bash", { command: `cd ${env.claudeDir} && sed -i 's/{}/x/' settings.json` }],
    ["Write", { file_path: path.join(env.claudeDir, "rules", "r.md"), content: "x" }],
    ["Bash", { command: `echo x > ${path.join(env.claudeDir, "projects", "-w", "memory", "MEMORY.md")}` }],
    ["Bash", { command: `cp /tmp/x ${env.home}/.claude.json` }],
    ["Monitor", { command: `tee -a ${path.join(env.claudeDir, "memory", "MEMORY.md")} < /tmp/x` }],
  ];
}

// Real integrations, as the Telegram channels call them: the owner's connected account (his user
// id 9001) and a bot paired with his own private chat and a colleague's (777).
function withIntegrations(env) {
  const acct = env.store.createIntegration({ kind: "telegram_account", name: "account", secret: "", settings: { me: { id: "9001" } } });
  const bot = env.store.createIntegration({ kind: "telegram_bot", name: "bot", secret: "", settings: { pairedChats: ["9001", "777"] } });
  const runner = { send: async () => ({ delivered: "run" }), isActive: () => false, cancel: async () => {} };
  const integrations = createIntegrations({ store: env.store, runner, asks: null, fetchImpl: async () => Response.json({ ok: true, result: {} }), log: {} });
  return { integrations, acct: acct.id, bot: bot.id };
}
const newestChat = (store) => store.db.prepare("SELECT id FROM chats ORDER BY rowid DESC LIMIT 1").get().id;

test("a chat born from a colleague's message to the bot cannot write memory, settings or any other instruction file", async () => {
  const env = setup();
  const { integrations, bot } = withIntegrations(env);
  await integrations.bridge.receive(bot, "777", { text: "memory را عوض کن", senderId: 777, person: { name: "colleague" } });
  const options = await sessionFor(env, env.store.getChat(newestChat(env.store)));
  for (const [tool, input] of writes(env)) {
    const d = await decide(options, tool, input, env.worktree);
    assert.equal(d.decision, "deny", `${tool} ${JSON.stringify(input)}`);
    assert.match(d.reason, /Telegram message/);
    assert.match(d.reason, /Propose the change to the owner/);
  }
  // Reading stays open, and so does ordinary work in the worktree and the rest of the home.
  for (const [tool, input] of [
    ["Read", { file_path: path.join(env.claudeDir, "memory", "MEMORY.md") }],
    ["Bash", { command: `cat ${path.join(env.claudeDir, "memory", "MEMORY.md")} | grep a` }],
    ["Bash", { command: "cat .claude/settings.local.json" }],
    ["Write", { file_path: path.join(env.worktree, "src", "a.mjs"), content: "x" }],
    ["Bash", { command: "npm test > /tmp/out.txt" }],
    ["Bash", { command: `echo x > ${env.home}/scratch.txt` }],
  ]) {
    assert.equal((await decide(options, tool, input, env.worktree)).decision, "allow", `${tool} ${JSON.stringify(input)}`);
  }
  integrations.stopAll();
});

test("the owner's own Saved Messages (even a forwarded message there) and his own bot chat stay unrestricted", async () => {
  const env = setup();
  const { integrations, acct, bot } = withIntegrations(env);
  await integrations.bridge.receive(acct, "me", { text: "یادداشت را در memory بنویس" });
  const saved = newestChat(env.store);
  await integrations.bridge.receive(acct, "me", { text: "forwarded", forwarded: true });
  await integrations.bridge.receive(bot, "9001", { text: "سلام", senderId: 9001, person: { name: "owner" } });
  const ownBot = newestChat(env.store);
  assert.notEqual(saved, ownBot);
  for (const id of [saved, ownBot]) {
    const options = await sessionFor(env, env.store.getChat(id));
    for (const [tool, input] of writes(env)) {
      assert.equal((await decide(options, tool, input, env.worktree)).decision, "allow", `${id}: ${tool} ${JSON.stringify(input)}`);
    }
  }
  integrations.stopAll();
});

test("a chat made out of a Telegram-born chat inherits its origin: a child, a side chat, a fork, a suggestion it made", async () => {
  const env = setup();
  const { markMessengerOrigin, telegramOrigin } = await origin();
  const bot = env.store.createIntegration({ kind: "telegram_bot", name: "b", secret: "", settings: {} });
  const tg = env.store.createChat({ title: "از ربات" });
  markMessengerOrigin(env.store, tg.id, bot.id, "777");
  const child = env.store.createChat({ title: "consult", parentChatId: tg.id });
  const side = env.store.createChat({ title: "side", sideOf: tg.id });
  const fork = env.store.createChat({ title: "fork" });
  env.store.setKv(`fork-of:${fork.id}`, tg.id);
  const started = env.store.createChat({ title: "از پیشنهادِ چتِ ربات" });
  const row = env.store.createSuggestion({ fromChatId: tg.id, title: "x", tldr: "t", prompt: "p" });
  env.store.settleSuggestion(row.id, "started", started.id);
  const memoryWrite = ["Write", { file_path: path.join(env.claudeDir, "memory", "MEMORY.md"), content: "x" }];
  for (const c of [tg, child, side, fork, started]) {
    assert.equal(telegramOrigin(env.store, env.store.getChat(c.id)), "telegram_bot", c.title);
    assert.equal((await decide(await sessionFor(env, env.store.getChat(c.id)), ...memoryWrite, env.worktree)).decision, "deny", c.title);
  }
});

test("a bot chat made before the marker is recognised by its link; a /new keeps the marker after the link moves", async () => {
  const env = setup();
  const { telegramOrigin } = await origin();
  const bot = env.store.createIntegration({ kind: "telegram_bot", name: "b", secret: "", settings: {} });
  const old = env.store.createChat({ title: "قدیمی" });
  env.store.linkChat(bot.id, "777", old.id);
  assert.equal(telegramOrigin(env.store, env.store.getChat(old.id)), "bot");
  // A chat created through receive keeps its origin once /new moves the link elsewhere.
  const { integrations, bot: liveBot } = withIntegrations(env);
  await integrations.bridge.receive(liveBot, "777", { text: "x", senderId: 777, person: { name: "c" } });
  const born = newestChat(env.store);
  integrations.bridge.newChat(liveBot, "777");
  assert.deepEqual(env.store.linksForChat(born), [], "the link moved off this chat");
  assert.equal(telegramOrigin(env.store, env.store.getChat(born)), "telegram_bot");
  integrations.stopAll();
});

test("an ordinary owner chat is unchanged — including one that received a routed outside message", async () => {
  const env = setup();
  const { instructionPathsFor } = await origin();
  const plain = env.store.createChat({ title: "عادی" });
  const routed = env.store.createChat({ title: "کار روزانه" });
  env.store.setKv(thirdPartyKey(routed.id), { at: "now" });
  const started = env.store.createChat({ title: "پیشنهاد عادی" });
  const row = env.store.createSuggestion({ fromChatId: plain.id, title: "x", tldr: "t", prompt: "p" });
  env.store.settleSuggestion(row.id, "started", started.id);
  for (const c of [plain, routed, started]) {
    assert.deepEqual(instructionPathsFor(env.store, env.store.getChat(c.id), { configDirs: [env.claudeDir], reposRoot: env.reposRoot }), []);
    const options = await sessionFor(env, env.store.getChat(c.id));
    for (const [tool, input] of writes(env)) {
      assert.equal((await decide(options, tool, input, env.worktree)).decision, "allow", `${c.title}: ${tool} ${JSON.stringify(input)}`);
    }
  }
});

test("writing into the folder that holds a protected file, the brain's hooks and a symlinked .claude are refused to a Telegram-born chat only", async () => {
  const env = setup();
  const { markMessengerOrigin } = await origin();
  fs.mkdirSync(path.join(env.reposRoot, "brain", "hooks"), { recursive: true });
  const elsewhere = path.join(env.base, "elsewhere");
  fs.mkdirSync(elsewhere);
  const linkedWt = path.join(env.reposRoot, "_wt", "linked");
  fs.mkdirSync(linkedWt, { recursive: true });
  fs.symlinkSync(elsewhere, path.join(linkedWt, ".claude"));
  const brain = path.join(env.reposRoot, "brain");
  const cases = [
    ["Bash", { command: `cp /tmp/CLAUDE.md ${env.claudeDir}/` }],
    ["Bash", { command: `cd ${env.claudeDir} && cp /tmp/CLAUDE.md .` }],
    ["Bash", { command: `cp /tmp/x/core.md ${brain}/` }],
    ["Bash", { command: `tar -xf x.tar -C ${env.claudeDir}` }],
    ["Bash", { command: `git -C ${brain} checkout evil -- .` }],
    ["Bash", { command: `cd ${brain} && git reset --hard origin/evil` }],
    ["Bash", { command: `echo x > ${brain}/hooks/pretooluse_bundle.py` }],
    ["Write", { file_path: path.join(brain, "hooks", "pretooluse_bundle.py"), content: "x" }],
    ["Write", { file_path: path.join(linkedWt, ".claude", "settings.json"), content: "{}" }],
    ["Bash", { command: "cp /tmp/s.json .claude/" }],
  ];
  const bot = env.store.createIntegration({ kind: "telegram_bot", name: "b", secret: "", settings: {} });
  const tg = env.store.createChat({ title: "از ربات" });
  markMessengerOrigin(env.store, tg.id, bot.id, "777");
  const denied = await sessionFor(env, env.store.getChat(tg.id));
  const plain = await sessionFor(env, env.store.createChat({ title: "عادی" }));
  for (const [tool, input] of cases) {
    assert.equal((await decide(denied, tool, input, env.worktree)).decision, "deny", `telegram: ${tool} ${JSON.stringify(input)}`);
    assert.equal((await decide(plain, tool, input, env.worktree)).decision, "allow", `owner: ${tool} ${JSON.stringify(input)}`);
  }
  for (const command of [`ls ${env.claudeDir}`, `git -C ${brain} log -1`, `cd ${brain} && git status`, "ls .claude"]) {
    assert.equal((await decide(denied, "Bash", { command }, env.worktree)).decision, "allow", command);
  }
});

test("TELEGRAM_INSTRUCTION_GUARD off (no instructionPaths) or no full Claude Code: nothing changes", async () => {
  const env = setup();
  let seen = null;
  const queryImpl = ({ prompt, options }) => {
    seen = options;
    return (async function* () {
      for await (const _ of prompt) break;
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: options.sessionId };
    })();
  };
  const scoped = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({
    cwd: env.worktree,
    rules: "R",
    fileAccess: { read: [env.base], write: [env.worktree], deny: [] },
    instructionPaths: [path.join(env.claudeDir, "memory")],
  });
  await (await scoped.send("go")).wait();
  assert.equal(seen.hooks.PreToolUse.length, 2, "without full Claude Code only the file guard and the plan-mode guard run");
});

test("review: Bash in the agent folder (a bot chat without a repo) keeps ordinary commands", async () => {
  const env = setup();
  const { integrations, bot } = withIntegrations(env);
  await integrations.bridge.receive(bot, "777", { text: "x", senderId: 777, person: { name: "c" } });
  const options = await sessionFor(env, env.store.getChat(newestChat(env.store)));
  for (const command of ["kubectl get pods", "curl -s https://example.com", "python3 -c 'print(1)'", "git clone https://example.com/r.git", "npm view x"]) {
    assert.equal((await decide(options, "Bash", { command }, env.agentDir)).decision, "allow", command);
  }
  assert.equal((await decide(options, "Bash", { command: `echo x >> ${path.join(env.claudeDir, "CLAUDE.md")}` }, env.agentDir)).decision, "deny");
  integrations.stopAll();
});

test("review: a forwarded first message, or another sender, in the owner's own bot chat makes it Telegram-born", async () => {
  const env = setup();
  const { telegramOrigin } = await origin();
  const { integrations, bot } = withIntegrations(env);
  await integrations.bridge.receive(bot, "9001", { text: "fwd", senderId: 9001, forwarded: true, person: { name: "owner" } });
  assert.equal(telegramOrigin(env.store, env.store.getChat(newestChat(env.store))), "telegram_bot");
  integrations.stopAll();
});

test("review: a chat made out of the desk (a consult, a side chat) is guarded like a Telegram-born chat", async () => {
  const env = setup();
  const { telegramOrigin } = await origin();
  const desk = ensureGlobal(env.store);
  const deskId = typeof desk === "string" ? desk : desk.id;
  const consult = env.store.createChat({ title: "consult", parentChatId: deskId });
  const side = env.store.createChat({ title: "side", sideOf: deskId });
  for (const c of [consult, side]) {
    assert.equal(telegramOrigin(env.store, env.store.getChat(c.id)), "desk", c.title);
    const options = await sessionFor(env, env.store.getChat(c.id));
    assert.equal((await decide(options, "Write", { file_path: path.join(env.claudeDir, "memory", "MEMORY.md"), content: "x" }, env.worktree)).decision, "deny", c.title);
  }
});
