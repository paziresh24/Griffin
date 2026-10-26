import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccountTools } from "../src/integrations/telegram-account.mjs";

// telegram_send {file}: a file from this chat's workspace only (symlinks resolved), regular, ≤ 50MB.
function setup({ networkFirst = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tg-file-"));
  const root = path.join(base, "chat");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "report.pdf"), "%PDF-1.4 hello");
  fs.writeFileSync(path.join(base, "secret.txt"), "outside");
  const calls = [];
  const client = {
    getEntity: async () => ({ id: 42n, firstName: "امیرحسین" }),
    sendMessage: async (_e, opts) => { calls.push({ kind: "message", ...opts }); return { id: 100 + calls.length }; },
    sendFile: async (_e, opts) => { calls.push({ kind: "file", ...opts }); return { id: 100 + calls.length }; },
  };
  function CustomFile(name, size, filePath) { Object.assign(this, { name, size, path: filePath }); }
  const tools = createAccountTools({ getClient: () => client, fileRoots: () => [root], loadCustomFile: async () => CustomFile, networkFirst });
  const send = async (args) => JSON.parse((await tools.telegram_send.execute({ chat: "42", text: "گزارش", ...args })).content[0].text);
  return { base, root, calls, send };
}

test("telegram_send file: a workspace file goes out with sendFile and the text as caption", async () => {
  const { root, calls, send } = setup();
  const done = await send({ file: "report.pdf" });
  assert.equal(done.sent, true);
  assert.equal(done.file, "report.pdf");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "file");
  assert.equal(calls[0].caption, "گزارش");
  assert.equal(calls[0].file.name, "report.pdf");
  assert.equal(calls[0].file.path, fs.realpathSync(path.join(root, "report.pdf")));
  // An absolute path inside the workspace works too.
  assert.equal((await send({ file: path.join(root, "report.pdf") })).sent, true);
});

test("telegram_send file: a path outside the workspace or a symlink out of it sends nothing", async () => {
  const { base, root, calls, send } = setup();
  fs.symlinkSync(path.join(base, "secret.txt"), path.join(root, "link.txt"));
  for (const file of ["../secret.txt", path.join(base, "secret.txt"), "link.txt", "/etc/passwd", "missing.pdf"]) {
    assert.match((await send({ file })).error, /inside this chat's workspace/, file);
  }
  assert.equal(calls.length, 0);
});

test("telegram_send file: a directory or a file over 50MB is refused", async () => {
  const { root, calls, send } = setup();
  fs.mkdirSync(path.join(root, "dir"));
  assert.match((await send({ file: "dir" })).error, /not a regular file/);
  const big = path.join(root, "big.bin");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 50 * 1024 * 1024 + 1); // sparse: no real disk use
  assert.match((await send({ file: "big.bin" })).error, /limit is 52428800/);
  assert.equal(calls.length, 0);
});

test("telegram_send file: a text over one caption goes first as its own message", async () => {
  const { calls, send } = setup();
  const long = "ا".repeat(1500);
  assert.equal((await send({ file: "report.pdf", text: long, replyTo: 7 })).sent, true);
  assert.deepEqual(calls.map((c) => c.kind), ["message", "file"]);
  assert.equal(calls[0].message, long);
  assert.equal(calls[0].replyTo, 7);
  assert.equal(calls[1].caption, "");
});

test("telegram_send file: without fileRoots (API paths) a file is refused; networkFirst sees the file", async () => {
  const tools = createAccountTools({ getClient: () => ({ getEntity: async () => ({ id: 1n }) }) });
  const r = JSON.parse((await tools.telegram_send.execute({ chat: "1", text: "x", file: "a.pdf" })).content[0].text);
  assert.match(r.error, /not available on this path/);

  const seen = [];
  const { calls, send } = setup({ networkFirst: async (a) => { seen.push(a); throw new Error("text only"); } });
  assert.match((await send({ file: "report.pdf" })).error, /text only/);
  assert.equal(seen[0].file, "report.pdf");
  assert.equal(calls.length, 0);
});
