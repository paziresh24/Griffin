// Adaptive AIMD (Additive Increase / Multiplicative Decrease) concurrency and pacing
// limiter for upstream LLM providers. No fixed rate ceiling:
// - Starts open (initialLimit) and grows its concurrency window smoothly on 200s
//   whenever the window is actually utilized, up to maxLimit.
// - On 429 (rate limit), halves concurrency immediately, raises an adaptive
//   inter-request pace (or honors server Retry-After), and pauses ALL waiters on
//   the same provider through a shared cooldown gate instead of letting concurrent
//   chats stampede the API in independent retry loops.

function abortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

export function sleepAbortable(ms, signal) {
  const delay = Math.max(0, Number(ms) || 0);
  if (signal?.aborted) return Promise.reject(abortError());
  if (delay === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createAdaptiveLimiter({
  initialLimit = 4,
  minLimit = 1,
  maxLimit = 16,
  basePaceMs = 1_000,
  maxPaceMs = 30_000,
  maxCooldownMs = 60_000,
  jitterRatio = 0.25,
  now = () => Date.now(),
  random = () => Math.random(),
} = {}) {
  const floorMin = Math.max(1, Math.floor(minLimit));
  const ceilMax = Math.max(floorMin, Math.floor(maxLimit));
  const start = Math.min(ceilMax, Math.max(floorMin, initialLimit));

  let limit = start;
  let inFlight = 0;
  let paceMs = 0;
  let streak429 = 0;
  let cooldownUntil = 0;
  let nextLaunchAt = 0;
  const queue = [];
  let wakeTimer = null;

  function clearWake() {
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
  }

  function scheduleWake(delayMs) {
    clearWake();
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      pump();
    }, Math.max(1, Math.ceil(delayMs)));
    wakeTimer.unref?.();
  }

  function pump() {
    while (queue.length > 0) {
      const cap = Math.max(floorMin, Math.floor(limit));
      if (inFlight >= cap) return;
      const t = now();
      const gate = Math.max(cooldownUntil, nextLaunchAt);
      if (gate > t) {
        scheduleWake(gate - t);
        return;
      }
      const waiter = queue.shift();
      waiter.cleanup();
      inFlight += 1;
      const used = inFlight;
      if (paceMs > 0) nextLaunchAt = t + paceMs;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        inFlight = Math.max(0, inFlight - 1);
        pump();
      };
      waiter.resolve({ release, used });
    }
    if (queue.length === 0) clearWake();
  }

  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        cleanup: () => {},
      };
      if (signal) {
        const onAbort = () => {
          const idx = queue.indexOf(waiter);
          if (idx >= 0) queue.splice(idx, 1);
          if (queue.length === 0) clearWake();
          reject(abortError());
        };
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
      }
      queue.push(waiter);
      pump();
    });
  }

  function onSuccess(used = 1) {
    streak429 = 0;
    paceMs = paceMs >= 200 ? Math.floor(paceMs / 2) : 0;
    const cap = Math.max(floorMin, Math.floor(limit));
    // Gentle AIMD probe: requires 4 * cap clean responses while utilizing the window to add +1 slot,
    // so after a 429 the window settles at the upstream's real capacity instead of oscillating.
    if (used >= cap) {
      limit = Math.min(ceilMax, limit + 1 / (cap * 4));
    }
    pump();
  }

  function onRateLimit(retryAfterMs = 0) {
    streak429 += 1;
    limit = Math.max(floorMin, Math.floor(limit / 2));
    const explicit = Number.isFinite(retryAfterMs) && retryAfterMs > 0;
    let delay;
    if (explicit) {
      delay = Math.min(Math.round(retryAfterMs), maxCooldownMs);
      paceMs = Math.min(delay, maxPaceMs);
    } else {
      paceMs = Math.min(basePaceMs * 2 ** (streak429 - 1), maxPaceMs);
      delay = paceMs;
    }
    const jitter = explicit ? 0 : Math.round(delay * jitterRatio * Math.max(0, Math.min(1, random())));
    const totalWait = Math.min(delay + jitter, maxCooldownMs);
    const until = now() + totalWait;
    if (until > cooldownUntil) cooldownUntil = until;
    if (queue.length > 0) pump();
    return totalWait;
  }

  function snapshot() {
    return {
      limit: Math.max(floorMin, Math.floor(limit)),
      rawLimit: Number(limit.toFixed(2)),
      inFlight,
      queued: queue.length,
      paceMs,
      cooldownMs: Math.max(0, cooldownUntil - now()),
      streak429,
    };
  }

  return { acquire, onSuccess, onRateLimit, snapshot };
}
