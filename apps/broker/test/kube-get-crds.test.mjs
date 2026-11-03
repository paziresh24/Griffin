import test from "node:test";
import assert from "node:assert/strict";
import { createKube } from "../src/kube.mjs";
import { createTools } from "../src/tools.mjs";
import { TEST_SITE } from "./fixture-site.mjs";

// 2026-11-02: an ops chain said «ابزار فهرست Backupها را ندارم» — kube_get now reads CNPG backups,
// scheduled backups, MariaDB and Argo applications (RBAC already reads every CRD), summarized.
const clusters = { prod: { api: "https://k8s.test" } };
const vault = { item: async () => "token-x" };
const noSsh = async () => {
  throw new Error("no ssh");
};
const BODIES = {
  "/apis/postgresql.cnpg.io/v1/namespaces/n/backups": { items: [{ metadata: { name: "db-daily-1", namespace: "n" }, spec: { cluster: { name: "db" }, method: "barmanObjectStore" }, status: { phase: "completed", startedAt: "2026-11-01T01:00:00Z", stoppedAt: "2026-11-01T01:03:00Z", backupId: "20261101T010000" } }] },
  "/apis/postgresql.cnpg.io/v1/namespaces/n/scheduledbackups": { items: [{ metadata: { name: "db-daily", namespace: "n" }, spec: { cluster: { name: "db" }, schedule: "0 30 4 * * *" }, status: { lastScheduleTime: "2026-11-01T04:30:00Z" } }] },
  "/apis/k8s.mariadb.com/v1alpha1/namespaces/n/mariadbs": { items: [{ metadata: { name: "m", namespace: "n" }, spec: { replicas: 2 }, status: { currentPrimary: "m-0", conditions: [{ type: "Ready", status: "True", message: "Running" }] } }] },
  "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications": { items: [{ metadata: { name: "o-app", namespace: "argocd" }, spec: { destination: { namespace: "o" } }, status: { sync: { status: "OutOfSync", revision: "c6b7f7251234" }, health: { status: "Healthy" }, resources: [{ kind: "Service", name: "a", status: "OutOfSync" }, { kind: "Deployment", name: "b", status: "Synced" }], conditions: [] } }] },
};
const fetchImpl = async (url) => {
  const body = BODIES[new URL(url).pathname];
  return body ? Response.json(body) : Response.json({ kind: "Status", code: 404, reason: "NotFound" }, { status: 404 });
};

test("kube_get lists CNPG backups and scheduled backups, MariaDB and Argo applications, summarized", async () => {
  const tools = createTools({ site: TEST_SITE, kube: createKube({ vault, clusters, fetchImpl, sshRun: noSsh }), vault, sshRun: noSsh });
  const kinds = tools.kube_get.inputSchema.properties.kind.enum;
  for (const k of ["backups.postgresql.cnpg.io", "scheduledbackups.postgresql.cnpg.io", "mariadbs.k8s.mariadb.com", "applications.argoproj.io"]) assert.ok(kinds.includes(k), k);

  const b = await tools.kube_get.execute({ cluster: "prod", kind: "backups.postgresql.cnpg.io", namespace: "n" });
  assert.deepEqual(b.items[0], { name: "db-daily-1", namespace: "n", cluster: "db", method: "barmanObjectStore", phase: "completed", started: "2026-11-01T01:00:00Z", stopped: "2026-11-01T01:03:00Z", error: null, backupId: "20261101T010000" });
  const sb = await tools.kube_get.execute({ cluster: "prod", kind: "scheduledbackups.postgresql.cnpg.io", namespace: "n" });
  assert.equal(sb.items[0].schedule, "0 30 4 * * *");
  const m = await tools.kube_get.execute({ cluster: "prod", kind: "mariadbs.k8s.mariadb.com", namespace: "n" });
  assert.deepEqual([m.items[0].ready, m.items[0].currentPrimary, m.items[0].replicas], ["True", "m-0", 2]);
  const a = await tools.kube_get.execute({ cluster: "prod", kind: "applications.argoproj.io", namespace: "argocd" });
  assert.deepEqual([a.items[0].sync, a.items[0].revision, a.items[0].health, a.items[0].outOfSync], ["OutOfSync", "c6b7f725", "Healthy", ["Service/a"]]);
});
