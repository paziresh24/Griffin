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
  await assert.rejects(tools.git_push.execute({ repo: "../x", branch: "griffin/ab12cd34" }), /invalid repo/);
  await assert.rejects(tools.git_clone.execute({ project: "g/app" }), /already exists/);
  await assert.rejects(tools.git_clone.execute({ project: "../../etc" }), /group\/name/);

  const cloned = await tools.git_clone.execute({ project: "infra/new-repo" });
  assert.equal(cloned.repo, "new-repo");
  assert.deepEqual(calls.find((c) => c.args[0] === "clone").args, ["clone", "-q", "https://gitlab.example.com/infra/new-repo.git", path.join(root, "new-repo")]);
});
