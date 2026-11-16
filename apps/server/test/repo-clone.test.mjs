import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cloneUrl, isGitUrl, repoNameFromUrl } from "../src/repo-clone.mjs";

test("git URLs are told apart from a GitLab group/name and from local or command transports", () => {
  for (const url of ["https://github.com/paziresh24/Griffin", "https://github.com/a/b.git", "https://gitlab.example.com/g/sub/p.git", "git@github.com:a/b.git", "ssh://git@host.example/a/b"]) assert.ok(isGitUrl(url), url);
  for (const bad of ["group/name", "file:///etc", "/srv/repo", "ext::sh -c id", "https://github.com", "https://x.com/a b", "http://github.com/a/b"]) assert.equal(isGitUrl(bad), false, bad);
  assert.equal(repoNameFromUrl("https://github.com/paziresh24/Griffin.git"), "Griffin");
  assert.equal(repoNameFromUrl("git@github.com:a/my-app.git"), "my-app");
});

test("a URL is cloned under the repos folder with no prompts and local transports off; a failure leaves nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repos-"));
  const calls = [];
  const out = await cloneUrl({ url: "https://github.com/a/tool.git", root, exec: async (args, opts) => { calls.push({ args, opts }); fs.mkdirSync(args.at(-1), { recursive: true }); } });
  assert.deepEqual(out, { repo: "tool", url: "https://github.com/a/tool.git" });
  assert.ok(calls[0].args.includes("protocol.file.allow=never"));
  assert.ok(calls[0].args.includes("protocol.ext.allow=never"));
  assert.equal(calls[0].opts.env.GIT_TERMINAL_PROMPT, "0");
  await assert.rejects(cloneUrl({ url: "https://github.com/a/tool.git", root, exec: async () => {} }), /از قبل هست/);
  await assert.rejects(cloneUrl({ url: "https://github.com/a/priv.git", root, exec: async (args) => { fs.mkdirSync(args.at(-1)); throw new Error("Authentication failed"); } }), /کلون نشد: Authentication failed/);
  assert.equal(fs.existsSync(path.join(root, "priv")), false);
  await assert.rejects(cloneUrl({ url: "file:///etc", root }), /آدرس git معتبر نیست/);
});

test("a real clone from a local bare repo is refused by the file-transport guard", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repos-"));
  await assert.rejects(cloneUrl({ url: `file://${root}`, root }), /معتبر نیست/);
  execFileSync("git", ["--version"]);
});
