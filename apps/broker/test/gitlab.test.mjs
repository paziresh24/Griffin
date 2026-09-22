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

test("gitlab_propose: new griffin/ branch from the default branch, one commit, a Draft MR, never merge", async () => {
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
    title: "fix(alertmanager): cap telegram messages",
    actions: [{ action: "update", path: "platform/x.yaml", content: "a: 1\n" }],
  });
  assert.equal(out.branch, "griffin/alert-template-cap");
  assert.equal(out.iid, 7);
  const commit = calls.find((c) => c.path.endsWith("/repository/commits"));
  assert.equal(commit.body.branch, "griffin/alert-template-cap");
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
