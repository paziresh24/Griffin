import net from "node:net";

// Cheap reachability check for every cluster path, without credentials:
// any HTTP answer from the public API counts as reachable; the emergency path is a TCP connect.
export function createProbe({ clusters, kube, timeoutMs = 5_000, ttlMs = 30_000 }) {
  let cache = { at: 0, value: null, pending: null };

  // A real authenticated read, so "ok" means the broker can use the API — not just that the
  // gateway answered (it answers 302 to login when the credential is rejected).
  async function apiCheck(name) {
    const started = Date.now();
    try {
      await kube.publicRequest(name, "/api/v1/namespaces?limit=1");
      return { ok: true, ms: Date.now() - started };
    } catch (error) {
      const message = error?.name === "TimeoutError" ? "timeout" : String(error?.cause?.code || error?.message || error);
      return { ok: false, error: message, ms: Date.now() - started };
    }
  }

  function tcp({ host, port }) {
    const started = Date.now();
    return new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (result) => {
        socket.destroy();
        resolve({ ...result, ms: Date.now() - started });
      };
      socket.setTimeout(timeoutMs, () => done({ ok: false, error: "timeout" }));
      socket.once("connect", () => done({ ok: true }));
      socket.once("error", (error) => done({ ok: false, error: error.code || error.message }));
    });
  }

  async function run() {
    const entries = await Promise.all(
      Object.entries(clusters).map(async ([name, config]) => {
        const [api, emergency] = await Promise.all([
          apiCheck(name),
          config.emergency ? tcp(config.emergency) : Promise.resolve(null),
        ]);
        return [name, { api, emergency }];
      }),
    );
    return { at: new Date().toISOString(), clusters: Object.fromEntries(entries) };
  }

  return async function probe() {
    if (cache.value && Date.now() - cache.at < ttlMs) return cache.value;
    cache.pending ||= run().then((value) => {
      cache = { at: Date.now(), value, pending: null };
      return value;
    });
    return cache.pending;
  };
}
