import test from "node:test";
import assert from "node:assert/strict";
import { createVcenterTools } from "../src/vcenter.mjs";
import { ToolInputError } from "../src/kube.mjs";

// The fake transport keys handlers by "METHOD pathname?search" like the other tool suites; a
// clock is injected so the clone-task polling loop can hit its deadline instantly.
function setup({ responses = {}, secrets = null, advanceMs = 0 } = {}) {
  const calls = [];
  let clock = 1_000_000_000_000;
  const readSecret = async ({ name }) => {
    const all = secrets ?? { url: "https://vc.example", user: "administrator@vsphere.local", password: "pw-1" };
    if (!(name in all)) throw new Error(`infisical http_404 ${name}`);
    return all[name];
  };
  const transport = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || "GET"} ${u.pathname}${u.search}`;
    calls.push({ key, headers: init.headers || {}, body: init.body });
    if (advanceMs) clock += advanceMs;
    if (u.pathname === "/rest/com/vmware/cis/session" && key.startsWith("POST")) return SESSION;
    const handler = responses[key] ?? responses[`${init.method || "GET"} ${u.pathname}`];
    if (typeof handler === "function") return handler(u, init);
    if (handler) return handler;
    return { status: 200, text: "" };
  };
  return {
    tools: createVcenterTools({ readSecret, secretRef: { project: "ops", path: "/vcenter" }, transport, sleep: async () => {}, now: () => clock }),
    calls,
    keys: () => calls.map((c) => c.key),
  };
}

const SESSION = { status: 200, text: JSON.stringify({ value: "sid-1" }) };
const VM_LIST = {
  "GET /rest/vcenter/vm": {
    status: 200,
    text: JSON.stringify({
      value: [
        { vm: "vm-100", name: "VPS-MrAlice-Windows-10-4", power_state: "POWERED_ON", cpu_count: 4, memory_size_MiB: 4096 },
        { vm: "vm-2016", name: "VPS-BBob-Ubuntu-Server-24.04-25", power_state: "POWERED_OFF", cpu_count: 6, memory_size_MiB: 8192 },
      ],
    }),
  },
};
const ok = (body) => ({ status: 200, text: JSON.stringify(body) });

test("login carries Basic from Infisical url/user/password and the session id afterwards", async () => {
  const { tools, calls } = setup({ responses: { ...VM_LIST } });
  await tools.vcenter_vms.execute({});
  const login = calls[0];
  const expected = Buffer.from("administrator@vsphere.local:pw-1").toString("base64");
  assert.equal(login.headers.Authorization, `Basic ${expected}`);
  assert.ok(calls.slice(1).every((c) => c.headers["vmware-api-session-id"] === "sid-1"));
  assert.ok(calls.some((c) => c.key === "DELETE /rest/com/vmware/cis/session"), "logout at the end");
});

test("missing Infisical credential is a ToolInputError naming the path", async () => {
  const { tools } = setup({ secrets: {} });
  await assert.rejects(tools.vcenter_vms.execute({}), (err) => {
    assert.ok(err instanceof ToolInputError);
    assert.match(err.message, /ops\/vcenter/);
    return true;
  });
});

test("vcenter_vms summarizes and filters by search/power", async () => {
  const { tools } = setup({ responses: { ...VM_LIST } });
  const result = await tools.vcenter_vms.execute({ search: "windows", power_state: "POWERED_ON" });
  assert.equal(result.total, 1);
  assert.equal(result.vms[0].name, "VPS-MrAlice-Windows-10-4");
  assert.equal(result.vms[0].memory_MiB, 4096);
});

test("vcenter_vm_get resolves a name to its id and merges guest info", async () => {
  const { tools } = setup({
    responses: {
      ...VM_LIST,
      "GET /api/vcenter/vm/vm-100": ok({ name: "VPS-MrAlice-Windows-10-4", power_state: "POWERED_ON", cpu: { count: 4 }, memory: { size_MiB: 4096 } }),
      "GET /api/vcenter/vm/vm-100/guest/identity": ok({ host_name: "WIN10", ip_address: "198.51.100.50" }),
    },
  });
  const result = await tools.vcenter_vm_get.execute({ vm: "vps-mralice-windows-10-4" });
  assert.equal(result.vm, "vm-100");
  assert.equal(result.guest.ip_address, "198.51.100.50");
});

test("vcenter_vm_get on an unknown name lists similar names", async () => {
  const { tools } = setup({ responses: { ...VM_LIST } });
  await assert.rejects(tools.vcenter_vm_get.execute({ vm: "alice-99" }), (err) => {
    assert.ok(err instanceof ToolInputError);
    assert.match(err.message, /similar: VPS-MrAlice-Windows-10-4/);
    return true;
  });
});

test("vcenter_vm_create refuses an existing name without any write", async () => {
  const { tools, calls } = setup({ responses: { ...VM_LIST } });
  await assert.rejects(tools.vcenter_vm_create.execute({ name: "vps-mralice-windows-10-4", source: "VPS-MrAlice-Windows-10-4" }), (err) => {
    assert.ok(err instanceof ToolInputError);
    assert.match(err.message, /already exists/);
    return true;
  });
  assert.ok(!calls.some((c) => c.method === undefined ? false : c.key.includes("action=clone")), "no clone call");
  assert.ok(!calls.some((c) => c.key.startsWith("POST /api/")), "no api writes at all");
});

function cloneFlow({ taskResponses, extra = {} } = {}) {
  let polls = 0;
  return {
    ...VM_LIST,
    "GET /api/vcenter/vm/vm-100/hardware/disk": ok([{ disk: "2000" }]),
    "GET /api/vcenter/vm/vm-100/hardware/disk/2000": ok({ backing: { vmdk_file: "[datastore1 (1)] VPS-MrAlice-Windows-10-4/disk.vmdk" } }),
    "GET /rest/vcenter/datastore": ok({ value: [
      { name: "datastore1 (1)", datastore: "datastore-193", type: "VMFS", free_space: 300 * 1024 ** 3, capacity: 800 * 1024 ** 3 },
      { name: "datastore1 (1)", datastore: "datastore-2013", type: "VMFS", free_space: 2000 * 1024 ** 3, capacity: 2800 * 1024 ** 3 },
    ] }),
    "GET /rest/vcenter/host": ok({ value: [] }),
    "GET /rest/vcenter/folder": ok({ value: [] }),
    "POST /api/vcenter/guest/customization-specs": ok({ name: "griffin-test" }),
    "DELETE /api/vcenter/guest/customization-specs/griffin-VPS-Test-Win-5": { status: 204, text: "" },
    "POST /api/vcenter/vm?action=clone": ok({ vm: "vm-3001", task: "task-9:com.vmware.vcenter.vm" }),
    "GET /api/cis/tasks/task-9%3Acom.vmware.vcenter.vm": () => ok(taskResponses[polls++] || { status: "SUCCEEDED", progress: 100 }),
    "GET /api/vcenter/vm/vm-3001": ok({ name: "VPS-Test-Win-5", power_state: "POWERED_ON", cpu: { count: 4 }, memory: { size_MiB: 8192 } }),
    "GET /api/vcenter/vm/vm-3001/guest/info": ok({ host_name: "VPS-TEST-WIN-5", ip_address: null }),
    ...extra,
  };
}

const CREATE_ARGS = {
  name: "VPS-Test-Win-5",
  source: "VPS-MrAlice-Windows-10-4",
  hostname: "VPS-TEST-WIN-5",
  password: "Sup3r-Secret!",
  ip: "dhcp",
};

test("vcenter_vm_create clones with a Windows spec and never echoes the password", async () => {
  const { tools, calls } = setup({ responses: cloneFlow({ taskResponses: [{ status: "RUNNING", progress: 10 }] }) });
  const result = await tools.vcenter_vm_create.execute(CREATE_ARGS);
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.created.vm, "vm-3001");
  assert.equal(result.created.password_set, true);

  const specPost = calls.find((c) => c.key === "POST /api/vcenter/guest/customization-specs");
  const spec = JSON.parse(specPost.body);
  assert.equal(spec.name, "griffin-VPS-Test-Win-5");
  assert.equal(spec.spec.configuration_spec.windows_config.sysprep.user_data.computer_name.fixed_name, "VPS-TEST-WIN-5");
  assert.equal(spec.spec.configuration_spec.windows_config.sysprep.gui_unattended.password, "Sup3r-Secret!");
  assert.deepEqual(spec.spec.interfaces, [{ adapter: { ipv4: { type: "DHCP" } } }]);

  const clonePost = calls.find((c) => c.key === "POST /api/vcenter/vm?action=clone");
  const clone = JSON.parse(clonePost.body);
  assert.equal(clone.source, "vm-100");
  assert.equal(clone.name, "VPS-Test-Win-5");
  assert.equal(clone.power_on, true);
  assert.deepEqual(clone.guest_customization_spec, { name: "griffin-VPS-Test-Win-5" });

  assert.ok(!JSON.stringify(result).includes("Sup3r-Secret"), "password never in the result");
  assert.ok(calls.some((c) => c.key === "DELETE /api/vcenter/guest/customization-specs/griffin-VPS-Test-Win-5"), "scratch spec deleted");
});

test("vcenter_vm_create re-sizes while off, then powers on", async () => {
  const { tools, calls } = setup({
    responses: cloneFlow({
      extra: {
        "PATCH /api/vcenter/vm/vm-3001/hardware/cpu": { status: 204, text: "" },
        "PATCH /api/vcenter/vm/vm-3001/hardware/memory": { status: 204, text: "" },
        "POST /api/vcenter/vm/vm-3001/power?action=start": { status: 204, text: "" },
      },
    }),
  });
  const result = await tools.vcenter_vm_create.execute({ name: "VPS-Test-Win-5", source: "vm-100", cpu: 8, memory_gb: 16 });
  const clone = JSON.parse(calls.find((c) => c.key === "POST /api/vcenter/vm?action=clone").body);
  assert.equal(clone.power_on, false, "clone stays off for the hardware patch");
  const cpuPatch = JSON.parse(calls.find((c) => c.key === "PATCH /api/vcenter/vm/vm-3001/hardware/cpu").body);
  const memPatch = JSON.parse(calls.find((c) => c.key === "PATCH /api/vcenter/vm/vm-3001/hardware/memory").body);
  assert.deepEqual(cpuPatch, { count: 8 });
  assert.deepEqual(memPatch, { size_MiB: 16384 });
  assert.ok(calls.some((c) => c.key === "POST /api/vcenter/vm/vm-3001/power?action=start"), "powered on after resize");
  assert.equal(result.created.cpu, 4); // live detail wins
  assert.ok(!calls.some((c) => c.key === "POST /api/vcenter/guest/customization-specs"), "no spec without hostname/password/ip");
});

test("vcenter_vm_create returns running when the clone task exceeds the wait budget", async () => {
  const { tools } = setup({
    responses: cloneFlow({ taskResponses: [{ status: "RUNNING", progress: 5 }, { status: "RUNNING", progress: 20 }, { status: "RUNNING", progress: 40 }] }),
    advanceMs: 60_000,
  });
  const result = await tools.vcenter_vm_create.execute({ ...CREATE_ARGS, wait_seconds: 30 });
  assert.equal(result.status, "running");
  assert.equal(result.vm, "vm-3001");
  assert.match(result.note, /check vcenter_vm_get/);
});

test("vcenter_vm_create fails loudly when the clone task fails", async () => {
  const { tools } = setup({
    responses: cloneFlow({ taskResponses: [{ status: "FAILED", error: { messages: [{ default_message: "Insufficient disk space" }] } }] }),
  });
  await assert.rejects(tools.vcenter_vm_create.execute(CREATE_ARGS), /Insufficient disk space/);
});

test("static ip needs a prefix; long hostnames are rejected up front", async () => {
  const { tools } = setup({ responses: cloneFlow() });
  await assert.rejects(tools.vcenter_vm_create.execute({ ...CREATE_ARGS, ip: "198.51.100.10", prefix: undefined }), /prefix is required/);
  await assert.rejects(tools.vcenter_vm_create.execute({ ...CREATE_ARGS, hostname: "THIS-HOSTNAME-IS-FAR-TOO-LONG" }), /15 chars|hostname/);
});

test("customization without an explicit ip keeps the source NIC config and says so", async () => {
  const { tools, calls } = setup({ responses: cloneFlow() });
  const result = await tools.vcenter_vm_create.execute({ name: "VPS-Test-Win-5", source: "VPS-MrAlice-Windows-10-4", hostname: "VPS-TEST-WIN-5" });
  assert.ok(result.warnings.some((w) => /IP conflict/.test(w)));
  const spec = JSON.parse(calls.find((c) => c.key === "POST /api/vcenter/guest/customization-specs").body);
  assert.equal(spec.spec.interfaces, undefined, "no adapter section when ip is not chosen");
});

test("placement names that repeat across datacenters are refused; the id wins", async () => {
  const { tools, calls } = setup({ responses: cloneFlow() });
  await assert.rejects(
    tools.vcenter_vm_create.execute({ name: "VPS-Test-Win-5", source: "vm-100", datastore: "datastore1 (1)" }),
    (err) => {
      assert.ok(err instanceof ToolInputError);
      assert.match(err.message, /ambiguous.*datastore-193 \/ datastore-2013/);
      return true;
    },
  );
  const result = await tools.vcenter_vm_create.execute({ name: "VPS-Test-Win-5", source: "vm-100", datastore: "datastore-2013" });
  assert.equal(result.created.vm, "vm-3001");
  const clone = JSON.parse(calls.find((c) => c.key === "POST /api/vcenter/vm?action=clone").body);
  assert.equal(clone.placement.datastore, "datastore-2013");
});

test("a powered-on source on a nearly-full datastore is refused up front with the live vCenter lesson", async () => {
  const { tools, calls } = setup({
    responses: cloneFlow({
      extra: {
        "GET /rest/vcenter/datastore": ok({ value: [
          { name: "datastore1 (1)", datastore: "datastore-193", type: "VMFS", free_space: 39 * 1024 ** 3, capacity: 800 * 1024 ** 3 },
          { name: "datastore1 (1)", datastore: "datastore-2013", type: "VMFS", free_space: 2000 * 1024 ** 3, capacity: 2800 * 1024 ** 3 },
        ] }),
      },
    }),
  });
  await assert.rejects(tools.vcenter_vm_create.execute({ name: "VPS-Test-Win-5", source: "vm-100" }), (err) => {
    assert.ok(err instanceof ToolInputError);
    assert.match(err.message, /only 39 GiB free/);
    assert.match(err.message, /Insufficient disk space/);
    return true;
  });
  assert.ok(!calls.some((c) => c.key.includes("action=clone")), "no clone attempt when the source datastore cannot snapshot");
});

test("os_disk_only drops the source's extra (foreign) disks from the clone", async () => {
  const { tools, calls } = setup({
    responses: cloneFlow({
      extra: { "GET /api/vcenter/vm/vm-100/hardware/disk": ok([{ disk: "2000" }, { disk: "2001" }, { disk: "2002" }]) },
    }),
  });
  const result = await tools.vcenter_vm_create.execute({ name: "VPS-Test-Win-5", source: "vm-100", os_disk_only: true });
  const clone = JSON.parse(calls.find((c) => c.key === "POST /api/vcenter/vm?action=clone").body);
  assert.deepEqual(clone.disks_to_remove, ["2001", "2002"]);
  assert.ok(result.warnings.some((w) => /dropped 2 extra/.test(w)));
});

test("vcenter_inventory reports placement facts with free space in GiB", async () => {
  const { tools } = setup({
    responses: {
      "GET /rest/vcenter/datacenter": ok({ value: [{ name: "DC-1", datacenter: "datacenter-3" }] }),
      "GET /rest/vcenter/host": ok({ value: [{ name: "198.51.100.22", host: "host-190", connection_state: "CONNECTED" }] }),
      "GET /rest/vcenter/datastore": ok({ value: [{ name: "DS-01", datastore: "datastore-2003", type: "VMFS", free_space: 30_266_097_664, capacity: 999_922_073_600 }] }),
      "GET /rest/vcenter/network": ok({ value: [{ name: "VM Network", network: "network-13", type: "STANDARD_PORTGROUP" }] }),
      "GET /rest/vcenter/folder": ok({ value: [
        { name: "vm", folder: "group-v4", type: "VIRTUAL_MACHINE" },
        { name: "vCLS", folder: "group-v8", type: "VIRTUAL_MACHINE" },
        { name: "host", folder: "group-h5", type: "HOST" },
      ] }),
    },
  });
  const result = await tools.vcenter_inventory.execute({});
  assert.equal(result.datastores[0].free_gib, 28);
  assert.deepEqual(result.vm_folders, [{ name: "vm", folder: "group-v4" }]); // vCLS/system folders stay out
});
