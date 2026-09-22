import { K8S_NAME, ToolInputError } from "./kube.mjs";

// SQL on any CloudNativePG cluster, run with psql inside the cluster's current primary pod over the
// emergency SSH path (kubectl exec needs no DB password and works when the public API is down).
// Read-only by default (the session is set to default_transaction_read_only); write=true runs the
// same statement read-write. No statement filtering: the owner wants the full power, and the
// agent is told to ask before writes.

const MAX_ROWS = 500;
const cluster = { type: "string", description: "cluster name from the site config" };

// RFC 4180 CSV as psql --csv writes it.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// psql --csv prints one table per result-producing statement; a blank line never appears inside
// a CSV table, so results are split on header rows only when the statement count is 1.
export function toTable(csv, maxRows = MAX_ROWS) {
  const rows = parseCsv(csv.replace(/\n+$/, "\n"));
  if (!rows.length) return { columns: [], rows: [], rowCount: 0, truncated: false };
  const [columns, ...data] = rows;
  return {
    columns,
    rows: data.slice(0, maxRows).map((values) => Object.fromEntries(columns.map((c, i) => [c, values[i] ?? null]))),
    rowCount: data.length,
    truncated: data.length > maxRows,
  };
}

export function createPgTools({ kube }) {
  async function primaryPod(clusterName, namespace, name) {
    const path = `/apis/postgresql.cnpg.io/v1/namespaces/${namespace}/clusters/${name}`;
    const result = await kube.withFallback(clusterName, {
      viaApi: async () => {
        const response = await kube.publicRequest(clusterName, path);
        if (response.notFound) throw new ToolInputError(`CNPG cluster ${namespace}/${name} not found on ${clusterName}`);
        return response.body;
      },
      viaSsh: async () => JSON.parse(await kube.emergency(clusterName, ["get", "clusters.postgresql.cnpg.io", name, "-n", namespace, "-o", "json"])),
    });
    const status = result.value?.status || {};
    const pod = status.currentPrimary || status.targetPrimary;
    if (!pod) throw new Error(`CNPG cluster ${namespace}/${name} has no current primary (phase: ${status.phase || "unknown"})`);
    return { pod, phase: status.phase || null, source: result.source };
  }

  return {
    pg_query: {
      description:
        "Run SQL on a CloudNativePG cluster (any namespace, any statement) with psql in its primary pod. Read-only transaction by default; set write=true to change data (ask the owner first). Returns a table (≤500 rows). Find clusters with kube_get kind=clusters.postgresql.cnpg.io. psql meta-commands work as a single statement (e.g. \"\\\\l\", \"\\\\dt public.*\").",
      inputSchema: {
        type: "object",
        properties: {
          cluster,
          namespace: { type: "string", pattern: K8S_NAME.source },
          name: { type: "string", pattern: K8S_NAME.source, description: "CNPG cluster name" },
          database: { type: "string", maxLength: 63, description: "database (default postgres; list with \\\\l)" },
          sql: { type: "string", minLength: 1, maxLength: 100_000 },
          write: { type: "boolean", description: "run read-write (default false = read-only transaction)" },
          timeoutSeconds: { type: "integer", minimum: 1, maximum: 600, description: "statement_timeout (default 60)" },
        },
        required: ["cluster", "namespace", "name", "sql"],
        additionalProperties: false,
      },
      async execute(args) {
        const clusterName = String(args.cluster || "");
        if (!clusterName) throw new ToolInputError("cluster is required");
        const namespace = String(args.namespace || "");
        const name = String(args.name || "");
        if (!K8S_NAME.test(namespace) || !K8S_NAME.test(name)) throw new ToolInputError("invalid namespace or cluster name");
        const database = String(args.database || "postgres");
        if (!/^[A-Za-z0-9_$-]{1,63}$/.test(database)) throw new ToolInputError("invalid database name");
        const sql = String(args.sql || "");
        if (!sql.trim() || sql.includes("\0")) throw new ToolInputError("sql is required");
        const timeout = Math.min(Math.max(Number(args.timeoutSeconds) || 60, 1), 600);
        const write = Boolean(args.write);

        const primary = await primaryPod(clusterName, namespace, name);
        const psql = [
          "exec", "-n", namespace, primary.pod, "-c", "postgres", "--",
          "psql", "-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database,
          "-c", `SET statement_timeout = '${timeout}s'`,
          ...(write ? [] : ["-c", "SET default_transaction_read_only = on"]),
          "-c", sql,
        ];
        const started = Date.now();
        let csv;
        try {
          csv = await kube.emergency(clusterName, psql, { timeoutMs: (timeout + 30) * 1000, maxBytes: 16 * 1024 * 1024 });
        } catch (error) {
          const message = String(error.message).replace(/^kubectl on [^:]+: /, "");
          if (!write && /read-only transaction/i.test(message)) {
            throw new Error(`${message} — the statement writes; rerun with write=true after the owner approves`);
          }
          throw new Error(message);
        }
        return {
          cluster: clusterName,
          namespace,
          name,
          database,
          pod: primary.pod,
          mode: write ? "read-write" : "read-only",
          ms: Date.now() - started,
          ...toTable(csv),
          source: `psql ${namespace}/${primary.pod} via emergency-ssh (${primary.source})`,
        };
      },
    },
  };
}
