import fs from "node:fs";

// Live host resources behind GET /api/host, shown on Settings → وضعیت. Griffin
// runs in a container without lxcfs, so /proc/stat, /proc/meminfo, /proc/loadavg and /proc/uptime are
// the host's own; /proc/self/status is this server process. Pure /proc and statfs readers — no
// binaries, no shell. Parsers are exported so node tests can feed them fixture text.

export function parseMemInfo(text) {
  const values = new Map();
  for (const line of String(text || "").split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim());
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  const total = values.get("MemTotal");
  const available = values.get("MemAvailable");
  if (!total || available == null) return null;
  const used = Math.max(0, total - available);
  return { total, available, used, percent: Math.round((used / total) * 100) };
}

// /proc/stat's "cpu" line aggregates every core: user nice system idle iowait irq softirq steal …
export function parseCpuTimes(text) {
  const line = String(text || "").split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return null;
  const idle = (parts[3] || 0) + (parts[4] || 0); // idle + iowait
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

export function parseLoadavg(text) {
  const parts = String(text || "").trim().split(/\s+/).map(Number).slice(0, 3);
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : null;
}

// One filesystem, counted the way df does: root-reserved blocks are not available to the app, so
// the percent is used over (used + available) and rounds up — a full disk never reads as 99%.
export function diskUsage(stat) {
  if (!stat || !stat.blocks || !stat.bsize) return null;
  const total = stat.blocks * stat.bsize;
  const used = Math.max(0, stat.blocks - stat.bfree) * stat.bsize;
  const available = Math.max(0, stat.bavail) * stat.bsize;
  const reachable = used + available;
  return { total, used, available, percent: reachable ? Math.min(100, Math.ceil((used / reachable) * 100)) : null };
}

const statfs = (dir) => {
  try {
    return fs.statfsSync(dir);
  } catch {
    return null;
  }
};

const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/**
 * One sample. CPU percent needs two /proc/stat reads; on a cold cache one short pause bridges
 * them, then samples are served from a short cache so a page polling every few seconds
 * neither hammers /proc nor returns stale minutes-old numbers.
 */
export function createHostStats({
  sampleMs = 120,
  cacheMs = 2_000,
  diskPath = "/",
  now = () => Date.now(),
  processUptime = () => process.uptime(),
} = {}) {
  let cached = null;
  let previous = null; // last { at, idle, total } for the delta
  let cores = null;

  function cpuTimes() {
    const parsed = parseCpuTimes(read("/proc/stat"));
    if (parsed && cores == null) {
      cores = (String(read("/proc/stat")).match(/^cpu\d+ /gm) || []).length || null;
    }
    return parsed;
  }

  async function sample() {
    const at = now();
    if (cached && at - cached.at < cacheMs) return cached.value;
    let before = previous && at - previous.at < 5_000 ? previous : null;
    let after = cpuTimes();
    if (!before || after.total === before.total) {
      await new Promise((resolve) => setTimeout(resolve, sampleMs));
      const second = cpuTimes();
      if (second && second.total > after.total) {
        before = after;
        after = second;
      }
    }
    if (after) previous = { at, ...after };
    const cpuPercent =
      before && after && after.total > before.total
        ? Math.max(0, Math.min(100, Math.round((1 - (after.idle - before.idle) / (after.total - before.total)) * 100)))
        : null;

    const memory = parseMemInfo(read("/proc/meminfo"));
    const disk = diskUsage(statfs(diskPath));
    const load = parseLoadavg(read("/proc/loadavg"));
    const uptimeS = Number((read("/proc/uptime").split(" ")[0] || "")) || null;
    const rss = (read("/proc/self/status").match(/^VmRSS:\s+(\d+)\s+kB/m) || [])[1];
    // Since this server process last started (a restart or deploy), apart from the machine's uptime.
    const processUptimeS = Math.floor(processUptime());

    const value = {
      cpu: { percent: cpuPercent, cores },
      memory,
      disk,
      load,
      uptimeS,
      process: {
        rssBytes: rss ? Number(rss) * 1024 : null,
        uptimeS: Number.isFinite(processUptimeS) ? processUptimeS : null,
        startedAt: Number.isFinite(processUptimeS) ? new Date(at - processUptimeS * 1000).toISOString() : null,
      },
      at: new Date(at).toISOString(),
    };
    cached = { at, value };
    return value;
  }

  return sample;
}
