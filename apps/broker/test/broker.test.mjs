import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createKube } from "../src/kube.mjs";
import { TEST_SITE } from "./fixture-site.mjs";
import { createBrokerServer } from "../src/server.mjs";
import { createTools, parseDf, summarize } from "../src/tools.mjs";

const vault = { item: async (slug) => (slug === "kube__token" ? "static-bearer" : "secret") };

const podList = {
  items: [
    { metadata: { name: "seaweedfs-volume-1", namespace: "storage" }, spec: { nodeName: "node-3" }, status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 1 }] } },
    { metadata: { name: "api-7f", namespace: "app" }, spec: {}, status: { phase: "Running", containerStatuses: [{ ready: false, restartCount: 9, state: { waiting: { reason: "CrashLoopBackOff" } } }] } },
  ],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup({ apiUp = true } = {}) {
  const fetches = [];
  const sshCalls = [];
  const fetchImpl = async (url, init) => {
    fetches.push({ url: String(url), auth: init?.headers?.Authorization });
    if (!apiUp) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (String(url).endsWith("/api/v1/pods")) return jsonResponse(podList);
    return jsonResponse({}, 404);
  };
  const sshRun = async (target, command) => {
    sshCalls.push({ target, command });
    if (command.includes("'exec'")) {
      return { stdout: gzipSync("Filesystem      Size  Used Avail Use% Mounted on\n/dev/sdb1       905G  896G  8.6G  99% /data0\n"), stderr: "" };
    }
    assert.match(command, /\| gzip -c$/, "emergency kubectl output is gzipped on the node");
    return { stdout: gzipSync(JSON.stringify(podList)), stderr: "" };
  };
  const kube = createKube({ clusters: TEST_SITE.clusters, vault, sshRun, fetchImpl });
  const tools = createTools({ site: TEST_SITE, kube, vault, sshRun, fetchImpl });
  return { tools, fetches, sshCalls };
}

test("kube_status answers from the public API when it is up", async () => {
  const { tools, fetches, sshCalls } = setup();
  const result = await tools.kube_status.execute({ cluster: "prod" });
  assert.equal(result.counts.total, 2);
  assert.match(result.source, /^public-api /);
  assert.equal(fetches[0].auth, "Bearer static-bearer");
  assert.equal(sshCalls.length, 0);
  assert.deepEqual(result.pods.map((p) => p.name), ["api-7f"], "cluster-wide lists only unhealthy pods");
  assert.equal(result.pods[0].reason, "CrashLoopBackOff");
});

test("kube_status falls back to emergency SSH when the gateway is down", async () => {
  const { tools, sshCalls } = setup({ apiUp: false });
  const result = await tools.kube_status.execute({ cluster: "edge" });
  assert.equal(result.counts.total, 2);
  assert.equal(result.source, "emergency-ssh 203.0.113.20:2222");
  assert.deepEqual(result.attempts.map((a) => [a.path, a.ok]), [["public-api", false], ["emergency-ssh", true]]);
  assert.equal(sshCalls[0].command, "k0s kubectl 'get' 'pods' '-A' '-o' 'json' | gzip -c");
});

test("every failed path is reported", async () => {
  const sshRun = async () => {
    throw new Error("ssh 203.0.113.30: killed (timeout)");
  };
  const kube = createKube({ clusters: TEST_SITE.clusters, vault, sshRun, fetchImpl: async () => { throw new Error("down"); } });
  const failing = createTools({ site: TEST_SITE, kube, vault, sshRun });
  await assert.rejects(failing.kube_status.execute({ cluster: "dr" }), (error) => {
    assert.equal(error.attempts.length, 2);
    assert.equal(error.attempts[1].path, "emergency-ssh");
    return true;
  });
});

test("emergency kubectl failure behind the gzip pipe is reported with stderr", async () => {
  const sshRun = async () => ({ stdout: gzipSync(""), stderr: "error: You must be logged in to the server" });
  const kube = createKube({ clusters: TEST_SITE.clusters, vault, sshRun, fetchImpl: async () => { throw new Error("down"); } });
  const tools = createTools({ site: TEST_SITE, kube, vault, sshRun });
  await assert.rejects(tools.kube_status.execute({ cluster: "prod" }), (error) => {
    assert.match(error.attempts[1].error, /must be logged in/);
    return true;
  });
});

test("inputs that could reach a shell are rejected", async () => {
  const { tools, sshCalls } = setup();
  await assert.rejects(tools.kube_df.execute({ cluster: "prod", namespace: "storage;id", pod: "x" }), /invalid namespace/);
  await assert.rejects(tools.kube_df.execute({ cluster: "prod", namespace: "storage", pod: "x", path: "/data0 $(id)" }), /invalid path/);
  await assert.rejects(tools.kube_get.execute({ cluster: "prod", kind: "secrets" }), /kind must be/);
  await assert.rejects(tools.kube_status.execute({ cluster: "nowhere" }), /cluster must be/);
  assert.equal(sshCalls.length, 0);
});

test("kube_df runs exec over the emergency path and parses df", async () => {
  const { tools, sshCalls } = setup();
  const result = await tools.kube_df.execute({ cluster: "prod", namespace: "storage", pod: "seaweedfs-volume-1", path: "/data0" });
  assert.equal(sshCalls[0].target, TEST_SITE.clusters.prod.emergency);
  assert.equal(sshCalls[0].command, "kubectl 'exec' '-n' 'storage' 'seaweedfs-volume-1' '--' 'df' '-h' '/data0' | gzip -c");
  assert.deepEqual(result.df[0], { filesystem: "/dev/sdb1", size: "905G", used: "896G", available: "8.6G", usePercent: "99%", mount: "/data0" });
  assert.deepEqual(parseDf(""), []);
  // real busybox output from seaweedfs-volume-1 (2026-09-14)
  const wrapped = "Filesystem                Size      Used Available Use% Mounted on\n/dev/mapper/topolvm--vg-b18a93e6\n                        904.5G    895.9G      8.6G  99% /data0\n";
  assert.deepEqual(parseDf(wrapped), [
    { filesystem: "/dev/mapper/topolvm--vg-b18a93e6", size: "904.5G", used: "895.9G", available: "8.6G", usePercent: "99%", mount: "/data0" },
  ]);
});

test("kube_exec quotes the command as one sh -c argument; deployments list env sources", async () => {
  const { tools, sshCalls } = setup();
  await tools.kube_exec.execute({ cluster: "prod", namespace: "ns", pod: "app-1", command: "echo -n \"$T\" | sha256sum; id" });
  assert.equal(sshCalls[0].command, `kubectl 'exec' '-n' 'ns' 'app-1' '--' 'sh' '-c' 'echo -n "$T" | sha256sum; id' | gzip -c`);
  const deploy = summarize("deployments", {
    metadata: { name: "d" },
    spec: { template: { spec: { containers: [{ image: "i", envFrom: [{ secretRef: { name: "s1" } }, { configMapRef: { name: "c1" } }], env: [{ name: "X", valueFrom: { secretKeyRef: { name: "s2", key: "k" } } }] }] } } },
  });
  assert.deepEqual(deploy.envSources, { secrets: ["s1"], configMaps: ["c1"], keyRefs: ["X <- secret s2/k"] });
});

test("debug_exec defaults to the sandbox when one is configured; other hosts only by name; ssh_exec is opt-in", async () => {
  const sshCalls = [];
  const sshRun = async (target, command) => (sshCalls.push({ target, command }), { stdout: "up", stderr: "" });
  const prev = process.env.GRIFFIN_SANDBOX_KEY;
  process.env.GRIFFIN_SANDBOX_KEY = "/sandbox-keys/client";
  try {
    const site = { ...TEST_SITE, ssh: { user: "ops-ro", keySlug: "ssh__ro" }, tools: { ssh: true } };
    const tools = createTools({ site, kube: createKube({ vault, sshRun, clusters: TEST_SITE.clusters }), vault, sshRun });
    const out = await tools.debug_exec.execute({ command: "uptime" });
    assert.equal(out.host, "sandbox");
    assert.equal(out.source, "sandbox");
    assert.equal(sshCalls[0].target.host, "127.0.0.1");
    assert.equal(sshCalls[0].target.keyFile, "/sandbox-keys/client");
    assert.equal(sshCalls[0].target.loopback, true);
    await tools.debug_exec.execute({ host: "debug", command: "uptime" });
    assert.equal(sshCalls[1].target.host, "203.0.113.40");
    const ssh = await tools.ssh_exec.execute({ host: "app.example.com", command: "df -h" });
    assert.equal(ssh.user, "ops-ro");
    assert.deepEqual([sshCalls[2].target.keySlug, sshCalls[2].target.tofu], ["ssh__ro", true]);
  } finally {
    if (prev === undefined) delete process.env.GRIFFIN_SANDBOX_KEY;
    else process.env.GRIFFIN_SANDBOX_KEY = prev;
  }
  const plain = createTools({ site: TEST_SITE, kube: {}, vault, sshRun });
  assert.ok(!("ssh_exec" in plain), "ssh_exec is opt-in");
  assert.deepEqual(plain.debug_exec.inputSchema.properties.host.enum, ["debug"]);
});

test("broker HTTP API on a unix socket", async () => {
  const { tools } = setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-"));
  const socketPath = path.join(dir, "b.sock");
  const server = createBrokerServer({ tools, log: {} });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const call = (method, url, body) =>
    new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method, path: url, headers: { "content-type": "application/json" } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  try {
    const list = await call("GET", "/tools");
    assert.ok(list.body.some((t) => t.name === "kube_logs" && t.inputSchema.required.includes("pod")));
    const ok = await call("POST", "/tools/kube_status", { cluster: "prod" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.result.counts.total, 2);
    const bad = await call("POST", "/tools/kube_status", { cluster: "nope" });
    assert.equal(bad.status, 400);
    assert.equal((await call("POST", "/tools/unknown", {})).status, 404);
    // tool names with digits (s3_list) must route; this 404'd in production on 2026-09-14
    assert.equal((await call("POST", "/tools/s3_list", {})).status, 400);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("vault.put writes KV v2 with the machine token and never accepts empty values", async () => {
  const { createVault } = await import("../src/vault.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const ageBin = path.join(dir, "age");
  fs.writeFileSync(ageBin, "#!/bin/sh\necho machine-token\n", { mode: 0o755 });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, token: init.headers["X-Vault-Token"], body: init.body });
    return new Response(null, { status: 204 });
  };
  try {
    for (const f of ["token.age", "id.age"]) fs.writeFileSync(path.join(dir, f), "x");
    const store = createVault({ url: "http://bao", ageBin, fetchImpl, tokenAge: path.join(dir, "token.age"), identity: path.join(dir, "id.age") });
    await store.put("kube__token", '{"type":"authentik-basic"}');
    assert.deepEqual(calls[0], {
      url: "http://bao/v1/emergency/data/items/kube__token",
      method: "POST",
      token: "machine-token",
      body: JSON.stringify({ data: { value: '{"type":"authentik-basic"}' } }),
    });
    await assert.rejects(store.put("kube__token", ""), /empty/);
    assert.equal(calls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("kube_logs asks the API with Accept */* (text/plain is rejected with 406)", async () => {
  const accepts = [];
  const fetchImpl = async (url, init) => {
    accepts.push(init.headers.Accept);
    if (init.headers.Accept === "text/plain") return new Response("{}", { status: 406 });
    return new Response("line one\nline two\n", { status: 200, headers: { "content-type": "text/plain" } });
  };
  const sshRun = async () => { throw new Error("ssh must not be used"); };
  const kube = createKube({ clusters: TEST_SITE.clusters, vault, sshRun, fetchImpl });
  const tools = createTools({ site: TEST_SITE, kube, vault, sshRun, fetchImpl });
  const result = await tools.kube_logs.execute({ cluster: "dr", namespace: "platform", pod: "proxy-abc", tail: 2 });
  assert.deepEqual(accepts, ["*/*"]);
  assert.match(result.source, /^public-api /);
  assert.match(JSON.stringify(result), /line two/);
});

test("probe marks the API healthy only when an authenticated read succeeds", async () => {
  const { createProbe } = await import("../src/probe.mjs");
  const kube = {
    publicRequest: async (name) => {
      if (name === "edge") throw new Error("gateway auth rejected http_302");
      return { body: { items: [] } };
    },
  };
  const probe = createProbe({ clusters: { prod: { api: "https://m" }, edge: { api: "https://y" } }, kube });
  const result = await probe();
  assert.equal(result.clusters.prod.api.ok, true);
  assert.equal(result.clusters.edge.api.ok, false);
  assert.match(result.clusters.edge.api.error, /http_302/);
  assert.equal(result.clusters.prod.emergency, null);
});

test("unsealer only acts when the vault is initialized and sealed", async () => {
  const { unsealOnce } = await import("../src/unseal.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unseal-"));
  const ageBin = path.join(dir, "age");
  fs.writeFileSync(ageBin, "#!/bin/sh\necho unseal-key-b64\n", { mode: 0o755 });
  const make = (states) => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET", body: init.body });
      const body = String(url).endsWith("/sys/unseal") ? { sealed: false } : states.shift();
      return new Response(JSON.stringify(body), { status: 200 });
    };
    return { calls, fetchImpl };
  };
  const base = { url: "http://bao", unsealAge: "/x.age", identity: "/id", ageBin, log: {} };
  try {
    const open = make([{ initialized: true, sealed: false }]);
    assert.equal(await unsealOnce({ ...base, fetchImpl: open.fetchImpl }), "unsealed");
    assert.equal(open.calls.length, 1);

    const fresh = make([{ initialized: false, sealed: true }]);
    assert.equal(await unsealOnce({ ...base, fetchImpl: fresh.fetchImpl }), "not-initialized");

    const sealed = make([{ initialized: true, sealed: true }]);
    assert.equal(await unsealOnce({ ...base, fetchImpl: sealed.fetchImpl }), "unsealed-now");
    assert.deepEqual(sealed.calls[1], { url: "http://bao/v1/sys/unseal", method: "PUT", body: JSON.stringify({ key: "unseal-key-b64" }) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("kube_copy_secret copies data server-side, returns only key names, refuses to overwrite", async () => {
  const { createTools } = await import("../src/tools.mjs");
  const writes = [];
  const secrets = { "prod/shop-db-replication": { type: "kubernetes.io/tls", data: { "tls.crt": "Y3J0", "tls.key": "a2V5" } } };
  const kube = {
    publicRequest: async (cluster, path) => {
      const name = path.split("/").pop();
      const s = secrets[`${cluster}/${name}`];
      return s ? { body: { ...s, metadata: { resourceVersion: "7" } } } : { notFound: true };
    },
    publicWrite: async (cluster, path, opts) => {
      writes.push({ cluster, path, ...opts });
      secrets[`${cluster}/${opts.body.metadata.name}`] = opts.body;
    },
  };
  const tools = createTools({ site: TEST_SITE, kube, vault: { item: async () => "x" }, sshRun: async () => ({}) });
  const out = await tools.kube_copy_secret.execute({ fromCluster: "prod", toCluster: "dr", namespace: "team-c", name: "shop-db-replication", targetName: "shop-db-primary-replication-creds" });
  assert.equal(out.action, "created");
  assert.deepEqual(out.keys, ["tls.crt", "tls.key"]);
  assert.ok(!JSON.stringify(out).includes("a2V5"), "values never returned");
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[0].body.type, "kubernetes.io/tls");
  await assert.rejects(tools.kube_copy_secret.execute({ fromCluster: "prod", toCluster: "dr", namespace: "team-c", name: "shop-db-replication", targetName: "shop-db-primary-replication-creds" }), /already exists/);
});

test("kube_copy_secret can rewrite a hostname token in every value", async () => {
  const { createTools } = await import("../src/tools.mjs");
  const b64 = (t) => Buffer.from(t).toString("base64");
  const written = {};
  const kube = {
    publicRequest: async (cluster, path) => {
      if (cluster === "prod") return { body: { type: "kubernetes.io/basic-auth", data: { host: b64("shop-db-rw"), uri: b64("postgresql://u:p@shop-db-rw.team-c:5432/shop"), other: b64("shop-db-rw-x") } } };
      return written[path.split("/").pop()] ? { body: { metadata: { resourceVersion: "1" } } } : { notFound: true };
    },
    publicWrite: async (cluster, path, opts) => { written[opts.body.metadata.name] = opts.body; },
  };
  const tools = createTools({ site: TEST_SITE, kube, vault: { item: async () => "x" }, sshRun: async () => ({}) });
  const out = await tools.kube_copy_secret.execute({ fromCluster: "prod", toCluster: "dr", namespace: "team-c", name: "shop-db-app", targetName: "shop-db-app2", rewriteHost: { from: "shop-db-rw", to: "shop-db-primary-rw" } });
  const dec = (k) => Buffer.from(written["shop-db-app2"].data[k], "base64").toString();
  assert.equal(dec("host"), "shop-db-primary-rw");
  assert.equal(dec("uri"), "postgresql://u:p@shop-db-primary-rw.team-c:5432/shop");
  assert.equal(dec("other"), "shop-db-rw-x", "only whole host tokens");
  assert.deepEqual(out.rewritten, ["host", "uri"]);
});

test("cnpg_retry_bootstrap deletes only failed, inactive jobs of that cluster", async () => {
  const { createTools } = await import("../src/tools.mjs");
  const deleted = [];
  const kube = {
    publicRequest: async (c, path) => {
      assert.match(path, /labelSelector=cnpg\.io%2Fcluster%3Dshop-db-replica/);
      return { body: { items: [
        { metadata: { name: "shop-db-replica-1-pgbasebackup" }, status: { failed: 7 } },
        { metadata: { name: "ok-job" }, status: { succeeded: 1 } },
        { metadata: { name: "running-job" }, status: { active: 1, failed: 1 } },
      ] } };
    },
    publicWrite: async (c, path, opts) => { assert.equal(opts.method, "DELETE"); deleted.push(path.split("/").pop()); },
  };
  const tools = createTools({ site: TEST_SITE, kube, vault: { item: async () => "x" }, sshRun: async () => ({}) });
  const out = await tools.cnpg_retry_bootstrap.execute({ cluster: "dr", namespace: "team-c", name: "shop-db-replica" });
  assert.deepEqual(deleted, ["shop-db-replica-1-pgbasebackup"]);
  assert.deepEqual(out.deletedJobs, deleted);
});

// A fresh install configures nothing: the tool list must then be honest about it, or agents spend
// their turns calling endpoints that cannot exist.
test("tool packs follow the site config: nothing configured, nothing but credential-free tools", async () => {
  const { enabledPacks } = await import("../src/tools.mjs");
  const bare = createTools({ site: { clusters: {}, routers: {}, debugHosts: {} }, kube: {}, vault: {}, sshRun: async () => ({}) });
  const names = Object.keys(bare);
  assert.deepEqual(names.sort(), ["dns_lookup", "http_check", "tls_check"]);

  const packs = enabledPacks({ clusters: {}, routers: {}, debugHosts: {} });
  assert.equal(packs.kubernetes, false);
  assert.equal(packs.gitlab, false);
  assert.equal(packs.net, true);

  // Declaring a cluster and a GitLab publishes exactly those packs.
  const some = createTools({
    site: { clusters: { prod: { api: "https://k8s.example.com" } }, gitlab: { url: "https://gitlab.example.com" }, routers: {}, debugHosts: {} },
    kube: {},
    vault: {},
    sshRun: async () => ({}),
  });
  assert.ok(Object.keys(some).includes("kube_status"));
  assert.ok(Object.keys(some).includes("gitlab_version"));
  assert.ok(Object.keys(some).includes("git_clone"), "repos ride on the gitlab config");
  assert.ok(!Object.keys(some).includes("mikrotik_print"));
  assert.ok(!Object.keys(some).includes("debug_exec"), "no shell host, no shell tool");
  assert.ok(!Object.keys(some).includes("arvan_domains"), "vendor packs are opt-in");

  // An explicit switch wins over the inference.
  const forced = createTools({
    site: { clusters: {}, routers: {}, debugHosts: {}, tools: { arvan: true } },
    kube: {},
    vault: {},
    sshRun: async () => ({}),
  });
  assert.ok(Object.keys(forced).includes("arvan_domains"));
});

test("without OpenBao, tool credentials live in the broker's own box and only names come back", async () => {
  const { createVault } = await import("../src/vault.mjs");
  const { createSecretStore } = await import("../src/secretbox.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-"));
  try {
    const vault = createVault({ local: createSecretStore({ dataDir: dir }), tokenAge: path.join(dir, "missing") });
    await assert.rejects(vault.item("gitlab__token"), /not set/);
    await vault.put("gitlab__token", "tok-example-123456789");
    assert.equal(await vault.item("gitlab__token"), "tok-example-123456789");
    const listed = await vault.list();
    assert.equal(listed.backend, "broker");
    assert.deepEqual(listed.items.map((i) => i.name), ["gitlab__token"]);
    assert.ok(!JSON.stringify(listed).includes("tok-example-123456789"));
    assert.equal(await vault.remove("gitlab__token"), true);
    assert.ok(!fs.readFileSync(path.join(dir, "secrets.json"), "utf8").includes("tok-example"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-10-20: every shell step can carry its own title (the chat row), and it stays optional.
test("shell tools offer an optional step title", () => {
  const tools = createTools({ site: { ...TEST_SITE, tools: { ssh: true } }, kube: createKube({ vault, sshRun: async () => ({ stdout: "", stderr: "" }) }), vault, sshRun: async () => ({ stdout: "", stderr: "" }) });
  for (const name of ["debug_exec", "ssh_exec", "kube_exec", "mikrotik_exec"]) {
    const schema = tools[name]?.inputSchema;
    assert.ok(schema, `${name} exists`);
    assert.equal(schema.properties.description.type, "string", `${name} takes a description`);
    assert.ok(!schema.required.includes("description"), `${name}: the title is optional`);
  }
});
