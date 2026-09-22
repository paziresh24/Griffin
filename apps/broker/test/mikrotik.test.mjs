import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createMikrotikTools, inCidr, MARK } from "../src/mikrotik.mjs";
import { connectRouterOs, decodeSentences, encodeSentence } from "../src/routeros.mjs";
import { TEST_SITE } from "./fixture-site.mjs";

// Fake RouterOS API server with a NAT table and an address list. `readOnly` mimics the router
// group without the write policy.
function fakeRouter({ readOnly = false } = {}) {
  const tables = {
    "/ip/firewall/nat": [
      { ".id": "*D7", chain: "dstnat", protocol: "tcp", "dst-address": "198.51.100.1", "dst-port": "8443", action: "dst-nat", "to-addresses": "10.0.0.46", "to-ports": "3100", comment: "manual rule, not ours" },
      { ".id": "*E1", chain: "dstnat", protocol: "tcp", "dst-address": "198.51.100.1", "dst-port": "9000", action: "dst-nat", "to-addresses": "10.0.0.46", "to-ports": "9000", comment: `${MARK} old test` },
    ],
    "/ip/firewall/address-list": [{ ".id": "*A1", list: "edge-allowlist", address: "203.0.113.0/24", comment: "edge ranges" }],
  };
  const log = [];
  let next = 0x100;
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let authed = false;
    const reply = (...sentences) => socket.write(Buffer.concat(sentences.map(encodeSentence)));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { sentences, rest } = decodeSentences(buf);
      buf = rest;
      for (const words of sentences) {
        const [cmd, ...params] = words;
        log.push(words);
        const attrs = Object.fromEntries(params.filter((p) => p.startsWith("=")).map((p) => [p.slice(1, p.indexOf("=", 1)), p.slice(p.indexOf("=", 1) + 1)]));
        const queries = params.filter((p) => p.startsWith("?")).map((p) => [p.slice(1, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]);
        if (cmd === "/login") {
          if (attrs.name === "griffin" && attrs.password === "pw") { authed = true; reply(["!done"]); }
          else reply(["!trap", "=message=invalid user name or password (6)"], ["!done"]);
          continue;
        }
        if (!authed) { socket.destroy(); continue; }
        const path = cmd.slice(0, cmd.lastIndexOf("/"));
        const verb = cmd.slice(cmd.lastIndexOf("/") + 1);
        if (cmd === "/ping") {
          reply(...Array.from({ length: Number(attrs.count) }, (_, i) => ["!re", `=seq=${i}`, "=time=12ms"]), ["!done"]);
        } else if (verb === "print") {
          const rows = (tables[path] || []).filter((r) => queries.every(([k, v]) => String(r[k] ?? "") === v));
          reply(...rows.map((r) => ["!re", ...Object.entries(r).map(([k, v]) => `=${k}=${v}`)]), ["!done"]);
        } else if (readOnly) {
          reply(["!trap", "=message=not enough permissions (9)"], ["!done"]);
        } else if (verb === "add") {
          const id = `*${(next++).toString(16).toUpperCase()}`;
          tables[path].push({ ".id": id, ...attrs });
          reply(["!done", `=ret=${id}`]);
        } else if (verb === "remove") {
          tables[path] = tables[path].filter((r) => r[".id"] !== attrs[".id"]);
          reply(["!done"]);
        } else if (verb === "enable" || verb === "disable") {
          const row = tables[path].find((r) => r[".id"] === attrs[".id"]);
          row.disabled = verb === "disable" ? "true" : "false";
          reply(["!done"]);
        } else reply(["!trap", "=message=no such command"], ["!done"]);
      }
    });
  });
  return { server, tables, log };
}

async function setup(options) {
  const fake = fakeRouter(options);
  await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  const { port } = fake.server.address();
  const vault = { item: async () => JSON.stringify({ host: "127.0.0.1", port, user: "griffin", password: "pw" }) };
  const tools = createMikrotikTools({ vault, routers: TEST_SITE.routers });
  return { ...fake, tools, close: () => new Promise((r) => fake.server.close(r)) };
}

test("RouterOS words round-trip, including long lengths", () => {
  const long = "x".repeat(300);
  const { sentences, rest } = decodeSentences(Buffer.concat([encodeSentence(["!re", `=comment=${long}`]), encodeSentence(["!done"])]));
  assert.deepEqual(sentences, [["!re", `=comment=${long}`], ["!done"]]);
  assert.equal(rest.length, 0);
  assert.equal(decodeSentences(encodeSentence(["!re", "=a=b"]).subarray(0, 4)).sentences.length, 0, "partial sentence waits");
  assert.ok(inCidr("10.0.0.46", "10.0.0.0/24"));
  assert.ok(!inCidr("10.0.1.5", "10.0.0.0/24"));
});

test("read tools: print with filters and ping", async () => {
  const r = await setup();
  try {
    const nat = await r.tools.mikrotik_print.execute({ path: "/ip/firewall/nat", where: { "dst-port": "8443" } });
    assert.equal(nat.total, 1);
    assert.equal(nat.items[0]["to-ports"], "3100");
    assert.match(nat.source, /^routeros-api 127\.0\.0\.1:/);
    await assert.rejects(r.tools.mikrotik_print.execute({ path: "/user" }), /path must be one of/);
    await assert.rejects(r.tools.mikrotik_print.execute({ path: "/ip/firewall/connection" }), /add at least one filter/);
    const ping = await r.tools.mikrotik_ping.execute({ address: "198.51.100.9", count: 2 });
    assert.equal(ping.received, 2);
    await assert.rejects(r.tools.mikrotik_ping.execute({ address: "1.2.3.4; /system reboot" }), /IPv4 or a hostname/);
  } finally {
    await r.close();
  }
});

test("forward_add: marked comment, LAN only, no port clash", async () => {
  const r = await setup();
  try {
    const added = await r.tools.mikrotik_forward_add.execute({ publicPort: 8444, toAddress: "10.0.0.46", toPort: 3101, srcAddressList: "edge-allowlist", reason: "test forward" });
    assert.equal(added.changed, "added");
    const row = r.tables["/ip/firewall/nat"].find((x) => x[".id"] === added.id);
    assert.equal(row.comment, `${MARK} test forward`);
    assert.equal(row["dst-address"], "198.51.100.1");
    assert.equal(row["src-address-list"], "edge-allowlist");
    await assert.rejects(r.tools.mikrotik_forward_add.execute({ publicPort: 8443, toAddress: "10.0.0.46", toPort: 1, reason: "x" }), /already forwarded/);
    await assert.rejects(r.tools.mikrotik_forward_add.execute({ publicPort: 8500, toAddress: "10.1.0.5", toPort: 1, reason: "x" }), /inside 10\.0\.0\.0\/24/);
  } finally {
    await r.close();
  }
});

test("remove/enable only touch items Griffin created", async () => {
  const r = await setup();
  try {
    await assert.rejects(r.tools.mikrotik_remove.execute({ path: "/ip/firewall/nat", id: "*D7" }), /not created by Griffin/);
    assert.ok(r.tables["/ip/firewall/nat"].some((x) => x[".id"] === "*D7"), "owner rule untouched");
    const disabled = await r.tools.mikrotik_set_enabled.execute({ path: "/ip/firewall/nat", id: "*E1", enabled: false });
    assert.equal(disabled.changed, "disabled");
    const removed = await r.tools.mikrotik_remove.execute({ path: "/ip/firewall/nat", id: "*E1" });
    assert.equal(removed.changed, "removed");
    assert.ok(!r.tables["/ip/firewall/nat"].some((x) => x[".id"] === "*E1"));
  } finally {
    await r.close();
  }
});

test("address lists: only allowed lists; duplicates are a no-op", async () => {
  const r = await setup();
  try {
    await assert.rejects(r.tools.mikrotik_address_list_add.execute({ list: "admin-allow", address: "1.2.3.4", reason: "x" }), /list must be/);
    assert.equal((await r.tools.mikrotik_address_list_add.execute({ list: "edge-allowlist", address: "203.0.113.0/24", reason: "x" })).changed, "none");
    const added = await r.tools.mikrotik_address_list_add.execute({ list: "edge-allowlist", address: "198.51.100.0/24", reason: "new edge range" });
    assert.equal(added.changed, "added");
  } finally {
    await r.close();
  }
});

test("a read-only router user gets a clear refusal on writes; bad password fails login", async () => {
  const r = await setup({ readOnly: true });
  try {
    await assert.rejects(
      r.tools.mikrotik_address_list_add.execute({ list: "edge-allowlist", address: "198.51.100.0/24", reason: "x" }),
      /router refused: not enough permissions.*write policy/,
    );
    const { port } = r.server.address();
    await assert.rejects(connectRouterOs({ host: "127.0.0.1", port, user: "griffin", password: "wrong" }), /login failed: invalid user name/);
  } finally {
    await r.close();
  }
});

// Not every router's credential lives in the local vault: the office router (the one that
// terminates the office VPN) is in a secret manager instead of the vault. Same tools, same guards.
test("a router whose credential is in Infisical works the same, and says what is missing when it is not", async () => {
  const fake = fakeRouter();
  await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  const { port } = fake.server.address();
  const reads = [];
  const secrets = { MT_HOST: "127.0.0.1", MT_USER: "griffin", MT_PASS: "pw" };
  const tools = createMikrotikTools({
    vault: { item: async () => { throw new Error("should not touch the vault"); } },
    routers: {
      office: {
        infisical: { project: "ops", path: "/routers/office", host: "MT_HOST", user: "MT_USER", password: "MT_PASS", port: "MT_PORT" },
        lan: null,
        writableLists: [],
        apiHint: "API روی این روتر باز نیست",
      },
    },
    readSecret: async ({ projectId, path, name }) => {
      reads.push(`${projectId}${path}:${name}`);
      return name === "MT_PORT" ? String(port) : secrets[name];
    },
  });
  try {
    const out = await tools.mikrotik_print.execute({ router: "office", path: "/ip/firewall/nat", where: { "dst-port": "8443" } });
    assert.equal(out.total, 1);
    assert.ok(reads.includes("ops/routers/office:MT_PASS"), "password read from the secret manager, never from the agent");
    assert.equal(JSON.stringify(out).includes("pw"), false, "the credential never comes back in the result");

    const broken = createMikrotikTools({
      vault: { item: async () => { throw new Error("nope"); } },
      routers: { office: { infisical: { project: "p", path: "/x", host: "H", user: "U", password: "P" }, writableLists: [] } },
      readSecret: async () => { throw new Error("http_404"); },
    });
    await assert.rejects(broken.mikrotik_print.execute({ router: "office", path: "/ip/address" }), /not readable from the secret manager \(p\/x\)/);

    // The API service being closed is the normal state of a router nobody opened yet: the error
    // has to carry the one command that fixes it, not a bare ECONNREFUSED.
    const closed = createMikrotikTools({
      vault: { item: async () => { throw new Error("nope"); } },
      routers: { office: { infisical: { project: "p", path: "/x", host: "H", user: "U", password: "P" }, writableLists: [], apiHint: "در Winbox: /ip service set api disabled=no" } },
      readSecret: async ({ name }) => ({ H: "127.0.0.1", U: "u", P: "p" })[name],
      connect: async () => { throw new Error("router connection error: ECONNREFUSED"); },
    });
    await assert.rejects(closed.mikrotik_print.execute({ router: "office", path: "/ip/address" }), /ECONNREFUSED — در Winbox/);
  } finally {
    await new Promise((r) => fake.server.close(r));
  }
});

// Some routers keep the RouterOS API off, so their console is reached over
// Winbox. Same tool surface, text instead of records, and the catastrophic lines are refused.
test("winbox routers: reads go through the console, writes carry the credential, resets are refused", async () => {
  const ran = [];
  const tools = createMikrotikTools({
    vault: { item: async () => JSON.stringify({ host: "10.0.0.1", user: "u", password: "p" }) },
    routers: { office: { vaultSlug: "x", transport: "winbox", port: 8291, lan: null, writableLists: [] } },
    connect: async () => { throw new Error("the API must never be dialled for a winbox router"); },
    exec: async (args) => {
      ran.push(args);
      return 'name: mik-office password=Sup3rSecret service=l2tp\n';
    },
  });

  const printed = await tools.mikrotik_print.execute({ router: "office", path: "/ppp/active", where: { service: "l2tp" } });
  assert.equal(ran[0].command, '/ppp/active/print detail without-paging where service="l2tp"');
  assert.equal(ran[0].port, 8291);
  assert.equal(ran[0].password, "p", "the credential is resolved in the broker, not passed by the agent");
  assert.match(printed.output, /mik-office/);
  assert.match(printed.source, /^winbox 10\.0\.0\.1:8291$/);
  assert.equal(printed.items, undefined, "a console read is text, and says so");

  const out = await tools.mikrotik_exec.execute({ router: "office", command: "/ppp/secret/print detail without-paging" });
  assert.match(out.output, /mik-office/);
  // /ppp/secret prints every VPN password; the agent (and the chat log) must never see them.
  assert.ok(!out.output.includes("Sup3rSecret"), "console output is masked");
  assert.match(out.output, /password: \*\*\*/);

  for (const bad of ["/system reset-configuration", "/system/reboot", "/user remove smhossein"]) {
    await assert.rejects(tools.mikrotik_exec.execute({ router: "office", command: bad }), /مجاز نیست/);
  }
  assert.equal(ran.length, 2, "nothing catastrophic ever reached the router");

  // A router on the API transport must not accept console lines.
  const api = createMikrotikTools({ vault: { item: async () => "{}" }, routers: { edge: { vaultSlug: "y", writableLists: [] } } });
  await assert.rejects(api.mikrotik_exec.execute({ router: "edge", command: "/system/identity/print" }), /RouterOS API/);
});
