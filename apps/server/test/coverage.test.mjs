import test from "node:test";
import assert from "node:assert/strict";
import {
  coverageCommand,
  coverageContextPrompt,
  coverageIntroPrompt,
  coverageReplyPrompt,
  coverageOwnerNote,
  createEndAgentTool,
  guardTeamTools,
  isDestructiveShell,
  isDestructiveSql,
  isYes,
} from "../src/integrations/coverage.mjs";
import { createAsks } from "../src/asks.mjs";

test("coverageCommand: only /agent and /agent off", () => {
  assert.equal(coverageCommand("/agent"), "start");
  assert.equal(coverageCommand("  /agent  "), "start");
  assert.equal(coverageCommand("/agent off"), "end");
  assert.equal(coverageCommand("/AGENT OFF"), "end");
  assert.equal(coverageCommand("ایجنت"), null);
  assert.equal(coverageCommand("پوشش"), null);
  assert.equal(coverageCommand("خودم"), null);
  assert.equal(coverageCommand("/agent please"), null);
  assert.equal(coverageCommand("پلتفرم‌بان /agent"), null);
});

test("intro and coverage prompts tell the agent to speak for itself", () => {
  const intro = coverageIntroPrompt("علی");
  assert.match(intro, /علی/);
  assert.match(intro, /معرفی/);
  assert.match(intro, /ابزار صدا نزن/);
  assert.match(intro, /Owner/);
  const focus = coverageReplyPrompt("کریمی", "اشتباه نمیکنه؟", ["Owner: پوش با نام نویسندهٔ اشتباه — توکن @skarimi", "همکار: اشتباه نمیکنه؟"]);
  assert.match(focus, /اشتباه نمیکنه؟/);
  assert.match(focus, /توکن @skarimi/, "the conversation around the replied message is included");
  assert.match(focus, /نپرس «کدوم پیام؟»/);
  assert.doesNotMatch(focus, /قربونت/);
  assert.match(focus, /پیدا نکردم/);
  const note = coverageOwnerNote("سارا کریمی", "پاسخ داد سارا");
  assert.match(note, /^«Owner از داخل گریفین — برای تو، نه برای سارا کریمی»: پاسخ داد سارا$/);
  assert.doesNotMatch(focus, /معرفی کن/);
  const ctx = coverageContextPrompt("احمدی", ["همکار: لاگ hook0 را چک کن", "Owner: /agent"]);
  assert.match(ctx, /تاریخچه/);
  assert.match(ctx, /hook0/);
  assert.match(ctx, /نمی‌تواند مستقیم/);
});

test("end_agent tool notifies onEnd", async () => {
  let note = null;
  const tool = createEndAgentTool({ onEnd: (n) => { note = n; } });
  const result = await tool.execute({ note: "done" });
  assert.equal(note, "done");
  assert.match(result.content[0].text, /"ended":true/);
});

test("destructive SQL is refused; normal select is not", () => {
  assert.equal(isDestructiveSql("DROP DATABASE hami"), true);
  assert.equal(isDestructiveSql("truncate table x"), true);
  assert.equal(isDestructiveSql("DELETE FROM users;"), true);
  assert.equal(isDestructiveSql("SELECT * FROM users LIMIT 10"), false);
  assert.equal(isDestructiveSql("DELETE FROM users WHERE id = 1"), false);
});

test("destructive shell is refused; normal diagnostics are not", () => {
  assert.equal(isDestructiveShell("rm -rf /"), true);
  assert.equal(isDestructiveShell("mkfs.ext4 /dev/sda"), true);
  assert.equal(isDestructiveShell("reboot"), true);
  assert.equal(isDestructiveShell("df -h /data0"), false);
  assert.equal(isDestructiveShell("journalctl -u xray -n 50"), false);
});

test("isYes accepts Persian/English affirmatives and selected labels", () => {
  assert.equal(isYes({ answered: true, answer: "بله", selected: ["بله"] }), true);
  assert.equal(isYes({ answered: true, answer: "نه", selected: ["نه"] }), false);
  assert.equal(isYes({ answered: true, answer: "yes" }), true);
  assert.equal(isYes({ answered: false, reason: "stopped" }), false);
});

test("guardTeamTools blocks destructive SQL without asking", async () => {
  const asks = createAsks();
  const tools = {
    pg_query: {
      async execute() {
        return { content: [{ type: "text", text: "ran" }] };
      },
    },
  };
  const guarded = guardTeamTools(tools, { chatId: "c1", asks });
  const result = await guarded.pg_query.execute({ sql: "DROP TABLE secrets", write: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /مخرب/);
});

test("guardTeamTools requires owner yes for write SQL", async () => {
  const asks = createAsks();
  let ran = false;
  const tools = {
    pg_query: {
      async execute() {
        ran = true;
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
  };
  const guarded = guardTeamTools(tools, { chatId: "c2", asks });
  const pending = guarded.pg_query.execute({ sql: "UPDATE x SET a=1", write: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asks.isWaiting("c2"), true);
  asks.answer("c2", { answer: "بله", selected: ["بله"] });
  const result = await pending;
  assert.equal(ran, true);
  assert.equal(result.content[0].text, "ok");
});

test("guardTeamTools lets read-only pg_query through", async () => {
  const asks = createAsks();
  const tools = {
    pg_query: {
      async execute(args) {
        return { content: [{ type: "text", text: JSON.stringify(args) }] };
      },
    },
  };
  const guarded = guardTeamTools(tools, { chatId: "c3", asks });
  const result = await guarded.pg_query.execute({ sql: "SELECT 1" });
  assert.equal(asks.isWaiting("c3"), false);
  assert.match(result.content[0].text, /SELECT 1/);
});

test("guardTeamTools blocks destructive debug_exec; lets diagnostics through", async () => {
  const asks = createAsks();
  const ran = [];
  const tools = {
    debug_exec: {
      async execute(args) {
        ran.push(args.command);
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
  };
  const guarded = guardTeamTools(tools, { chatId: "c5", asks });
  const bad = await guarded.debug_exec.execute({ command: "rm -rf /" });
  assert.equal(bad.isError, true);
  assert.deepEqual(ran, []);
  await guarded.debug_exec.execute({ command: "df -h /data0" });
  assert.deepEqual(ran, ["df -h /data0"]);
  assert.equal(asks.isWaiting("c5"), false);
});

test("telegram_send to covered peer skips confirm; other chats need yes", async () => {
  const asks = createAsks();
  const sent = [];
  const tools = {
    telegram_send: {
      async execute(args) {
        sent.push(args.chat);
        return { content: [{ type: "text", text: "sent" }] };
      },
    },
  };
  const guarded = guardTeamTools(tools, { chatId: "c4", asks, peerChat: "999" });
  await guarded.telegram_send.execute({ chat: "999", text: "hi" });
  assert.deepEqual(sent, ["999"]);
  assert.equal(asks.isWaiting("c4"), false);

  const pending = guarded.telegram_send.execute({ chat: "@other", text: "nope" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asks.isWaiting("c4"), true);
  asks.answer("c4", { answer: "نه", selected: ["نه"] });
  const refused = await pending;
  assert.equal(refused.isError, true);
  assert.deepEqual(sent, ["999"]);
});
