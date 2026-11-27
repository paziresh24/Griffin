import net from "node:net";

// One account, one exit (owner 2026-11-25: five subscription Claude accounts were banned and every one
// of them had been used through Griffin; a rotating exit shared by every account and every install is
// the "coordinated activity" pattern an anti-fraud system reads as a farm, not a person).
//
// `proxyUrl` is an account's own fixed exit (socks5://… or http://…). When it is set the run gets ONLY
// that exit, and its clock is fixed to the same place, so the time zone agrees with the IP.
// An account with no proxyUrl behaves exactly as it always did — nothing here is forced on anyone.

/** The env of a run: this account's own exit and clock, or the install's path unchanged. */
export function accountEgressEnv(env, egress = null) {
  const out = { ...env };
  const url = String(egress?.proxyUrl || "").trim();
  if (url) {
    out.HTTPS_PROXY = url;
    out.HTTP_PROXY = url;
    out.https_proxy = url;
    out.http_proxy = url;
    // Node honours NO_PROXY over the proxy: an inherited "*" (or a vendor host) would leak the traffic
    // out unproxied, which is the one thing a pinned account must never do.
    out.NO_PROXY = "127.0.0.1,localhost,::1";
    out.no_proxy = out.NO_PROXY;
    out.NODE_USE_ENV_PROXY = "1";
  }
  const tz = String(egress?.timezone || "").trim();
  if (tz) out.TZ = tz;
  return out;
}

/** Default TCP reachability probe for a proxy; injected in tests. */
export function tcpConnect(host, port, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const done = (fn) => (err) => {
      socket.destroy();
      fn(err);
    };
    socket.setTimeout(timeoutMs, () => done(reject)(new Error("timeout")));
    socket.once("connect", () => done(resolve)());
    socket.once("error", done(reject));
  });
}

/**
 * A pinned account must never go out from the server's own address: when its exit is unreachable the
 * send fails with a clear reason instead of quietly falling back (a dropped proxy that silently falls
 * back to the Iranian IP is exactly what a banned account looked like).
 * `connect(host, port)` resolves for a reachable proxy; injected so a test needs no socket.
 */
export async function assertEgress(egress, { connect = tcpConnect, timeoutMs = 4_000 } = {}) {
  const url = String(egress?.proxyUrl || "").trim();
  if (!url) return { ok: true, via: "direct" };
  let host;
  let port;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port) || (u.protocol === "https:" ? 443 : u.protocol.startsWith("socks") ? 1080 : 80);
    if (!host) throw new Error("no host");
  } catch {
    return { ok: false, reason: "bad_proxy", error: `آدرس پروکسی نامعتبر است: ${url}` };
  }
  let verdict = "ok";
  let timer;
  try {
    await Promise.race([
      Promise.resolve(connect(host, port)).catch((e) => {
        verdict = e?.code || "refused";
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          verdict = "timeout";
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (verdict !== "ok") {
    return {
      ok: false,
      reason: "egress_down",
      error: `پروکسی این اکانت در دسترس نیست (${host}:${port}${verdict === "timeout" ? "، بی‌پاسخ" : ""}). برای اینکه درخواست از آی‌پی سرور بیرون نزند، ارسال متوقف شد.`,
    };
  }
  return { ok: true, via: url };
}
