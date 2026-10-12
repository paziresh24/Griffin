import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHostStats, diskUsage, parseCpuTimes, parseLoadavg, parseMemInfo } from "../src/host-stats.mjs";

const MEMINFO = `MemTotal:       16384 kB
MemFree:          512 kB
MemAvailable:    8192 kB
Buffers:          128 kB
Cached:          2048 kB
SwapTotal:          0 kB
`;

const CPUTIMES = `cpu  100 0 50 800 100 0 10 40 0 0
cpu0 50 0 25 400 50 0 5 20 0 0
cpu1 50 0 25 400 50 0 5 20 0 0
intr 12345
`;

test("parseMemInfo reads MemAvailable as the free part, in bytes, with a percent used", () => {
  const mem = parseMemInfo(MEMINFO);
  assert.equal(mem.total, 16384 * 1024);
  assert.equal(mem.available, 8192 * 1024);
  assert.equal(mem.used, 8192 * 1024);
  assert.equal(mem.percent, 50);
});

test("parseMemInfo returns null when the kernel answer is unusable", () => {
  assert.equal(parseMemInfo(""), null);
  assert.equal(parseMemInfo("MemTotal:  100 kB\n"), null, "no MemAvailable");
});

test("parseCpuTimes aggregates all cores; idle includes iowait", () => {
  const cpu = parseCpuTimes(CPUTIMES);
  assert.equal(cpu.total, 100 + 0 + 50 + 800 + 100 + 0 + 10 + 40);
  assert.equal(cpu.idle, 800 + 100);
  assert.equal(parseCpuTimes("intr 1\n"), null);
});

test("parseLoadavg keeps three numbers or gives up", () => {
  assert.deepEqual(parseLoadavg("0.10 0.25 0.40 2/817 12345"), [0.1, 0.25, 0.4]);
  assert.equal(parseLoadavg("1.0 2.0"), null);
  assert.equal(parseLoadavg(""), null);
});

test("diskUsage counts like df: used over what an unprivileged writer can reach, rounded up", () => {
  // 1000 blocks of 4 kB: 100 free, of which 50 are root-reserved => 900 used, 50 available.
  const disk = diskUsage({ bsize: 4096, blocks: 1000, bfree: 100, bavail: 50 });
  assert.equal(disk.total, 1000 * 4096);
  assert.equal(disk.used, 900 * 4096);
  assert.equal(disk.available, 50 * 4096);
  assert.equal(disk.percent, 95, "900 / (900 + 50) = 94.7 -> 95, the number df prints");
});

test("diskUsage returns null when the filesystem answer is unusable", () => {
  assert.equal(diskUsage(null), null);
  assert.equal(diskUsage({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 }), null);
});

test("createHostStats samples the real host: cpu/memory/load present, cached for quick re-reads", async () => {
  const stats = createHostStats();
  const first = await stats();
  assert.equal(typeof first.cpu.percent, "number", "the two /proc/stat reads bridged a cpu delta");
  assert.ok(first.cpu.percent >= 0 && first.cpu.percent <= 100);
  assert.ok(first.cpu.cores >= 1);
  assert.equal(first.memory.total, parseMemInfo(fs.readFileSync("/proc/meminfo", "utf8")).total);
  assert.ok(Array.isArray(first.load) || first.load === null);
  assert.ok(first.uptimeS > 0);
  const root = fs.statfsSync("/");
  assert.equal(first.disk.total, root.blocks * root.bsize, "the root filesystem rides along");
  assert.ok(first.disk.percent >= 0 && first.disk.percent <= 100);
  assert.ok(first.process.rssBytes > 0, "the server's own RSS rides along");

  const second = await stats();
  assert.equal(second, first, "a re-read inside the cache window returns the same sample");
});

test("createHostStats reports how long the server process has been up, apart from the machine", async () => {
  const stats = createHostStats({ processUptime: () => 7_384.6 });
  const sample = await stats();
  assert.equal(sample.process.uptimeS, 7_384, "whole seconds since this server process started");
  assert.equal(Date.parse(sample.at) - Date.parse(sample.process.startedAt), 7_384_000, "the start time is the sample time minus the uptime");
  assert.ok(sample.uptimeS > 0, "the machine's own uptime still rides along");

  const real = await createHostStats()();
  assert.ok(real.process.uptimeS >= 0, "the default reads the live process");
  assert.ok(real.process.uptimeS <= real.uptimeS, "a process cannot have been up longer than its machine");
});
