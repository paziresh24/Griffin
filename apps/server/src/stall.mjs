// Where the server's one thread goes when it stops answering (owner 2026-11-07: a chat opened after
// 1–6 s on .46 while a 1 KB answer of the same moment waited as long — the loop was busy, not the
// network). Every stall over STALL_MS is logged with the requests in flight, and the owner can take
// a short CPU profile of the live process: GET /api/doctor/profile?ms= (index.mjs).
import { Session } from "node:inspector/promises";

const TICK_MS = 100;
const STALL_MS = 300;
const KEPT = 50;
const IDLE = new Set(["(idle)", "(program)", "(garbage collector)", "(root)"]);

const inflight = new Map();
const stalls = [];
let seq = 0;
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const lag = Math.round(now - last - TICK_MS);
  last = now;
  if (lag < STALL_MS) return;
  const busy = [...inflight.values()];
  stalls.push({ at: new Date().toISOString(), ms: lag, inflight: busy });
  if (stalls.length > KEPT) stalls.shift();
  console.error(`[stall] ${lag}ms; in flight: ${busy.join(", ") || "-"}`);
}, TICK_MS).unref();

export async function stallMiddleware(c, next) {
  const id = (seq += 1);
  inflight.set(id, `${c.req.method} ${c.req.path}`);
  try {
    await next();
  } finally {
    inflight.delete(id);
  }
}

export const recentStalls = () => [...stalls];

const frame = (node) => {
  const { functionName, url, lineNumber } = node.callFrame;
  return `${functionName || "(anonymous)"} ${url ? `${url.split("/").slice(-2).join("/")}:${lineNumber + 1}` : ""}`.trim();
};

/** Time per stack in a profile: the leaf frames and the nearest frame of our own code above them. */
export function summarize(profile, top = 40) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const child of n.children || []) parent.set(child, n.id);
  const self = new Map();
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + (profile.timeDeltas[i] || 0)));
  const total = new Map();
  for (const [id, us] of self) {
    const leaf = byId.get(id);
    let key = leaf.callFrame.functionName;
    if (!IDLE.has(key)) {
      const chain = [];
      let own = "";
      for (let cur = id; cur != null && !own; cur = parent.get(cur)) {
        const node = byId.get(cur);
        if (chain.length < 3) chain.push(frame(node));
        if (/\/(apps|packages|modules)\//.test(node.callFrame.url) && !/node_modules/.test(node.callFrame.url)) own = frame(node);
      }
      key = `${chain.join(" < ")}${own && !chain.includes(own) ? ` … ${own}` : ""}`;
    }
    total.set(key, (total.get(key) || 0) + us);
  }
  return [...total].sort((a, b) => b[1] - a[1]).slice(0, top).map(([stack, us]) => ({ ms: Math.round(us / 1000), stack }));
}

let profiling = null;
export async function cpuProfile(ms) {
  if (profiling) throw new Error("a profile is already running");
  const session = new Session();
  session.connect();
  profiling = session;
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 1000 });
    await session.post("Profiler.start");
    await new Promise((resolve) => setTimeout(resolve, ms));
    const { profile } = await session.post("Profiler.stop");
    return summarize(profile);
  } finally {
    session.disconnect();
    profiling = null;
  }
}
