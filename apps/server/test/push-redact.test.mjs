// Lock-screen redaction: linear time on hostile input, and the leaks the fix-review4 review found.
import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/push.mjs";

const MB = 1024 * 1024;
const adversarial = {
  "ab.ab.": "ab.".repeat(MB / 3),
  "A1+A1+": "A1+".repeat(MB / 3),
  "long base64": "QUJD".repeat(MB / 4),
  "url-like": "a:".repeat(MB / 2),
  "scheme chars": "a+b.c-".repeat(MB / 6),
  "eyJ repeated": "eyJ".repeat(MB / 3),
  "sk- repeated": "sk-".repeat(MB / 3),
  "KEY= repeated": "KEYKEY".repeat(MB / 6) + "x",
  "slashes": "a/".repeat(MB / 2),
  "quoted keys": '"k":'.repeat(MB / 4),
  "secret keys, quoted values": 'KEY:"a"'.repeat(MB / 7),
  "Persian names": "رمز ".repeat(MB / 4),
  "PEM begins": "-----BEGIN ".repeat(MB / 11),
};

for (const [name, input] of Object.entries(adversarial)) {
  test(`redactSecrets: 1 MB of '${name}' redacts in under 50 ms`, () => {
    const started = performance.now();
    redactSecrets(input);
    const ms = performance.now() - started;
    assert.ok(ms < 50, `${name}: ${ms.toFixed(1)} ms`);
  });
  test(`redactSecrets: the unclipped scan of 1 MB of '${name}' is linear (under 4 s; a quadratic scan takes minutes)`, () => {
    const started = performance.now();
    redactSecrets(input, { maxLength: Infinity });
    const ms = performance.now() - started;
    assert.ok(ms < 4000, `${name}: ${ms.toFixed(1)} ms`);
  });
}

test("redactSecrets: URL userinfo is removed, the host stays", () => {
  const a = redactSecrets("cloning https://user:pass@host.example/x now");
  assert.ok(!a.includes("user") && !a.includes("pass"), a);
  assert.match(a, /https:\/\/host\.example\/…/);
  const b = redactSecrets("db at mongodb://admin:pass@db.example.com is up");
  assert.ok(!b.includes("admin") && !b.includes("pass"), b);
  assert.match(b, /mongodb:\/\/db\.example\.com/);
});

test("redactSecrets: an AWS secret key is redacted, bare and after AWS_SECRET_ACCESS_KEY=", () => {
  const key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  for (const text of [`key ${key} end`, `AWS_SECRET_ACCESS_KEY=${key}`, `AWS_SECRET_ACCESS_KEY: ${key}`, `AWS_SECRET_ACCESS_KEY = ${key}`]) {
    const out = redactSecrets(text);
    assert.ok(!out.includes("wJalrXUtnFEMI") && !out.includes("EXAMPLEKEY"), `${text} -> ${out}`);
    assert.match(out, /\[redacted\]/);
  }
});

test("redactSecrets: KEY/SECRET/TOKEN/PASS/PWD names redact their value", () => {
  for (const text of ["MY_API_KEY=short1", "DB_PASSWORD: hunter22", "GITLAB_TOKEN=abc", "client_secret=xyz", "PGPWD=q1", 'password="two words"']) {
    const out = redactSecrets(`set ${text} done`);
    const value = text.split(/[=:]\s*/)[1].replace(/"/g, "").split(" ")[0];
    assert.ok(!out.includes(value), `${text} -> ${out}`);
    assert.match(out, /\[redacted\]/);
    assert.match(out, /done$/);
  }
});

test("redactSecrets: 30+ runs with a digit or / are redacted, and schemeless Slack webhooks", () => {
  for (const run of ["abcdefghijklmnopqrstuvwxyzabc1", "abcdefghijklmno/pqrstuvwxyzabcd", "A-b_C=d+E-f_G=h+I-j_K=l+M-n_O1"]) {
    const out = redactSecrets(`x ${run} y`);
    assert.equal(out, "x [redacted] y", run);
  }
  const hook = redactSecrets(["post to hooks.slack.com/services/", "T0/B0/XXXXXXXX please"].join(""));
  assert.ok(!hook.includes("T0/B0") && !hook.includes("XXXXXXXX"), hook);
  assert.match(hook, /please$/);
});

test("redactSecrets: normal Persian and English sentences stay readable", () => {
  const sentences = [
    "گفتگو تمام شد و تغییرها در شاخهٔ جدید ثبت شد",
    "سؤال: کدام فایل را اول بررسی کنم؟",
    "Tests pass: 42 of 42, build is green.",
    "Edited src/push.mjs and the README, then ran npm test.",
    "Reviewing the_quite_long_identifier_without_digits today",
  ];
  for (const s of sentences) assert.equal(redactSecrets(s), s);
});

// fix-review6: the misses an independent review found. Each case names the secret that must go.
const leaks = {
  "JSON key": ['{"password":"hunter2x"}', "hunter2x"],
  "JSON key, later field": ['{"user":"bob","token":"abc123xy"}', "abc123xy"],
  "JSON key with spaces": ['{ "password" : "hunter2x" }', "hunter2x"],
  "quoted key": ['"api_key": "zq9secret"', "zq9secret"],
  "single-quoted key": ["'api_key': 'zq9secret'", "zq9secret"],
  "=> assignment": ["secret_key => 'rubyval9'", "rubyval9"],
  "=> assignment, no spaces": ["secret_key=>'rubyval9'", "rubyval9"],
  "connection string": ["Server=db1;User Id=sa;Password=Sup3rS;Database=app;", "Sup3rS"],
  "pass= after whitespace": ["login with pass=letmein now", "letmein"],
  "pwd= after whitespace": ["login with pwd=letmein now", "letmein"],
  "bearer lower case": ["authorization: bearer abcdef123456", "abcdef123456"],
  "BEARER upper case": ["Authorization: BEARER abcdef123456", "abcdef123456"],
  "PEM block": ["key -----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA 7s9dK2 -----END RSA PRIVATE KEY----- done", "7s9dK2"],
  "PEM block, multi-line": ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nzzTopQ\n-----END OPENSSH PRIVATE KEY-----", "zzTopQ"],
  "PEM block cut off before END": ["-----BEGIN EC PRIVATE KEY----- MHcCAQEE qqSecret", "qqSecret"],
  "رمز:": ["رمز: kh4yli99", "kh4yli99"],
  "رمز =": ["رمز = kh4yli99", "kh4yli99"],
  "رمز عبور:": ["رمز عبور: kh4yli99", "kh4yli99"],
  "رمز عبور :": ["رمز عبور : kh4yli99", "kh4yli99"],
  "رمز‌عبور (ZWNJ)": ["رمز\u200cعبور: kh4yli99", "kh4yli99"],
  "کلید=": ["کلید=kh4yli99", "kh4yli99"],
  "توکن full-width colon": ["توکن： kh4yli99", "kh4yli99"],
  "توکن:value": ["توکن:kh4yli99", "kh4yli99"],
  "پسورد:": ["پسورد: kh4yli99", "kh4yli99"],
  "كليد (Arabic letters)": ["كليد: kh4yli99", "kh4yli99"],
};
for (const [name, [text, secret]] of Object.entries(leaks)) {
  test(`redactSecrets: ${name}`, () => {
    const out = redactSecrets(text);
    assert.ok(!out.includes(secret), `${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
    assert.match(out, /\[redacted\]/);
  });
}

test("redactSecrets: the text around a redacted value survives", () => {
  assert.equal(redactSecrets('{"user":"bob","token":"abc123xy"}'), '{"user":"bob","token":[redacted]}');
  assert.equal(redactSecrets("key -----BEGIN RSA PRIVATE KEY----- MIIE 7s9dK2 -----END RSA PRIVATE KEY----- done"), "key [redacted] done");
  assert.equal(redactSecrets("رمز عبور: kh4yli99 لطفاً"), "رمز عبور: [redacted] لطفاً");
});

test("redactSecrets: sentences near the new patterns stay readable", () => {
  const sentences = [
    "Tests pass: 42",
    "Tests pass: 42 of 42, build is green.",
    "All checks pass = good news",
    "the bearer of bad news",
    "رمز موفقیت تیم همین بود",
    "کلید اصلی این کار سادگی است",
    "Server=db1;Database=app;",
    '{"user":"bob","count":3}',
    "a => b is an arrow function",
  ];
  for (const s of sentences) assert.equal(redactSecrets(s), s);
});

// review 7: over-redaction. After "name:" only a single token of 8+ characters is a secret, and a
// PEM BEGIN with no END redacts only to the end of its line.
test("redactSecrets: a secret name before : redacts only a single 8+ character value", () => {
  for (const s of ["کلید: فایل config را اول بخوان", "رمز: موفقیت", "Password: hunter2", "token: two words here", "پسورد： کوتاه"]) {
    assert.equal(redactSecrets(s), s, s);
  }
  assert.equal(redactSecrets("Password: hunter22 then"), "Password: [redacted] then");
  assert.equal(redactSecrets("کلید:abcd1234"), "کلید:[redacted]");
  assert.equal(redactSecrets('{"token":"abcd1234"}'), '{"token":[redacted]}');
  assert.equal(redactSecrets('{"token":"abc"}'), '{"token":"abc"}');
  assert.equal(redactSecrets("DB_PASSWORD=short"), "DB_PASSWORD=[redacted]", "= is unchanged");
});

test("redactSecrets: a -----BEGIN with no END redacts only to the end of that line", () => {
  assert.equal(redactSecrets("see -----BEGIN RSA PRIVATE KEY----- MIIEabc\nthe rest stays readable"), "see [redacted]\nthe rest stays readable");
  assert.equal(
    redactSecrets("-----BEGIN KEY-----\nb3BlbnNzaC1rZXk\n-----END KEY-----\nafter"),
    "[redacted]\nafter",
    "a full block still goes whole",
  );
});
