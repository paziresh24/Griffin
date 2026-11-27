// Every chat answers in Persian (owner 2026-10-25/28: «چرا … انگلیسی جواب میدن؟»): Claude Code's own
// language setting, a Persian note on every user turn, and its «hasn't heard from you» nudge in Persian.
import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeProvider, ENGLISH_ANSWER_NUDGE, LANGUAGE_NOTE, mostlyEnglish, REPLY_LANGUAGE, SILENT_TURN_REMINDER } from "../src/providers/claude.mjs";

async function optionsOf(extra = {}) {
  const seen = [];
  const queryImpl = ({ prompt, options }) => {
    seen.push(options);
    return (async function* () {
      for await (const _ of prompt) break;
      const id = options.resume || options.sessionId;
      yield { type: "system", subtype: "init", session_id: id, mcp_servers: [] };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: id };
    })();
  };
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({ cwd: "/tmp", ...extra });
  await (await agent.send("وضعیت دیسک نودهای مبین چطوره؟")).wait();
  return seen[0];
}

const persian = /[؀-ۿ]/;

for (const [name, extra] of [
  ["a chain the owner did not start", {}],
  ["the owner's own chat", { fileAccess: { read: ["/tmp"], write: ["/tmp"], deny: [] } }],
  ["the owner's full Claude Code", { fileAccess: { read: ["/tmp"], write: ["/tmp"], deny: [] }, claudeCode: true }],
]) {
  test(`${name}: Persian note on every turn and Persian nudge (settings.language off by default)`, async () => {
    const o = await optionsOf(extra);
    assert.equal(o.settings?.language, undefined);
    assert.equal(o.env.CLAUDE_CODE_SILENT_TURN_REMINDER_TEXT, SILENT_TURN_REMINDER);
    assert.match(SILENT_TURN_REMINDER, persian);
    const entries = o.hooks.UserPromptSubmit;
    assert.ok(entries?.length, "a UserPromptSubmit hook");
    const outs = [];
    for (const entry of entries) for (const hook of entry.hooks) outs.push(await hook({ hook_event_name: "UserPromptSubmit", prompt: "سلام" }));
    const note = outs.map((out) => out?.hookSpecificOutput).find((h) => h?.hookEventName === "UserPromptSubmit");
    assert.equal(note.additionalContext, LANGUAGE_NOTE);
    assert.match(LANGUAGE_NOTE, persian);
  });
}

test("CLAUDE_LANGUAGE_FLAG=on sends settings.language explicitly when opted in", async () => {
  const prev = process.env.GRIFFIN_CLAUDE_LANGUAGE_FLAG;
  process.env.GRIFFIN_CLAUDE_LANGUAGE_FLAG = "on";
  try {
    const o = await optionsOf({});
    assert.equal(o.settings.language, REPLY_LANGUAGE);
  } finally {
    if (prev === undefined) delete process.env.GRIFFIN_CLAUDE_LANGUAGE_FLAG;
    else process.env.GRIFFIN_CLAUDE_LANGUAGE_FLAG = prev;
  }
});

test("mostlyEnglish: an English answer yes; Persian with identifiers, code and short lines no", () => {
  assert.equal(mostlyEnglish("The support errors are gone. Almost all remaining Arvan errors now come from foreign POPs."), true);
  assert.equal(mostlyEnglish("I'm waiting for the stability check. It will report back in about ۸ minutes."), true);
  assert.equal(mostlyEnglish("خطای `katibe-adaptor` و patient-dr و p24vclinic رفع شد و hook0-output-worker هم سالم است."), false);
  assert.equal(mostlyEnglish("نتیجه:\n```\nThe quick brown fox jumps over the lazy dog again and again and again\n```"), false);
  assert.equal(mostlyEnglish("Done."), false);
});

test("the owner's chat: the turn's end sends an English answer back once", async () => {
  const o = await optionsOf({ fileAccess: { read: ["/tmp"], write: ["/tmp"], deny: [] }, claudeCode: true, backgroundTasks: true });
  const stop = async (input) => {
    for (const entry of o.hooks.Stop) for (const hook of entry.hooks) {
      const out = await hook({ hook_event_name: "Stop", ...input });
      if (out?.decision) return out;
    }
    return null;
  };
  const english = "The support errors are gone. Almost all remaining Arvan errors now come from foreign POPs.";
  assert.deepEqual(await stop({ last_assistant_message: english }), { decision: "block", reason: ENGLISH_ANSWER_NUDGE });
  assert.equal(await stop({ last_assistant_message: english, stop_hook_active: true }), null, "once");
  assert.equal(await stop({ last_assistant_message: "خطاهای ساپورت رفع شد." }), null);
});
