import crypto from "node:crypto";
import { K8S_NAME, ToolInputError } from "./kube.mjs";

// Read-only S3 (developed against SeaweedFS, plain AWS SigV4 so any S3 API works). Endpoint,
// region and the Kubernetes Secret holding the key pair ("<owner>-accessKey" / "<owner>-secretKey")
// come from the site config:
//
//   "s3": { "cluster": "prod", "endpoint": "https://s3.example.com", "region": "us-east-1",
//           "secret": { "namespace": "storage", "name": "s3-credentials" } }
//
// The broker reads the pair at call time and signs requests itself; keys never reach the agent.
// Only GET/HEAD are ever sent.

export const DEFAULT_S3 = null;

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

// RFC 3986 encoding as S3 expects; "/" kept in object keys.
export function encodeKey(key) {
  return key.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

export function signV4({ method, url, accessKey, secretKey, region, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256hex("");
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const headers = { host: u.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join("");
  const canonical = [method, u.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(toSign).digest("hex");
  return {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function xmlValues(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
}

const unescapeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function parseListObjects(xml) {
  const objects = xmlValues(xml, "Contents").map((block) => ({
    key: unescapeXml(xmlValues(block, "Key")[0] || ""),
    size: Number(xmlValues(block, "Size")[0] || 0),
    lastModified: xmlValues(block, "LastModified")[0] || null,
  }));
  return {
    objects,
    prefixes: xmlValues(xml, "CommonPrefixes").map((b) => unescapeXml(xmlValues(b, "Prefix")[0] || "")),
    truncated: xmlValues(xml, "IsTruncated")[0] === "true",
    nextToken: unescapeXml(xmlValues(xml, "NextContinuationToken")[0] || "") || null,
  };
}

export function createS3Tools({ kube, config = DEFAULT_S3, fetchImpl = fetch }) {
  const cache = new Map(); // owner -> { at, keys }

  async function ownerKeys(owner) {
    if (!config) throw new ToolInputError("no S3 configured — add an \"s3\" section to the site config");
    if (!K8S_NAME.test(owner)) throw new ToolInputError("owner must be a key-pair owner name, e.g. team-a");
    const hit = cache.get(owner);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.keys;
    const { namespace, name } = config.secret;
    const result = await kube.withFallback(config.cluster, {
      viaApi: async () => (await kube.publicRequest(config.cluster, `/api/v1/namespaces/${namespace}/secrets/${name}`)).body,
      viaSsh: async () => JSON.parse(await kube.emergency(config.cluster, ["get", "secret", name, "-n", namespace, "-o", "json"])),
    });
    const data = result.value?.data || {};
    const accessKey = data[`${owner}-accessKey`];
    const secretKey = data[`${owner}-secretKey`];
    if (!accessKey || !secretKey) throw new ToolInputError(`no S3 keys for owner "${owner}" in ${namespace}/${name}`);
    const keys = { accessKey: Buffer.from(accessKey, "base64").toString().trim(), secretKey: Buffer.from(secretKey, "base64").toString().trim(), keySource: result.source };
    cache.set(owner, { at: Date.now(), keys });
    return keys;
  }

  async function request(owner, method, path, params = {}) {
    const keys = await ownerKeys(owner);
    const url = new URL(config.endpoint + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const headers = signV4({ method, url: url.toString(), accessKey: keys.accessKey, secretKey: keys.secretKey, region: config.region });
    const response = await fetchImpl(url, { method, headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const code = xmlValues(body, "Code")[0];
      throw new Error(`S3 ${method} ${url.pathname} http_${response.status}${code ? ` ${code}` : ""}`);
    }
    return { response, source: `s3 ${url.host} as ${owner}` };
  }

  const bucketArg = { type: "string", description: "bucket name" };
  const ownerArg = { type: "string", pattern: K8S_NAME.source, description: "whose key pair in the credentials Secret to sign with" };

  function requireBucket(value) {
    const bucket = String(value || "");
    if (!BUCKET.test(bucket)) throw new ToolInputError("invalid bucket name");
    return bucket;
  }

  return {
    s3_list: {
      description:
        "List objects in an S3 bucket (read-only). S3 lists keys alphabetically, not by time: results are sorted newest-first only over the keys scanned. Buckets with hundreds of thousands of objects cannot be scanned fully — for \"latest upload\" find the key in the app's logs/DB (kube_logs) and use s3_get, or narrow with a prefix.",
      inputSchema: {
        type: "object",
        properties: {
          owner: ownerArg,
          bucket: bucketArg,
          prefix: { type: "string", maxLength: 512 },
          delimiter: { type: "string", enum: ["/"], description: "group by folder" },
          maxPages: { type: "integer", minimum: 1, maximum: 50, description: "pages of 1000 keys to scan (default 5; ~0.3s each)" },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "objects returned (default 30)" },
        },
        required: ["owner", "bucket"],
        additionalProperties: false,
      },
      async execute(args) {
        const owner = String(args.owner || "");
        const bucket = requireBucket(args.bucket);
        const prefix = String(args.prefix || "");
        if (/[\0\r\n]/.test(prefix)) throw new ToolInputError("invalid prefix");
        const maxPages = Math.min(Math.max(Number(args.maxPages) || 5, 1), 50);
        const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
        const objects = [];
        const prefixes = new Set();
        let token = null;
        let pages = 0;
        let truncated = false;
        let source = "";
        do {
          const { response, source: s } = await request(owner, "GET", `/${bucket}`, {
            "list-type": 2, "max-keys": 1000, prefix, delimiter: args.delimiter, "continuation-token": token,
          });
          source = s;
          const page = parseListObjects(await response.text());
          objects.push(...page.objects);
          page.prefixes.forEach((p) => prefixes.add(p));
          token = page.nextToken;
          truncated = page.truncated;
          pages += 1;
        } while (truncated && token && pages < maxPages);
        objects.sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)));
        return {
          bucket,
          prefix: prefix || null,
          scanned: objects.length,
          complete: !truncated,
          note: truncated ? `stopped after ${pages} pages; newest-first order is only over the scanned keys — narrow the prefix` : undefined,
          prefixes: [...prefixes].slice(0, 100),
          objects: objects.slice(0, limit),
          source,
        };
      },
    },

    s3_get: {
      description:
        "Fetch one object from an S3 bucket (read-only, ≤25MB) and show it to the owner in the chat: images, video, audio, PDF, Markdown and text render inline, anything else as a download. Images and text are also given to you.",
      inputSchema: {
        type: "object",
        properties: { owner: ownerArg, bucket: bucketArg, key: { type: "string", minLength: 1, maxLength: 1024 } },
        required: ["owner", "bucket", "key"],
        additionalProperties: false,
      },
      async execute(args) {
        const owner = String(args.owner || "");
        const bucket = requireBucket(args.bucket);
        const key = String(args.key || "");
        if (!key || /[\0\r\n]/.test(key)) throw new ToolInputError("invalid key");
        const path = `/${bucket}/${encodeKey(key)}`;
        const head = await request(owner, "HEAD", path);
        const contentType = (head.response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
        const size = Number(head.response.headers.get("content-length") || 0);
        const meta = { bucket, key, contentType, size, lastModified: head.response.headers.get("last-modified"), source: head.source };
        if (size > MAX_FILE_BYTES) return { ...meta, note: `object is ${size} bytes; larger than ${MAX_FILE_BYTES}, not downloaded` };
        const { response } = await request(owner, "GET", path);
        const data = Buffer.from(await response.arrayBuffer()).toString("base64");
        return { ...meta, file: { name: key.split("/").pop(), mimeType: contentType, data } };
      },
    },
  };
}
