import test from "node:test";
import assert from "node:assert/strict";
import { redactArgs, redactResult } from "../src/redact.mjs";

test("infisical_upsert args mask the value and only the value", () => {
  const out = redactArgs("infisical_upsert", {
    name: "OTP_GATEWAY_PASSWORD",
    value: "hunter2",
    path: "/otp-debug",
    environment: "prod",
  });
  assert.equal(out.value, "***");
  assert.equal(out.name, "OTP_GATEWAY_PASSWORD");
  assert.equal(out.path, "/otp-debug");
  assert.equal(out.environment, "prod");
});

test("pg_query SQL masks password literals, keeps the statement auditable", () => {
  const sql = "CREATE ROLE r WITH LOGIN PASSWORD 'S3cr3t-X'; GRANT SELECT ON otp_requests TO r;";
  const out = redactArgs("pg_query", { sql, write: true });
  assert.match(out.sql, /PASSWORD '\*\*\*'/);
  assert.doesNotMatch(out.sql, /S3cr3t/);
  assert.match(out.sql, /GRANT SELECT ON otp_requests/);
});

test("debug_exec command masks credential assignments, keeps hosts and flags", () => {
  const out = redactArgs("debug_exec", {
    command: `printf '%s' '{"h":"203.0.113.4","pw":"abc123"}' >/tmp/x; psql --password=zZ9q -h 1.2.3.4`,
  });
  assert.doesNotMatch(out.command, /abc123|zZ9q/);
  assert.match(out.command, /203\.0\.113\.4/);
  assert.match(out.command, /psql/);
});

test("secret-named keys are masked in any tool result, including JSON embedded in text", () => {
  const result = {
    status: "success",
    value: {
      content: [
        { type: "text", text: { text: JSON.stringify({ secretKey: "OTP", secretValue: "topsecret", note: "read-only" }) } },
      ],
    },
  };
  const out = redactResult("infisical_get", result);
  const embedded = JSON.parse(out.value.content[0].text.text);
  assert.equal(embedded.secretValue, "***");
  assert.equal(embedded.secretKey, "***", "secret-named keys mask their value too");
  assert.equal(embedded.note, "read-only");
});

test("plain rows with secret-named columns are masked; other columns survive", () => {
  const out = redactResult("pg_query", { rows: [{ rolname: "app", password: "h" }, { token: "t", n: 3 }] });
  assert.equal(out.rows[0].password, "***");
  assert.equal(out.rows[0].rolname, "app");
  assert.equal(out.rows[1].token, "***");
  assert.equal(out.rows[1].n, 3);
});

test("args of unrelated tools keep non-secret content untouched", () => {
  const out = redactArgs("kube_get", { cluster: "prod-a", kind: "pods", namespace: "team-a" });
  assert.deepEqual(out, { cluster: "prod-a", kind: "pods", namespace: "team-a" });
});

test("secret-shaped results are masked: private keys, JWTs, infisical values, kube secret data", () => {
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----";
  const inf = redactResult("infisical_get", { status: "success", value: JSON.stringify({ name: "PRIVATE_KEY", value: key }) });
  assert.doesNotMatch(JSON.stringify(inf), /b3BlbnNzaC1rZXkt/);
  assert.match(JSON.stringify(inf), /PRIVATE_KEY/, "the name stays readable");
  const ks = redactResult("kube_secret", { value: JSON.stringify({ name: "app", data: { JWT_SECRET: "1RIPnNNWVHdO1sA", DB_URL: "postgres://u:p@h/db" } }) });
  assert.doesNotMatch(JSON.stringify(ks), /1RIPnNNW|postgres:\/\//);
  assert.match(JSON.stringify(ks), /JWT_SECRET/);
  const out = redactResult("debug_exec", { stdout: `cat id\n${key}\ntoken eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.abcdefghijkl` });
  assert.doesNotMatch(JSON.stringify(out), /b3BlbnNzaC1rZXkt|eyJhbGci/);
});
