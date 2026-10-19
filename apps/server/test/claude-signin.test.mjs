import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { createClaudeSignin, screen } from "../src/claude-signin.mjs";

const code = "diagnostic-authorization-code#diagnostic-state";
const token = "sk-ant-oat01-" + "synthetic-test-token-".repeat(4);

function terminal(t, { rejectCode = false } = {}) {
  const children = [];
  t.mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.writes = [];
    child.kill = () => { child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL"); };
    let pastedAt = null;
    child.stdin = new Writable({
      write(chunk, encoding, done) {
        const text = chunk.toString();
        child.writes.push(text);
        // Claude's terminal input treats a burst containing code and Return as
        // pasted text. Only a later Return submits the pasted authorization code.
        if (text === code) pastedAt = performance.now();
        if (text === "\r" && pastedAt !== null && performance.now() - pastedAt >= 350) {
          setImmediate(() => child.stdout.write(rejectCode ? "OAuth error: invalid code" : `Your OAuth token (valid for 1 year):\r\n${token}\r\nStore this token securely.`));
        }
        done();
      },
    });
    children.push(child);
    setImmediate(() => child.stdout.write("https://claude.ai/oauth/authorize?state=diagnostic-state"));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return children;
}

test("submits pasted Claude code after the terminal's paste debounce and stores its token", { timeout: 2500 }, async (t) => {
  const children = terminal(t);
  const stored = [];
  const signin = createClaudeSignin({ env: { GRIFFIN_CLAUDE_BIN: "/diagnostic/claude" }, onToken: (...args) => stored.push(args) });
  t.after(() => signin.cancel());
  await signin.start("claude-self");
  assert.deepEqual(await signin.submit("claude-self", code), { ok: true });
  assert.deepEqual(stored, [["claude-self", token]]);
  assert.equal(signin.pending("claude-self"), false);
  assert.deepEqual(children[0].writes, [code, "\r"]);
});

test("a rejected code returns an error instead of waiting for the HTTP timeout", { timeout: 2500 }, async (t) => {
  terminal(t, { rejectCode: true });
  const signin = createClaudeSignin({ env: { GRIFFIN_CLAUDE_BIN: "/diagnostic/claude" }, onToken: () => assert.fail("must not store a token") });
  t.after(() => signin.cancel());
  await signin.start("claude-self");
  await assert.rejects(signin.submit("claude-self", code), /Claude rejected the code/);
  assert.equal(signin.pending("claude-self"), false);
});

test("cancelling a paste does not send a delayed Return to the old or next terminal", async (t) => {
  const children = terminal(t);
  const signin = createClaudeSignin({ env: { GRIFFIN_CLAUDE_BIN: "/diagnostic/claude" }, onToken: () => assert.fail("must not store a token") });
  t.after(() => signin.cancel());
  await signin.start("old-account");
  const submitted = signin.submit("old-account", code);
  const rejected = assert.rejects(submitted, /Claude did not accept the code/);
  signin.cancel();
  await rejected;
  await signin.start("next-account");
  await delay(650);
  assert.deepEqual(children[0].writes, [code]);
  assert.deepEqual(children[1].writes, []);
  assert.equal(signin.pending("next-account"), true);
});

test("a terminal that exits before submission receives no delayed Return", async (t) => {
  const children = terminal(t);
  const signin = createClaudeSignin({ env: { GRIFFIN_CLAUDE_BIN: "/diagnostic/claude" }, onToken: () => assert.fail("must not store a token") });
  t.after(() => signin.cancel());
  await signin.start("claude-self");
  const rejected = assert.rejects(signin.submit("claude-self", code), /Claude did not accept the code/);
  children[0].emit("exit", 1);
  children[0].emit("close", 1);
  await rejected;
  await delay(650);
  assert.deepEqual(children[0].writes, [code]);
});

test("a second submit cannot overwrite an in-flight code exchange", { timeout: 2500 }, async (t) => {
  const children = terminal(t);
  const stored = [];
  const signin = createClaudeSignin({ env: { GRIFFIN_CLAUDE_BIN: "/diagnostic/claude" }, onToken: (...args) => stored.push(args) });
  t.after(() => signin.cancel());
  await signin.start("claude-self");
  const submitted = signin.submit("claude-self", code);
  await assert.rejects(signin.submit("claude-self", code), /already/);
  await submitted;
  assert.deepEqual(stored, [["claude-self", token]]);
  assert.deepEqual(children[0].writes, [code, "\r"]);
});

test("a token printed after exit and wrapped by the terminal is still stored", { timeout: 2500 }, async (t) => {
  const children = terminal(t);
  const stored = [];
  const signin = createClaudeSignin({ env: { GRIFFIN_CLAUDE_BIN: "/diagnostic/claude" }, onToken: (...args) => stored.push(args) });
  t.after(() => signin.cancel());
  await signin.start("claude-self");
  const child = children[0];
  child.stdin.write = (text) => {
    if (text !== "\r") return true;
    child.emit("exit", 0);
    // The previous frame left "o" where the token's "o" goes; the redraw jumps over it (\x1b[1C).
    child.stdout.write(`\r\n\x1b7\r\n       o\x1b8Your OAuth token (valid for 1 year):\r\n${token.slice(0, 7)}\x1b[1C${token.slice(8, 30)}\r\n\x1b[33m${token.slice(30)}\x1b[39m\r\nStore this token securely.`);
    setImmediate(() => child.emit("close", 0));
    return true;
  };
  assert.deepEqual(await signin.submit("claude-self", code), { ok: true });
  assert.deepEqual(stored, [["claude-self", token]]);
});

test("screen keeps what cursor moves jump over", () => {
  assert.equal(screen("Paste\x1b[1Ccode\x1b[2G\r\nab\x1b[Kc\x1b[4G!"), "Paste code\nabc!");
  assert.equal(screen("old line\r\x1b[2Knew"), "new");
});
