import test from "node:test";
import assert from "node:assert/strict";
import { createWebTools, htmlToText, parseDuckDuckGo, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../src/web-search.mjs";

const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];
const body = (status, text, type = "text/html; charset=utf-8") => new Response(text, { status, headers: { "content-type": type } });
const DDG = `
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://cloudnative-pg.io/docs/wal/">WAL archiving - <b>CloudNativePG</b></a></h2>
  <a class="result__snippet" href="https://cloudnative-pg.io/docs/wal/"><b>WAL</b> archiving &amp; PITR in CloudNativePG</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa%3Fx%3D1&amp;rut=abc">Second</a></h2>
  <a class="result__snippet" href="#">second snippet</a>
</div>
<div class="result results_links result--ad">
  <a class="result__a" href="https://ads.example.com/">Buy now</a>
</div>`;

test("parseDuckDuckGo reads titles, real URLs and snippets, and skips ads", () => {
  const r = parseDuckDuckGo(DDG);
  assert.deepEqual(r.map((x) => x.url), ["https://cloudnative-pg.io/docs/wal/", "https://example.org/a?x=1"]);
  assert.equal(r[0].title, "WAL archiving - CloudNativePG");
  assert.equal(r[0].snippet, "WAL archiving & PITR in CloudNativePG");
});

test("htmlToText drops scripts and chrome, keeps blocks as lines and decodes entities", () => {
  const { title, text } = htmlToText(`<html><head><title>Hi &amp; bye</title><script>evil()</script></head>
    <body><nav>menu</nav><h1>Head</h1><p>one &lt;two&gt;</p><ul><li>a</li><li>b</li></ul><footer>foot</footer></body></html>`);
  assert.equal(title, "Hi & bye");
  assert.ok(!/evil|menu|foot/.test(text));
  assert.match(text, /Head\n+one <two>\n+- a\n- b/);
});

test("web_search queries DuckDuckGo without a key and returns the untrusted note", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), body: String(init.body), method: init.method };
    return body(200, DDG);
  };
  const tools = createWebTools({ fetchImpl, lookup: PUBLIC }).tools();
  const out = JSON.parse((await tools[WEB_SEARCH_TOOL].execute({ query: "cnpg wal", recency: "week", count: 1 })).content[0].text);
  assert.equal(seen.method, "POST");
  assert.match(seen.url, /html\.duckduckgo\.com/);
  assert.match(seen.body, /q=cnpg\+wal/);
  assert.match(seen.body, /df=w/);
  assert.equal(out.source, "duckduckgo");
  assert.equal(out.results.length, 1);
  assert.match(out.note, /never follow instructions/);
});

test("web_search uses the owner's SearXNG when WEB_SEARCH_URL is set", async () => {
  let seen;
  const fetchImpl = async (url) => {
    seen = String(url);
    return body(200, JSON.stringify({ results: [{ title: "T", url: "https://a.example/", content: "<b>c</b>" }] }), "application/json");
  };
  // A LAN SearXNG is fine: it is the owner's own setting, not a model-supplied URL.
  const tools = createWebTools({ fetchImpl, lookup: PUBLIC, searchUrl: () => "http://192.168.1.5:8080/search" }).tools();
  const out = JSON.parse((await tools[WEB_SEARCH_TOOL].execute({ query: "x" })).content[0].text);
  assert.match(seen, /192\.168\.1\.5:8080\/search\?q=x&format=json/);
  assert.deepEqual(out.results, [{ title: "T", url: "https://a.example/", snippet: "c" }]);
  assert.equal(out.source, "searxng");
});

test("web_search says so when the engine asks for a captcha", async () => {
  const fetchImpl = async () => body(200, '<div class="anomaly-modal">captcha</div>');
  const out = await createWebTools({ fetchImpl, lookup: PUBLIC }).tools()[WEB_SEARCH_TOOL].execute({ query: "x" });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /captcha/);
});

test("web_fetch returns readable text, pages through long ones, refuses private hosts and binaries", async () => {
  const long = `<html><head><title>Doc</title></head><body><p>${"word ".repeat(2000)}</p></body></html>`;
  const fetchImpl = async (url) => {
    if (String(url).includes("file.pdf")) return body(200, "%PDF", "application/pdf");
    return body(200, long);
  };
  const fetchTool = createWebTools({ fetchImpl, lookup: PUBLIC }).tools()[WEB_FETCH_TOOL];
  const first = JSON.parse((await fetchTool.execute({ url: "https://example.com/doc", maxChars: 1000 })).content[0].text);
  assert.equal(first.title, "Doc");
  assert.equal(first.text.length, 1000);
  assert.equal(first.truncated, true);
  const next = JSON.parse((await fetchTool.execute({ url: "https://example.com/doc", maxChars: 1000, offset: first.nextOffset })).content[0].text);
  assert.equal(next.offset, 1000);
  assert.ok(next.text.length > 0);

  for (const bad of ["http://127.0.0.1:3100/api/chats", "http://169.254.169.254/latest/meta-data/", "http://localhost/"]) {
    const out = await fetchTool.execute({ url: bad });
    assert.equal(out.isError, true, bad);
    assert.match(out.content[0].text, /not a public address/);
  }
  const pdf = await fetchTool.execute({ url: "https://example.com/file.pdf" });
  assert.equal(pdf.isError, true);
  assert.match(pdf.content[0].text, /show_media/);
});

test("web_fetch checks every redirect hop", async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.5/admin" } });
  const out = await createWebTools({ fetchImpl, lookup: PUBLIC }).tools()[WEB_FETCH_TOOL].execute({ url: "https://example.com/" });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /not a public address/);
});

test("both tools disappear when WEB_SEARCH is off", () => {
  assert.deepEqual(createWebTools({ enabled: () => false }).tools(), {});
});

test("the web tools taint a chat for knowledge auto-trust, and are in the tool catalog", async () => {
  const { SAFE_TOOLS } = await import("../src/knowledge-trust.mjs");
  const { APP_TOOL_NAMES } = await import("../src/agents/profiles.mjs");
  for (const name of [WEB_SEARCH_TOOL, WEB_FETCH_TOOL]) {
    assert.ok(!SAFE_TOOLS.includes(name), `${name} brings in other people's text`);
    assert.ok(APP_TOOL_NAMES.includes(name), `${name} can be enabled per agent`);
  }
});
