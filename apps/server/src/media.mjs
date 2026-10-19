import fs from "node:fs/promises";
import net from "node:net";
import dns from "node:dns/promises";
import path from "node:path";

// Media from any source (a broker tool, a URL, a workspace file) is stored per chat and rendered
// by the UI by type: image, video, audio, PDF, Markdown/text inline; anything else as a download.
// Tool results carry { media: { mediaId, mimeType, name, bytes } }; the bytes never enter events.

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_FOR_MODEL = 60_000;
const MODEL_IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

const BY_EXTENSION = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", opus: "audio/ogg",
  pdf: "application/pdf",
  md: "text/markdown", markdown: "text/markdown", txt: "text/plain", log: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", yaml: "application/yaml", yml: "application/yaml", xml: "application/xml", html: "text/html", htm: "text/html",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
};

export function guessMimeType(name, declared) {
  const clean = String(declared || "").split(";")[0].trim().toLowerCase();
  if (clean && clean !== "application/octet-stream" && clean !== "binary/octet-stream") return clean;
  const ext = String(name || "").split("?")[0].split(".").pop().toLowerCase();
  return BY_EXTENSION[ext] || "application/octet-stream";
}

export function isTextType(mimeType) {
  return /^text\/|^application\/(json|yaml|xml|x-ndjson)$/.test(mimeType);
}

// Types the browser may render inline from our origin. HTML and SVG can run script, so they are
// served as plain text (HTML) or only inside an <img> (SVG, with a sandbox CSP on the response).
export function servingHeaders(media) {
  const type = media.mime_type;
  const name = encodeURIComponent(media.meta?.name || "file");
  const inline = /^(image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)|video\/|audio\/|application\/pdf$)/.test(type) || isTextType(type);
  return {
    "content-type": type === "text/html" ? "text/plain; charset=utf-8" : isTextType(type) ? `${type}; charset=utf-8` : type,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
    "cache-control": "private, max-age=86400",
    "x-content-type-options": "nosniff",
    // Chrome refuses to render a PDF under a sandbox CSP; every other type keeps it.
    "content-security-policy": type === "application/pdf"
      ? "default-src 'none'; object-src 'self'; plugin-types application/pdf"
      : "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    "accept-ranges": "bytes",
  };
}

// Stores a file and returns the tool content: a text summary (with the media id), the picture for
// images the model can read, or the text itself for text files.
export function storeMedia(store, { chatId, name, mimeType, data, meta = {} }) {
  if (!store || !chatId) throw new Error("media store unavailable");
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "base64");
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error(`file is ${bytes.length} bytes; the limit is ${MAX_MEDIA_BYTES}`);
  const type = guessMimeType(name, mimeType);
  const mediaId = store.saveMedia({ chatId, mimeType: type, data: bytes, meta: { ...meta, name: name || null } });
  return { mediaId, mimeType: type, name: name || null, bytes: bytes.length, raw: bytes };
}

export function mediaContent(summary, media) {
  const content = [{ type: "text", text: JSON.stringify(summary) }];
  if (MODEL_IMAGE_TYPES.test(media.mimeType) && media.bytes <= 8 * 1024 * 1024) {
    content.push({ type: "image", data: media.raw.toString("base64"), mimeType: media.mimeType });
  } else if (isTextType(media.mimeType)) {
    const text = media.raw.toString("utf8");
    content.push({ type: "text", text: text.length > MAX_TEXT_FOR_MODEL ? `${text.slice(0, MAX_TEXT_FOR_MODEL)}\n… [truncated]` : text });
  }
  return content;
}

export const SHOW_MEDIA_TOOL = "show_media";

const PRIVATE_HOSTNAME_SUFFIXES = [".internal", ".local", ".localhost"];
// Some national DNS filters (Iran's, for one) answer a blocked name with one of these. Such a name is not private: the fetch
// goes out through the egress proxy, which resolves it again outside. Allowed only as a DNS
// answer, never as a literal host.
const FILTER_SINKHOLES = new Set(["10.10.34.34", "10.10.34.35", "10.10.34.36"]);
const MAX_REDIRECTS = 3;

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true; // unparsable: fail closed
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 10) return true; // "this network", loopback, RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT, also used inside clusters
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

// Eight 16-bit groups, with "::" expanded and a dotted IPv4 tail folded in.
function ipv6Groups(ip) {
  let text = ip.toLowerCase().split("%")[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  return [...left, ...Array(fill).fill("0"), ...right].map((g) => parseInt(g, 16));
}

const v4From = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPrivateIPv6(ip) {
  const g = ipv6Groups(ip);
  if (g.length !== 8 || g.some((n) => Number.isNaN(n))) return true; // fail closed
  const zeroHead = (n) => g.slice(0, n).every((x) => x === 0);
  if (zeroHead(8)) return true; // ::
  if (zeroHead(7) && g[7] === 1) return true; // ::1
  // An IPv4 address carried inside IPv6 is judged as that IPv4 address: mapped (::ffff:a.b.c.d,
  // which WHATWG URL writes as hex), compatible (::a.b.c.d), SIIT (::ffff:0:a.b.c.d), NAT64
  // (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::).
  if (zeroHead(5) && (g[5] === 0xffff || g[5] === 0)) return isPrivateIPv4(v4From(g[6], g[7]));
  if (zeroHead(4) && g[4] === 0xffff && g[5] === 0) return isPrivateIPv4(v4From(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateIPv4(v4From(g[6], g[7]));
  if (g[0] === 0x2002) return isPrivateIPv4(v4From(g[1], g[2]));
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // not a recognizable IP shape: fail closed
}

// show_media fetches whatever URL it is given, so without this it is a path into the host's own
// network (SSRF) for any caller. Refuses loopback, private, link-local, CGNAT and multicast
// addresses (IPv4 inside IPv6 too) and *.internal/*.local names, and for a DNS name checks every
// address it resolves to. The name is resolved here once; a name whose answer changes between this
// check and the connection is not caught here — the egress proxy should refuse private targets.
export async function assertPublicUrl(rawUrl, { lookup = dns.lookup } = {}) {
  const url = new URL(String(rawUrl));
  if (!/^https?:$/.test(url.protocol)) throw new Error("url must be http or https");
  const hostname = url.hostname.toLowerCase();
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (bareHost === "localhost" || PRIVATE_HOSTNAME_SUFFIXES.some((suffix) => bareHost.endsWith(suffix))) {
    throw new Error(`url host is not a public address: ${hostname}`);
  }
  if (net.isIP(bareHost)) {
    if (isPrivateIP(bareHost)) throw new Error(`url host is not a public address: ${hostname}`);
    return url;
  }
  let addresses;
  try {
    addresses = await lookup(bareHost, { all: true });
  } catch {
    throw new Error(`could not resolve host: ${hostname}`);
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (!list.length) throw new Error(`could not resolve host: ${hostname}`);
  for (const entry of list) {
    const address = typeof entry === "string" ? entry : entry?.address;
    if (FILTER_SINKHOLES.has(address)) continue;
    if (!address || isPrivateIP(address)) throw new Error(`url host resolves to a non-public address: ${hostname}`);
  }
  return url;
}

// Redirects are followed by hand, each new location checked like the first, so a public URL
// cannot bounce to a private one.
export async function fetchPublic(rawUrl, { fetchImpl = fetch, lookup = dns.lookup, init = {}, timeoutMs = 60_000 } = {}) {
  let url = await assertPublicUrl(rawUrl, { lookup });
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return { url, response };
    if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
    url = await assertPublicUrl(new URL(location, url), { lookup });
  }
}

// App-side tool: show a file from an http(s) URL or from the workspace (e.g. a report the agent
// just wrote). Broker tools return files themselves via { file: { name, mimeType, data } }.
export function createShowMedia({ store, workspace, resolveRoots = null, fetchImpl = fetch, lookup = dns.lookup }) {
  return {
    tool(chatId) {
      return {
        description:
          "Show the owner a file in the chat: image, video, audio, PDF, Markdown, text/CSV/JSON (rendered inline) or anything else (download). Give either a workspace path (files you created or found) or an http(s) URL. You get back a summary; images and text are also given to you.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "file path under /workspace (absolute or relative)" },
            url: { type: "string", description: "http(s) URL" },
            title: { type: "string", description: "short caption" },
          },
          additionalProperties: false,
        },
        async execute(args) {
          try {
            let file;
            if (args?.path) {
              const roots = (resolveRoots ? resolveRoots(chatId) : [workspace]).map((r) => path.resolve(r));
              const given = String(args.path);
              let target = null;
              let rootUsed = roots[0];
              for (const root of roots) {
                const candidate = path.resolve(root, given);
                if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) {
                  try {
                    const stat = await fs.stat(candidate);
                    if (stat.isFile()) {
                      target = candidate;
                      rootUsed = root;
                      break;
                    }
                  } catch {
                    // try next root
                  }
                }
              }
              if (!target) throw new Error("path must be a file inside the workspace");
              const stat = await fs.stat(target);
              if (stat.size > MAX_MEDIA_BYTES) throw new Error(`file is ${stat.size} bytes; the limit is ${MAX_MEDIA_BYTES}`);
              file = { name: path.basename(target), mimeType: null, data: await fs.readFile(target), source: `workspace ${path.relative(rootUsed, target)}` };
            } else if (args?.url) {
              const { url, response } = await fetchPublic(args.url, { fetchImpl, lookup });
              if (!response.ok) throw new Error(`http ${response.status}`);
              const declared = Number(response.headers.get("content-length") || 0);
              if (declared > MAX_MEDIA_BYTES) throw new Error(`file is ${declared} bytes; the limit is ${MAX_MEDIA_BYTES}`);
              const data = Buffer.from(await response.arrayBuffer());
              file = { name: decodeURIComponent(url.pathname.split("/").pop() || url.hostname), mimeType: response.headers.get("content-type"), data, source: `url ${url.host}` };
            } else {
              throw new Error("give path or url");
            }
            const media = storeMedia(store, { chatId, name: file.name, mimeType: file.mimeType, data: file.data, meta: { source: file.source, title: args.title || null } });
            const { raw, ...summaryMedia } = media;
            return { content: mediaContent({ title: args.title || null, source: file.source, media: summaryMedia }, media) };
          } catch (error) {
            return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
          }
        },
      };
    },
  };
}
