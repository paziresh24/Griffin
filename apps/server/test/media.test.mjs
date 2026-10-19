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
    // Network-independent: example.com resolves to a plain public address.
    const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const tool = createShowMedia({ store: s.store, workspace: s.workspace, fetchImpl, lookup }).tool(s.chat.id);

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

test("show_media refuses URLs that point into the host's own network (SSRF)", async () => {
  const s = setup();
  try {
    let fetched = 0;
    const fetchImpl = async () => {
      fetched += 1;
      return new Response(Buffer.from("x"), { status: 200, headers: { "content-type": "text/plain" } });
    };
    const noDns = () => {
      throw new Error("an IP literal or a private name needs no DNS lookup");
    };
    const tool = createShowMedia({ store: s.store, workspace: s.workspace, fetchImpl, lookup: noDns }).tool(s.chat.id);
    for (const url of [
      "http://127.0.0.1/secret",
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.10/",
      "http://0.0.0.0:8080/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fd00::1]/",
      "http://localhost:3000/",
      "http://db.internal/",
      "http://printer.local/",
    ]) {
      const res = await tool.execute({ url });
      assert.equal(res.isError, true, url);
      assert.match(res.content[0].text, /not a public address/, url);
    }

    // A public-looking name that resolves to a private address is refused too.
    const rebind = createShowMedia({ store: s.store, workspace: s.workspace, fetchImpl, lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.1.2.3", family: 4 }] }).tool(s.chat.id);
    const rebound = await rebind.execute({ url: "http://looks-public.example.com/" });
    assert.equal(rebound.isError, true);
    assert.match(rebound.content[0].text, /non-public address/);
    assert.equal(fetched, 0, "no private URL was fetched");

    // A public name still works.
    const ok = createShowMedia({ store: s.store, workspace: s.workspace, fetchImpl, lookup: async () => [{ address: "93.184.216.34", family: 4 }] }).tool(s.chat.id);
    const good = await ok.execute({ url: "https://example.com/report.txt" });
    assert.equal(good.isError, undefined);
    assert.equal(fetched, 1);
  } finally {
    s.cleanup();
  }
});

test("show_media checks every redirect, so a public URL cannot bounce to a private one", async () => {
  const s = setup();
  try {
    const calls = [];
    const routes = {
      "https://example.com/short": { status: 302, location: "/files/a.txt" },
      "https://example.com/files/a.txt": { status: 200 },
      "https://example.com/evil": { status: 302, location: "http://169.254.169.254/latest/meta-data" },
    };
    const fetchImpl = async (url, opts) => {
      calls.push({ url: String(url), redirect: opts?.redirect });
      const r = routes[String(url)] || { status: 404 };
      return r.location ? new Response(null, { status: r.status, headers: { location: r.location } }) : new Response(Buffer.from("x"), { status: r.status, headers: { "content-type": "text/plain" } });
    };
    const tool = createShowMedia({ store: s.store, workspace: s.workspace, fetchImpl, lookup: async () => [{ address: "93.184.216.34", family: 4 }] }).tool(s.chat.id);
    const ok = await tool.execute({ url: "https://example.com/short" });
    assert.equal(ok.isError, undefined);
    assert.deepEqual(calls.map((c) => c.url), ["https://example.com/short", "https://example.com/files/a.txt"]);
    assert.ok(calls.every((c) => c.redirect !== "follow"), "fetch never follows on its own");
    calls.length = 0;
    const bad = await tool.execute({ url: "https://example.com/evil" });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /not a public address/);
    assert.deepEqual(calls.map((c) => c.url), ["https://example.com/evil"], "the private location is never fetched");
  } finally {
    s.cleanup();
  }
});

test("a name Iran's filter answers is not mistaken for a private address; IPv4 inside IPv6 is judged as IPv4", async () => {
  const s = setup();
  try {
    const fetchImpl = async () => new Response(Buffer.from("x"), { status: 200, headers: { "content-type": "text/plain" } });
    const filtered = createShowMedia({ store: s.store, workspace: s.workspace, fetchImpl, lookup: async () => [{ address: "10.10.34.35", family: 4 }] }).tool(s.chat.id);
    assert.equal((await filtered.execute({ url: "https://x.com/a.png" })).isError, undefined);
    const literal = await filtered.execute({ url: "http://10.10.34.35/" });
    assert.equal(literal.isError, true, "a sinkhole literal is still refused");
    const tool = createShowMedia({ store: s.store, workspace: s.workspace, fetchImpl, lookup: () => { throw new Error("no DNS"); } }).tool(s.chat.id);
    for (const url of ["http://[::7f00:1]/", "http://[::ffff:0:7f00:1]/", "http://[64:ff9b::a00:1]/", "http://[2002:7f00:1::]/", "http://[fec0::1]/", "http://198.18.0.1/", "http://224.0.0.1/"]) {
      const res = await tool.execute({ url });
      assert.equal(res.isError, true, url);
      assert.match(res.content[0].text, /not a public address/, url);
    }
    assert.equal((await tool.execute({ url: "http://[2606:4700::1111]/x.txt" })).isError, undefined, "a public IPv6 literal works");
  } finally {
    s.cleanup();
  }
});
