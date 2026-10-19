import test from "node:test";
import assert from "node:assert/strict";
import { turnsOf, repoOf, griffinCwd } from "../scripts/from-claude-desktop.mjs";

test("desktop transcript: real user turns with the assistant text after them", () => {
  const l = (o) => JSON.stringify(o);
  const turns = turnsOf([
    l({ type: "user", message: { content: "اول" }, timestamp: "t1" }),
    l({ type: "assistant", message: { content: [{ type: "text", text: "جواب" }, { type: "tool_use", name: "Bash" }] }, timestamp: "t2" }),
    l({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }),
    l({ type: "user", message: { content: "<task-notification>…" } }),
    l({ type: "user", isMeta: true, message: { content: "meta" } }),
    l({ type: "user", isSidechain: true, message: { content: "sub" } }),
    l({ type: "assistant", message: { content: [{ type: "text", text: "بعدی" }] }, timestamp: "t3" }),
    "not json",
    l({ type: "user", message: { content: [{ type: "text", text: "دوم" }] }, timestamp: "t4" }),
  ]);
  assert.deepEqual(turns.map((t) => [t.user, t.texts, t.endAt]), [["اول", ["جواب", "بعدی"], "t3"], ["دوم", [], "t4"]]);
});

test("desktop folder -> Griffin repo and run folder", () => {
  const repos = "infra-gitops,griffin=Griffin";
  assert.equal(repoOf("/home/x/Projects/Alice Example/infra-gitops/.claude/worktrees/a", repos), "infra-gitops");
  assert.equal(repoOf("/home/x/Projects/Griffin", repos), "griffin");
  assert.equal(repoOf("/home/x/.config/scratch", repos), null);
  assert.equal(repoOf("/home/x/Projects/Griffin", ""), null, "nothing listed = no repo");
  assert.equal(griffinCwd("65365452-aaaa", "infra-gitops"), "/workspace/repos/_wt/griffin-65365452");
  assert.equal(griffinCwd("65365452-aaaa", null), "/workspace/agents/griffin");
});

test("desktop transcript: reminders around the words go, pasted content stays", async () => {
  const { userWords } = await import("../scripts/from-claude-desktop.mjs");
  assert.equal(userWords([{ type: "text", text: "<system-reminder>\nworktree\n</system-reminder>" }, { type: "text", text: "کار" }]), "کار");
  assert.equal(userWords("\n\n<pasted_content id=\"a\">x</pasted_content>"), "<pasted_content id=\"a\">x</pasted_content>");
  assert.equal(userWords("<task-notification>done</task-notification>"), "");
});

test("desktop sync: new moves, unchanged stays, Desktop's latest comes again, a chat that went on in Griffin is left alone", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { importSessions } = await import("../scripts/from-claude-desktop.mjs");
  const { openStore } = await import("../src/db.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-desk-"));
  const [sessions, projects, home] = ["s", "p", "h"].map((d) => fs.mkdirSync(path.join(root, d), { recursive: true }) && path.join(root, d));
  const dbFile = path.join(root, "db.sqlite");
  openStore(dbFile).db.close();
  const id = "44444444-4444-4444-8444-444444444444";
  const transcript = path.join(projects, "-home-x-scratch", `${id}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const say = (text, at) => fs.appendFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: text }, timestamp: at })}\n`);
  const desk = (lastActivityAt) => fs.writeFileSync(path.join(sessions, "local_a.json"), JSON.stringify({ sessionId: "local_a", cliSessionId: id, cwd: "/home/x/scratch", title: "t", createdAt: Date.now() - 9e5, lastActivityAt }));
  const sync = () => importSessions({ sessions, projects, db: dbFile, claudeHome: home })[0];
  const placed = path.join(home, "projects", "-workspace-agents-griffin", `${id}.jsonl`);

  say("اول", new Date(Date.now() - 9e5).toISOString());
  desk(Date.now() - 6e5);
  const first = sync();
  assert.equal(first.action, "moved");
  assert.equal(sync().action, "skipped (up to date)");

  say("دوم", new Date(Date.now() - 1e3).toISOString());
  const tick = () => new Promise((r) => setTimeout(r, 5));
  await tick();
  desk(Date.now());
  await tick();
  assert.equal(sync().action, "refreshed");
  assert.ok(fs.readFileSync(placed, "utf8").includes("دوم"), "Desktop's newer transcript replaces the copy");

  fs.rmSync(placed);
  assert.equal(sync().action, "relinked");

  // Desktop gave the session a new Claude id: the same chat, now on the new one.
  const id2 = "55555555-5555-4555-8555-555555555555";
  fs.renameSync(transcript, path.join(path.dirname(transcript), `${id2}.jsonl`));
  fs.writeFileSync(path.join(sessions, "local_a.json"), JSON.stringify({ sessionId: "local_a", cliSessionId: id2, cwd: "/home/x/scratch", title: "t", lastActivityAt: Date.now() - 1 }));
  const renamed = sync();
  assert.equal(renamed.chatId, first.chatId);
  assert.equal(openStore(dbFile).getChat(first.chatId).agent_id, id2);

  const db = openStore(dbFile);
  db.db.prepare("INSERT INTO runs (id, chat_id, status, started_at) VALUES ('r', ?, 'finished', ?)").run(first.chatId, new Date(Date.now() + 1e5).toISOString());
  db.db.close();
  fs.writeFileSync(path.join(sessions, "local_a.json"), JSON.stringify({ sessionId: "local_a", cliSessionId: id2, cwd: "/home/x/scratch", title: "t", lastActivityAt: Date.now() + 3e5 }));
  assert.equal(sync().action, "skipped (continued in Griffin)");
});
