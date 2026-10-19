// An install's prompts, tool descriptions and user-visible messages name the configured owner
// (owner.mjs / persona.mjs), never a hard-coded person: the exported builders render it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function render(env, code) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "owner-prompts-"));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { PATH: process.env.PATH, GRIFFIN_DATA: data, ...env },
    cwd: path.join(SRC, ".."),
    encoding: "utf8",
  });
  fs.rmSync(data, { recursive: true, force: true });
  return out;
}

const CODE = `
import { DEFAULT_PEER_MESSAGES } from "./src/peer-limits.mjs";
import { threadOwnerPrompt, sessionLinePrompt } from "./src/integrations/threads.mjs";
import { teamContext } from "./src/prompt.mjs";
console.log(JSON.stringify([DEFAULT_PEER_MESSAGES, threadOwnerPrompt({ name: "x", text: "t" }), sessionLinePrompt({ name: "x", text: "t" }), teamContext({ mother: true }), teamContext({})]));
`;

test("a custom owner renders its own name", () => {
  const out = render({ GRIFFIN_OWNER_NAME: "Sara", GRIFFIN_OWNER_NAME_FA: "سارا" }, CODE);
  assert.ok(out.includes("سارا") || out.includes("Sara"));
});

test("the default install names no one", () => {
  const out = render({}, CODE);
  assert.ok(!out.includes("سارا") && !out.includes("Sara"));
});
