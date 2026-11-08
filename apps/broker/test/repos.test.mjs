import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepoTools, plantedGitConfig, run as runGit } from "../src/repos.mjs";
import { execFileSync } from "node:child_process";

const vault = { item: async () => "tok-123" };

test("clone/fetch/push: the token goes in env, only a chat branch is pushed, nothing overwritten", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-repos-"));
  fs.mkdirSync(path.join(root, "app", ".git"), { recursive: true });
  const calls = [];
  const git = async (args, { cwd, env }) => {
    calls.push({ args, cwd, header: env.GIT_CONFIG_VALUE_0 });
    if (args[0] === "push") return { stdout: "", stderr: "remote: https://gitlab.example.com/g/app/-/merge_requests/new?x=1\n" };
    return { stdout: "main\n", stderr: "" };
  };
  const tools = createRepoTools({ vault, host: "https://gitlab.example.com/", root, git, authorFix: false });

  const pushed = await tools.git_push.execute({ repo: "app", branch: "griffin/ab12cd34" });
  assert.equal(pushed.mergeRequestUrl, "https://gitlab.example.com/g/app/-/merge_requests/new?x=1");
  assert.deepEqual(calls.at(-1).args, ["push", "--porcelain", "origin", "refs/heads/griffin/ab12cd34:refs/heads/griffin/ab12cd34"]);
  assert.equal(calls.at(-1).header, `Authorization: Basic ${Buffer.from("oauth2:tok-123").toString("base64")}`);
  assert.ok(calls.every((c) => !c.args.join(" ").includes("tok-123")), "never in argv");

  await assert.rejects(tools.git_push.execute({ repo: "app", branch: "main" }), /chat branch/);
  // Branches carry the assistant's name; a branch named like a release still is not a chat branch.
  await tools.git_push.execute({ repo: "app", branch: "nova/ab12cd34" });
  assert.deepEqual(calls.at(-1).args, ["push", "--porcelain", "origin", "refs/heads/nova/ab12cd34:refs/heads/nova/ab12cd34"]);
  await assert.rejects(tools.git_push.execute({ repo: "app", branch: "release/2026" }), /chat branch/);
  await assert.rejects(tools.git_push.execute({ repo: "../x", branch: "griffin/ab12cd34" }), /invalid repo/);
  await assert.rejects(tools.git_clone.execute({ project: "g/app" }), /already exists/);
  await assert.rejects(tools.git_clone.execute({ project: "../../etc" }), /group\/name/);

  const cloned = await tools.git_clone.execute({ project: "infra/new-repo" });
  assert.equal(cloned.repo, "new-repo");
  assert.deepEqual(calls.find((c) => c.args[0] === "clone").args, ["clone", "-q", "https://gitlab.example.com/infra/new-repo.git", path.join(root, "new-repo")]);
});

test("git_push with mrTitle opens one Draft MR per branch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-repos-"));
  fs.mkdirSync(path.join(root, "app", ".git"), { recursive: true });
  const git = async (args) => (args[0] === "remote" ? { stdout: "https://gitlab.example.com/root/app.git\n", stderr: "" } : { stdout: "", stderr: "" });
  const seen = [];
  let open = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push(`${init.method || "GET"} ${url}`);
    if (url.includes("/merge_requests?state=opened")) return Response.json(open);
    if (url.endsWith("/merge_requests")) {
      const body = JSON.parse(init.body);
      open = [{ iid: 7, web_url: "https://x/7" }];
      return Response.json({ iid: 7, web_url: "https://x/7", title: body.title });
    }
    return Response.json({ default_branch: "main" });
  };
  const tools = createRepoTools({ vault, host: "https://gitlab.example.com/", root, git, fetchImpl });
  const first = await tools.git_push.execute({ repo: "app", branch: "nova/ab12cd34", mrTitle: "feat: x" });
  assert.equal(first.mergeRequest.iid, 7);
  assert.equal(first.mergeRequest.existing, false);
  assert.ok(seen.some((s) => s.startsWith("POST") && s.includes("root%2Fapp")));
  const again = await tools.git_push.execute({ repo: "app", branch: "nova/ab12cd34", mrTitle: "feat: x" });
  assert.equal(again.mergeRequest.existing, true);
  assert.equal(seen.filter((s) => s.startsWith("POST")).length, 1);
});

// 2026-10-21: a clone an agent left on its own branch logged a refresh error every 10 minutes.
test("git_fetch update leaves a checkout on its own branch alone, ff's a tracking one", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-ff-"));
  const sh = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  sh(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  sh(root, "clone", "-q", "origin.git", "seed");
  sh(path.join(root, "seed"), "commit", "-q", "--allow-empty", "-m", "a");
  sh(path.join(root, "seed"), "push", "-q", "origin", "HEAD:main");
  sh(root, "clone", "-q", "origin.git", "app");
  sh(path.join(root, "seed"), "commit", "-q", "--allow-empty", "-m", "b");
  sh(path.join(root, "seed"), "push", "-q", "origin", "HEAD:main");
  const tools = createRepoTools({ vault, host: "https://gitlab.example.com/", root });
  const ff = await tools.git_fetch.execute({ repo: "app", update: true });
  assert.equal(ff.updated, true);
  sh(path.join(root, "app"), "checkout", "-q", "-b", "sanij/a24c0de2");
  const own = await tools.git_fetch.execute({ repo: "app", update: true });
  assert.deepEqual([own.fetched, own.updated], [true, false]);
  assert.match(own.reason, /not on a branch/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("git_push toDefault: only an allowed project, onto its default branch, never --force", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-repos-"));
  for (const r of ["mohr", "other"]) fs.mkdirSync(path.join(root, r, ".git"), { recursive: true });
  const calls = [];
  const git = async (args, { cwd }) => {
    calls.push({ args, cwd });
    if (args[0] === "remote") return { stdout: `https://gitlab.example.com/${cwd.endsWith("mohr") ? "mahdibagheri/mohr" : "g/other"}.git\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const fetchImpl = async (url) => ({ ok: true, json: async () => ({ default_branch: "master" }), text: async () => "", url });
  const tools = createRepoTools({ vault, host: "https://gitlab.example.com/", root, git, fetchImpl, defaultPush: new Set(["mahdibagheri/mohr"]) });

  const out = await tools.git_push.execute({ repo: "mohr", branch: "navid/ab12cd34", toDefault: true });
  assert.equal(out.target, "master");
  assert.deepEqual(calls.at(-1).args, ["push", "--porcelain", "origin", "refs/heads/navid/ab12cd34:refs/heads/master"]);
  assert.ok(calls.every((c) => !c.args.some((a) => /^(-f|--force)/.test(a) || a.startsWith("+"))), "never forced");

  await assert.rejects(tools.git_push.execute({ repo: "other", branch: "navid/ab12cd34", toDefault: true }), /not allowed/);
  await assert.rejects(tools.git_push.execute({ repo: "mohr", branch: "master", toDefault: true }), /chat branch/);
  // Off by default: no list, no direct push.
  await assert.rejects(createRepoTools({ vault, host: "https://gitlab.example.com/", root, git, fetchImpl, defaultPush: new Set() }).git_push.execute({ repo: "mohr", branch: "navid/ab12cd34", toDefault: true }), /not allowed/);
});

// 2026-10-29: Platform's author watch flagged pushes made with a person's token whose commits said
// «Nova» / «Kian». The branch's new commits go out as the token's user; a colleague's commit already
// on origin keeps its author; the chat's worktree stays clean.
test("git_push re-makes the branch's unpushed commits as the token's user", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-author-"));
  const as = (name, email) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
  const sh = (cwd, env, ...a) => String(execFileSync("git", a, { cwd, stdio: "pipe", env }));
  const sara = as("Sara", "sara@x.ir");
  const nova = as("Nova", "nova@agents.example.org");
  sh(root, sara, "init", "-q", "--bare", "-b", "main", "origin.git");
  sh(root, sara, "clone", "-q", "origin.git", "seed");
  const seed = path.join(root, "seed");
  sh(seed, sara, "commit", "-q", "--allow-empty", "-m", "base");
  sh(seed, sara, "push", "-q", "origin", "HEAD:main");
  sh(seed, sara, "checkout", "-q", "-b", "sara/feature");
  fs.writeFileSync(path.join(seed, "s.txt"), "sara\n");
  sh(seed, sara, "add", "s.txt");
  sh(seed, sara, "commit", "-q", "-m", "sara's work");
  sh(seed, sara, "push", "-q", "origin", "sara/feature");
  sh(root, sara, "clone", "-q", "origin.git", "app");
  const app = path.join(root, "app");
  const wt = path.join(root, "wt");
  sh(app, nova, "worktree", "add", "-q", "-b", "nova/ab12cd34", wt, "origin/main");
  fs.writeFileSync(path.join(wt, "a.txt"), "one\n");
  sh(wt, nova, "add", "a.txt");
  sh(wt, nova, "commit", "-q", "-m", "fix: one\n\nbody line\n\nCo-Authored-By: x <y@z>");
  sh(wt, nova, "merge", "-q", "--no-edit", "origin/sara/feature");
  fs.writeFileSync(path.join(wt, "a.txt"), "two\n");
  sh(wt, nova, "commit", "-q", "-am", "fix: two");
  const before = sh(wt, nova, "log", "--format=%H %B", "-1", "HEAD~2");

  const fetchImpl = async (url) => (String(url).endsWith("/user") ? Response.json({ name: "Alex Example", username: "root", email: "alex@x.ir" }) : new Response("", { status: 404 }));
  const tools = createRepoTools({ vault, host: "https://gitlab.example.com/", root, fetchImpl });
  const out = await tools.git_push.execute({ repo: "app", branch: "nova/ab12cd34" });
  assert.equal(out.pushed, true);
  assert.equal(out.rewritten.length, 3, "two own commits and the merge");
  assert.equal(out.author, "Alex Example <alex@x.ir>");

  const pushedLog = sh(path.join(root, "origin.git"), sara, "log", "--format=%an|%ae|%cn|%ce|%s", "nova/ab12cd34");
  assert.deepEqual(pushedLog.trim().split("\n").sort(), [
    "Alex Example|alex@x.ir|Alex Example|alex@x.ir|fix: two",
    "Alex Example|alex@x.ir|Alex Example|alex@x.ir|Merge remote-tracking branch 'origin/sara/feature' into nova/ab12cd34",
    "Sara|sara@x.ir|Sara|sara@x.ir|sara's work",
    "Alex Example|alex@x.ir|Alex Example|alex@x.ir|fix: one",
    "Sara|sara@x.ir|Sara|sara@x.ir|base",
  ].sort());
  // Same message (body and trailers), same tree; the worktree sees no change.
  assert.equal(sh(wt, nova, "log", "--format=%B", "-1", "HEAD~2"), before.slice(before.indexOf(" ") + 1));
  assert.equal(sh(wt, nova, "status", "--porcelain"), "");
  assert.equal(sh(wt, nova, "rev-parse", "HEAD"), sh(path.join(root, "origin.git"), sara, "rev-parse", "nova/ab12cd34"));

  // Nothing new: nothing re-made.
  const again = await tools.git_push.execute({ repo: "app", branch: "nova/ab12cd34" });
  assert.equal(again.rewritten, undefined);
  // A token whose user cannot be read: pushed as is, and said so.
  fs.writeFileSync(path.join(wt, "a.txt"), "three\n");
  sh(wt, nova, "commit", "-q", "-am", "fix: three");
  const blind = createRepoTools({ vault, host: "https://gitlab.example.com/", root, fetchImpl: async () => new Response("", { status: 403 }) });
  assert.match((await blind.git_push.execute({ repo: "app", branch: "nova/ab12cd34" })).authorCheck, /could not be read/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the broker's git refuses a repo whose own config would run a program (core.fsmonitor), before running it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-planted-"));
  const marker = `${dir}-pwned`;
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const ok = await runGit(["status", "--porcelain"], { cwd: dir, env: process.env, timeout: 20_000 });
  assert.equal(ok.stdout, "");
  execFileSync("git", ["config", "core.fsmonitor", `touch ${marker}; false`], { cwd: dir });
  await assert.rejects(runGit(["status", "--porcelain"], { cwd: dir, env: process.env, timeout: 20_000 }), /core\.fsmonitor/);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(plantedGitConfig("local\tcore.hookspath\nlocal\tfilter.a.clean\nglobal\tfilter.lfs.clean"), ["filter.a.clean"]);
});
