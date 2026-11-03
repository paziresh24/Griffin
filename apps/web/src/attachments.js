import { num, t } from "./i18n.js";
import { retryableError } from "./outbox.js";
// What the composer can attach and how it is sent. A file goes to the server as soon
// as it is picked, a piece at a time (server uploads.mjs), with the bar on its chip; the message then
// names it by id: `images` for pictures, `files` for the rest, as POST /api/chats/:id/messages takes
// them (server attachments.mjs). A small PDF or text file reaches the model inline; anything else (a
// big PDF, zip, xlsx, audio…) the server saves in the chat's folder for the agent's file tools. A
// picture over Claude's 5 MB is shrunk here first. No React here: the adapter classes only need a
// canvas for shrinking.
const BY_EXTENSION = {
  pdf: "application/pdf",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  html: "text/html",
};

// A known extension decides: browsers leave the type empty for many text files (.md, .yml) and
// Windows reports a .csv as application/vnd.ms-excel, which the server refuses.
export function fileMime({ name = "", type = "" } = {}) {
  const ext = String(name).includes(".") ? String(name).split(".").pop().toLowerCase() : "";
  return BY_EXTENSION[ext] || type || "application/octet-stream";
}

const TEXT_TYPE = /^(?:text\/[a-z0-9.+-]+|application\/(?:json|yaml|x-yaml|xml))$/;
/** The types the model reads inline (the same rule as server attachments.mjs); others are kept as files. */
export const isAttachableFile = (mimeType) => mimeType === "application/pdf" || TEXT_TYPE.test(String(mimeType || ""));

// What the server takes: at most 4 files and 20 pictures, 50 MB a file, 80 MB a message. Inline caps
// (5 MB a PDF, 10 MB a text file) only decide whether the server sends it inline or keeps it.
export const MAX_FILES = 4;
export const MAX_IMAGES = 20;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 80 * 1024 * 1024;
export const MAX_PDF_BYTES = 5 * 1024 * 1024;
// A picture Claude takes inline (the server's 7,000,000 base64 characters).
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const fa = (n) => num(n);

/** Null when the file can be attached, else why not (in the owner's words). */
export function fileProblem(file) {
  if (!file?.size) return t("«{name}» خالی است", { name: file?.name || t("فایل") });
  if (file.size > MAX_FILE_BYTES) return t("«{name}» بزرگ‌تر از {mb} مگابایت است", { name: file.name, mb: fa(50) });
  return null;
}

/** Null when one message may carry these, else why not. */
export function countProblem({ images = [], files = [] } = {}) {
  if (files.length > MAX_FILES) return t("حداکثر {n} فایل در یک پیام", { n: fa(MAX_FILES) });
  const bytes = files.reduce((sum, f) => sum + (Number(f?.file?.size) || Number(f?.bytes) || 0), 0);
  if (bytes > MAX_MESSAGE_BYTES) return t("فایل‌های یک پیام روی هم حداکثر {mb} مگابایت", { mb: fa(80) });
  if (images.length > MAX_IMAGES) return t("حداکثر {n} تصویر در یک پیام", { n: fa(MAX_IMAGES) });
  return null;
}

/**
 * The attachments over a message's limits, newest first to go: the composer removes them as soon
 * as they are added, so a send never fails on the count and loses what was attached.
 */
export function overLimit(attachments = []) {
  const extra = [];
  let files = 0;
  let images = 0;
  let bytes = 0;
  for (const attachment of attachments) {
    const image = isImageAttachment(attachment);
    if (image) images += 1;
    else files += 1;
    // A message's files together: the server refuses over 80 MB, and a refused send loses them.
    const size = image ? 0 : Number(attachment?.file?.size) || 0;
    bytes += size;
    const over = image ? images > MAX_IMAGES : files > MAX_FILES || bytes > MAX_MESSAGE_BYTES;
    if (over && attachment?.id) {
      extra.push(attachment.id);
      if (image) images -= 1;
      else files -= 1;
      bytes -= size;
    }
  }
  return extra;
}

// Any file: what the model cannot read inline the server keeps for the agent's file tools.
export const FILE_TYPES = "*";

/** A drag that carries files (not selected text or a link): only those are a drop on the chat. */
export const dragHasFiles = (dataTransfer) => Array.from(dataTransfer?.types || []).includes("Files");

export const isImageAttachment = (attachment) => attachment?.type === "image" || String(attachment?.contentType || "").startsWith("image/");

/** A composer message as the server takes it; `typed` is exactly what the owner wrote. */
export function attachmentPayload(message) {
  const text = (message?.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const images = [];
  const files = [];
  for (const attachment of message?.attachments || []) {
    for (const part of attachment.content || []) {
      if (part.uploadId) (part.type === "image" ? images : files).push({ uploadId: part.uploadId, name: part.filename, mimeType: part.mimeType, bytes: part.bytes });
    }
  }
  const fallback = files.length ? t("این فایل را ببین.") : images.length ? t("این تصویر را ببین.") : "";
  return { typed: text, text: text || fallback, images, files };
}

/** What the thread shows of a file before the server has it: its name and size, never its bytes. */
export const filesShown = (files = []) => files.map((file) => ({ name: file.name, mimeType: file.mimeType, bytes: file.bytes }));

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// A piece small enough that the bar moves on a slow line, and big enough for a fast one.
export const PIECE_BYTES = 512 * 1024;
const RETRIES = 5;

/**
 * Sends a file a piece at a time, yielding the percent the server has confirmed, and returns the
 * upload's id. A piece lost to the network goes again; the server's 409 says where it stands.
 * talk: start({ name, mimeType, size }) -> { id }, put(id, offset, piece, signal) -> { received }.
 */
export async function* sendPieces(blob, { name, mimeType }, talk, signal, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const { id } = await talk.start({ name, mimeType, size: blob.size });
  let sent = 0;
  let tries = 0;
  while (sent < blob.size) {
    try {
      ({ received: sent } = await talk.put(id, sent, blob.slice(sent, sent + PIECE_BYTES), signal));
      tries = 0;
      yield Math.floor((sent * 100) / blob.size);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.status === 409 && Number.isFinite(error.body?.received)) sent = error.body.received;
      else if (!retryableError(error) || ++tries > RETRIES) throw error;
      else await wait(tries * 1000);
    }
  }
  return id;
}

/**
 * This composer's uploads: `busy` until each is done, or removed when it failed, so a message never
 * goes without a file the box shows. talk.remove(id) drops a stored one that was taken out.
 */
export function createUploads(talk) {
  const live = new Map(); // attachment id -> { controller, uploadId, done }
  const listeners = new Set();
  let busy = false;
  const changed = () => {
    busy = [...live.values()].some((upload) => !upload.done);
    for (const listener of listeners) listener();
  };
  // Pending first, so the chip shows at once; each step of the upload then updates it.
  async function* run(pending, blob, mimeType) {
    const upload = { controller: new AbortController(), uploadId: null, done: false };
    live.set(pending.id, upload);
    changed();
    const running = (progress) => ({ ...pending, status: { type: "running", reason: "uploading", progress } });
    yield running(0);
    try {
      const pieces = sendPieces(blob, { name: pending.name, mimeType }, talk, upload.controller.signal);
      for (let step = await pieces.next(); ; step = await pieces.next()) {
        if (step.done) {
          upload.uploadId = step.value;
          break;
        }
        yield running(step.value);
      }
    } catch (error) {
      if (upload.controller.signal.aborted) return;
      console.warn("[upload]", error);
      throw new Error(t("«{name}» آپلود نشد؛ حذفش کنید و دوباره بگذارید", { name: pending.name }));
    }
    upload.done = true;
    changed();
    yield { ...pending, uploadId: upload.uploadId, status: { type: "requires-action", reason: "composer-send" } };
  }
  const uploads = {
    run,
    busy: () => busy,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sent(id) {
      live.delete(id);
      changed();
    },
    remove(id) {
      const upload = live.get(id);
      if (!upload) return;
      upload.controller.abort();
      live.delete(id);
      changed();
      if (upload.uploadId) Promise.resolve(talk.remove(upload.uploadId)).catch(() => {});
    },
    // The box is gone (another chat): what it held went with it.
    stop() {
      for (const id of [...live.keys()]) uploads.remove(id);
    },
  };
  return uploads;
}

// The adapter for any other file.
export class FileAttachmentAdapter {
  accept = FILE_TYPES;

  constructor(uploads) {
    this.uploads = uploads;
  }

  async *add({ file }) {
    const problem = fileProblem(file);
    if (problem) throw new Error(problem);
    const contentType = fileMime(file);
    const pending = { id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, type: "document", name: file.name, contentType, file };
    yield* this.uploads.run(pending, file, contentType);
  }

  async send(attachment) {
    this.uploads.sent(attachment.id);
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{ type: "file", filename: attachment.name, mimeType: attachment.contentType, uploadId: attachment.uploadId, bytes: attachment.file.size }],
    };
  }

  async remove(attachment) {
    this.uploads.remove(attachment.id);
  }
}

// Pictures: inline when Claude takes them (PNG, JPEG, WebP, GIF up to 5 MB). A bigger PNG/JPEG/WebP
// is redrawn smaller as JPEG; one that still does not fit, an animated GIF or another type (HEIC,
// TIFF…) goes as it is, and the server keeps it as a file for the agent.
const INLINE_IMAGE = /^image\/(png|jpeg|webp|gif)$/;
const SHRINKABLE_IMAGE = /^image\/(png|jpeg|webp)$/;

/** The size a picture is redrawn at: its longest side at most `maxSide`, never enlarged. */
export function fitSize(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** How a picture is sent: "image" as it is, "shrink" first, or "file". */
export function imageRoute({ type = "", size = 0 } = {}) {
  if (INLINE_IMAGE.test(type) && size <= MAX_IMAGE_BYTES) return "image";
  if (SHRINKABLE_IMAGE.test(type)) return "shrink";
  return "file";
}

// A JPEG under the cap, or null (no canvas, an undecodable file, still too big).
async function shrinkImage(file) {
  try {
    if (typeof createImageBitmap !== "function") return null;
    const bitmap = await createImageBitmap(file);
    for (const [maxSide, quality] of [[3072, 0.85], [2560, 0.8], [2048, 0.75], [1600, 0.7]]) {
      const { width, height } = fitSize(bitmap.width, bitmap.height, maxSide);
      const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff"; // a transparent PNG becomes JPEG on white, not black
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: "image/jpeg", quality }) : await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= MAX_IMAGE_BYTES) {
        bitmap.close?.();
        return blob;
      }
    }
    bitmap.close?.();
    return null;
  } catch {
    return null;
  }
}

export class ImageAttachmentAdapter {
  accept = "image/*";

  constructor(uploads) {
    this.uploads = uploads;
  }

  async *add({ file }) {
    const problem = fileProblem(file);
    if (problem) throw new Error(problem);
    const pending = { id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, type: "image", name: file.name, contentType: file.type, file };
    const blob = (imageRoute(file) === "shrink" && (await shrinkImage(file))) || file;
    yield* this.uploads.run({ ...pending, contentType: blob.type, bytes: blob.size }, blob, blob.type);
  }

  async send(attachment) {
    this.uploads.sent(attachment.id);
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{ type: "image", image: "", filename: attachment.name, mimeType: attachment.contentType, uploadId: attachment.uploadId, bytes: attachment.bytes }],
    };
  }

  async remove(attachment) {
    this.uploads.remove(attachment.id);
  }
}
