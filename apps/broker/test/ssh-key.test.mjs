import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeKey } from "../src/ssh.mjs";

// A real key, so "ssh can read it" is checked by ssh-keygen itself, not by our own parser.
function realKey() {
  const dir = mkdtempSync(path.join(tmpdir(), "keytest-"));
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", path.join(dir, "k")]);
  const key = readFileSync(path.join(dir, "k"), "utf8");
  return { dir, key };
}

function reads(dir, text) {
  const f = path.join(dir, "probe");
  writeFileSync(f, text, { mode: 0o600 });
  try {
    execFileSync("ssh-keygen", ["-y", "-f", f], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

test("normalizeKey: shapes a settings box can mangle a key into all become readable", () => {
  const { dir, key } = realKey();
  const lines = key.trim().split("\n");
  const body = lines.slice(1, -1);
  const shapes = {
    clean: key,
    "no trailing newline": key.trim(),
    crlf: key.replace(/\n/g, "\r\n"),
    "crlf, no trailing": key.trim().replace(/\n/g, "\r\n"),
    "body on one line": `${lines[0]}\n${body.join("")}\n${lines.at(-1)}\n`,
    "all on one line, spaces": `${lines[0]} ${body.join(" ")} ${lines.at(-1)}`,
    indented: lines.map((l) => `   ${l}`).join("\n"),
    "bare CR": key.replace(/\n/g, "\r"),
  };
  try {
    for (const [name, raw] of Object.entries(shapes)) {
      assert.equal(reads(dir, normalizeKey(raw)), true, `normalized "${name}" must be readable by ssh-keygen`);
    }
    // Red proof: what the old code wrote (trim + newline) was NOT readable for these shapes.
    for (const name of ["crlf", "crlf, no trailing", "all on one line, spaces", "indented", "bare CR"]) {
      assert.equal(reads(dir, `${shapes[name].trim()}\n`), false, `old handling of "${name}" is the bug being fixed`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeKey: output is LF only, framed, 70-column body, one trailing newline", () => {
  const out = normalizeKey("-----BEGIN OPENSSH PRIVATE KEY-----\r\n" + "A".repeat(150) + "\r\n-----END OPENSSH PRIVATE KEY-----\r\n\r\n");
  assert.equal(out.includes("\r"), false);
  assert.deepEqual(out.split("\n"), ["-----BEGIN OPENSSH PRIVATE KEY-----", "A".repeat(70), "A".repeat(70), "A".repeat(10), "-----END OPENSSH PRIVATE KEY-----", ""]);
});

test("normalizeKey: non-PEM text and legacy encrypted PEM are only trimmed", () => {
  assert.equal(normalizeKey("  not a pem \r\n"), "not a pem\n");
  const enc = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABC\n\nQUJD\n-----END RSA PRIVATE KEY-----";
  assert.equal(normalizeKey(enc), `${enc}\n`);
  assert.equal(normalizeKey(undefined), "\n");
});
