import test from "node:test";
import assert from "node:assert/strict";

test("kube_create: plural paths, create-only POST, RBAC refused", async () => {
  const { kindPlural, createTools } = await import("../src/tools.mjs");
  assert.equal(kindPlural("Job"), "jobs");
  assert.equal(kindPlural("NetworkPolicy"), "networkpolicies");
  assert.equal(kindPlural("Ingress"), "ingresses");
  assert.equal(kindPlural("Backup"), "backups");
  const calls = [];
  const kube = { publicWrite: async (cluster, path, opts) => (calls.push({ cluster, path, opts }), { metadata: { name: "b1", uid: "u" } }) };
  const tools = createTools({ site: { clusters: { east: {} } }, kube, vault: {}, sshRun: async () => ({}) });
  const out = await tools.kube_create.execute({ cluster: "east", namespace: "orders", manifest: { apiVersion: "postgresql.cnpg.io/v1", kind: "Backup", metadata: { name: "b1" }, spec: { cluster: { name: "db" } } } });
  assert.equal(calls[0].path, "/apis/postgresql.cnpg.io/v1/namespaces/orders/backups");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(out.created, true);
  await assert.rejects(tools.kube_create.execute({ cluster: "east", namespace: "orders", manifest: { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "x" } } }));
});
