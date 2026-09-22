import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { createShowMedia, guessMimeType, servingHeaders } from "../src/media.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-media-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const chat = store.createChat({ title: "t", model: null, mode: "agent" });
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace);
  const runner = { activeCount: () => 0, isActive: () => false };
  const app = createApp({ store, runner });
  return { dir, store, chat, workspace, app, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("mime guessing and safe serving headers", () => {
  assert.equal(guessMimeType("report.pdf", "application/octet-stream"), "application/pdf");
  assert.equal(guessMimeType("notes.md", ""), "text/markdown");
  assert.equal(guessMimeType("x.mp4", "video/mp4; codecs=avc1"), "video/mp4");
  const html = servingHeaders({ mime_type: "text/html", meta: { name: "a.html" } });
  assert.equal(html["content-type"], "text/plain; charset=utf-8", "HTML is never rendered from our origin");
  assert.match(html["content-security-policy"], /sandbox/);
  assert.match(servingHeaders({ mime_type: "application/zip", meta: {} })["content-disposition"], /^attachment/);
  assert.doesNotMatch(servingHeaders({ mime_type: "application/pdf", meta: {} })["content-security-policy"], /sandbox/, "Chrome blocks sandboxed PDFs");
  assert.match(servingHeaders({ mime_type: "application/pdf", meta: { name: "گزارش.pdf" } })["content-disposition"], /^inline; filename\*=UTF-8''%DA%AF/);
});

test("show_media stores workspace files and URLs; text reaches the model; paths stay in the workspace", async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.workspace, "report.md"), "# سلام\n\nجدول");
    const fetchImpl = async () => new Response(Buffer.from("%PDF-1.7 fake"), { status: 200, headers: { "content-type": "application/pdf" } });
    const tool = createShowMedia({ store: s.store, workspace: s.workspace, fetchImpl }).tool(s.chat.id);

    const md = await tool.execute({ path: "report.md", title: "گزارش" });
    const mdSummary = JSON.parse(md.content[0].text);
    assert.equal(mdSummary.media.mimeType, "text/markdown");
    assert.equal(md.content[1].text, "# سلام\n\nجدول");

    const pdf = await tool.execute({ url: "https://example.com/files/a.pdf" });
    const pdfSummary = JSON.parse(pdf.content[0].text);
    assert.equal(pdfSummary.media.mimeType, "application/pdf");
    assert.equal(pdf.content.length, 1, "PDF bytes are not sent to the model");

    const escape = await tool.execute({ path: "../../etc/passwd" });
    assert.equal(escape.isError, true);
    assert.match(escape.content[0].text, /inside the workspace/);
    assert.equal((await tool.execute({ url: "file:///etc/passwd" })).isError, true);

    // served back with Range support
    const full = await s.app.request(`/api/media/${pdfSummary.media.mediaId}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "application/pdf");
    const part = await s.app.request(`/api/media/${pdfSummary.media.mediaId}`, { headers: { range: "bytes=0-3" } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "%PDF");
    assert.equal(part.headers.get("content-range"), "bytes 0-3/13");
    const list = await (await s.app.request(`/api/chats/${s.chat.id}/media`)).json();
    assert.equal(list.media.length, 2);
  } finally {
    s.cleanup();
  }
});
