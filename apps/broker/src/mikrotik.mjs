import { genv } from "./env.mjs";
import { ToolInputError } from "./kube.mjs";
import { connectRouterOs, RouterOsError } from "./routeros.mjs";
import { winboxExec } from "./winbox.mjs";

// MikroTik tools for the routers this deployment sits behind. Credentials come from the vault
// ({host, port, user, password}); the router user's group decides what is possible at all.
//
// Write guard (enforced here, not only in the prompt):
//   - everything the broker adds carries a comment starting with MARK;
//   - remove / enable / disable only touch items whose comment starts with MARK, so rules the
//     owner or anyone else created can never be changed through Griffin;
//   - port forwards only go from the router's public address to the LAN, on a free port;
//   - address-list writes only go to lists named in writableLists or starting with LIST_PREFIX.

export const MARK = genv("MIKROTIK_MARK", "griffin:");
export const LIST_PREFIX = `${MARK.replace(/[:\s]+$/, "")}-`;

// Credentials come either from the local vault or from a secret manager — the broker resolves
// them, they never reach the agent.
export const DEFAULT_ROUTERS = {};

// Routers come from the site config, keyed by the name the agent uses:
//
//   "routers": {
//     "gateway": {
//       "label": "site gateway",
//       "vaultSlug": "mikrotik-gateway__api",   // vault item: {host, port, user, password}
//       "publicAddress": "203.0.113.1",          // only this address may be a forward's dst
//       "lan": "10.0.0.0/24",                    // only this range may be a forward's target
//       "writableLists": ["edge-allowlist"]      // plus any list named "<MARK-prefix>*"
//     },
//     "office": {
//       "label": "office router",
//       "host": "10.1.0.1",
//       // credentials may live in a secret manager instead of the vault:
//       "infisical": { "project": "ops", "path": "/routers/office",
//                      "host": "MT_HOST", "user": "MT_USER", "password": "MT_PASS" },
//       // RouterOS API off? talk the Winbox protocol on 8291 instead, like a person would.
//       "transport": "winbox", "port": 8291,
//       "apiHint": "what to run on the router once so the API/user exists"
//     }
//   }

// Menus the agent may read. Credentials and scripts are not here (the router group also lacks
// the "sensitive" policy).
const READ_PATHS = [
  "/system/resource", "/system/identity", "/system/clock", "/system/routerboard", "/system/health", "/system/package",
  "/log",
  "/interface", "/interface/ethernet", "/interface/vlan", "/interface/bridge", "/interface/bridge/port",
  "/interface/ipip", "/interface/eoip", "/interface/gre", "/interface/wireguard", "/interface/wireguard/peers",
  "/interface/sstp-server", "/interface/l2tp-server", "/ppp/active",
  "/ip/address", "/ip/route", "/ip/arp", "/ip/neighbor", "/ip/pool", "/ip/dns", "/ip/dns/static",
  "/ip/dhcp-server", "/ip/dhcp-server/lease", "/ip/dhcp-client", "/ip/service",
  "/ip/firewall/nat", "/ip/firewall/filter", "/ip/firewall/mangle", "/ip/firewall/raw",
  "/ip/firewall/address-list", "/ip/firewall/connection",
  "/ip/ipsec/active-peers", "/ip/ipsec/policy", "/queue/simple", "/queue/tree", "/routing/ospf/neighbor",
];

// Paths whose tables can be huge: require at least one filter.
const NEEDS_FILTER = new Set(["/ip/firewall/connection", "/log"]);

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV4_OR_CIDR = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/([0-9]|[12]\d|3[0-2]))?$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const FILTER_KEY = /^[a-z][a-z0-9.-]{0,40}$/;
const LIST_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function ipToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc * 256) + Number(part), 0);
}

export function inCidr(ip, cidr) {
  const [base, bits] = cidr.split("/");
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(base) & mask) >>> 0);
}

function text(value, label, { max = 120 } = {}) {
  const s = String(value ?? "").trim();
  if (!s) throw new ToolInputError(`${label} is required`);
  if (s.length > max || /[\0\r\n]/.test(s)) throw new ToolInputError(`invalid ${label}`);
  return s;
}

function port(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ToolInputError(`${label} must be 1-65535`);
  return n;
}

function markComment(reason) {
  return `${MARK} ${text(reason, "reason", { max: 100 })}`;
}

const router = (routers) => ({ type: "string", enum: Object.keys(routers), description: "which router from the site config (defaults to the first)" });

export function createMikrotikTools({ vault, routers = DEFAULT_ROUTERS, connect = connectRouterOs, readSecret = null, exec = winboxExec }) {
  // When the caller names no router, use the first one in the site config.
  function firstRouter() {
    const name = Object.keys(routers)[0];
    if (!name) throw new ToolInputError("no routers configured — add a \"routers\" section to the site config");
    return name;
  }

  async function credentialFor(config, name) {
    if (config.vaultSlug) {
      const item = JSON.parse(await vault.item(config.vaultSlug));
      // Sibling routers share the gateway's user but live at their own address.
      return config.host ? { ...item, host: config.host, port: config.port || item.port } : item;
    }
    const from = config.infisical;
    if (!from || !readSecret) throw new ToolInputError(`router "${name}" has no credential source configured`);
    const read = async (key) => readSecret({ projectId: from.project, path: from.path, name: from[key] });
    try {
      // Read one at a time: three parallel reads on a cold token raced the login and came back 404.
      const host = await read("host");
      const user = await read("user");
      const password = await read("password");
      const port = from.port ? await read("port") : null;
      if (!host || !user || !password) throw new Error("host/user/password missing");
      // No port default here: the API speaks 8728 and the Winbox console 8291, and the caller
      // knows which one it is (a stored 8728 default sent the console to the closed API port).
      return { host, user, password, port: Number(port) || null };
    } catch (error) {
      throw new ToolInputError(
        `credential for router "${name}" is not readable from the secret manager (${from.project}${from.path}): ${error.message}`,
      );
    }
  }

  // Both "the API is shut" and "this user cannot log in here" mean the same thing to the reader:
  // access to that router has not been granted yet, and the hint says how to grant it.
  const notReachable = (message) =>
    /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timed out|login failed|closed the connection|invalid user/i.test(String(message));

  async function session(name, fn) {
    const config = routers[name || firstRouter()];
    if (!config) throw new ToolInputError(`unknown router (known: ${Object.keys(routers).join(", ")})`);
    const credential = await credentialFor(config, name || firstRouter());
    const started = Date.now();
    const api = await connect({ host: credential.host, port: credential.port || 8728, user: credential.user, password: credential.password }).catch(
      (error) => {
        throw config.apiHint && notReachable(error.message)
          ? new Error(`${error.message} — ${config.apiHint}`)
          : error;
      },
    );
    try {
      const value = await fn(api, config);
      return { router: name || firstRouter(), ...value, source: `routeros-api ${credential.host}:${credential.port || 8728}`, ms: Date.now() - started };
    } catch (error) {
      if (error instanceof RouterOsError && /permission/i.test(error.message)) {
        throw new Error(`router refused: ${error.message} (the router user "${credential.user}" may lack the write policy)`);
      }
      if (config.apiHint && notReachable(error.message)) {
        throw new Error(`${error.message} — ${config.apiHint}`);
      }
      throw error;
    } finally {
      api.close();
    }
  }

  // Catastrophic console commands: not "needs approval", simply never from here.
  const FORBIDDEN_CONSOLE = /(reset-configuration|\/system\s+reset|system\/reset|shutdown|reboot|routerboard\s+upgrade|package\s+downgrade|\/file\s+remove|file\/remove|user\s+remove|\/user\s+set\s+.*password)/i;

  async function console_(name, command, { timeoutMs = 30_000 } = {}) {
    const config = routers[name || firstRouter()];
    if (!config) throw new ToolInputError(`unknown router (known: ${Object.keys(routers).join(", ")})`);
    if (config.transport !== "winbox") {
      throw new ToolInputError(`router "${name}" is reached over the RouterOS API — use mikrotik_print / mikrotik_* on it`);
    }
    const line = text(command, "command", { max: 900 });
    if (FORBIDDEN_CONSOLE.test(line)) throw new ToolInputError("این دستور (ریست/ریبوت/حذف کاربر یا فایل) از این مسیر مجاز نیست");
    const credential = await credentialFor(config, name || "office");
    const started = Date.now();
    const output = await exec({
      host: credential.host,
      port: credential.port || config.port || 8291,
      user: credential.user,
      password: credential.password,
      command: line,
      timeoutMs,
    });
    // A console read can print credentials (/ppp/secret detail shows every VPN password). The
    // agent never needs those, and the result becomes a chat event — so they are masked here.
    const safe = String(output)
      .replace(/\b(password|secret|pre-shared-key|private-key|psk)\s*[:=]\s*("[^"]*"|\S+)/gi, "$1: ***")
      .replace(/\b(password|secret)=("[^"]*"|\S+)/gi, "$1=***");
    return { router: name, command: line, output: safe, source: `winbox ${credential.host}:${credential.port || config.port || 8291}`, ms: Date.now() - started };
  }

  async function findById(api, path, id) {
    const { records } = await api.command([`${path}/print`, `?.id=${id}`]);
    if (!records.length) throw new ToolInputError(`${path} item ${id} not found`);
    return records[0];
  }

  function requireOwned(item, path) {
    if (!String(item.comment || "").startsWith(MARK)) {
      throw new ToolInputError(`${path} ${item[".id"]} was not created by Griffin (comment must start with "${MARK}"); change it on the router yourself`);
    }
  }

  const OWNED_PATHS = ["/ip/firewall/nat", "/ip/firewall/filter", "/ip/firewall/address-list"];

  return {
    mikrotik_print: {
      description:
        "Read a RouterOS menu on a configured MikroTik (NAT, firewall, address lists, interfaces, routes, tunnels, DHCP, log, resources…). Equality filters narrow big tables.",
      inputSchema: {
        type: "object",
        properties: {
          router: router(routers),
          path: { type: "string", enum: READ_PATHS },
          where: { type: "object", additionalProperties: { type: "string" }, description: "equality filters, e.g. {\"chain\":\"dstnat\"}" },
          properties: { type: "array", items: { type: "string" }, maxItems: 20, description: "only these fields (proplist)" },
          limit: { type: "integer", minimum: 1, maximum: 500, description: "max items (default 100)" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(args) {
        const path = String(args.path || "");
        if (!READ_PATHS.includes(path)) throw new ToolInputError(`path must be one of ${READ_PATHS.join(", ")}`);
        // Winbox routers have no API to query: read the same menu from the console instead.
        if (routers[args.router || firstRouter()]?.transport === "winbox") {
          const where = Object.entries(args.where || {})
            .map(([key, value]) => `${key}="${String(value).replace(/"/g, "")}"`)
            .join(" ");
          return console_(args.router, `${path}/print detail without-paging${where ? ` where ${where}` : ""}`);
        }
        const where = Object.entries(args.where || {});
        if (where.length > 8) throw new ToolInputError("at most 8 filters");
        for (const [key, value] of where) {
          if (!FILTER_KEY.test(key) || /[\0\r\n]/.test(String(value)) || String(value).length > 200) throw new ToolInputError(`invalid filter ${key}`);
        }
        if (NEEDS_FILTER.has(path) && !where.length) throw new ToolInputError(`${path} is large; add at least one filter in "where"`);
        const props = (args.properties || []).map(String);
        if (props.some((p) => !FILTER_KEY.test(p) && p !== ".id")) throw new ToolInputError("invalid property name");
        const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);
        return session(args.router, async (api) => {
          const words = [`${path}/print`];
          if (props.length) words.push(`=.proplist=${props.join(",")}`);
          for (const [key, value] of where) words.push(`?${key}=${value}`);
          const { records, truncated } = await api.command(words, { limit, commandTimeoutMs: 30_000 });
          return { path, total: records.length, truncated, items: records };
        });
      },
    },

    mikrotik_exec: {
      description:
        "Run ONE RouterOS console command on a router reached over Winbox (TCP 8291) — the same terminal the Winbox app gives a person, so nothing extra (API/SSH) has to be enabled. Returns the console text. Reads (/…/print, /…/get, monitor, export) are free; anything that changes the router needs the owner's yes first. Reset/reboot/user or file removal are refused outright.",
      inputSchema: {
        type: "object",
        properties: {
          router: router(routers),
          command: { type: "string", description: 'one console line, e.g. "/ppp/secret/print detail without-paging"' },
          timeoutMs: { type: "integer", minimum: 5000, maximum: 120000 },
        },
        required: ["router", "command"],
        additionalProperties: false,
      },
      execute: (args) => console_(args.router, args.command, { timeoutMs: Number(args.timeoutMs) || 30_000 }),
    },

    mikrotik_ping: {
      description: "Ping an address from the MikroTik itself (tests the router's own path, e.g. to a cluster node or the internet).",
      inputSchema: {
        type: "object",
        properties: {
          router: router(routers),
          address: { type: "string", description: "IPv4 or hostname" },
          count: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["address"],
        additionalProperties: false,
      },
      async execute(args) {
        const address = text(args.address, "address", { max: 253 });
        if (!IPV4.test(address) && !HOSTNAME.test(address)) throw new ToolInputError("address must be IPv4 or a hostname");
        const count = Math.min(Math.max(Number(args.count) || 4, 1), 10);
        return session(args.router, async (api) => {
          const { records } = await api.command(["/ping", `=address=${address}`, `=count=${count}`], { commandTimeoutMs: (count + 5) * 1000 });
          const replies = records.filter((r) => r.time);
          return {
            address,
            sent: count,
            received: replies.length,
            times: replies.map((r) => r.time),
            last: records.at(-1) || null,
          };
        });
      },
    },

    mikrotik_forward_add: {
      description:
        `WRITE. Add a TCP/UDP port forward from the router's public address to a LAN host. Ask the owner first (ask_owner). The rule gets a "${MARK}" comment so it can be removed later with mikrotik_remove.`,
      inputSchema: {
        type: "object",
        properties: {
          router: router(routers),
          publicPort: { type: "integer", minimum: 1, maximum: 65535 },
          toAddress: { type: "string", description: "LAN IPv4 inside the router's LAN" },
          toPort: { type: "integer", minimum: 1, maximum: 65535 },
          protocol: { type: "string", enum: ["tcp", "udp"] },
          srcAddressList: { type: "string", description: "only allow sources in this address list" },
          reason: { type: "string", description: "why; stored in the rule comment" },
        },
        required: ["publicPort", "toAddress", "toPort", "reason"],
        additionalProperties: false,
      },
      async execute(args) {
        const publicPort = port(args.publicPort, "publicPort");
        const toPort = port(args.toPort, "toPort");
        const toAddress = text(args.toAddress, "toAddress");
        const protocol = args.protocol === "udp" ? "udp" : "tcp";
        const comment = markComment(args.reason);
        const srcList = args.srcAddressList ? text(args.srcAddressList, "srcAddressList", { max: 64 }) : null;
        if (srcList && !LIST_NAME.test(srcList)) throw new ToolInputError("invalid srcAddressList");
        return session(args.router, async (api, config) => {
          if (!config.lan) throw new ToolInputError(`router "${args.router || firstRouter()}" has no LAN configured for port forwards`);
          if (!IPV4.test(toAddress) || !inCidr(toAddress, config.lan)) throw new ToolInputError(`toAddress must be inside ${config.lan}`);
          const existing = await api.command(["/ip/firewall/nat/print", "?chain=dstnat", `?dst-port=${publicPort}`], { limit: 50 });
          const clash = existing.records.filter((r) => r.protocol === protocol && (!r["dst-address"] || r["dst-address"] === config.publicAddress));
          if (clash.length) throw new ToolInputError(`public ${protocol} port ${publicPort} is already forwarded (${clash.map((r) => `${r[".id"]} ${r.comment || ""}`).join("; ")})`);
          const words = [
            "/ip/firewall/nat/add", "=chain=dstnat", `=dst-address=${config.publicAddress}`, `=protocol=${protocol}`,
            `=dst-port=${publicPort}`, "=action=dst-nat", `=to-addresses=${toAddress}`, `=to-ports=${toPort}`, `=comment=${comment}`,
          ];
          if (srcList) words.push(`=src-address-list=${srcList}`);
          const { done } = await api.command(words);
          return { changed: "added", path: "/ip/firewall/nat", id: done.ret || null, rule: { publicAddress: config.publicAddress, publicPort, protocol, toAddress, toPort, srcAddressList: srcList, comment } };
        });
      },
    },

    mikrotik_address_list_add: {
      description: `WRITE. Add an address/CIDR to a firewall address list (only the router's writableLists or lists starting with "${LIST_PREFIX}"). Ask the owner first.`,
      inputSchema: {
        type: "object",
        properties: {
          router: router(routers),
          list: { type: "string" },
          address: { type: "string", description: "IPv4 or CIDR" },
          reason: { type: "string" },
        },
        required: ["list", "address", "reason"],
        additionalProperties: false,
      },
      async execute(args) {
        const list = text(args.list, "list", { max: 64 });
        const address = text(args.address, "address", { max: 18 });
        if (!IPV4_OR_CIDR.test(address)) throw new ToolInputError("address must be IPv4 or CIDR");
        const comment = markComment(args.reason);
        return session(args.router, async (api, config) => {
          if (!LIST_NAME.test(list) || !((config.writableLists || []).includes(list) || list.startsWith(LIST_PREFIX))) {
            throw new ToolInputError(`list must be one of ${(config.writableLists || []).join(", ") || "(none configured)"} or start with "${LIST_PREFIX}"`);
          }
          const existing = await api.command(["/ip/firewall/address-list/print", `?list=${list}`, `?address=${address}`]);
          if (existing.records.length) return { changed: "none", reason: "already in the list", id: existing.records[0][".id"] };
          const { done } = await api.command(["/ip/firewall/address-list/add", `=list=${list}`, `=address=${address}`, `=comment=${comment}`]);
          return { changed: "added", path: "/ip/firewall/address-list", id: done.ret || null, list, address, comment };
        });
      },
    },

    mikrotik_set_enabled: {
      description: `WRITE. Enable or disable a NAT/filter rule or address-list entry that Griffin created (comment starts with "${MARK}"). Ask the owner first.`,
      inputSchema: {
        type: "object",
        properties: {
          router: router(routers),
          path: { type: "string", enum: OWNED_PATHS },
          id: { type: "string", pattern: "^\\*[0-9A-F]+$" },
          enabled: { type: "boolean" },
        },
        required: ["path", "id", "enabled"],
        additionalProperties: false,
      },
      async execute(args) {
        const path = String(args.path);
        const id = String(args.id);
        if (!OWNED_PATHS.includes(path) || !/^\*[0-9A-F]+$/.test(id)) throw new ToolInputError("invalid path or id");
        return session(args.router, async (api) => {
          const item = await findById(api, path, id);
          requireOwned(item, path);
          await api.command([`${path}/${args.enabled ? "enable" : "disable"}`, `=.id=${id}`]);
          return { changed: args.enabled ? "enabled" : "disabled", path, id, comment: item.comment };
        });
      },
    },

    mikrotik_remove: {
      description: `WRITE. Remove a NAT/filter rule or address-list entry that Griffin created (comment starts with "${MARK}"). Ask the owner first.`,
      inputSchema: {
        type: "object",
        properties: {
          router: router(routers),
          path: { type: "string", enum: OWNED_PATHS },
          id: { type: "string", pattern: "^\\*[0-9A-F]+$" },
        },
        required: ["path", "id"],
        additionalProperties: false,
      },
      async execute(args) {
        const path = String(args.path);
        const id = String(args.id);
        if (!OWNED_PATHS.includes(path) || !/^\*[0-9A-F]+$/.test(id)) throw new ToolInputError("invalid path or id");
        return session(args.router, async (api) => {
          const item = await findById(api, path, id);
          requireOwned(item, path);
          await api.command([`${path}/remove`, `=.id=${id}`]);
          return { changed: "removed", path, id, removed: item };
        });
      },
    },
  };
}
