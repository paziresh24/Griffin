import test from "node:test";
import assert from "node:assert/strict";
import { createPgTools, parseCsv, toTable } from "../src/pg.mjs";

test("CSV parsing handles quotes, commas, newlines and Persian text", () => {
  assert.deepEqual(parseCsv('id,name\n1,"a, b"\n2,"line1\nline2"\n3,"سلام ""دنیا"""\n'), [
    ["id", "name"], ["1", "a, b"], ["2", "line1\nline2"], ["3", 'سلام "دنیا"'],
  ]);
  const t = toTable("id,key\n1,a\n2,b\n3,c\n", 2);
  assert.deepEqual(t, { columns: ["id", "key"], rows: [{ id: "1", key: "a" }, { id: "2", key: "b" }], rowCount: 3, truncated: true });
});

function fakeKube({ psqlOutput = "id,key\n1,a\n", psqlError = null } = {}) {
  const calls = [];
  return {
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
}

test("pg_query runs psql in the current primary, read-only by default", async () => {
  const kube = fakeKube();
  const { pg_query } = createPgTools({ kube });
  const result = await pg_query.execute({ cluster: "prod", namespace: "team-a", name: "app-db", database: "hami", sql: "select id, key from attachments order by id desc limit 1" });
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
