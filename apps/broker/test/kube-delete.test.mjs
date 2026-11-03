import test from "node:test";
import assert from "node:assert/strict";
import { createTools, protectedNamespace } from "../src/tools.mjs";
import { TEST_SITE } from "./fixture-site.mjs";

// A fake API: objects by path; GET answers {notFound} like kube.publicRequest, DELETE removes.
function fakeKube(objects) {
  const calls = [];
  const kube = {
    publicRequest: async (cluster, path) => (calls.push({ method: "GET", cluster, path }), objects[path] ? { body: objects[path] } : { notFound: true }),
    publicWrite: async (cluster, path, opts) => {
      calls.push({ method: opts.method, cluster, path, body: opts.body });
      delete objects[path];
      return {};
    },
  };
  return { kube, calls, tools: createTools({ site: TEST_SITE, kube, vault: {}, sshRun: async () => ({}) }) };
}

const CJ = "/apis/batch/v1/namespaces/akazemi/cronjobs/freeturn-monitor";
const APP = "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/akazemi-freeturn";
const tracked = { metadata: { name: "freeturn-monitor", annotations: { "argocd.argoproj.io/tracking-id": "akazemi-freeturn:batch/CronJob:akazemi/freeturn-monitor" } } };

test("kube_delete: only the allowlisted kinds, never data or credentials", async () => {
  const { tools, calls } = fakeKube({});
  for (const kind of ["PersistentVolumeClaim", "Secret", "Namespace", "RoleBinding", "Cluster", ""]) {
    await assert.rejects(tools.kube_delete.execute({ cluster: "prod", namespace: "akazemi", kind, name: "x" }), /not deleted from here[\s\S]*MR or the owner/);
  }
  assert.equal(calls.length, 0);
});

test("kube_delete: platform and credential namespaces are refused", async () => {
  const { tools, calls } = fakeKube({});
  for (const ns of ["kube-system", "argocd", "platform-rbac", "authentik", "infisical", "gitlab", "cnpg-system"]) {
    assert.equal(protectedNamespace(ns), true, ns);
    await assert.rejects(tools.kube_delete.execute({ cluster: "prod", namespace: ns, kind: "Pod", name: "x" }), /platform\/credentials/);
  }
  assert.equal(protectedNamespace("akazemi"), false);
  assert.equal(calls.length, 0);
});

test("kube_delete: a missing object is a plain not-found result, nothing is deleted", async () => {
  const { tools, calls } = fakeKube({});
  const out = await tools.kube_delete.execute({ cluster: "prod", namespace: "akazemi", kind: "cronjobs", name: "freeturn-monitor" });
  assert.equal(out.found, false);
  assert.equal(out.deleted, false);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
});

test("kube_delete: refused when an Argo app with selfHeal still has it in git", async () => {
  const { tools, calls } = fakeKube({
    [CJ]: tracked,
    [APP]: { spec: { syncPolicy: { automated: { prune: false, selfHeal: true } } }, status: { resources: [{ group: "batch", kind: "CronJob", namespace: "akazemi", name: "freeturn-monitor" }] } },
  });
  await assert.rejects(tools.kube_delete.execute({ cluster: "prod", namespace: "akazemi", kind: "CronJob", name: "freeturn-monitor" }), /selfHeal[\s\S]*MR/);
  assert.ok(!calls.some((c) => c.method === "DELETE"));
});

test("kube_delete: the orphan (prune off, gone from git) is deleted in Background and confirmed gone", async () => {
  const { tools, calls } = fakeKube({
    [CJ]: tracked,
    // selfHeal on, but git no longer has it (Argo lists it only to prune): it will not come back.
    [APP]: { spec: { syncPolicy: { automated: { prune: false, selfHeal: true } } }, status: { resources: [{ group: "batch", kind: "CronJob", namespace: "akazemi", name: "freeturn-monitor", requiresPruning: true }] } },
  });
  const out = await tools.kube_delete.execute({ cluster: "prod", namespace: "akazemi", kind: "CronJob", name: "freeturn-monitor" });
  const del = calls.find((c) => c.method === "DELETE");
  assert.equal(del.path, CJ);
  assert.equal(del.body.propagationPolicy, "Background");
  assert.deepEqual(calls.slice(-1)[0], { method: "GET", cluster: "prod", path: CJ });
  assert.equal(out.deleted, true);
  assert.equal(out.gone, true);
  assert.deepEqual(out.argoApp, { name: "akazemi-freeturn", found: true, automated: true, prune: false, selfHeal: true, inGit: false });
});

test("kube_delete: core and gateway kinds take their own API paths", async () => {
  const pod = "/api/v1/namespaces/orders/pods/web-1";
  const route = "/apis/gateway.networking.k8s.io/v1/namespaces/orders/httproutes/web";
  const { tools, calls } = fakeKube({ [pod]: { metadata: { name: "web-1" } }, [route]: { metadata: { name: "web" } } });
  assert.equal((await tools.kube_delete.execute({ cluster: "edge", namespace: "orders", kind: "pod", name: "web-1" })).gone, true);
  assert.equal((await tools.kube_delete.execute({ cluster: "edge", namespace: "orders", kind: "HTTPRoute", name: "web" })).argoApp, null);
  assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.path), [pod, route]);
});

// 2026-10-29: of 170 owner apps on east none has selfHeal or prune — a live object deleted stays
// deleted. In git = refused whatever selfHeal says; unknown = refused.
test("kube_delete: a live object still in git is refused even with selfHeal and prune off", async () => {
  const { tools, calls } = fakeKube({
    [CJ]: tracked,
    [APP]: { spec: { syncPolicy: {} }, status: { resources: [{ group: "batch", kind: "CronJob", namespace: "akazemi", name: "freeturn-monitor" }] } },
  });
  await assert.rejects(tools.kube_delete.execute({ cluster: "prod", namespace: "akazemi", kind: "CronJob", name: "freeturn-monitor" }), /live in git[\s\S]*MR/);
  assert.ok(!calls.some((c) => c.method === "DELETE"));
});

test("kube_delete: Argo-tracked but the app or its resource list is unreadable → refused (fail closed)", async () => {
  // tracking-id naming an app that is not there
  let fake = fakeKube({ [CJ]: tracked });
  await assert.rejects(fake.tools.kube_delete.execute({ cluster: "prod", namespace: "akazemi", kind: "CronJob", name: "freeturn-monitor" }), /fail closed/);
  // the app read fails (403/500)
  fake = fakeKube({ [CJ]: tracked });
  const get = fake.kube.publicRequest;
  fake.kube.publicRequest = async (cluster, path) => (path === APP ? Promise.reject(new Error("API http_500")) : get(cluster, path));
  await assert.rejects(fake.tools.kube_delete.execute({ cluster: "prod", namespace: "akazemi", kind: "CronJob", name: "freeturn-monitor" }), /fail closed/);
  // the app has no resource list
  fake = fakeKube({ [CJ]: tracked, [APP]: { spec: {}, status: {} } });
  await assert.rejects(fake.tools.kube_delete.execute({ cluster: "prod", namespace: "akazemi", kind: "CronJob", name: "freeturn-monitor" }), /resource list[\s\S]*fail closed/);
  assert.ok(!fake.calls.some((c) => c.method === "DELETE"));
});

test("kube_delete: a Pod its controller remakes is a restart and goes; a helm label naming no app is not Argo's", async () => {
  const pod = "/api/v1/namespaces/akazemi/pods/web-abc";
  const cm = "/api/v1/namespaces/akazemi/configmaps/scratch";
  const { tools, calls } = fakeKube({
    [pod]: { metadata: { name: "web-abc", annotations: tracked.metadata.annotations, ownerReferences: [{ kind: "ReplicaSet", name: "web-1", controller: true }] } },
    [cm]: { metadata: { name: "scratch", labels: { "app.kubernetes.io/instance": "some-release" } } },
  });
  const out = await tools.kube_delete.execute({ cluster: "prod", namespace: "akazemi", kind: "Pod", name: "web-abc" });
  assert.equal(out.gone, true);
  assert.match(out.note, /ReplicaSet web-1/);
  assert.equal((await tools.kube_delete.execute({ cluster: "prod", namespace: "akazemi", kind: "ConfigMap", name: "scratch" })).argoApp, null);
  assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.path), [pod, cm]);
});
