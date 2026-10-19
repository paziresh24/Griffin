import test from "node:test";
import assert from "node:assert/strict";
import { createGitlabTools } from "../src/gitlab.mjs";

function setup() {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.pathname === "/api/v4/search" && u.searchParams.get("scope") === "blobs") {
      return new Response(JSON.stringify({ error: "scope does not have a valid value" }), { status: 400 });
    }
    if (u.pathname === "/api/v4/search" && u.searchParams.get("scope") === "projects") {
      return Response.json([{ id: 1, path_with_namespace: "a/b", web_url: "https://x/a/b" }]);
    }
    if (u.pathname === "/api/v4/projects" && !u.pathname.includes("/search")) {
      return new Response(
        JSON.stringify([
          { id: 10, path_with_namespace: "g/one" },
          { id: 11, path_with_namespace: "g/two" },
        ]),
        { status: 200, headers: { "x-total-pages": "1", "content-type": "application/json" } },
      );
    }
    if (u.pathname === "/api/v4/projects/10/search") {
      return Response.json([{ project_id: 10, path: "package.json", ref: "main", startline: 12, data: '"next": "14.1.0"' }]);
    }
    if (u.pathname === "/api/v4/projects/11/search") {
      return Response.json([]);
    }
    if (u.pathname === "/api/v4/projects/acme%2Fwidget/search") {
      return Response.json([{ project_id: 394, path: "apps/broker/package.json", ref: "main", startline: 1, data: "{}" }]);
    }
    return new Response("nope", { status: 404 });
  };
  return { tools: createGitlabTools({ vault: { item: async () => "tok" }, fetchImpl, host: "https://gitlab.example.com" }), calls };
}

test("global blob search fans out when Advanced Search is off", async () => {
  const { tools, calls } = setup();
  const result = await tools.gitlab_search.execute({ search: '"next": "14.1.0"', scope: "blobs", limit: 10 });
  assert.equal(result.count, 1);
  assert.equal(result.results[0].projectPath, "g/one");
  assert.match(result.results[0].line, /14\.1\.0/);
  assert.equal(result.source, "gitlab fanout /projects");
  assert.ok(calls.some((c) => c.startsWith("/api/v4/search?")));
  assert.ok(calls.some((c) => c.startsWith("/api/v4/projects?")));
  assert.ok(calls.some((c) => c.includes("/projects/10/search")));
});

test("project-scoped blob search does not fan out", async () => {
  const { tools, calls } = setup();
  const result = await tools.gitlab_search.execute({ search: "broker", scope: "blobs", project: "acme/widget" });
  assert.equal(result.count, 1);
  assert.equal(result.source, "gitlab search /projects/acme%2Fwidget/search");
  assert.equal(calls.filter((c) => c.startsWith("/api/v4/projects?") && !c.includes("/search")).length, 0);
});

test("global projects scope still uses /search", async () => {
  const { tools } = setup();
  const result = await tools.gitlab_search.execute({ search: "acme", scope: "projects" });
  assert.equal(result.results[0].path, "a/b");
  assert.equal(result.source, "gitlab search /search");
});

test("gitlab_propose: new <assistant>/ branch from the default branch, one commit, a Draft MR, never merge", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || "GET", path: decodeURIComponent(u.pathname), body: init.body ? JSON.parse(init.body) : null });
    if (u.pathname === "/api/v4/projects/acme%2Finfra" && init.method === "GET") return Response.json({ default_branch: "main" });
    if (u.pathname.includes("/repository/branches/")) return new Response("{}", { status: 404 });
    if (u.pathname.endsWith("/repository/commits")) return Response.json({ short_id: "abc123" });
    if (u.pathname.endsWith("/merge_requests")) return Response.json({ iid: 7, web_url: "https://g/mr/7", state: "opened" });
    return new Response("nope", { status: 404 });
  };
  const tools = createGitlabTools({ vault: { item: async () => "tok" }, fetchImpl, host: "https://gitlab.example.com" });
  const out = await tools.gitlab_propose.execute({
    project: "acme/infra",
    branch: "alert-template-cap",
    prefix: "nova",
    title: "fix(alertmanager): cap telegram messages",
    actions: [{ action: "update", path: "platform/x.yaml", content: "a: 1\n" }],
  });
  assert.equal(out.branch, "nova/alert-template-cap");
  assert.equal(out.iid, 7);
  const commit = calls.find((c) => c.path.endsWith("/repository/commits"));
  assert.equal(commit.body.branch, "nova/alert-template-cap");
  assert.equal(commit.body.start_branch, "main");
  const mr = calls.find((c) => c.path.endsWith("/merge_requests"));
  assert.match(mr.body.title, /^Draft: /);
  assert.ok(!calls.some((c) => c.path.endsWith("/merge")), "never merges");

  await assert.rejects(
    tools.gitlab_propose.execute({ project: "p", branch: "x1y", title: "hello", actions: [{ action: "update", path: "../etc/passwd", content: "" }], targetBranch: "main" }),
    /invalid path/,
  );
});

test("repeated global fanout search is served from cache (no re-scan)", async () => {
  const { tools, calls } = setup();
  const first = await tools.gitlab_search.execute({ search: "cache-me", scope: "blobs", limit: 10 });
  assert.equal(first.cached, undefined);
  const beforeSecond = calls.length;
  const second = await tools.gitlab_search.execute({ search: "cache-me", scope: "blobs", limit: 10 });
  assert.equal(second.cached, true);
  assert.deepEqual(second.results, first.results);
  // The expensive part (listing projects + per-project /search fan-out) must be skipped.
  const afterCalls = calls.slice(beforeSecond);
  assert.ok(!afterCalls.some((c) => c.includes("/projects/10/search")), "no per-project fan-out on a cache hit");
  assert.ok(!afterCalls.some((c) => c.startsWith("/api/v4/projects?")), "no project listing on a cache hit");
});

test("gitlab_pipeline without id lists the project's recent pipelines (no /pipelines/NaN)", async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    paths.push(decodeURIComponent(u.pathname));
    if (u.pathname.endsWith("/pipelines")) return Response.json([{ id: 9, ref: "main", status: "failed", sha: "abcdef123456", created_at: "t1", updated_at: "t2" }]);
    return new Response("nope", { status: 404 });
  };
  const tools = createGitlabTools({ vault: { item: async () => "tok" }, fetchImpl, host: "https://gitlab.example.com" });
  const out = await tools.gitlab_pipeline.execute({ project: "team/app" });
  assert.deepEqual(out.pipelines, [{ id: 9, ref: "main", status: "failed", sha: "abcdef12", createdAt: "t1", updatedAt: "t2" }]);
  assert.ok(!paths.some((p) => p.includes("NaN")));
  await assert.rejects(tools.gitlab_pipeline.execute({ project: "team/app", retryFailed: true }), /id is required/);
});

function repoSetup() {
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i + 1}`).join("\n");
  const diff = (n) => `@@ -1 +1 @@\n-old${n}\n+new${n}\n+more${n}`;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/repository/files/big.mjs/raw")) return new Response(big);
    if (u.pathname === "/api/v4/projects/acme%2Fg/merge_requests/54") return Response.json({ title: "t", state: "opened", source_branch: "s", target_branch: "main", sha: "abc" });
    if (u.pathname === "/api/v4/projects/acme%2Fg/merge_requests/54/diffs") {
      return Response.json([
        { new_path: "a.mjs", old_path: "a.mjs", diff: diff(1) },
        { new_path: "huge.mjs", old_path: "huge.mjs", diff: "+x\n".repeat(40_000) },
        { new_path: "b.mjs", old_path: "b.mjs", new_file: true, diff: diff(2) },
      ]);
    }
    if (u.pathname === "/api/v4/projects/acme%2Fg/repository/compare") return Response.json({ commits: [{ short_id: "c1", title: "x" }], diffs: [{ new_path: "a.mjs", old_path: "a.mjs", diff: diff(3) }] });
    return new Response("nope", { status: 404 });
  };
  return createGitlabTools({ vault: { item: async () => "tok" }, fetchImpl, host: "https://gitlab.example.com" });
}

test("gitlab_file returns a big file in line windows", async () => {
  const tools = repoSetup();
  const first = await tools.gitlab_file.execute({ project: "acme/g", path: "big.mjs", ref: "main" });
  assert.equal(first.totalLines, 4000);
  assert.equal(first.truncated, true);
  assert.equal(first.nextStartLine, 1501);
  const part = await tools.gitlab_file.execute({ project: "acme/g", path: "big.mjs", ref: "main", startLine: 3990, endLine: 3992 });
  assert.equal(part.content, "line 3990\nline 3991\nline 3992");
  assert.equal(part.truncated, undefined);
});

test("gitlab_mr_changes packs diffs, leaves the huge one out, and serves it by path", async () => {
  const tools = repoSetup();
  const all = await tools.gitlab_mr_changes.execute({ project: "acme/g", iid: 54 });
  assert.equal(all.fileCount, 3);
  assert.equal(all.files[0].added, 2);
  assert.equal(all.files[1].diffOmitted, true);
  assert.match(all.files[2].diff, /new2/);
  assert.match(all.note, /path=/);
  const one = await tools.gitlab_mr_changes.execute({ project: "acme/g", iid: 54, path: "huge.mjs" });
  assert.equal(one.files[0].truncated, true);
  const cmp = await tools.gitlab_mr_changes.execute({ project: "acme/g", from: "main", to: "s" });
  assert.equal(cmp.commits[0].id, "c1");
  assert.match(cmp.files[0].diff, /new3/);
  await assert.rejects(() => tools.gitlab_mr_changes.execute({ project: "acme/g", iid: 54, path: "nope.mjs" }), /not among/);
});

test("gitlab_project_member adds a developer, keeps a higher role, rejects bad roles", async () => {
  const writes = [];
  const members = { 7: { access_level: 40 } };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    if (p === "/api/v4/users") return Response.json([{ id: Number(u.searchParams.get("username") === "boss" ? 7 : 8), username: u.searchParams.get("username"), state: "active" }]);
    const m = p.match(/members\/all\/(\d+)$/);
    if (m) return members[m[1]] ? Response.json(members[m[1]]) : new Response("{}", { status: 404 });
    if (p.endsWith("/members") && init.method === "POST") { writes.push(JSON.parse(init.body)); return Response.json({ access_level: 30 }); }
    return new Response("nope", { status: 404 });
  };
  const tools = createGitlabTools({ vault: { item: async () => "tok" }, fetchImpl, host: "https://gitlab.example.com" });
  const added = await tools.gitlab_project_member.execute({ project: "acme/g", username: "newbie", role: "developer" });
  assert.equal(added.changed, true);
  assert.deepEqual(writes, [{ user_id: 8, access_level: 30 }]);
  const kept = await tools.gitlab_project_member.execute({ project: "acme/g", username: "boss", role: "developer" });
  assert.equal(kept.changed, false);
  assert.equal(writes.length, 1);
  await assert.rejects(tools.gitlab_project_member.execute({ project: "acme/g", username: "x", role: "owner" }), /reporter or developer/);
});

function proposeSetup(files, { branchExists = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    calls.push({ method: init.method || "GET", path, ref: u.searchParams.get("ref"), body: init.body ? JSON.parse(init.body) : null });
    if (path === "/api/v4/projects/g/r") return Response.json({ default_branch: "main" });
    if (path.includes("/repository/branches/")) return branchExists ? Response.json({}) : new Response("{}", { status: 404 });
    const raw = path.match(/\/repository\/files\/(.+)\/raw$/);
    if (raw) return files[raw[1]] === undefined ? new Response("nope", { status: 404 }) : new Response(files[raw[1]]);
    if (path.endsWith("/repository/commits")) return Response.json({ short_id: "c1" });
    if (path.endsWith("/merge_requests")) return Response.json({ iid: 9, web_url: "https://g/mr/9", state: "opened" });
    return new Response("nope", { status: 404 });
  };
  return { tools: createGitlabTools({ vault: { item: async () => "tok" }, fetchImpl, host: "https://gitlab.example.com" }), calls };
}

test("gitlab_propose edit: the broker reads the file and changes only the found text", async () => {
  const original = "keys:\n  - A\n  - B\nsecret: ***\nother: 1\n";
  const { tools, calls } = proposeSetup({ "values.yaml": original });
  await tools.gitlab_propose.execute({
    project: "g/r",
    branch: "add-key",
    title: "feat: add key C",
    actions: [{ action: "edit", path: "values.yaml", edits: [{ find: "  - B\n", replace: "  - B\n  - C\n" }] }],
  });
  const commit = calls.find((c) => c.path.endsWith("/repository/commits"));
  assert.equal(commit.body.actions[0].action, "update");
  assert.equal(commit.body.actions[0].content, "keys:\n  - A\n  - B\n  - C\nsecret: ***\nother: 1\n");
  assert.equal(calls.find((c) => c.path.endsWith("/raw")).ref, "main");
});

test("gitlab_propose edit: no match, ambiguous match and missing file are refused; all=true replaces every one", async () => {
  const { tools, calls } = proposeSetup({ "f.txt": "a\na\nb\n" });
  const run = (edits, path = "f.txt") => tools.gitlab_propose.execute({ project: "g/r", branch: "edit-x", title: "edit test", actions: [{ action: "edit", path, edits }] });
  await assert.rejects(run([{ find: "zzz", replace: "y" }]), /not in the file/);
  await assert.rejects(run([{ find: "a\n", replace: "c\n" }]), /occurs 2 times/);
  await assert.rejects(run([{ find: "a", replace: "c" }], "missing.txt"), /does not exist/);
  assert.ok(!calls.some((c) => c.path.endsWith("/repository/commits")), "nothing committed on a refused edit");
  await run([{ find: "a\n", replace: "c\n", all: true }]);
  assert.equal(calls.find((c) => c.path.endsWith("/repository/commits")).body.actions[0].content, "c\nc\nb\n");
});

test("gitlab_propose edit with update=true reads the proposal branch, so a second edit builds on the first", async () => {
  const { tools, calls } = proposeSetup({ "f.txt": "one\n" }, { branchExists: true });
  await tools.gitlab_propose.execute({ project: "g/r", branch: "edit-x", prefix: "nova", title: "second edit", update: true, actions: [{ action: "edit", path: "f.txt", edits: [{ find: "one", replace: "two" }] }] });
  assert.equal(calls.find((c) => c.path.endsWith("/raw")).ref, "nova/edit-x");
});

test("gitlab_propose update refuses a whole-file rewrite that brings in *** the file does not have", async () => {
  const { tools, calls } = proposeSetup({ "v.yaml": "token: real-value\n" });
  await assert.rejects(
    tools.gitlab_propose.execute({ project: "g/r", branch: "rewrite-x", title: "rewrite test", actions: [{ action: "update", path: "v.yaml", content: "token: ***\n" }] }),
    /use action edit|Use action edit/i,
  );
  assert.ok(!calls.some((c) => c.path.endsWith("/repository/commits")));
  // A file that already had *** keeps its count, so a faithful rewrite still goes through.
  const ok = proposeSetup({ "v.yaml": "token: ***\n" });
  await ok.tools.gitlab_propose.execute({ project: "g/r", branch: "rewrite-y", title: "rewrite ok", actions: [{ action: "update", path: "v.yaml", content: "token: ***\nmore: 1\n" }] });
});
