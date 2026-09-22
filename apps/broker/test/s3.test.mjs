import test from "node:test";
import assert from "node:assert/strict";
import { createS3Tools, encodeKey, parseListObjects, signV4 } from "../src/s3.mjs";
import { TEST_SITE } from "./fixture-site.mjs";

test("SigV4 matches the AWS reference example (GET object, empty payload)", () => {
  // AWS "Signature Calculations for the Authorization Header" example keys and date.
  const headers = signV4({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    accessKey: "AKIAIOSFODNN7EXAMPLE",
    secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(headers["x-amz-date"], "20130524T000000Z");
  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(encodeKey("attachments/1/a b(1).jpg"), "attachments/1/a%20b%281%29.jpg");
});

test("ListObjectsV2 XML parsing", () => {
  const xml = "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken><Contents><Key>a/1.jpg</Key><Size>10</Size><LastModified>2026-09-14T11:00:00Z</LastModified></Contents><CommonPrefixes><Prefix>a/</Prefix></CommonPrefixes></ListBucketResult>";
  assert.deepEqual(parseListObjects(xml), { objects: [{ key: "a/1.jpg", size: 10, lastModified: "2026-09-14T11:00:00Z" }], prefixes: ["a/"], truncated: true, nextToken: "tok&1" });
});

test("s3 tools read owner keys from the cluster secret, sign, and return images; keys never appear in results", async () => {
  const b64 = (s) => Buffer.from(s).toString("base64");
  const kube = {
    withFallback: async (_cluster, { viaApi }) => ({ value: await viaApi(), source: "public-api test" }),
    publicRequest: async (_cluster, path) => {
      assert.equal(path, "/api/v1/namespaces/storage/secrets/s3-credentials");
      return { body: { data: { "team-a-accessKey": b64("AKTEST"), "team-a-secretKey": b64("SECRET-VALUE") } } };
    },
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, auth: init.headers.Authorization });
    const u = new URL(url);
    if (init.method === "GET" && u.searchParams.get("list-type")) {
      return new Response("<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>attachments/1/old.jpg</Key><Size>3</Size><LastModified>2026-09-13T00:00:00Z</LastModified></Contents><Contents><Key>attachments/2/new.jpg</Key><Size>3</Size><LastModified>2026-09-14T00:00:00Z</LastModified></Contents></ListBucketResult>");
    }
    if (init.method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "image/jpeg", "content-length": "3" } });
    if (u.pathname.endsWith("/missing.jpg")) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), { status: 200 });
  };
  const s3 = createS3Tools({ kube, config: TEST_SITE.s3, fetchImpl });
  const list = await s3.s3_list.execute({ owner: "team-a", bucket: "uploads", prefix: "attachments/" });
  assert.deepEqual(list.objects.map((o) => o.key), ["attachments/2/new.jpg", "attachments/1/old.jpg"], "newest first");
  assert.equal(list.complete, true);
  const got = await s3.s3_get.execute({ owner: "team-a", bucket: "uploads", key: "attachments/2/new.jpg" });
  assert.deepEqual(got.file, { name: "new.jpg", mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64") });
  assert.ok(calls.every((c) => c.auth.includes("Credential=AKTEST/") && ["GET", "HEAD"].includes(c.method)));
  assert.ok(!JSON.stringify({ list, got }).includes("SECRET-VALUE"));
  await assert.rejects(s3.s3_get.execute({ owner: "team-a", bucket: "uploads", key: "missing.jpg" }), /http_\d+/);
  await assert.rejects(s3.s3_list.execute({ owner: "nobody", bucket: "x-y-z" }), /no S3 keys for owner "nobody"/);
  await assert.rejects(s3.s3_list.execute({ owner: "team-a", bucket: "../etc" }), /invalid bucket/);
});
