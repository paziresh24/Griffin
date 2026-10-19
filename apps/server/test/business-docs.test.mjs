import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { businessDocsConfig, createBusinessDocs, isAllowedDocPath } from "../src/business-docs.mjs";

const hasTool = (p, name) => (p.meta?.allPlatform ? !(p.meta.disabled || []).includes(name) : (p.tools || []).includes(name));

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdocs-"));
  const g = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# agents\n");
  fs.writeFileSync(path.join(dir, "docs", "INDEX.md"), "# نقشه\nچرخِ رشد flywheel\n");
  fs.writeFileSync(path.join(dir, "secret.env"), "TOKEN=abc\n");
  fs.writeFileSync(path.join(dir, "docs", "run.sh"), "SHTOKEN=1\n");
  g("add", "-A"); g("commit", "-q", "-m", "x");
  // a working-tree-only change must never be served
  fs.writeFileSync(path.join(dir, "docs", "INDEX.md"), "uncommitted\n");
  return dir;
}

test("path guard: only AGENTS.md and text files under docs/", () => {
  assert.ok(isAllowedDocPath("AGENTS.md"));
  assert.ok(isAllowedDocPath("docs/flywheel/flywheel-fa.md"));
  for (const bad of ["../etc/passwd", "docs/../secret.env", "/etc/passwd", "secret.env", "griffin.env", "docs/x.sh", "docs\\x.md", ""]) {
    assert.equal(isAllowedDocPath(bad), false, bad);
  }
});

test("read serves the committed ref, not the working tree, and refuses other files", async () => {
  const d = createBusinessDocs({ repoDir: repo(), ref: "main", fetch: false });
  const ok = (await d.read("docs/INDEX.md"));
  assert.ok(!ok.isError);
  assert.match(ok.content[0].text, /flywheel/);
  assert.doesNotMatch(ok.content[0].text, /uncommitted/);
  assert.ok((await d.read("secret.env")).isError);
  assert.ok((await d.read("docs/../secret.env")).isError);
  assert.ok((await d.read("docs/missing.md")).isError);
});

test("search finds Persian and English text only inside AGENTS.md and docs/", async () => {
  const d = createBusinessDocs({ repoDir: repo(), ref: "main", fetch: false });
  assert.match((await d.search("flywheel")).content[0].text, /^docs\/INDEX\.md:2:/m);
  assert.match((await d.search("چرخ")).content[0].text, /docs\/INDEX\.md/);
  assert.match((await d.search("TOKEN")).content[0].text, /no match/);
  assert.match((await d.search("SHTOKEN")).content[0].text, /no match/); // a type read() refuses is not searched either
  assert.ok((await d.search("a")).isError);
});

test("long files come in parts with an offset", async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "docs", "big.md"), "x".repeat(70_000));
  spawnSync("git", ["-C", dir, "add", "-A"]); spawnSync("git", ["-C", dir, "commit", "-q", "-m", "big"]);
  const d = createBusinessDocs({ repoDir: dir, ref: "main", fetch: false });
  const first = (await d.read("docs/big.md")).content[0].text;
  assert.match(first, /offset=60000/);
  const second = (await d.read("docs/big.md", 60000)).content[0].text;
  assert.equal(second.length, 10000);
});

test("off by default: no repo, no tools, no names, no prompt label, profiles untouched", async () => {
  const { businessDocsFeature } = await import("../src/business-docs.mjs");
  const { openStore } = await import("../src/db.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdocs-off-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  try {
    const before = store.getAgentProfile("griffin");
    for (const config of [null, { repoDir: path.join(dir, "missing"), label: "x" }]) {
      const f = businessDocsFeature({ config, store });
      assert.deepEqual(Object.keys(f.tools()), [], JSON.stringify(config));
      assert.deepEqual(f.names, []);
      assert.equal(f.promptLabel, "");
    }
    assert.deepEqual(store.getAgentProfile("griffin"), before, "profiles untouched");
    assert.ok(!(before.tools || []).includes("business_docs_search"), "the built-in profile does not list them");
    const { APP_TOOL_NAMES } = await import("../src/agents/profiles.mjs");
    assert.ok(!APP_TOOL_NAMES.includes("business_docs_search") && !APP_TOOL_NAMES.includes("business_docs_read"), "not in the app catalog");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("on: the tools, their names for the catalog, the label, and the owner's profile gets them once", async () => {
  const { businessDocsFeature } = await import("../src/business-docs.mjs");
  const { openStore } = await import("../src/db.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdocs-on-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  try {
    const f = businessDocsFeature({ config: { repoDir: repo(), label: "مستندات کسب‌وکار نمونه" }, store, ref: "main", fetch: false });
    assert.deepEqual(Object.keys(f.tools()).sort(), ["business_docs_read", "business_docs_search"]);
    assert.deepEqual(f.names, ["business_docs_search", "business_docs_read"]);
    assert.equal(f.promptLabel, "مستندات کسب‌وکار نمونه");
    assert.match(f.tools().business_docs_search.description, /مستندات کسب‌وکار نمونه/);
    assert.ok(hasTool(store.getAgentProfile("griffin"), "business_docs_read"));
    // An owner who later turns them off keeps them off: enabled once only.
    store.disableAgentTools("griffin", ["business_docs_search", "business_docs_read"]);
    businessDocsFeature({ config: { repoDir: repo(), label: "x" }, store, ref: "main", fetch: false });
    const p = store.getAgentProfile("griffin");
    assert.ok(!hasTool(p, "business_docs_read"), "turned off stays off");
    assert.match((await f.tools().business_docs_read.execute({ path: "docs/INDEX.md" })).content[0].text, /flywheel/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("descriptions carry the instance's label and no person's name by default", () => {
  const d = createBusinessDocs({ repoDir: repo(), ref: "main", fetch: false });
  const text = JSON.stringify(d.tools());
  assert.doesNotMatch(text, /آقای|خانم|\bMr\.|\bMrs\./);
  assert.match(text, /the business docs repo/);
});

test("git runs without blocking the server and is cut off by its timeout", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bdocs-bin-"));
  const fake = path.join(bin, "git");
  fs.writeFileSync(fake, "#!/bin/sh\nexec sleep 5\n");
  fs.chmodSync(fake, 0o755);
  const d = createBusinessDocs({ repoDir: bin, ref: "main", fetch: false, gitBin: fake, gitTimeoutMs: 300 });
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 20);
  const started = Date.now();
  const pending = d.read("docs/INDEX.md");
  assert.ok(pending instanceof Promise, "read is asynchronous");
  const result = await pending;
  clearInterval(timer);
  assert.ok(result.isError);
  assert.ok(Date.now() - started < 3000, "the timeout cut it off");
  assert.ok(ticks >= 5, `the event loop kept running (${ticks} ticks)`);
  fs.rmSync(bin, { recursive: true, force: true });
});

test("the switch: GRIFFIN_BUSINESS_DOCS_REPO names the checkout, GRIFFIN_BUSINESS_DOCS_LABEL its name; unset is off", () => {
  const read = (vars) => (key, fallback) => vars[key] ?? fallback;
  assert.equal(businessDocsConfig(read({})), null);
  assert.equal(businessDocsConfig(read({ BUSINESS_DOCS_REPO: "  " })), null);
  assert.deepEqual(businessDocsConfig(read({ BUSINESS_DOCS_REPO: "/srv/docs" })), { repoDir: "/srv/docs", label: "the business docs repo" });
  assert.equal(businessDocsConfig(read({ BUSINESS_DOCS_REPO: "/srv/docs", BUSINESS_DOCS_LABEL: " مستندات " })).label, "مستندات");
});

test("the prompt names the tools only on an install that has them", async () => {
  const { buildRules } = await import("../src/prompt.mjs");
  assert.doesNotMatch(buildRules({ agent: "griffin" }), /business_docs_search/);
  assert.match(buildRules({ agent: "griffin", businessDocsLabel: "مستندات نمونه" }), /business_docs_search \/ business_docs_read read مستندات نمونه/);
});

test("a new colleague's default quota reads the business docs only on an install that has them", async () => {
  const { createPeerAuth } = await import("../src/peer-auth.mjs");
  const { openStore } = await import("../src/db.mjs");
  for (const businessDocs of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdocs-peer-"));
    const store = openStore(path.join(dir, "db.sqlite"));
    try {
      const auth = createPeerAuth({ store, businessDocs });
      auth.createUser({ id: "colleague", label: "Colleague" });
      const tools = store.getAgentProfile("griffin").meta.callers["peer:colleague"].tools;
      assert.equal(tools.includes("business_docs_search") && tools.includes("business_docs_read"), businessDocs, String(businessDocs));
      assert.ok(tools.includes("knowledge_list"), "the usual quota stays");
      const other = store.getAgentProfile("platform")?.meta?.callers?.["peer:colleague"]?.tools || [];
      assert.ok(!other.includes("business_docs_read"), "only the main assistant");
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("GET /api/chats carries NEXT_STEP_RETURNS for the composer: off by default", async () => {
  const { createApp } = await import("../src/app.mjs");
  const { openStore } = await import("../src/db.mjs");
  const { CONFIG_SCHEMA } = await import("../src/config.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextstep-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  try {
    assert.equal((await (await createApp({ store, runner: {}, asks: {} }).request("/api/chats")).json()).nextStepReturns, false);
    assert.equal((await (await createApp({ store, runner: {}, asks: {}, nextStepReturns: () => true }).request("/api/chats")).json()).nextStepReturns, true);
    const key = CONFIG_SCHEMA.find((k) => k.key === "NEXT_STEP_RETURNS");
    assert.deepEqual([key.options[0], key.live], ["off", true], "a live Settings key, off first");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a tag named origin/main cannot stand in for the remote branch", async () => {
  const dir = repo();
  const g = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("update-ref", "refs/remotes/origin/main", "main");
  g("checkout", "-q", "-b", "side");
  fs.writeFileSync(path.join(dir, "docs", "INDEX.md"), "unreviewed side text\n");
  g("commit", "-q", "-am", "side");
  g("tag", "origin/main", "side");
  const d = createBusinessDocs({ repoDir: dir, fetch: false, log: null });
  const text = (await d.read("docs/INDEX.md")).content[0].text;
  assert.match(text, /flywheel/);
  assert.doesNotMatch(text, /unreviewed/);
  assert.match((await d.search("flywheel")).content[0].text, /^docs\/INDEX\.md:2:/m, "search lines still start at the path");
});

test("a file over the read buffer is said to be too big, not missing; a huge search shows its first matches", async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "docs", "big.csv"), "در,x\n".repeat(2_200_000));
  spawnSync("git", ["-C", dir, "add", "-A"]); spawnSync("git", ["-C", dir, "commit", "-q", "-m", "big"]);
  const d = createBusinessDocs({ repoDir: dir, ref: "main", fetch: false });
  const read = await d.read("docs/big.csv");
  assert.ok(read.isError);
  assert.match(read.content[0].text, /over 8 MB/);
  const found = await d.search("در");
  assert.ok(!found.isError, found.content[0].text);
  assert.match(found.content[0].text, /^docs\/big\.csv:1:/m);
});

test("no Settings label names a person", async () => {
  const { CONFIG_SCHEMA } = await import("../src/config.mjs");
  for (const key of ["NEXT_STEP_RETURNS"]) assert.doesNotMatch(CONFIG_SCHEMA.find((k) => k.key === key).label, /آقای|خانم|\bMr\.|\bMrs\./);
});
