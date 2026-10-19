import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepoTools } from "../src/repos.mjs";

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
  const tools = createRepoTools({ vault, host: "https://gitlab.example.com/", root, git });

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
