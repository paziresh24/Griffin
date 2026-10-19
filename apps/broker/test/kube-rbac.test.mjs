import test from "node:test";
import assert from "node:assert/strict";
import { createKube } from "../src/kube.mjs";
import { createProbe } from "../src/probe.mjs";
import { createTools } from "../src/tools.mjs";
import { createPgTools } from "../src/pg.mjs";

// A colleague's install: a Bearer credential that RBAC binds to one namespace, no emergency SSH key.
const clusters = { prod: { api: "https://k8s.test", emergency: { host: "198.51.100.1", port: 4820, user: "griffin", keySlug: "ssh__griffin", kubectl: "kubectl" } } };
const vault = { item: async () => "token-x" };
const status = (message) => Response.json({ kind: "Status", status: "Failure", reason: "Forbidden", code: 403, message }, { status: 403 });

function colleagueFetch(calls = []) {
  return async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method || "GET"} ${u.pathname}`);
    if (u.pathname === "/apis/authentication.k8s.io/v1/selfsubjectreviews") return Response.json({ status: { userInfo: { username: "alice" } } }, { status: 201 });
    if (u.pathname === "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews") {
      return Response.json({ status: { allowed: JSON.parse(init.body).spec.resourceAttributes.namespace === "alice" } }, { status: 201 });
    }
    if (u.pathname.startsWith("/api/v1/namespaces/alice/")) return Response.json({ items: [{ metadata: { name: "app-db-1", namespace: "alice" }, status: { phase: "Running" } }] });
    if (u.pathname.startsWith("/apis/postgresql.cnpg.io/v1/namespaces/alice/")) return Response.json({ items: [] });
    return status(`pods is forbidden: User "alice" cannot list resource "pods" at the cluster scope`);
  };
}
const noSsh = async () => {
  throw new Error("secret ssh__griffin is not set (Settings → Secrets)");
};

test("an RBAC 403 is the answer: no SSH fallback, and the error names the namespace it may read", async () => {
  let sshTried = false;
  const kube = createKube({ vault, clusters, fetchImpl: colleagueFetch(), sshRun: async () => { sshTried = true; return { stdout: Buffer.alloc(0), stderr: "" }; } });
  const tools = createTools({ kube, vault, sshRun: noSsh, site: { clusters } });
  await assert.rejects(tools.kube_logs.execute({ cluster: "prod", namespace: "someone-else", pod: "p" }), (error) => {
    assert.match(error.message, /^forbidden: .*namespace "alice"/);
    assert.equal(error.attempts.length, 1);
    return true;
  });
  assert.equal(sshTried, false);
});

test("the gateway's own 403 (not a Status) still falls back to SSH", async () => {
  let sshTried = false;
  const fetchImpl = async () => new Response("<html>denied</html>", { status: 403, headers: { "content-type": "text/html" } });
  const kube = createKube({ vault, clusters, fetchImpl, sshRun: async () => { sshTried = true; throw new Error("down"); } });
  await assert.rejects(createTools({ kube, vault, sshRun: noSsh, site: { clusters } }).kube_status.execute({ cluster: "prod" }), (error) => {
    assert.equal(error.attempts[0].error, "gateway auth rejected http_403");
    return true;
  });
  assert.equal(sshTried, true);
});

test("kube_status / kube_get without a namespace answer in the one namespace a bound credential has", async () => {
  const kube = createKube({ vault, clusters, fetchImpl: colleagueFetch(), sshRun: noSsh });
  const tools = createTools({ kube, vault, sshRun: noSsh, site: { clusters } });
  const s = await tools.kube_status.execute({ cluster: "prod" });
  assert.equal(s.namespace, "alice");
  assert.equal(s.counts.total, 1);
  assert.match(s.note, /cluster-wide reads are forbidden/);
  const g = await tools.kube_get.execute({ cluster: "prod", kind: "pods" });
  assert.equal(g.namespace, "alice");
  assert.equal(g.total, 1);
});

test("GRIFFIN_KUBE_NAMESPACE names the home namespace without asking who the credential is", async () => {
  const calls = [];
  const kube = createKube({ vault, clusters, fetchImpl: colleagueFetch(calls), sshRun: noSsh, homeNamespaceEnv: "alice" });
  assert.equal(await kube.homeNamespace("prod"), "alice");
  assert.ok(!calls.some((c) => c.includes("selfsubjectreviews")));
});

test("probe: a namespace-bound credential is healthy when its own namespace reads", async () => {
  const kube = createKube({ vault, clusters: { prod: { api: "https://k8s.test" } }, fetchImpl: colleagueFetch(), sshRun: noSsh });
  const result = await createProbe({ clusters: { prod: { api: "https://k8s.test" } }, kube })();
  assert.equal(result.clusters.prod.api.ok, true);
  assert.equal(result.clusters.prod.api.namespace, "alice");
});

// The v5 channel protocol: byte 0 = channel (1 stdout, 2 stderr, 3 status), then the payload.
function fakeWebSocket({ stdout = "", stderr = "", ok = true, opened = [] }) {
  return class {
    constructor(url, init) {
      opened.push({ url, init });
      setTimeout(() => {
        const frame = (ch, text) => this.onmessage({ data: Buffer.concat([Buffer.from([ch]), Buffer.from(text)]) });
        if (stdout) frame(1, stdout);
        if (stderr) frame(2, stderr);
        frame(3, JSON.stringify(ok ? { status: "Success" } : { status: "Failure", message: "command terminated with non-zero exit code" }));
        this.onclose({ code: 1000 });
      }, 1);
    }
    close() {}
  };
}

test("pg_query runs over the API exec when there is no emergency SSH key", async () => {
  const opened = [];
  const fetchImpl = async () => Response.json({ status: { currentPrimary: "app-db-1", phase: "Cluster in healthy state" } });
  const kube = createKube({ vault, clusters, fetchImpl, sshRun: noSsh, webSocketImpl: fakeWebSocket({ stdout: "n\n1\n", opened }) });
  const result = await createPgTools({ kube }).pg_query.execute({ cluster: "prod", namespace: "alice", name: "app-db", sql: "select 1 as n" });
  assert.deepEqual(result.rows, [{ n: "1" }]);
  assert.match(result.source, /via public-api exec/);
  const url = new URL(opened[0].url);
  assert.equal(url.protocol, "wss:");
  assert.equal(url.pathname, "/api/v1/namespaces/alice/pods/app-db-1/exec");
  assert.equal(url.searchParams.get("container"), "postgres");
  assert.equal(url.searchParams.getAll("command").at(-1), "select 1 as n");
  assert.equal(opened[0].init.headers.Authorization, "Bearer token-x");

  const failing = createKube({ vault, clusters, fetchImpl, sshRun: noSsh, webSocketImpl: fakeWebSocket({ stderr: "ERROR:  cannot execute UPDATE in a read-only transaction", ok: false }) });
  await assert.rejects(createPgTools({ kube: failing }).pg_query.execute({ cluster: "prod", namespace: "ns", name: "db", sql: "update t set x=1" }), /rerun with write=true/);
});
