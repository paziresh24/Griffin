import fs from "node:fs/promises";
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

// App-side tool: show a file from an http(s) URL or from the workspace (e.g. a report the agent
// just wrote). Broker tools return files themselves via { file: { name, mimeType, data } }.
export function createShowMedia({ store, workspace, resolveRoots = null, fetchImpl = fetch }) {
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
              const url = new URL(String(args.url));
              if (!/^https?:$/.test(url.protocol)) throw new Error("url must be http or https");
              const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
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
