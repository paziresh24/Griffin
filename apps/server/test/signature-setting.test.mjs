// The Telegram signature is per install: one setting, SIGNATURE, whose default is built from the
// install's own name («— <assistant name>»). The agent detector recognises free-form signatures: this
// install's own, those of known peers, and the «— name، دستیارِ owner · product» shape.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-signature-"));
process.env.GRIFFIN_DATA = dir;
for (const key of ["GRIFFIN_ASSISTANT_NAME", "GRIFFIN_ASSISTANT_LATIN", "GRIFFIN_PRODUCT", "GRIFFIN_SIGNATURE"]) delete process.env[key];
const { openStore } = await import("../src/db.mjs");
const persona = await import("../src/persona.mjs");
const { setConfigOverrides } = await import("../src/env.mjs");
const { agentFooter, withAgentFooter, signedByAgent } = await import("../src/integrations/format.mjs");
const { looksAssistantSigned } = await import("../src/integrations/peer-agent.mjs");
const { identity, teamContext } = await import("../src/prompt.mjs");

const store = openStore(path.join(dir, "t.sqlite"));
persona.bindPersonaStore?.(store);
let config = {};
setConfigOverrides(() => config);

function namedInstall() {
  config = {};
  store.setKv("persona", { name: "نیلو", latin: "Nilu" });
  store.setKv("profile", { name: "سارا" });
}

test("by default the signature is the install's own name: its messages are «— نیلو»", () => {
  namedInstall();
  assert.equal(agentFooter(), "— نیلو");
  assert.equal(withAgentFooter("سلام"), "سلام\n\n— نیلو");
  // Older signatures are replaced by this install's own.
  assert.equal(withAgentFooter("سلام\n\n— گریفین"), "سلام\n\n— نیلو");
  assert.equal(withAgentFooter("سلام\n— نیلو (فقط سارا می‌داند)"), "سلام\n\n— نیلو");
  assert.equal(withAgentFooter(""), "— نیلو");
  // The prompt promises the signature that actually goes out.
  assert.ok(identity().includes("«— نیلو»"));
  assert.ok(!identity().includes("دستیارِ سارا"));
  // Choosing the Karsara product does not change the signature by itself.
  config = { PRODUCT: "karsara" };
  assert.equal(agentFooter(), "— نیلو");
});

test("SIGNATURE in Configuration replaces the signature, free-form or with {name}/{owner}/{product}", () => {
  namedInstall();
  config = { SIGNATURE: "🤖 پیام خودکارِ سپیده" };
  assert.equal(withAgentFooter("سلام"), "سلام\n\n🤖 پیام خودکارِ سپیده");
  assert.equal(withAgentFooter(withAgentFooter("سلام")), "سلام\n\n🤖 پیام خودکارِ سپیده");
  assert.ok(signedByAgent("سلام\n\n🤖 پیام خودکارِ سپیده"));
  assert.ok(teamContext().includes("🤖 پیام خودکارِ سپیده"));

  config = { SIGNATURE: "— {name}، دستیارِ {owner} · {product}", PRODUCT: "karsara" };
  assert.equal(agentFooter(), "— نیلو، دستیارِ سارا · کارسرا");
  // The name is read live: a rename shows on the next message.
  store.setKv("persona", { name: "سپیده" });
  assert.equal(withAgentFooter("باشه"), "باشه\n\n— سپیده، دستیارِ سارا · کارسرا");
  config = {};
  assert.equal(agentFooter(), "— سپیده");
});

test("the detector knows this install's own signature, known peers' names and the «name، دستیارِ owner · product» shape, never a person's name", () => {
  namedInstall();
  config = { SIGNATURE: "🤖 پیام خودکارِ نیلو" };
  // This install's own configured signature (another install configured the same way).
  assert.ok(looksAssistantSigned("گزارش آماده است\n\n🤖 پیام خودکارِ نیلو"));
  // The «name، دستیارِ owner · product» shape, whatever the agent is called.
  assert.ok(looksAssistantSigned("باشه\n\n— سپیده، دستیارِ کاظمی · کارسرا"));

  // A peer whose MCP token is labelled with its assistant's name signs with just that name.
  assert.ok(!looksAssistantSigned("سلام\n\n— نسیم"), "an unknown name is a person's");
  store.createPeerUser({ id: "bob", label: "رضا کاظمی" });
  store.addPeerClient({ id: "c1", userId: "bob", label: "نسیم", tokenHash: "h1" });
  assert.ok(looksAssistantSigned("سلام\n\n— نسیم"));
  assert.ok(looksAssistantSigned("سلام\n— نسیم‏"));
  // A revoked token no longer vouches for the name.
  store.revokePeerClient("bob", "c1");
  assert.ok(!looksAssistantSigned("سلام\n\n— نسیم"));

  // A person's message that merely ends in a name (or names the peer mid-text) is never an agent's.
  store.addPeerClient({ id: "c2", userId: "bob", label: "نسیم", tokenHash: "h2" });
  for (const text of ["سلام\n— علی", "ممنون\n— رضا کاظمی", "سلام\n— کارسرا", "به نسیم بگو\n— رضا", "— نسیم گفت انجام شد", "سلام\n— نسیم جان"]) {
    assert.ok(!looksAssistantSigned(text), text);
  }
});

test("no message text lost, no person taken for an agent, one signature in every prompt", async () => {
  namedInstall();
  // A body list line that looks like a signature stays.
  const list = "افراد دسترسی‌دار:\n— مریم احمدی، دستیار دکتر رضایی\n— علی، منشی\nبقیه ندارند.";
  assert.equal(withAgentFooter(list), `${list}\n\n— نیلو`);
  // With the default signature, a person's message ending in the assistant's name is not an agent's.
  for (const text of ["ممنون\n— نیلو", "ممنون\n— نيلو"]) assert.ok(!looksAssistantSigned(text), text);
  // A bare-name SIGNATURE never cuts a message that starts with the name.
  config = { SIGNATURE: "{name}" };
  assert.equal(withAgentFooter("نیلو (من) فکر می‌کنم\nخط دوم"), "نیلو (من) فکر می‌کنم\nخط دوم\n\nنیلو");
  assert.ok(!looksAssistantSigned("سلام\nنیلو"));
  // One line, bounded; an unknown owner leaves no empty «دستیارِ».
  config = { SIGNATURE: `— {name}\n${"x".repeat(300)}` };
  assert.ok(!agentFooter().includes("\n") && agentFooter().length <= 120);
  store.setKv("profile", { name: "" });
  config = { SIGNATURE: "— {name}، دستیارِ {owner} · {product}" };
  if (!persona.ownerSignatureName()) assert.equal(agentFooter(), "— نیلو · گریفین");
  // The mother-chat prompt promises the signature that goes out.
  config = { SIGNATURE: "— {name} (پیام خودکار)" };
  const { motherContext } = await import("../src/integrations/mother.mjs");
  assert.ok(motherContext("علی").includes("«— نیلو (پیام خودکار)»"));
  // Device and generated token labels, and a label that is the person's own name, are not agent names.
  config = {};
  store.createPeerUser({ id: "ali", label: "علی" });
  store.addPeerClient({ id: "d1", userId: "ali", label: "لپ‌تاپ (کار)", tokenHash: "d1" });
  store.addPeerClient({ id: "d2", userId: "ali", label: "علی", tokenHash: "d2" });
  store.addPeerClient({ id: "d3", userId: "ali", label: "علی رضایی (invite)", tokenHash: "d3" });
  for (const text of ["سلام\n— علی", "سلام\n— لپ‌تاپ (کار)", "سلام\n— علی رضایی (invite)"]) assert.ok(!looksAssistantSigned(text), text);
});
