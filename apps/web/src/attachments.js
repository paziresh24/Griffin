// What the composer can attach and how it is sent: pictures as `images`, PDFs and
// text-like files as `files: [{ name, mimeType, data }]` (base64), as POST /api/chats/:id/messages
// takes them (server attachments.mjs). No React here: the adapter class only needs FileReader.
import { num, t } from "./i18n.js";

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
/** The types the server takes as a file (the same rule as server attachments.mjs). */
export const isAttachableFile = (mimeType) => mimeType === "application/pdf" || TEXT_TYPE.test(String(mimeType || ""));

// What the server takes: at most 4 files and 4 pictures, 10 MB a text file, 5 MB a PDF (a PDF stays
// in a Claude session and is sent again on every later turn; server attachments.mjs).
export const MAX_FILES = 4;
export const MAX_IMAGES = 4;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_TOTAL_BYTES = 12 * 1024 * 1024;

const fa = (n) => num(n);

/** Null when the file can be attached, else why not (in the owner's words). */
export function fileProblem(file) {
  if (!file?.size) return t("«{name}» خالی است", { name: file?.name || t("فایل") });
  const mime = fileMime(file);
  if (!isAttachableFile(mime)) return t("«{name}» پیوست نمی‌شود: فقط تصویر، PDF یا فایل متنی", { name: file.name });
  if (mime === "application/pdf" && file.size > MAX_PDF_BYTES) return t("«{name}» بزرگ‌تر از {mb} مگابایت است (سقف PDF)", { name: file.name, mb: fa(5) });
  if (file.size > MAX_FILE_BYTES) return t("«{name}» بزرگ‌تر از {mb} مگابایت است", { name: file.name, mb: fa(10) });
  return null;
}

/** Null when one message may carry these, else why not. */
export function countProblem({ images = [], files = [] } = {}) {
  if (files.length > MAX_FILES) return t("حداکثر {n} فایل در یک پیام", { n: fa(MAX_FILES) });
  const pdfBytes = files.filter((f) => (f?.contentType || f?.mimeType) === "application/pdf").reduce((sum, f) => sum + (Number(f?.file?.size) || Math.floor((String(f?.data || "").length * 3) / 4)), 0);
  if (pdfBytes > MAX_PDF_TOTAL_BYTES) return t("PDFهای یک پیام روی هم حداکثر {mb} مگابایت", { mb: fa(12) });
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
  let pdfBytes = 0;
  for (const attachment of attachments) {
    const image = isImageAttachment(attachment);
    if (image) images += 1;
    else files += 1;
    // The PDFs of one message together: the server refuses over 12 MB, and a refused send loses them.
    const pdf = !image && attachment?.contentType === "application/pdf";
    if (pdf) pdfBytes += Number(attachment?.file?.size) || 0;
    const over = image ? images > MAX_IMAGES : files > MAX_FILES || (pdf && pdfBytes > MAX_PDF_TOTAL_BYTES);
    if (over && attachment?.id) {
      extra.push(attachment.id);
      if (image) images -= 1;
      else files -= 1;
      if (pdf) pdfBytes -= Number(attachment?.file?.size) || 0;
    }
  }
  return extra;
}

export const FILE_TYPES = "application/pdf,text/*,application/json,application/yaml,application/x-yaml,application/xml,.md,.markdown,.txt,.log,.csv,.json,.yaml,.yml,.xml";

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
      if (part.type === "image") {
        const match = String(part.image).match(/^data:([^;]+);base64,(.*)$/);
        if (match) images.push({ mimeType: match[1], data: match[2] });
      } else if (part.type === "file" && part.data) {
        files.push({ name: part.filename || attachment.name || "file", mimeType: part.mimeType || fileMime({ name: attachment.name }), data: part.data });
      }
    }
  }
  const fallback = files.length ? t("این فایل را ببین.") : images.length ? t("این تصویر را ببین.") : "";
  return { typed: text, text: text || fallback, images, files };
}

/** What the thread shows of a file before the server has it: its name and size, never its bytes. */
export const filesShown = (files = []) => files.map((file) => ({ name: file.name, mimeType: file.mimeType, bytes: Math.floor((String(file.data || "").length * 3) / 4) }));

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The adapter for PDFs and text: read as base64 at send time, carried as a `file` part.
export class FileAttachmentAdapter {
  accept = FILE_TYPES;

  async add({ file }) {
    const problem = fileProblem(file);
    if (problem) throw new Error(problem);
    return {
      id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      type: "document",
      name: file.name,
      contentType: fileMime(file),
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  async send(attachment) {
    const data = await readBase64(attachment.file);
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{ type: "file", filename: attachment.name, mimeType: attachment.contentType, data }],
    };
  }

  async remove() {}
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
