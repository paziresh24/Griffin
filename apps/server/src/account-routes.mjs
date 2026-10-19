// Account / usage routes (Claude logins, short-named keys, plan limits, Z.ai) on Griffin's own
// engine accounts. Griffin keeps one model of accounts: the engine registry (providers/ids.mjs,
// kv "engines") with keys in the secret store (secrets.mjs "engine/<id>"). The short names map onto it:
//   Claude "main"            -> the base account "claude"; any other Claude login -> "claude-<x>"
//   key "zai"/"openrouter"/"custom" -> a claude-* account on that Anthropic-compatible endpoint
//                                      (claude-endpoint.mjs), made when none exists yet
//   key "cursor"             -> the base "cursor" account
// A Claude login here is Griffin's setup-token sign-in (claude-signin.mjs), not
// `claude auth login` into a config folder per account: Griffin keeps each account's token in the
// secret store. No response and no log line carries a key, token or pasted code.

const KEY_RE = /^[\x21-\x7e]{1,4096}$/;
const SHORT_KEYED = ["zai", "openrouter", "custom", "cursor"];

/** A short account id ("main", "work") or a Griffin one ("claude-work") -> the Griffin id. */
export function claudeAccountId(id) {
  const raw = String(id || "main").trim().toLowerCase();
  if (raw === "main" || raw === "claude") return "claude";
  if (/^claude-[a-z0-9]{1,24}$/.test(raw)) return raw;
  const slug = raw.replace(/[^a-z0-9]/g, "").slice(0, 24);
  return slug ? `claude-${slug}` : null;
}

/** Custom Anthropic-compatible endpoint settings (PUT /api/providers/custom/config). */
export function checkCustomEndpoint(body) {
  const baseUrl = String(body?.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(body?.model || "").trim().slice(0, 200);
  const smallModel = String(body?.smallModel || "").trim().slice(0, 200);
  const contextWindow = Number(body?.contextWindow) > 0 ? Math.floor(Number(body.contextWindow)) : null;
  if (baseUrl) {
    let u;
    try {
      u = new URL(baseUrl);
    } catch {
      return { error: "آدرس درست نیست؛ آدرس کامل سرویس را مثل https://api.example.com/anthropic بگذار." };
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return { error: "آدرس باید https باشد (http فقط روی همین سرور، localhost)." };
    if (u.username || u.password) return { error: "نام کاربری یا رمز را در آدرس نگذار؛ کلید را جدا ذخیره کن." };
  }
  return { config: { baseUrl, model, smallModel, ...(contextWindow ? { contextWindow } : {}) } };
}

const plain = (e) => String(e?.message || e).slice(0, 200);

/**
 * engines: the facade index.mjs builds over its account registry —
 *   claudeAccounts() -> [{id, label, hasKey}] (plain Claude logins, not endpoint accounts)
 *   addAccount(kind, {slug, label, endpoint, config}) -> id · removeAccount(id) · inUse(id)
 *   activeClaude() / setActiveClaude(id) · endpointAccount(endpoint) -> id|null
 *   setKey(id, key) · removeKey(id) · setConfig(id, patch)
 * signin: claude-signin.mjs (start/submit/cancel/available/pending).
 */
export function accountRoutes(api, { engines, signin, zaiAccount = null, zaiQuota = null, planLimits = null }) {
  // ---- Claude accounts (/api/providers/claude/accounts) ----
  const statusOf = (a) => ({
    available: Boolean(signin?.available()),
    loggedIn: a.hasKey,
    pending: Boolean(signin?.pending(a.id)),
    account: a.label || null,
    plan: null,
  });
  const listAccounts = () => {
    const active = engines.activeClaude();
    return {
      active,
      accounts: engines.claudeAccounts().map((a) => ({ id: a.id, main: a.id === "claude", active: a.id === active, label: a.label || "", ...statusOf(a) })),
    };
  };
  const known = (id) => engines.claudeAccounts().find((a) => a.id === id) || null;
  const noAccount = (c) => c.json({ error: "این حساب Claude پیدا نشد؛ فهرست حساب‌ها را دوباره باز کن." }, 404);

  api.get("/api/providers/claude/accounts", (c) => c.json(listAccounts()));
  api.post("/api/providers/claude/accounts", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = body?.id ? claudeAccountId(body.id) : null;
    if (body?.id && (!id || id === "claude")) return c.json({ error: "نام حساب فقط حروف انگلیسی کوچک و عدد باشد (مثلاً work)." }, 400);
    if (id && known(id)) return c.json({ error: "حسابی با این نام هست؛ نام دیگری بگذار." }, 409);
    const made = engines.addAccount("claude", { slug: id ? id.slice("claude-".length) : "", label: String(body?.label || "").slice(0, 40) });
    return c.json({ id: made, ...listAccounts() }, 201);
  });
  // New chats (that would run on the base Claude account) use this one first.
  api.put("/api/providers/claude/accounts/active", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = claudeAccountId(body?.id);
    if (!known(id)) return noAccount(c);
    engines.setActiveClaude(id);
    return c.json(listAccounts());
  });
  api.delete("/api/providers/claude/accounts/:id", (c) => {
    const id = claudeAccountId(c.req.param("id"));
    if (id === "claude") return c.json({ error: "حساب اصلی Claude حذف نمی‌شود؛ می‌توانی در «موتورها» خاموشش کنی." }, 400);
    if (!known(id)) return noAccount(c);
    if (engines.inUse(id)) return c.json({ error: "گفتگویی همین حالا روی این حساب کار می‌کند؛ صبر کن تمام شود و دوباره حذف کن." }, 409);
    if (signin?.pending(id)) signin.cancel();
    engines.removeAccount(id);
    return c.json(listAccounts());
  });

  // ---- Claude sign-in (/api/providers/claude/login?account=) ----
  const pick = (c) => {
    const id = claudeAccountId(c.req.query("account"));
    return known(id) ? id : null;
  };
  api.get("/api/providers/claude/login", (c) => {
    const id = pick(c);
    return id ? c.json(statusOf(known(id))) : noAccount(c);
  });
  api.post("/api/providers/claude/login/start", async (c) => {
    const id = pick(c);
    if (!id) return noAccount(c);
    if (!signin?.available()) return c.json({ error: "برنامهٔ Claude روی این سرور نصب نیست؛ به‌جای ورود، توکن یا کلید را در «موتورها» بگذار." }, 501);
    try {
      return c.json(await signin.start(id));
    } catch (e) {
      return c.json({ error: `صفحهٔ ورود Claude باز نشد (${plain(e)})؛ چند ثانیه بعد دوباره «ورود» را بزن.` }, 502);
    }
  });
  api.post("/api/providers/claude/login/code", async (c) => {
    const id = pick(c);
    if (!id) return noAccount(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      await signin.submit(id, typeof body?.code === "string" ? body.code.trim() : "");
    } catch (e) {
      if (e.restarted) return c.json({ ...statusOf(known(id)), restarted: true, url: e.restarted.url, error: "ورود قبلی تمام شده بود؛ ورود تازه شروع شد. از همین آدرس تازه وارد شو و کد تازه را بچسبان." }, 409);
      return c.json({ ...statusOf(known(id)), error: `کد پذیرفته نشد (${plain(e)})؛ «ورود» را از نو بزن و کد تازه را بچسبان.` }, 400);
    }
    return c.json(statusOf(known(id)));
  });
  api.delete("/api/providers/claude/login", (c) => {
    const id = pick(c);
    if (!id) return noAccount(c);
    if (signin?.pending(id)) signin.cancel();
    return c.json({ ok: true });
  });

  // ---- Keys (/api/providers/:id/key) ----
  const ENDPOINT_OF = { zai: "zai", openrouter: "openrouter", custom: "custom" };
  const target = (raw, create) => {
    if (raw === "cursor") return "cursor";
    if (ENDPOINT_OF[raw]) return engines.endpointAccount(ENDPOINT_OF[raw]) || (create ? engines.addAccount("claude", { slug: raw, endpoint: raw }) : null);
    return engines.isAccount(raw) ? raw : null;
  };
  api.put("/api/providers/:id/key", async (c) => {
    const raw = c.req.param("id");
    if (!SHORT_KEYED.includes(raw) && !engines.isAccount(raw)) return c.json({ error: "چنین موتوری نیست؛ از «موتورها» یکی را انتخاب کن." }, 400);
    const body = await c.req.json().catch(() => ({}));
    const key = String(body?.key ?? "").trim();
    if (!KEY_RE.test(key)) return c.json({ error: "کلید درست نیست؛ کلید را بدون فاصله و خط تازه دوباره بچسبان." }, 400);
    const id = target(raw, true);
    try {
      engines.setKey(id, key);
    } catch (e) {
      return c.json({ error: `کلید ذخیره نشد (${plain(e)}).` }, 400);
    }
    return c.json({ ok: true, id });
  });
  api.delete("/api/providers/:id/key", (c) => {
    const raw = c.req.param("id");
    const id = target(raw, false);
    if (!id) return c.json({ error: "برای این موتور کلیدی ذخیره نشده است." }, 404);
    engines.removeKey(id);
    return c.json({ ok: true, id });
  });
  // Custom Anthropic-compatible endpoint: base URL + main/small model (+ context window).
  api.put("/api/providers/custom/config", async (c) => {
    const checked = checkCustomEndpoint(await c.req.json().catch(() => ({})));
    if (checked.error) return c.json({ error: checked.error }, 400);
    const id = target("custom", true);
    engines.setConfig(id, checked.config);
    return c.json({ ok: true, id });
  });

  // ---- Plan limits and Z.ai (/api/usage/limits, /api/usage/zai, /api/auth/zai) ----
  api.get("/api/usage/limits", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(planLimits ? await planLimits() : { available: false, reason: "not configured" });
  });
  api.get("/api/usage/zai", async (c) => {
    c.header("cache-control", "no-store");
    const body = zaiQuota ? { ...(await zaiQuota()) } : { available: false, reason: "not configured" };
    body.resets = zaiAccount ? await zaiAccount.resetSummary() : { connected: false };
    return c.json(body);
  });
  const noZai = (c) => c.json({ error: "ورود Z.ai روی این نصب فعال نیست." }, 503);
  api.post("/api/usage/zai/reset", async (c) => {
    c.header("cache-control", "no-store");
    if (!zaiAccount) return noZai(c);
    const body = await c.req.json().catch(() => ({}));
    if (body?.resetType !== "FIVE_HOUR" && body?.resetType !== "WEEK") return c.json({ error: "invalid resetType" }, 400);
    let result;
    try {
      result = await zaiAccount.use({ resetType: body.resetType });
    } catch (e) {
      return c.json({ error: "reset_failed", detail: plain(e) }, 502);
    }
    if (result.error === "not_connected" || result.error === "no_reset_available") return c.json(result, 409);
    if (result.error) return c.json(result, 502);
    zaiQuota?.invalidate?.();
    return c.json(result);
  });
  api.post("/api/auth/zai/start", async (c) => {
    c.header("cache-control", "no-store");
    if (!zaiAccount) return noZai(c);
    try {
      return c.json(await zaiAccount.start());
    } catch (e) {
      return c.json({ error: `صفحهٔ ورود Z.ai باز نشد (${plain(e)})؛ چند ثانیه بعد دوباره بزن.` }, 502);
    }
  });
  api.get("/api/auth/zai/poll", async (c) => {
    c.header("cache-control", "no-store");
    if (!zaiAccount) return c.json({ status: "failed", error: "ورود Z.ai روی این نصب فعال نیست." });
    try {
      return c.json(await zaiAccount.poll());
    } catch (e) {
      return c.json({ status: "failed", error: plain(e) });
    }
  });
  api.get("/api/auth/zai", (c) => {
    c.header("cache-control", "no-store");
    return c.json(zaiAccount ? zaiAccount.connected() : { connected: false, name: null, email: null });
  });
  api.delete("/api/auth/zai", (c) => {
    zaiAccount?.cancelSignIn();
    zaiAccount?.signOut();
    return c.json({ ok: true });
  });
}
