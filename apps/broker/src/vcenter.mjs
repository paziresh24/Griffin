import https from "node:https";
import { ToolInputError } from "./kube.mjs";

// vCenter (8.0 U3) REST client. The credential never reaches the model: url/user/password live in
// Infisical at the site config's vcenter.infisical {project, path} (keys url, user,
// password). The vCenter certificate
// is issued for its internal name, not the IP we call, so TLS verification is off — the wire is
// authenticated by the credential, not the cert.
//
// API shapes were read live from this vCenter (validation errors print the exact vAPI schema):
//   clone:        POST /api/vcenter/vm?action=clone  { source, name, power_on, placement{…}, guest_customization_spec{name} }
//   cust. spec:   POST /api/vcenter/guest/customization-specs  (com.vmware.vcenter.guest …)
//   hw resize:    PATCH /api/vcenter/vm/<id>/hardware/{cpu,memory}   (VM must be powered off)
//   power:        POST /api/vcenter/vm/<id>/power?action=start       (no body)
//   tasks:        GET  /api/cis/tasks/<task>   — task ids look like "task-123:com.vmware…"

const VM_NAME = /^[^\\/,"'@\s][^\\/,"']{0,78}$/;
const HOSTNAME = /^[A-Za-z][A-Za-z0-9-]{0,14}$/; // Windows computer name (NetBIOS) is capped at 15 chars
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const SPEC_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
const GB = 1024;

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function transportImpl(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    // 150s: the clone POST itself can sit >60s before returning (seen live — the clone was
    // accepted and ran while the client had already given up).
    const req = https.request(url, { method, headers, agent, timeout: 150_000 }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("timeout", () => req.destroy(new Error(`vCenter ${new URL(url).pathname} timeout`)));
    req.on("error", reject);
    req.end(body);
  });
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Error payloads come in two shapes on this box: /api {error_type, messages[]} and legacy
// /rest {type, value:{messages[]}}. Prefer the server's own sentence.
function errorText(body) {
  const messages = body?.messages || body?.value?.messages || body?.error?.messages || [];
  const sentences = messages.map((m) => m.default_message || m).filter(Boolean);
  // vAPI puts the generic "Invalid input" first and the detailed one ("Missing field …") after —
  // keep the most specific sentence.
  sentences.sort((a, b) => b.length - a.length);
  return String(sentences[0] || body?.error_type || body?.raw || "unknown error");
}

function requireIp(value, label) {
  const ip = String(value || "").trim();
  if (!IPV4.test(ip) || ip.split(".").some((part) => Number(part) > 255)) throw new ToolInputError(`${label} must be an IPv4 address`);
  return ip;
}

export function createVcenterTools({
  readSecret,
  secretRef = null, // { project, path } in Infisical
  transport = transportImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  credentialTtlMs = 5 * 60_000,
}) {
  let cred = { at: 0, value: null };

  async function credentials() {
    if (cred.value && Date.now() - cred.at < credentialTtlMs) return cred.value;
    if (!readSecret || !secretRef?.project || !secretRef?.path) throw new ToolInputError("vCenter is not configured on this broker (set vcenter.infisical {project, path} in the site config)");
    try {
      const read = (name) => readSecret({ projectId: secretRef.project, path: secretRef.path, name });
      const [url, user, password] = await Promise.all([read("url"), read("user"), read("password")]);
      const base = String(url || "").trim().replace(/\/+$/, "");
      if (!/^https:\/\/.+/.test(base)) throw new Error("url is not https");
      if (!user || !password) throw new Error("empty user/password");
      cred = { at: Date.now(), value: { base, user: String(user), password: String(password) } };
      return cred.value;
    } catch (error) {
      cred = { at: 0, value: null };
      throw new ToolInputError(`vCenter credential unavailable from Infisical ${secretRef.project}${secretRef.path} (keys url/user/password): ${error.message}`);
    }
  }

  async function withSession(fn) {
    const { base, user, password } = await credentials();
    const basic = Buffer.from(`${user}:${password}`).toString("base64");
    const login = await transport(`${base}/rest/com/vmware/cis/session`, { method: "POST", headers: { Authorization: `Basic ${basic}`, Accept: "application/json" } });
    if (login.status === 401 || login.status === 403) throw new ToolInputError("vCenter rejected the credential (check user/password in Infisical)");
    if (login.status >= 500) throw new Error(`vCenter login http_${login.status}`);
    const sid = parseBody(login.text)?.value;
    if (!sid) throw new Error("vCenter login returned no session id");
    const vc = {
      base,
      async call(method, path, { json } = {}) {
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const response = await transport(`${base}${path}`, {
            method,
            headers: {
              "vmware-api-session-id": sid,
              Accept: "application/json",
              ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
          });
          if (response.status >= 500) {
            const body = parseBody(response.text);
            if (attempt === 3) throw new Error(`vCenter ${path} http_${response.status}: ${errorText(body).slice(0, 300)}`);
            lastError = new Error(`vCenter ${path} http_${response.status}: ${errorText(body).slice(0, 300)}`);
            await sleep(400 * attempt);
            continue;
          }
          const body = parseBody(response.text);
          if (response.status === 401 || response.status === 403) throw new ToolInputError(`vCenter rejected the session for ${path}`);
          if (response.status === 404) throw new Error(`vCenter ${path}: ${errorText(body)}`);
          if (response.status < 200 || response.status >= 300) throw new Error(`vCenter ${path} http_${response.status}: ${errorText(body).slice(0, 300)}`);
          return body && typeof body === "object" && "value" in body && String(path).startsWith("/rest/") ? body.value : body;
        }
        throw lastError;
      },
    };
    try {
      return await fn(vc);
    } finally {
      transport(`${base}/rest/com/vmware/cis/session`, { method: "DELETE", headers: { "vmware-api-session-id": sid } }).catch(() => {});
    }
  }

  async function listVms(vc) {
    const value = await vc.call("GET", "/rest/vcenter/vm");
    return Array.isArray(value) ? value : [];
  }

  function findVm(vms, source) {
    if (/^vm-\d+$/.test(source)) return vms.find((v) => v.vm === source) || null;
    const needle = String(source).toLowerCase();
    return vms.find((v) => String(v.name || "").toLowerCase() === needle) || null;
  }

  // The first disk's vmdk path carries the source datastore in brackets: "[DS] dir/file.vmdk".
  async function sourceDatastoreName(vc, vmId) {
    const disks = await vc.call("GET", `/api/vcenter/vm/${vmId}/hardware/disk`).catch(() => null);
    const first = Array.isArray(disks) ? disks[0]?.disk : null;
    if (!first) return null;
    const detail = await vc.call("GET", `/api/vcenter/vm/${vmId}/hardware/disk/${first}`).catch(() => null);
    const match = /\[([^\]]+)\]/.exec(String(detail?.backing?.vmdk_file || ""));
    return match ? match[1] : null;
  }

  function summarizeVms(vms, { search = "", power = "" } = {}) {
    return vms
      .filter((v) => (!power || v.power_state === power) && (!search || String(v.name || "").toLowerCase().includes(search)))
      .map((v) => ({ name: v.name, vm: v.vm, power_state: v.power_state, cpu_count: v.cpu_count ?? null, memory_MiB: v.memory_size_MiB ?? null }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  // One Windows customization spec per clone: hostname / admin password / IP. Built from the
  // com.vmware.vcenter.guest schema as this vCenter reports it, applied during the clone, then
  // deleted — the customization is baked into the guest, the spec itself is scratch state.
  function windowsSpec({ hostname, password, ip, prefix, gateway, dnsServers, vmName }) {
    const computer = hostname || vmName.replace(/[^A-Za-z0-9-]/g, "").slice(0, 15) || "griffin";
    // Without an explicit ip the adapter is left out: the NIC keeps whatever the source guest
    // had configured (static included) — the caller is warned about that separately.
    const ipv4 = ip == null ? null : ip === "dhcp" ? { type: "DHCP" } : { type: "STATIC", ip_address: ip, prefix, ...(gateway ? { gateways: [gateway] } : {}) };
    return {
      configuration_spec: {
        windows_config: {
          sysprep: {
            user_data: {
              computer_name: { type: "FIXED", fixed_name: hostname || computer },
              full_name: "Griffin",
              organization: "Griffin",
              product_key: "",
            },
            gui_unattended: {
              auto_logon: false,
              auto_logon_count: 0,
              time_zone: 85, // Tehran (UTC+03:30) — matches where these VMs are used
              ...(password ? { password } : {}),
            },
          },
        },
      },
      // global_DNS_settings is required even when empty (learned from this vCenter's validator).
      ...(dnsServers.length && ip && ip !== "dhcp" ? { global_DNS_settings: { dns_servers: dnsServers } } : { global_DNS_settings: {} }),
      ...(ipv4 ? { interfaces: [{ adapter: { ipv4 } }] } : {}),
    };
  }

  return {
    vcenter_vms: {
      description:
        "List virtual machines in vCenter (read-only): name, id, power state, CPU count, memory. Use a name substring with search. Follow the naming pattern of existing VMs when creating a new one.",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", maxLength: 200, description: "case-insensitive name substring" },
          power_state: { type: "string", enum: ["POWERED_ON", "POWERED_OFF", "SUSPENDED"] },
        },
        additionalProperties: false,
      },
      async execute(args) {
        return withSession(async (vc) => {
          const all = await listVms(vc);
          const vms = summarizeVms(all, { search: String(args?.search || "").toLowerCase(), power: args?.power_state || "" }).slice(0, 300);
          return { vms, total: vms.length, truncated: all.length > 300, source: "vcenter-api" };
        });
      },
    },

    vcenter_vm_get: {
      description:
        "One VM's live state from the company vCenter (read-only): power state, CPU, memory and guest identity (Windows host name + IP once VMware Tools reports it). Accepts the VM name or its vm-<id>.",
      inputSchema: {
        type: "object",
        properties: { vm: { type: "string", minLength: 1, maxLength: 200, description: "VM name or vm-<id>" } },
        required: ["vm"],
        additionalProperties: false,
      },
      async execute(args) {
        const wanted = String(args?.vm || "");
        if (!wanted) throw new ToolInputError("vm is required");
        return withSession(async (vc) => {
          const vms = await listVms(vc);
          const hit = findVm(vms, wanted);
          if (!hit) {
            // Drop a trailing sequence number so "alice-99" still suggests the MrAlice VM.
            const fuzzy = wanted.toLowerCase().replace(/[-_. ]?\d+$/, "").slice(0, 24);
            const names = summarizeVms(vms, { search: fuzzy }).slice(0, 10).map((v) => v.name);
            throw new ToolInputError(`no VM named \"${wanted}\" in this vCenter${names.length ? ` (similar: ${names.join(", ")})` : ` (${vms.length} VMs total)`}`);
          }
          const detail = await vc.call("GET", `/api/vcenter/vm/${hit.vm}`);
          const guest = await vc.call("GET", `/api/vcenter/vm/${hit.vm}/guest/identity`).catch(() => null);
          return {
            vm: hit.vm,
            name: detail?.name ?? hit.name,
            power_state: detail?.power_state ?? hit.power_state,
            cpu: detail?.cpu?.count ?? hit.cpu_count ?? null,
            memory_MiB: detail?.memory?.size_MiB ?? hit.memory_size_MiB ?? null,
            guest: guest ? { host_name: guest.host_name ?? null, ip_address: guest.ip_address ?? null } : null,
            source: "vcenter-api",
          };
        });
      },
    },

    vcenter_inventory: {
      description:
        "Company vCenter placement inventory (read-only): datacenters, ESXi hosts with connection state, datastores with free space, networks (port groups) and VM folders. Call this before vcenter_vm_create to pick a datastore/folder by free space.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return withSession(async (vc) => {
          const [datacenters, hosts, datastores, networks, folders] = await Promise.all([
            vc.call("GET", "/rest/vcenter/datacenter"),
            vc.call("GET", "/rest/vcenter/host"),
            vc.call("GET", "/rest/vcenter/datastore"),
            vc.call("GET", "/rest/vcenter/network"),
            vc.call("GET", "/rest/vcenter/folder"),
          ]);
          const gib = (bytes) => Math.round((Number(bytes) || 0) / 1024 / 1024 / 1024);
          return {
            datacenters: (Array.isArray(datacenters) ? datacenters : []).map((d) => ({ name: d.name, datacenter: d.datacenter })),
            hosts: (Array.isArray(hosts) ? hosts : []).map((h) => ({ name: h.name, host: h.host, connection_state: h.connection_state })),
            datastores: (Array.isArray(datastores) ? datastores : []).map((d) => ({
              name: d.name,
              datastore: d.datastore,
              type: d.type,
              free_bytes: d.free_space ?? null,
              capacity_bytes: d.capacity ?? null,
              free_gib: gib(d.free_space),
            })),
            networks: (Array.isArray(networks) ? networks : []).map((n) => ({ name: n.name, network: n.network, type: n.type })),
            vm_folders: (Array.isArray(folders) ? folders : []).filter((f) => f.type === "VIRTUAL_MACHINE" && !/^vCLS$|Discovered virtual machine/i.test(String(f.name))).map((f) => ({ name: f.name, folder: f.folder })),
            source: "vcenter-api",
          };
        });
      },
    },

    vcenter_customization_specs: {
      description: "List vCenter guest customization specs (read-only). vcenter_vm_create builds and cleans up its own spec, so this is mainly for checking leftovers.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return withSession(async (vc) => {
          const specs = await vc.call("GET", "/api/vcenter/guest/customization-specs");
          return { specs: (Array.isArray(specs) ? specs : []).slice(0, 100), source: "vcenter-api" };
        });
      },
    },

    vcenter_vm_create: {
      description:
        "Create a new VM on the company vCenter by cloning an existing VM (there are no templates — clone a clean Windows VM, e.g. the reference Windows 10/Server machine). Create-only: refuses a name that already exists; never edits or deletes other VMs. Follows the source's disks/network; cpu/memory are re-sized after the clone while it is still powered off, then it is powered on. Windows guest customization (sysprep) is applied when hostname, password or ip is given. Mutating: the owner confirms this call. The admin password, when set, is delivered only via Infisical (never in chat).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "new VM name, following the pattern of existing VMs", minLength: 1, maxLength: 80 },
          source: { type: "string", description: "VM name or vm-<id> to clone from", minLength: 1, maxLength: 200 },
          cpu: { type: "integer", minimum: 1, maximum: 64, description: "re-size vCPU after clone (default: keep source)" },
          memory_gb: { type: "number", minimum: 0.5, maximum: 1024, description: "re-size memory in GiB after clone (default: keep source)" },
          hostname: { type: "string", description: "Windows computer name (≤15 chars, letter first) — needs VMware Tools in the source", pattern: HOSTNAME.source },
          password: { type: "string", minLength: 6, maxLength: 100, description: "new local Administrator password (sysprep); deliver it via Infisical, not chat" },
          ip: { type: "string", description: '"dhcp" or a static IPv4 for the first NIC (needs hostname/customization)' },
          prefix: { type: "integer", minimum: 8, maximum: 32, description: "static IP prefix length (e.g. 24)" },
          gateway: { type: "string", description: "default gateway for the static IP" },
          dns: { type: "array", maxItems: 3, items: { type: "string" }, description: "DNS servers for the static IP" },
          datastore: { type: "string", maxLength: 200, description: "destination datastore name (default: same as source)" },
          host: { type: "string", maxLength: 200, description: "destination ESXi host name (default: vCenter picks)" },
          folder: { type: "string", maxLength: 200, description: "destination VM folder name (default: same as source)" },
          os_disk_only: { type: "boolean", description: "clone only the source's first (OS) disk and drop every other attached disk — needed when someone attached foreign data disks to the source VM (they are often locked and make the clone fail)" },
          power_on: { type: "boolean", description: "power on when ready (default true)" },
          wait_seconds: { type: "integer", minimum: 30, maximum: 150, description: "how long to wait for the clone task before returning status running (default 90)" },
        },
        required: ["name", "source"],
        additionalProperties: false,
      },
      async execute(args) {
        const name = String(args?.name || "");
        if (!VM_NAME.test(name)) throw new ToolInputError("invalid VM name (no quotes, backslashes or leading space; max 80 chars)");
        const source = String(args?.source || "");
        const cpu = args?.cpu === undefined ? null : Number(args.cpu);
        if (cpu !== null && (!Number.isInteger(cpu) || cpu < 1 || cpu > 64)) throw new ToolInputError("cpu must be an integer 1..64");
        const memoryMiB = args?.memory_gb === undefined ? null : Math.round(Number(args.memory_gb) * GB);
        if (memoryMiB !== null && (memoryMiB < 512 || memoryMiB > 1024 * GB)) throw new ToolInputError("memory_gb must be 0.5..1024");
        const resize = cpu !== null || memoryMiB !== null;
        const hostname = args?.hostname === undefined ? null : String(args.hostname);
        if (hostname && !HOSTNAME.test(hostname)) throw new ToolInputError("hostname must be ≤15 chars, start with a letter, letters/digits/dashes only (Windows NetBIOS limit)");
        const password = args?.password === undefined ? null : String(args.password);
        const ipMode = args?.ip === undefined ? null : String(args.ip).toLowerCase() === "dhcp" ? "dhcp" : "static";
        const ip = ipMode === "static" ? requireIp(args.ip, "ip") : ipMode === "dhcp" ? "dhcp" : null;
        const prefix = args?.prefix === undefined ? null : Number(args.prefix);
        if (ipMode === "static" && (!Number.isInteger(prefix) || prefix < 8 || prefix > 32)) throw new ToolInputError("prefix is required with a static ip (8..32)");
        const gateway = args?.gateway === undefined ? null : requireIp(args.gateway, "gateway");
        const dnsServers = Array.isArray(args?.dns) ? args.dns.map((d) => requireIp(d, "dns entry")) : [];
        const powerOn = args?.power_on !== false;
        const waitMs = Math.min(Math.max(Number(args?.wait_seconds) || 90, 30), 150) * 1000;
        const customize = Boolean(hostname || password || ipMode);

        return withSession(async (vc) => {
          const vms = await listVms(vc);
          if (vms.some((v) => String(v.name || "").toLowerCase() === name.toLowerCase())) {
            throw new ToolInputError(`a VM named \"${name}\" already exists — create-only tool, nothing changed (pick the next sequence number, see vcenter_vms)`);
          }
          const src = findVm(vms, source);
          if (!src) throw new ToolInputError(`clone source \"${source}\" not found (${vms.length} VMs — check vcenter_vms for the exact name)`);
          const warnings = [];
          if (src.power_state === "POWERED_ON") warnings.push(`source ${src.name} is powered on — the clone is a crash-consistent copy of its disks`);
          // A running clone snapshots on the SOURCE datastore; if that datastore is nearly full
          // vCenter fails the whole clone with "Insufficient disk space" (seen live on this box).
          if (src.power_state === "POWERED_ON") {
            const sourceDatastore = await sourceDatastoreName(vc, src.vm);
            if (sourceDatastore) {
              const datastores = await vc.call("GET", "/rest/vcenter/datastore");
              const ds = (Array.isArray(datastores) ? datastores : []).find((d) => d.name === sourceDatastore || d.datastore === sourceDatastore);
              if (ds) {
                const freeGib = Math.round(Number(ds.free_space || 0) / 1024 ** 3);
                // Live evidence from this box: vCenter refused running clones at 39 GiB and at
                // 72 GiB free ("Insufficient disk space") — refuse early below 100 GiB.
                if (freeGib < 100) {
                  throw new ToolInputError(
                    `source datastore ${ds.name} has only ${freeGib} GiB free — vCenter refuses to snapshot a running VM there ("Insufficient disk space", seen live at 39 and 72 GiB). Free ~150 GiB on it or coordinate a brief power-off of the source first`,
                  );
                }
                if (freeGib < 150) {
                  warnings.push(`source datastore ${ds.name} has only ${freeGib} GiB free — vCenter may refuse the clone with "Insufficient disk space" (free space or clone from a powered-off VM)`);
                }
              }
            }
          }

          const placement = {};
          // Names can repeat across datacenters (two "datastore1 (1)" here) — resolve accepts an
          // id (datastore-…/host-…/group-v…) and refuses ambiguous names instead of guessing.
  const pickByName = (items, value, label) => {
    if (!Array.isArray(items)) throw new ToolInputError(`${label} list unavailable`);
    const idOf = (item) => item.datastore || item.host || item.folder || null;
    if (/^(datastore|host|group)-\d+$/.test(value)) return items.find((item) => idOf(item) === value) || null;
    const hits = items.filter((item) => String(item.name).toLowerCase() === value.toLowerCase());
    if (hits.length > 1) {
      throw new ToolInputError(`${label} name \"${value}\" is ambiguous (${hits.length} matches) — pass the id instead: ${hits.map((h) => idOf(h)).join(" / ")}`);
    }
    return hits[0] || null;
  };
          if (args?.datastore !== undefined) {
            const datastores = await vc.call("GET", "/rest/vcenter/datastore");
            const ds = pickByName(datastores, String(args.datastore), "datastore");
            if (!ds) throw new ToolInputError(`datastore \"${args.datastore}\" not found (see vcenter_inventory)`);
            placement.datastore = ds.datastore;
            const freeGib = Math.round(Number(ds.free_space || 0) / 1024 ** 3);
            if (freeGib < 50) warnings.push(`datastore ${ds.name} has only ${freeGib} GiB free`);
          }
          if (args?.host !== undefined) {
            const hosts = await vc.call("GET", "/rest/vcenter/host");
            const host = pickByName(hosts, String(args.host), "host");
            if (!host) throw new ToolInputError(`host \"${args.host}\" not found (see vcenter_inventory)`);
            if (host.connection_state !== "CONNECTED") warnings.push(`host ${host.name} is ${host.connection_state}`);
            placement.host = host.host;
          }
          if (args?.folder !== undefined) {
            const folders = await vc.call("GET", "/rest/vcenter/folder");
            const candidates = (Array.isArray(folders) ? folders : []).filter((f) => f.type === "VIRTUAL_MACHINE");
            const folder = pickByName(candidates, String(args.folder), "VM folder");
            if (!folder) throw new ToolInputError(`VM folder \"${args.folder}\" not found (see vcenter_inventory)`);
            placement.folder = folder.folder;
          }

          // Scratch customization spec, deleted after the clone whatever happens.
          const specName = customize ? `griffin-${name.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 47)}` : null;
          if (specName && !SPEC_NAME.test(specName)) throw new ToolInputError("cannot derive a customization spec name from this VM name");
          if (customize && !ipMode) {
            warnings.push("no ip given — the NIC keeps the source guest's IP configuration; check for an IP conflict with the source VM");
          }
          let specCreated = false;
          if (specName) {
            const spec = windowsSpec({ hostname, password, ip, prefix, gateway, dnsServers, vmName: name });
            await vc.call("DELETE", `/api/vcenter/guest/customization-specs/${encodeURIComponent(specName)}`).catch(() => {});
            await vc.call("POST", "/api/vcenter/guest/customization-specs", { json: { name: specName, description: `griffin clone of ${src.name}`, spec } });
            specCreated = true;
          }

          try {
            const cloneBody = {
              source: src.vm,
              name,
              // Re-sizing only works while the clone is off; power on happens after the patch.
              power_on: powerOn && !resize,
              ...(Object.keys(placement).length ? { placement } : {}),
              ...(specCreated ? { guest_customization_spec: { name: specName } } : {}),
            };
            // Foreign disks attached to the source (another VM's disks, usually locked) make the
            // clone read them and fail; os_disk_only keeps just the first disk.
            if (args?.os_disk_only === true) {
              const disks = await vc.call("GET", `/api/vcenter/vm/${src.vm}/hardware/disk`).catch(() => null);
              const ids = (Array.isArray(disks) ? disks : []).map((d) => d.disk).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
              if (ids.length > 1) {
                cloneBody.disks_to_remove = ids.slice(1);
                warnings.push(`cloned only disk ${ids[0]}; dropped ${ids.length - 1} extra attached disk(s) (${ids.slice(1).join(", ")})`);
              }
            }
            const cloneResult = await vc.call("POST", "/api/vcenter/vm?action=clone", { json: cloneBody });
            const newVm = cloneResult?.vm || cloneResult?.value?.vm || null;
            if (!newVm) throw new Error(`vCenter accepted the clone but returned no vm id: ${JSON.stringify(cloneResult).slice(0, 200)}`);
            const taskId = cloneResult?.task || cloneResult?.value?.task || null;

            // Poll the clone task; return "running" instead of blocking past the caller's patience.
            const deadline = now() + waitMs;
            let task = null;
            while (taskId) {
              task = await vc.call("GET", `/api/cis/tasks/${encodeURIComponent(taskId)}`).catch(() => null);
              const status = String(task?.status || "");
              if (status === "RUNNING" || status === "PENDING" || status === "STARTED") {
                if (now() >= deadline) {
                  return {
                    status: "running",
                    vm: newVm,
                    name,
                    task: taskId,
                    note: "clone task still running — check vcenter_vm_get later; do not re-create",
                    warnings,
                    source: "vcenter-api",
                  };
                }
                await sleep(3000);
                continue;
              }
              if (status && status !== "SUCCEEDED" && status !== "SUCCESS") {
                throw new Error(`clone task ${status}: ${errorText(task).slice(0, 300)}`);
              }
              break;
            }

            if (cpu !== null) await vc.call("PATCH", `/api/vcenter/vm/${newVm}/hardware/cpu`, { json: { count: cpu } });
            if (memoryMiB !== null) await vc.call("PATCH", `/api/vcenter/vm/${newVm}/hardware/memory`, { json: { size_MiB: memoryMiB } });
            if (powerOn && resize) await vc.call("POST", `/api/vcenter/vm/${newVm}/power?action=start`);

            const detail = await vc.call("GET", `/api/vcenter/vm/${newVm}`).catch(() => null);
            if (customize) warnings.push("Windows sysprep runs on first boot — hostname/IP/password settle a few minutes after power-on");
            return {
              status: task ? String(task.status) : "SUCCEEDED",
              created: {
                name: detail?.name ?? name,
                vm: newVm,
                power_state: detail?.power_state ?? (powerOn ? "POWERED_ON" : null),
                cpu: detail?.cpu?.count ?? cpu ?? src.cpu_count ?? null,
                memory_MiB: detail?.memory?.size_MiB ?? memoryMiB ?? src.memory_size_MiB ?? null,
                password_set: Boolean(password),
                ip,
              },
              cloned_from: { name: src.name, vm: src.vm },
              warnings,
              source: "vcenter-api",
            };
          } finally {
            if (specCreated) await vc.call("DELETE", `/api/vcenter/guest/customization-specs/${encodeURIComponent(specName)}`).catch(() => {});
          }
        });
      },
    },
  };
}
