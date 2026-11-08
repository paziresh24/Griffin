import test from "node:test";
import assert from "node:assert/strict";
import { createPgTools, parseCsv, readOnlyRefusal, toTable } from "../src/pg.mjs";

test("CSV parsing handles quotes, commas, newlines and Persian text", () => {
  assert.deepEqual(parseCsv('id,name\n1,"a, b"\n2,"line1\nline2"\n3,"سلام ""دنیا"""\n'), [
    ["id", "name"], ["1", "a, b"], ["2", "line1\nline2"], ["3", 'سلام "دنیا"'],
  ]);
  const t = toTable("id,key\n1,a\n2,b\n3,c\n", 2);
  assert.deepEqual(t, { columns: ["id", "key"], rows: [{ id: "1", key: "a" }, { id: "2", key: "b" }], rowCount: 3, truncated: true });
});

function fakeKube({ psqlOutput = "id,key\n1,a\n", psqlError = null } = {}) {
  const calls = [];
  const kube = {
    calls,
    withFallback: async (_c, { viaApi }) => ({ value: await viaApi(), source: "public-api test" }),
    publicRequest: async (_c, path) => {
      calls.push({ api: path });
      return { body: { status: { currentPrimary: "app-db-2", phase: "Cluster in healthy state" } } };
    },
    emergency: async (_c, args, options) => {
      calls.push({ args, options });
      if (psqlError) throw new Error(`kubectl on 203.0.113.10: ${psqlError}`);
      return psqlOutput;
    },
  };
  // the real kube.exec builds this kubectl line for the emergency path
  kube.exec = async (c, { namespace, pod, container, command, ...options }) => {
    try {
      return { value: await kube.emergency(c, ["exec", "-n", namespace, pod, "-c", container, "--", ...command], options), source: "emergency-ssh test" };
    } catch (error) {
      throw Object.assign(new Error("all paths failed"), { attempts: [{ path: "emergency-ssh", ok: false, error: error.message }] });
    }
  };
  return kube;
}

test("pg_query runs psql in the current primary, read-only by default", async () => {
  const kube = fakeKube();
  const { pg_query } = createPgTools({ kube });
  const result = await pg_query.execute({ cluster: "prod", namespace: "team-a", name: "app-db", database: "app", sql: "select id, key from attachments order by id desc limit 1" });
  assert.equal(kube.calls[0].api, "/apis/postgresql.cnpg.io/v1/namespaces/team-a/clusters/app-db");
  const args = kube.calls[1].args;
  assert.deepEqual(args.slice(0, 7), ["exec", "-n", "team-a", "app-db-2", "-c", "postgres", "--"]);
  assert.ok(args.includes("SET default_transaction_read_only = on"));
  assert.equal(args.at(-1), "select id, key from attachments order by id desc limit 1");
  assert.equal(result.mode, "read-only");
  assert.deepEqual(result.rows, [{ id: "1", key: "a" }]);

  await pg_query.execute({ cluster: "prod", namespace: "team-a", name: "app-db", sql: "update t set x=1", write: true });
  assert.ok(!kube.calls[3].args.includes("SET default_transaction_read_only = on"), "write=true runs read-write");
});

test("a write in read-only mode explains how to proceed; bad names are rejected", async () => {
  const { pg_query } = createPgTools({ kube: fakeKube({ psqlError: "ERROR:  cannot execute UPDATE in a read-only transaction" }) });
  await assert.rejects(pg_query.execute({ cluster: "prod", namespace: "ns", name: "db", sql: "update t set x=1" }), /rerun with write=true/);
  await assert.rejects(pg_query.execute({ cluster: "prod", namespace: "ns;id", name: "db", sql: "select 1" }), /invalid namespace/);
  await assert.rejects(pg_query.execute({ cluster: "prod", namespace: "ns", name: "db", database: "x y", sql: "select 1" }), /invalid database/);
});

test("a read is one plain statement: no way out of the read-only transaction or the database", () => {
  for (const sql of [
    "SELECT * FROM users LIMIT 5",
    "select count(*) from t where note = 'begin; commit; set x' -- set role",
    "WITH a AS (SELECT 1) SELECT * FROM a;",
    "EXPLAIN SELECT 1",
    "SHOW server_version",
    "SELECT CASE WHEN x THEN 1 ELSE 0 END, \"offset\" FROM t",
  ]) assert.equal(readOnlyRefusal(sql), null, sql);
  for (const sql of [
    "BEGIN READ WRITE",
    "SELECT 1; INSERT INTO t VALUES (1)",
    "SET default_transaction_read_only = off",
    "  set session characteristics as transaction read write",
    "SELECT set_config('default_transaction_read_only', 'off', false)",
    "COPY (SELECT 1) TO PROGRAM 'id'",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT lo_import('/etc/passwd')",
    "SELECT * FROM dblink('host=x', 'select 1') AS t(a int)",
    "SELECT pg_terminate_backend(123)",
    "DO $$ BEGIN PERFORM 1; END $$",
    "ALTER SYSTEM SET x = 1",
    "\\! id",
  ]) assert.ok(readOnlyRefusal(sql), sql);
});

test("pg_query refuses a psql backslash command even with write=true", async () => {
  const kube = fakeKube();
  const tool = createPgTools({ kube }).pg_query;
  await assert.rejects(() => tool.execute({ cluster: "prod", namespace: "team-a", name: "app-db", sql: "\\! id", write: true }), /backslash/);
  await assert.rejects(() => tool.execute({ cluster: "prod", namespace: "team-a", name: "app-db", sql: "BEGIN READ WRITE" }), /transaction control/);
  assert.equal(kube.calls.length, 0, "nothing reached the pod");
});
