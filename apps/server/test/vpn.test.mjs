import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { outboundsOf, xrayConfig, linkToOutbound, reasonOf, proxiedHost, describeOutbound, outboundId, createVpn, parseRules, countryOfName, PRIVATE_CIDRS, TELEGRAM_CIDRS } from "../src/vpn.mjs";

const vless = "vless://11111111-2222-3333-4444-555555555555@a.example.com:443?type=ws&security=tls&path=%2Fws&host=cdn.example.com&sni=cdn.example.com#one";
const vmess = "vmess://" + Buffer.from(JSON.stringify({ add: "b.example.com", port: "8443", id: "66666666-7777-8888-9999-000000000000", net: "grpc", path: "svc", tls: "tls" })).toString("base64");
const trojan = "trojan://secret@c.example.com:443?sni=c.example.com#t";
const ss = "ss://" + Buffer.from("aes-256-gcm:pw").toString("base64") + "@d.example.com:8388#s";

test("share links become Xray outbounds", () => {
  const v = linkToOutbound(vless);
  assert.equal(v.protocol, "vless");
  assert.equal(v.settings.vnext[0].port, 443);
  assert.equal(v.streamSettings.wsSettings.path, "/ws");
  assert.equal(linkToOutbound(vmess).streamSettings.grpcSettings.serviceName, "svc");
  assert.equal(linkToOutbound(trojan).streamSettings.security, "tls");
  assert.deepEqual(linkToOutbound(ss).settings.servers[0], { address: "d.example.com", port: 8388, method: "aes-256-gcm", password: "pw" });
});

test("a paste: several links, a base64 subscription body, a subscription URL, a v2ray JSON", async () => {
  assert.equal((await outboundsOf(`${vless}\n${vmess}\n# note\n${trojan}`)).length, 3);
  assert.equal((await outboundsOf(Buffer.from(`${vless}\n${ss}`).toString("base64"))).length, 2);
  const fetched = [];
  const outs = await outboundsOf("https://panel.example.ir/sub/abc?x=1", { fetchText: async (u) => (fetched.push(u), Buffer.from(vless).toString("base64")) });
  assert.equal(outs.length, 1);
  assert.deepEqual(fetched, ["https://panel.example.ir/sub/abc?x=1"]);
  const json = JSON.stringify({ inbounds: [{ port: 1 }], outbounds: [{ tag: "x", protocol: "vless", settings: {} }, { protocol: "freedom" }] });
  assert.deepEqual(await outboundsOf(json), [{ protocol: "vless", settings: {} }]);
  // host:port alone is an HTTP proxy, not a subscription
  assert.equal((await outboundsOf("http://10.0.0.5:8080"))[0].protocol, "http");
  await assert.rejects(outboundsOf("hello there"), /no_servers/);
  assert.match(reasonOf(new Error("no_servers")), /سروری/);
});

test("one server is used directly; several get Xray's own balancer", () => {
  const one = xrayConfig([{ protocol: "vless" }]);
  assert.equal(one.routing.balancers, undefined);
  assert.equal(one.inbounds[0].port, 18118);
  const many = xrayConfig([{ protocol: "vless" }, { protocol: "trojan" }]);
  assert.deepEqual(many.outbounds.map((o) => o.tag), ["proxy-0", "proxy-1", "direct"]);
  assert.equal(many.routing.balancers[0].tag, "best");
  assert.ok(many.burstObservatory);
});

test("routing: LAN and Iran stay direct; only the providers and Telegram ride the VPN", () => {
  const rules = xrayConfig([{ protocol: "vless" }, { protocol: "trojan" }], { hosts: ["https://api.z.ai/api/coding/paas/v4", "https://llm.example.ir/v1", "http://host.docker.internal:11434/v1", "http://10.0.0.5:11434/v1"] }).routing.rules;
  // Private networks first, internal / Iranian names second: nothing below can pull them onto the VPN.
  assert.deepEqual(rules[0], { type: "field", ip: PRIVATE_CIDRS, outboundTag: "direct" });
  assert.ok(rules[1].domain.includes("domain:ir"));
  assert.equal(rules[1].outboundTag, "direct");
  const providers = rules[2];
  assert.equal(providers.balancerTag, "best");
  for (const d of ["domain:anthropic.com", "domain:cursor.sh", "domain:openrouter.ai", "domain:t.me", "domain:api.z.ai"]) assert.ok(providers.domain.includes(d), d);
  for (const d of ["domain:example.ir", "domain:llm.example.ir", "domain:host.docker.internal", "domain:github.com"]) assert.ok(!providers.domain.includes(d), `${d} must not ride the VPN`);
  assert.deepEqual(rules[3].ip, TELEGRAM_CIDRS);
  // Everything that matched nothing is direct.
  assert.deepEqual(rules.at(-1), { type: "field", network: "tcp,udp", outboundTag: "direct" });
  assert.equal(xrayConfig([{ protocol: "vless" }]).routing.rules[2].outboundTag, "proxy-0");
});

test("an engine's host rides the VPN only when it is a real public name", () => {
  assert.equal(proxiedHost("https://api.z.ai/api/coding/paas/v4"), "api.z.ai");
  assert.equal(proxiedHost("api.deepseek.com"), "api.deepseek.com");
  for (const url of ["https://llm.example.ir/v1", "http://host.docker.internal:11434/v1", "http://127.0.0.1:11434", "http://8.8.8.8/v1", "http://[::1]/v1", "http://ollama:11434", "not a url at all", ""]) assert.equal(proxiedHost(url), null, url);
});

test("a server in the list shows where it is and its name, never its id or password", () => {
  const o = linkToOutbound(vless);
  assert.equal(o.remark, "one");
  assert.ok(!JSON.stringify(o).includes("remark"), "the name is not part of the Xray config");
  assert.deepEqual(describeOutbound(o), { protocol: "vless", address: "a.example.com", port: 443, network: "ws", security: "tls" });
  assert.ok(!JSON.stringify(describeOutbound(linkToOutbound(trojan))).includes("secret"));
  assert.equal(outboundId(linkToOutbound(vless)), outboundId(linkToOutbound(`${vless}x`.replace("#onex", "#another"))));
  assert.notEqual(outboundId(linkToOutbound(vless)), outboundId(linkToOutbound(trojan)));
});

function fakeXray(dir) {
  const bin = path.join(dir, "fake-xray");
  fs.writeFileSync(bin, '#!/bin/sh\ncase "$*" in *-test*) exit 0;; esac\nexec sleep 30\n', { mode: 0o755 });
  return bin;
}

test("the list keeps dead servers too, can drop one, and an old config gets the routing rules", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-vpn-"));
  const dir = path.join(data, "vpn");
  fs.mkdirSync(dir, { recursive: true });
  // An install from before the list: a config with two servers and no routing.
  const oldCfg = { inbounds: [], outbounds: [{ tag: "proxy-0", ...linkToOutbound(vless) }, { tag: "proxy-1", ...linkToOutbound(trojan) }, { tag: "direct", protocol: "freedom" }] };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(oldCfg));
  const vpn = createVpn({ dataDir: data, env: { GRIFFIN_XRAY: fakeXray(dir) }, log: { info() {}, error() {} } });
  try {
    const first = vpn.list();
    assert.equal(first.servers.length, 2);
    assert.ok(first.servers.every((s) => s.state === "live" && !("outbound" in s)));
    vpn.start();
    const written = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.ok(written.routing.rules.some((r) => r.outboundTag === "direct" && r.ip), "rewritten with the routing rules before Xray starts");
    assert.equal(vpn.list().servers.filter((s) => s.inUse).length, 2);
    // Remove one: the other stays, and the removal is saved.
    const gone = first.servers.find((s) => s.address === "c.example.com").id;
    const after = await vpn.removeServer(gone);
    assert.deepEqual(after.servers.map((s) => s.address), ["a.example.com"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "servers.json"), "utf8")).servers.length, 1);
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).outbounds.filter((o) => o.tag.startsWith("proxy-")).length), "1");
    await assert.rejects(vpn.removeServer("nope"), /unknown/);
    // Hosts of the engines in use are saved with the list.
    assert.equal(vpn.setHosts(["https://api.z.ai/v1", "http://127.0.0.1:1"]), true);
    assert.equal(vpn.setHosts(["https://api.z.ai/v1"]), false);
    assert.deepEqual(vpn.list().routing.hosts, ["api.z.ai"]);
    // Removing the last one stops Xray and forgets the config.
    await vpn.removeServer(after.servers[0].id);
    assert.equal(vpn.configured(), false);
    assert.equal(vpn.list().running, false);
  } finally {
    await vpn.stop();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("a server that failed its test stays in the list as dead and does not enter the config", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-vpn-"));
  const dir = path.join(data, "vpn");
  fs.mkdirSync(dir, { recursive: true });
  const entry = (o, live) => ({ id: outboundId(o), outbound: o, remark: o.remark || "", addedAt: 1, live, ms: live ? 300 : null, claude: live, telegram: live, checkedAt: 5 });
  const good = linkToOutbound(vless);
  const bad = linkToOutbound(trojan);
  fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify({ servers: [entry(bad, false), entry(good, true)], used: [outboundId(good)], hosts: [] }));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(xrayConfig([good])));
  const vpn = createVpn({ dataDir: data, env: { GRIFFIN_XRAY: fakeXray(dir) }, log: { info() {}, error() {} } });
  try {
    vpn.start();
    const view = vpn.list();
    assert.deepEqual(view.servers.map((s) => [s.address, s.state, s.inUse]), [["c.example.com", "dead", false], ["a.example.com", "live", true]]);
    assert.equal(view.checkedAt, 5);
    // Dropping the dead one does not touch the running config.
    const after = await vpn.removeServer(view.servers[0].id);
    assert.deepEqual(after.servers.map((s) => s.address), ["a.example.com"]);
    assert.equal(after.running, true);
  } finally {
    await vpn.stop();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("the owner's own routes: a domain, a URL, an IP or a CIDR, cleaned; anything else is refused by name", () => {
  assert.deepEqual(parseRules("Example.com\n*.api.test.org, https://svc.example.net:8443/path 10.1.0.0/16 8.8.8.8 [2001:db8::1]:443 example.com"), ["example.com", "api.test.org", "svc.example.net", "10.1.0.0/16", "8.8.8.8", "2001:db8::1"]);
  assert.deepEqual(parseRules(["a.example.com"]), ["a.example.com"]);
  assert.deepEqual(parseRules(""), []);
  for (const bad of ["not a host", "10.0.0.0/33", "999.1.1.1", "localhost", "a_b.com"]) {
    // "not a host" is two entries: the first word is the one named.
    assert.throws(() => parseRules(bad), (error) => error.message === "bad_rule" && bad.startsWith(error.entry), bad);
  }
  assert.match(reasonOf(new Error("bad_rule")), /درست نیست/);
  assert.throws(() => parseRules(Array.from({ length: 201 }, (_, i) => `h${i}.example.com`)), /too_many_rules/);
});

test("routing: what the owner pinned direct beats the provider list, and what he pinned to the VPN comes before it", () => {
  const rules = xrayConfig([{ protocol: "vless" }], { hosts: ["https://api.z.ai/v1"], direct: ["api.z.ai", "5.6.7.0/24"], proxied: ["intranet-tool.example.org", "9.9.9.9"] }).routing.rules;
  const at = (match) => rules.findIndex(match);
  const directDomains = at((r) => r.outboundTag === "direct" && r.domain?.includes("domain:api.z.ai"));
  const providers = at((r) => r.domain?.includes("domain:anthropic.com"));
  assert.ok(directDomains > 1 && directDomains < providers, "after the LAN rules, before the providers");
  assert.deepEqual(rules[directDomains + 1], { type: "field", ip: ["5.6.7.0/24"], outboundTag: "direct" });
  const pinned = at((r) => r.domain?.includes("domain:intranet-tool.example.org"));
  assert.equal(rules[pinned].outboundTag, "proxy-0");
  assert.deepEqual(rules[pinned + 1], { type: "field", ip: ["9.9.9.9"], outboundTag: "proxy-0" });
  assert.ok(pinned < providers);
  // No routes → no empty rule (Xray refuses a rule with no condition).
  assert.ok(xrayConfig([{ protocol: "vless" }]).routing.rules.every((r) => r.domain || r.ip || r.network));
});

test("setRules saves the owner's routes, re-reads them clean, writes them into the running config, and refuses junk without changing anything", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-vpn-"));
  const dir = path.join(data, "vpn");
  fs.mkdirSync(dir, { recursive: true });
  const good = linkToOutbound(vless);
  fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify({ servers: [{ id: outboundId(good), outbound: good, remark: "", addedAt: 1, live: true, ms: 200, claude: true, telegram: true, checkedAt: 5 }], used: [outboundId(good)], hosts: [] }));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(xrayConfig([good])));
  const vpn = createVpn({ dataDir: data, env: { GRIFFIN_XRAY: fakeXray(dir) }, log: { info() {}, error() {} } });
  try {
    vpn.start();
    const out = await vpn.setRules({ direct: "Intranet.example.org\n10.9.0.0/16", proxied: ["tool.example.net"] });
    assert.deepEqual(out.routing.direct, ["intranet.example.org", "10.9.0.0/16"]);
    assert.deepEqual(out.routing.proxied, ["tool.example.net"]);
    const written = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.ok(written.routing.rules.some((r) => r.outboundTag === "direct" && r.domain?.includes("domain:intranet.example.org")));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "servers.json"), "utf8")).rules, { direct: ["intranet.example.org", "10.9.0.0/16"], proxied: ["tool.example.net"] });
    // Junk: refused, nothing changes. A list left out stays as it was.
    await assert.rejects(vpn.setRules({ direct: "fine.example.com\nnot a host" }), (error) => error.message === "bad_rule" && error.entry === "not");
    assert.deepEqual(vpn.list().routing.direct, ["intranet.example.org", "10.9.0.0/16"]);
    assert.deepEqual((await vpn.setRules({ proxied: [] })).routing, { ...vpn.list().routing, proxied: [] });
    assert.deepEqual(vpn.list().routing.direct, ["intranet.example.org", "10.9.0.0/16"]);
  } finally {
    await vpn.stop();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("servers can be turned off and on, one or several; an off server stays in the list but leaves the config", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-vpn-"));
  const dir = path.join(data, "vpn");
  fs.mkdirSync(dir, { recursive: true });
  const entry = (o, ms, extra = {}) => ({ id: outboundId(o), outbound: o, remark: o.remark || "", addedAt: 1, live: true, ms, claude: true, telegram: true, checkedAt: 5, ...extra });
  const a = linkToOutbound(vless);
  const b = linkToOutbound(trojan);
  const c = linkToOutbound(ss);
  fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify({ servers: [entry(a, 900, { country: "DE" }), entry(b, 300), entry(c, 500)], used: [outboundId(b), outboundId(c), outboundId(a)], hosts: [] }));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(xrayConfig([b, c, a])));
  const vpn = createVpn({ dataDir: data, env: { GRIFFIN_XRAY: fakeXray(dir) }, log: { info() {}, error() {} } });
  const proxies = () => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).outbounds.filter((o) => o.tag.startsWith("proxy-")).map((o) => o.settings.vnext?.[0]?.address || o.settings.servers[0].address);
  try {
    vpn.start();
    const view = vpn.list();
    assert.ok(view.servers.every((s) => s.enabled === true));
    assert.equal(view.servers[0].country, "DE");
    assert.equal(view.servers[0].countryFrom, "exit");
    // One off: it stays listed (and still tested), it leaves the running config.
    let after = await vpn.setEnabled([outboundId(b)], false);
    assert.deepEqual(after.servers.map((s) => [s.address, s.enabled, s.inUse]), [["a.example.com", true, true], ["c.example.com", false, false], ["d.example.com", true, true]]);
    assert.deepEqual(proxies(), ["d.example.com", "a.example.com"]);
    // Several at once; all off stops Xray.
    after = await vpn.setEnabled([outboundId(a), outboundId(c)], false);
    assert.equal(after.running, false);
    assert.equal(vpn.configured(), false);
    // On again: back into the config, fastest first, and the choice is saved.
    after = await vpn.setEnabled([outboundId(a), outboundId(b), outboundId(c)], true);
    assert.equal(after.running, true);
    assert.deepEqual(proxies(), ["c.example.com", "d.example.com", "a.example.com"]);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "servers.json"), "utf8")).servers.every((s) => !s.off));
    await assert.rejects(vpn.setEnabled(["nope"], false), /unknown/);
  } finally {
    await vpn.stop();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("a flag in a server's name gives its country until it is measured", () => {
  assert.equal(countryOfName("🇩🇪 Germany-1"), "DE");
  assert.equal(countryOfName("NL 🇳🇱 fast"), "NL");
  assert.equal(countryOfName("plain"), null);
  assert.equal(describeOutbound(linkToOutbound(vless)).country, undefined, "the country never comes from the link's parts");
});
