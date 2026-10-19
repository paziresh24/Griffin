import test from "node:test";
import assert from "node:assert/strict";
import { setupPrompt } from "../src/setup-prompt.mjs";

test("setup prompt names the install, its gaps and where the token is, but carries no secret", () => {
  const text = setupPrompt({ origin: "https://g.example", dataDir: "/data", missing: ["an AI engine"], name: "نیلا" });
  assert.match(text, /https:\/\/g\.example/);
  assert.match(text, /- an AI engine/);
  assert.match(text, /\/data\/owner\.token/);
  assert.match(text, /نیلا/);
  assert.doesNotMatch(text, /grf_|sk-ant-oat01-[A-Za-z0-9]{10}/);
});

test("setup prompt names the install's product (a Karsara-look install says Karsara)", () => {
  const text = setupPrompt({ origin: "https://k.example", dataDir: "/data", product: "Karsara" });
  assert.match(text, /^Finish setting up Karsara/);
  assert.doesNotMatch(text, /Griffin/);
});

test("setup prompt holds only the steps the owner chose", () => {
  const base = { origin: "https://g.example", dataDir: "/data", name: "نیلا", claudeHome: "/data/home/.claude" };
  const zai = setupPrompt({ ...base, choices: { agent: "claude", engine: "zai", proxy: "none", secrets: "ask", transfer: [] } });
  assert.match(zai, /preset":"zai"/);
  assert.doesNotMatch(zai, /signin|import\/upload|mcp-servers|PUT \/api\/secrets/);
  assert.match(zai, /Ask me for the key/);
  assert.match(zai, /already saved/);
  const all = setupPrompt({ ...base, choices: { agent: "claude", engine: "claude-sub", proxy: "move", secrets: "move", transfer: ["chats", "memory", "skills", "mcp"] } });
  assert.match(all, /claude\/signin/);
  assert.match(all, /import\/upload/);
  assert.match(all, /\/data\/home\/\.claude\/skills/);
  assert.match(all, /PUT \/api\/mcp-servers/);
  assert.match(all, /PUT \/api\/secrets/);
  assert.match(all, /same proxy/);
  const cursor = setupPrompt({ ...base, choices: { agent: "cursor", transfer: ["chats", "skills"] } });
  assert.match(cursor, /can't be imported/);
  assert.doesNotMatch(cursor, /Skills:/);
});

test("a section prompt holds only that step; ZCode can bring Claude chats over", () => {
  const base = { origin: "https://g.example", dataDir: "/data", name: "نیلا", claudeHome: "/data/home/.claude" };
  const imp = setupPrompt({ ...base, choices: { agent: "zcode", section: "import" } });
  assert.match(imp, /^Set up one part of Griffin/);
  assert.match(imp, /import\/upload/);
  assert.match(imp, /ZCode's own chat history can't be imported/);
  assert.doesNotMatch(imp, /providers\/claude|setup\/proxy|setup\/done|telegram-account/);
  const tg = setupPrompt({ ...base, choices: { agent: "claude", section: "telegram" } });
  assert.match(tg, /BotFather/);
  assert.match(tg, /telegram-account\/login/);
  assert.match(tg, /needPassword/);
  assert.doesNotMatch(tg, /import\/upload|setup\/done/);
  const full = setupPrompt({ ...base, choices: { agent: "claude", transfer: ["chats"] } });
  assert.doesNotMatch(full, /can't be imported/);
});

test("the install's access note leads the prompt, so the agent looks there first", () => {
  const text = setupPrompt({ origin: "https://k.example", dataDir: "/data", access: "Infisical project alice, prod, /capsule-karsara: CAPSULE_KARSARA_HOST/USER/PASSWORD, KARSARA_OWNER_TOKEN" });
  assert.match(text, /Where my access is .*\/capsule-karsara/);
  assert.ok(text.indexOf("Where my access is") < text.indexOf("Auth: every"));
  assert.doesNotMatch(setupPrompt({ origin: "https://k.example", dataDir: "/data" }), /Where my access is/);
});
