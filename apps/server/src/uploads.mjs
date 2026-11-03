// Files the owner attaches go ahead of their message, a piece at a time, as soon as they are picked:
// each piece is answered once it is on disk, so the bar on the file shows what really reached the
// server (a browser's own upload progress only counts bytes handed to the network). The message then
// names them by id. A resend of the message needs them again, so they stay until they expire.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_KEPT_FILE_BYTES } from "./attachments.mjs";

export const MAX_PIECE_BYTES = 1024 * 1024;
const KEEP_MS = 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f-]{36}$/;

export function createUploads(dir) {
  const bytesFile = (id) => path.join(dir, `${id}.bin`);
  const metaFile = (id) => path.join(dir, `${id}.json`);
  const meta = (id) => {
    if (!ID.test(String(id))) return null;
    try {
      return JSON.parse(fs.readFileSync(metaFile(id), "utf8"));
    } catch {
      return null;
    }
  };
  const received = (id) => fs.statSync(bytesFile(id)).size;
  const sweep = () => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > KEEP_MS) fs.rmSync(file, { force: true });
    }
  };
  const uploads = {
    start({ name, mimeType, size }) {
      if (!Number.isSafeInteger(size) || size <= 0) return { error: "invalid size", status: 400 };
      if (size > MAX_KEPT_FILE_BYTES) return { error: "هر فایل حداکثر ۵۰ مگابایت می‌تواند باشد", status: 413 };
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      sweep();
      const id = crypto.randomUUID();
      fs.writeFileSync(metaFile(id), JSON.stringify({ name: String(name || "file"), mimeType: String(mimeType || ""), size }), { mode: 0o600 });
      fs.writeFileSync(bytesFile(id), "", { mode: 0o600 });
      return { id };
    },
    // A piece at any other offset is a retry of one already stored, or a gap: the answer says where
    // this upload stands and the page goes on from there.
    append(id, offset, piece) {
      const info = meta(id);
      if (!info) return { error: "not found", status: 404 };
      const have = received(id);
      if (offset !== have) return { error: "wrong offset", status: 409, received: have };
      if (have + piece.length > info.size) return { error: "more than the file's size", status: 413 };
      fs.appendFileSync(bytesFile(id), piece);
      return { received: have + piece.length };
    },
    remove(id) {
      if (!ID.test(String(id))) return;
      fs.rmSync(bytesFile(id), { force: true });
      fs.rmSync(metaFile(id), { force: true });
    },
    // An attached file or picture as a message body carries it, or null when it is not all here.
    read(id) {
      const info = meta(id);
      if (!info || received(id) !== info.size) return null;
      return { name: info.name, mimeType: info.mimeType, data: fs.readFileSync(bytesFile(id)).toString("base64") };
    },
    // The message's `images` and `files` with every { uploadId } replaced by its content.
    fill(body) {
      const fill = (list) => list.map((entry) => (entry?.uploadId ? uploads.read(entry.uploadId) : entry));
      const images = Array.isArray(body.images) ? fill(body.images) : body.images;
      const files = Array.isArray(body.files) ? fill(body.files) : body.files;
      if ([...(Array.isArray(images) ? images : []), ...(Array.isArray(files) ? files : [])].includes(null)) return { error: "فایل پیوست پیدا نشد؛ دوباره پیوستش کنید" };
      return { ...body, images, files };
    },
  };
  return uploads;
}

export function registerUploadRoutes(app, uploads, readJson) {
  const answer = (c, out) => (out.error ? c.json({ error: out.error, ...(out.received != null ? { received: out.received } : {}) }, out.status) : c.json(out));
  app.post("/api/uploads", async (c) => {
    const { name, mimeType, size } = await readJson(c);
    const out = uploads.start({ name, mimeType, size });
    return out.error ? answer(c, out) : c.json(out, 201);
  });
  app.put("/api/uploads/:id", async (c) => {
    const offset = Number(c.req.query("offset"));
    if (!Number.isSafeInteger(offset) || offset < 0) return c.json({ error: "invalid offset" }, 400);
    if (Number(c.req.header("content-length") || 0) > MAX_PIECE_BYTES) return c.json({ error: "piece too big" }, 413);
    const piece = Buffer.from(await c.req.arrayBuffer());
    if (piece.length > MAX_PIECE_BYTES) return c.json({ error: "piece too big" }, 413);
    return answer(c, uploads.append(c.req.param("id"), offset, piece));
  });
  app.delete("/api/uploads/:id", (c) => {
    uploads.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
}
