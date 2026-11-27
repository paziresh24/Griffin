import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkspaceTools } from "../src/workspace-tools.mjs";

function makeTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-tools-"));
  const ws = path.join(root, "workspace", "agents", "griffin");
  const mem = path.join(root, "claude", "projects", "-workspace-agents-griffin", "memory");
  const know = path.join(ws, "knowledge-inside");
  fs.mkdirSync(path.join(ws, "hami-tools"), { recursive: true });
  fs.mkdirSync(mem, { recursive: true });
  fs.mkdirSync(know, { recursive: true });

  fs.writeFileSync(path.join(ws, "hami-tools", "PLAYBOOK.md"), "# Playbook\nline 2: send only via safe.mjs\nline 3: check 2h window\n");
  fs.writeFileSync(path.join(ws, "notes.txt"), "hello world\n");
  fs.writeFileSync(path.join(ws, ".env"), "API_SECRET=supersecret\n");
  fs.writeFileSync(path.join(ws, "hami-tools", "api-token.json"), "{\"token\":\"123\"}\n");
  fs.writeFileSync(path.join(know, "secret-note.md"), "should be hidden\n");
  fs.writeFileSync(path.join(mem, "MEMORY.md"), "- [Rule](feedback-rule.md) — check ticket status\n");
  fs.writeFileSync(path.join(mem, "feedback-rule.md"), "Never mention the operator first name.\n");
  fs.writeFileSync(path.join(mem, "not-markdown.txt"), "skip me\n");

  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "TOP_SECRET_OUTSIDE\n");
  fs.symlinkSync(outside, path.join(ws, "escape.txt"));
  fs.symlinkSync(outside, path.join(mem, "escape.md"));

  return { root, ws, mem, know, tools: createWorkspaceTools({ workspaceDir: ws, memoryDir: mem, knowledgeRoot: know }) };
}

test("workspace_list shows workspace + memory/*.md and hides secrets, symlinks, and knowledgeRoot", async () => {
  const { root, tools } = makeTempEnv();
  try {
    const res = JSON.parse((await tools.workspace_list.execute({})).content[0].text);
    assert.ok(res.files.includes("memory/"));
    assert.ok(res.files.includes("hami-tools/PLAYBOOK.md"));
    assert.ok(res.files.includes("notes.txt"));
    assert.ok(!res.files.some((f) => f.includes(".env") || f.includes("token") || f.includes("escape") || f.includes("knowledge-inside")));

    const memRes = JSON.parse((await tools.workspace_list.execute({ path: "memory" })).content[0].text);
    assert.deepEqual(memRes.files.sort(), ["memory/MEMORY.md", "memory/feedback-rule.md"].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace_read reads workspace files and memory/*.md with line numbers, and refuses escapes/secrets", async () => {
  const { root, tools } = makeTempEnv();
  try {
    const okWs = JSON.parse((await tools.workspace_read.execute({ path: "hami-tools/PLAYBOOK.md", offset: 2, limit: 2 })).content[0].text);
    assert.equal(okWs.lines, 4);
    assert.deepEqual(okWs.shown, [2, 3]);
    assert.match(okWs.text, /safe\.mjs/);

    const okMem = JSON.parse((await tools.workspace_read.execute({ path: "memory/feedback-rule.md" })).content[0].text);
    assert.match(okMem.text, /Never mention/);

    for (const bad of [".env", "hami-tools/api-token.json", "escape.txt", "memory/escape.md", "../outside.txt", "knowledge-inside/secret-note.md", "memory/not-markdown.txt"]) {
      const r = await tools.workspace_read.execute({ path: bad });
      assert.equal(r.isError, true, `expected ${bad} to be refused`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace_search searches workspace and memory/*.md while skipping secrets", async () => {
  const { root, tools } = makeTempEnv();
  try {
    const res = JSON.parse((await tools.workspace_search.execute({ pattern: "safe\\.mjs|operator" })).content[0].text);
    assert.equal(res.matches.length, 2);
    assert.ok(res.matches.some((m) => m.startsWith("hami-tools/PLAYBOOK.md:2:")));
    assert.ok(res.matches.some((m) => m.startsWith("memory/feedback-rule.md:1:")));

    const sec = JSON.parse((await tools.workspace_search.execute({ pattern: "supersecret|TOP_SECRET" })).content[0].text);
    assert.equal(sec.matches.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
