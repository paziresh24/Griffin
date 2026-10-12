import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Bot, Check, Copy, Cpu, Globe, Loader2, Plug, Send, Sparkles, Stethoscope, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { BRAND } from "../brand.js";
import { ClaudeSignin } from "./Providers.jsx";

// Setup wizards: first run (engine → name → messenger), and each piece on its own from Settings or
// from a doctor finding. #/setup/<flow>. Every step tests what it saved for real before moving on.

export const FLOWS = {
  first: { title: t("راه‌اندازی"), steps: ["welcome", "engine", "name", "telegram", "done"] },
  engine: { title: t("موتور هوش مصنوعی"), steps: ["engine", "done"] },
  proxy: { title: t("پراکسی خروجی"), steps: ["proxy", "done"] },
  name: { title: t("نام دستیار"), steps: ["name", "done"] },
  telegram: { title: t("ربات تلگرام یا بله"), steps: ["telegram", "done"] },
  mcp: { title: t("اتصال یک ایجنت دیگر (MCP)"), steps: ["mcp", "done"] },
};

export function setupFlowFromHash(hash = window.location.hash) {
  const m = /^#\/setup(?:\/(\w+))?$/.exec(hash);
  return m ? (FLOWS[m[1]] ? m[1] : "first") : null;
}

const ENGINES = [
  { id: "claude-sub", provider: "claude", label: t("Claude — اشتراک Pro/Max"), hint: t("با اکانت Claude وارد شو؛ {name} توکن بلندمدت را خودش می‌گیرد و نگه می‌دارد.", { name: BRAND.name }), placeholder: "sk-ant-oat…" },
  { id: "claude-api", provider: "claude", label: t("Claude — کلید API"), hint: t("از console.anthropic.com → API keys."), placeholder: "sk-ant-api…" },
  { id: "openai", provider: "openai", preset: "openai", label: "OpenAI", hint: t("از platform.openai.com → API keys."), placeholder: "sk-…", model: "gpt-4o-mini" },
  { id: "openrouter", provider: "openai", preset: "openrouter", label: "OpenRouter", hint: t("یک کلید برای صدها مدل؛ مدل را مثل provider/model بنویس."), placeholder: "sk-or-…", model: "" },
  { id: "ollama", provider: "openai", preset: "ollama", label: t("Ollama (روی همین سیستم)"), hint: t("بدون کلید. در Docker با --add-host=host.docker.internal:host-gateway اجرا کن."), noKey: true, model: "llama3.1" },
  { id: "custom", provider: "openai", label: t("سرویس سازگار با OpenAI"), hint: t("هر endpoint با /chat/completions (Z.ai، vLLM، LM Studio، …)."), placeholder: t("کلید"), model: "", custom: true },
  { id: "cursor", provider: "cursor", label: "Cursor", hint: t("از cursor.com → Settings → API keys."), placeholder: "key_…" },
];

const CAUSE = {
  no_key: t("کلیدی ذخیره نشد."),
  bad_key: t("کلید رد شد — دوباره کپی کن (بدون فاصله). توکن اشتراک Claude با sk-ant-oat شروع می‌شود و باید گزینهٔ «اشتراک» را بزنی."),
  region: t("این سرویس از IP این سرور جواب نمی‌دهد (محدودیت کشور). یک پراکسی خروجی تنظیم کن و دوباره تست کن."),
  network: t("سرور به این سرویس نمی‌رسد (DNS/فیلتر/فایروال). پراکسی خروجی یا آدرس را چک کن."),
  quota: t("کلید درست است ولی اعتبار/سهمیه‌اش تمام شده."),
  model: t("مدل یا آدرس پیدا نشد — نام مدل را دقیق بنویس."),
  forbidden: t("دسترسی رد شد (۴۰۳)."),
  other: t("خطای ناشناخته — جزئیات پایین است."),
};

// A server title with {vars} (doctor checks): the title and every string var go through t(),
// since vars can be server-side Persian too (a cause, an agent label).
export const tr = (text, vars) => t(text, vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "string" ? t(v) : v])));

const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm";
const primary = "press inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60";

export function SetupPage({ flow = "first", onClose }) {
  const steps = FLOWS[flow].steps;
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const next = () => setIndex((i) => Math.min(i + 1, steps.length - 1));
  const finish = async () => {
    if (flow === "first") await api("/api/setup/done", { method: "POST" }).catch(() => {});
    onClose();
  };

  return (
    <div className="flex h-dvh flex-col overflow-y-auto bg-background">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Wand2 className="size-5 text-primary" />
        <h1 className="text-base font-semibold">{FLOWS[flow].title}</h1>
        <span className="text-xs text-muted-foreground">{index + 1} / {steps.length}</span>
        <button type="button" onClick={finish} className="press ms-auto rounded-lg p-1.5 text-muted-foreground hover:bg-muted" aria-label={t("بستن")}><X className="size-5" /></button>
      </header>
      <div className="h-1 bg-muted"><div className="h-1 bg-primary transition-all" style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></div>
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-8">
        {step === "welcome" ? <Welcome onNext={next} /> : null}
        {step === "engine" ? <EngineStep onNext={next} moveDefault={flow === "first"} /> : null}
        {step === "proxy" ? <ProxyStep onSaved={next} /> : null}
        {step === "name" ? <NameStep onNext={next} /> : null}
        {step === "telegram" ? <TelegramStep onNext={next} optional={flow === "first"} /> : null}
        {step === "mcp" ? <McpStep onNext={next} /> : null}
        {step === "done" ? <Done onClose={finish} /> : null}
        {index > 0 && step !== "done" ? (
          <button type="button" onClick={() => setIndex((i) => i - 1)} className="press mt-6 inline-flex items-center gap-1 text-sm text-muted-foreground">
            <ArrowRight className="size-4 rtl:rotate-0 ltr:rotate-180" /> {t("قبلی")}
          </button>
        ) : null}
      </main>
    </div>
  );
}

function Welcome({ onNext }) {
  return (
    <div className="space-y-4">
      <Sparkles className="size-8 text-primary" />
      <h2 className="text-xl font-semibold">{t("خوش آمدی")}</h2>
      <p className="text-sm leading-7 text-muted-foreground">
        {t("سه قدم کوتاه: یک موتور هوش مصنوعی (کلید)، یک اسم برای دستیار، و اگر خواستی یک ربات تلگرام. هر قدم همان لحظه واقعی تست می‌شود؛ بعداً هم از تنظیمات → سلامت هر کدام را دوباره باز کن.")}
      </p>
      <button type="button" onClick={onNext} className={primary}>{t("شروع")} <ArrowLeft className="size-4 ltr:rotate-180" /></button>
    </div>
  );
}

function EngineStep({ onNext, moveDefault }) {
  const [choice, setChoice] = useState(null);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const engine = ENGINES.find((e) => e.id === choice);

  const pick = (e) => {
    setChoice(e.id);
    setModel(e.model ?? "");
    setResult(null);
  };

  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      const body = {};
      const apiKey = key.trim() || (engine.noKey ? "ollama" : "");
      if (apiKey) body.apiKey = apiKey;
      if (engine.preset) body.preset = engine.preset;
      if (engine.custom) body.baseUrl = baseUrl.trim();
      if (engine.provider === "openai" && model.trim()) body.model = model.trim();
      await api(`/api/providers/${engine.provider}`, { method: "PATCH", body });
      await verify();
    } catch (e) {
      setResult({ ok: false, cause: "other", detail: e.message });
    }
    setBusy(false);
  };

  // After a key or a browser sign-in: test it for real, then put the default agent on it.
  const verify = async () => {
    const r = await api(`/api/doctor/engine/${engine.provider}`);
    setResult(r);
    if (r.ok) {
      if (moveDefault) await api("/api/agents/griffin", { method: "PATCH", body: { provider: engine.provider } }).catch(() => {});
      await api("/api/doctor/heal", { method: "POST" }).catch(() => {});
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Cpu className="size-5" /> {t("موتور هوش مصنوعی")}</h2>
      <p className="text-sm text-muted-foreground">{t("ایجنت‌ها با این جواب می‌دهند. کلید رمزنگاری‌شده در سکرت‌منیجر همین سرور می‌ماند.")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {ENGINES.map((e) => (
          <button key={e.id} type="button" onClick={() => pick(e)} className={`press rounded-xl border p-3 text-start text-sm ${choice === e.id ? "border-primary bg-primary/10" : "hover:bg-muted/50"}`}>
            {e.label}
          </button>
        ))}
      </div>
      {engine ? (
        <div className="space-y-3 rounded-2xl border bg-card p-4">
          <p className="text-xs leading-6 text-muted-foreground" dir="auto">{engine.hint}</p>
          {engine.id === "claude-sub" ? <ClaudeSignin id="claude" onDone={() => verify().catch((e) => setResult({ ok: false, cause: "other", detail: e.message }))} /> : null}
          {engine.id === "claude-sub" ? <p className="text-xs text-muted-foreground">{t("یا اگر توکن را از قبل داری:")}</p> : null}
          {engine.custom ? <input className={field} dir="ltr" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" /> : null}
          {engine.noKey ? null : <input className={field} dir="ltr" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={engine.placeholder} />}
          {engine.provider === "openai" ? <input className={field} dir="ltr" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model" /> : null}
          <button type="button" onClick={test} disabled={busy || (!engine.noKey && !key.trim()) || (engine.custom && !baseUrl.trim())} className={primary}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Stethoscope className="size-4" />} {t("ذخیره و تست")}
          </button>
          {result ? <ProbeResult result={result} /> : null}
          {result && !result.ok && (result.cause === "region" || result.cause === "network") ? <ProxyStep onSaved={test} inline /> : null}
        </div>
      ) : null}
      {result?.ok ? <button type="button" onClick={onNext} className={primary}>{t("بعدی")} <ArrowLeft className="size-4 ltr:rotate-180" /></button> : null}
    </div>
  );
}

export function ProbeResult({ result }) {
  if (result.ok) return <p className="flex items-center gap-2 text-sm text-ok"><Check className="size-4" /> {result.busy ? t("کلید درست است (سرویس الان شلوغ است)") : t("جواب داد")}{result.ms ? ` (${result.ms}ms)` : ""}.</p>;
  return (
    <div className="space-y-1 rounded-lg bg-bad/10 p-3 text-sm">
      <p className="text-bad">{CAUSE[result.cause] || CAUSE.other}</p>
      {result.detail ? <p className="break-all font-mono text-xs text-muted-foreground" dir="ltr">{String(result.detail).slice(0, 300)}</p> : null}
    </div>
  );
}

function ProxyStep({ onSaved, inline = false }) {
  const [url, setUrl] = useState("");
  const [state, setState] = useState(null);
  useEffect(() => {
    api("/api/setup/proxy").then((r) => { setUrl(r.url || ""); setState(r.fromEnv ? "env" : null); }).catch(() => {});
  }, []);
  const save = async () => {
    try {
      await api("/api/setup/proxy", { method: "POST", body: { url: url.trim() } });
      toast.success(t("پراکسی ذخیره شد"));
      onSaved?.();
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <div className={inline ? "space-y-2 border-t pt-3" : "space-y-4"}>
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Globe className="size-4" /> {t("پراکسی خروجی")}</h3>
      <p className="text-xs leading-6 text-muted-foreground">
        {t("فقط ترافیک بیرونی (موتورها) از آن می‌رود؛ مثل {example} (Xray/V2Ray با inbound نوع HTTP).", { example: "http://127.0.0.1:8118" })}
      </p>
      {state === "env" ? (
        <p className="text-xs text-muted-foreground">{t("پراکسی از متغیر محیطی (HTTPS_PROXY / CURSOR_PROXY) آمده؛ همان‌جا عوضش کن.")}</p>
      ) : (
        <div className="flex gap-2">
          <input className={field} dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://host:port" />
          <button type="button" onClick={save} className={primary}>{t("ذخیره")}</button>
        </div>
      )}
    </div>
  );
}

function NameStep({ onNext }) {
  const [name, setName] = useState("");
  const [latin, setLatin] = useState("");
  const [fromEnv, setFromEnv] = useState(false);
  useEffect(() => {
    api("/api/setup").then((r) => { setName(r.persona?.name || ""); setLatin(r.persona?.latin || ""); setFromEnv(r.personaFromEnv); }).catch(() => {});
  }, []);
  const save = async () => {
    try {
      const r = await api("/api/setup/persona", { method: "POST", body: { name, latin } });
      if (r.restart) toast.message(t("نام تازه بعد از ری‌استارت سرور روی همه‌جا می‌نشیند."));
      onNext();
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Bot className="size-5" /> {t("نام دستیار")}</h2>
      <p className="text-sm text-muted-foreground">{t("همکاران با این اسم صدایش می‌زنند و زیر پیام‌هایش امضا می‌شود. «گریفین» همچنان صدا می‌زند.")}</p>
      {fromEnv ? <p className="text-xs text-muted-foreground">{t("اسم از متغیر محیطی GRIFFIN_ASSISTANT_NAME آمده؛ آن بر این فرم مقدم است.")}</p> : null}
      <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("مثلاً اوریون")} />
      <input className={field} dir="ltr" value={latin} onChange={(e) => setLatin(e.target.value)} placeholder="Latin, e.g. Orion" />
      <div className="flex gap-2">
        <button type="button" onClick={save} disabled={!name.trim()} className={primary}>{t("ذخیره")}</button>
        <button type="button" onClick={onNext} className="press rounded-lg border px-4 py-2 text-sm">{t("همین بماند")}</button>
      </div>
    </div>
  );
}

function TelegramStep({ onNext, optional }) {
  const [kind, setKind] = useState("telegram_bot");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [bot, setBot] = useState(null);
  const add = async () => {
    setBusy(true);
    try {
      const r = await api("/api/integrations", { method: "POST", body: { kind, token: token.trim(), name: kind === "bale_bot" ? "Bale" : "Telegram" } });
      setBot(r.integration);
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
  };
  const link = bot?.username && bot?.pairingCode ? (kind === "bale_bot" ? `https://ble.ir/${bot.username}?start=${bot.pairingCode}` : `https://t.me/${bot.username}?start=${bot.pairingCode}`) : null;
  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Send className="size-5" /> {t("ربات پیام‌رسان")}</h2>
      <p className="text-sm leading-7 text-muted-foreground">{t("در تلگرام از ‎@BotFather (یا در بله از ‎@botfather) با /newbot یک ربات بساز و توکنش را اینجا بگذار. بعد لینک را باز کن تا ربات فقط مال تو شود.")}</p>
      {bot ? (
        <div className="space-y-2 rounded-2xl border bg-card p-4 text-sm">
          <p className="flex items-center gap-2 text-ok"><Check className="size-4" /> {t("ربات وصل شد")}{bot.username ? ` (@${bot.username})` : ""}.</p>
          {link ? <a href={link} target="_blank" rel="noreferrer" className="block break-all text-primary underline" dir="ltr">{link}</a> : null}
          <p className="text-xs text-muted-foreground">{t("بعد از زدن Start، هر پیامت به ربات یک چت با دستیار است.")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <select className={field} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="telegram_bot">{t("تلگرام")}</option>
            <option value="bale_bot">{t("بله")}</option>
          </select>
          <input className={field} dir="ltr" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456:ABC…" />
          <button type="button" onClick={add} disabled={busy || !token.trim()} className={primary}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />} {t("وصل کن")}</button>
        </div>
      )}
      <button type="button" onClick={onNext} className="press rounded-lg border px-4 py-2 text-sm">{bot ? t("بعدی") : optional ? t("فعلاً نه") : t("رد شدن")}</button>
    </div>
  );
}

function McpStep({ onNext }) {
  const [name, setName] = useState("");
  const [issued, setIssued] = useState(null);
  const [busy, setBusy] = useState(false);
  const issue = async () => {
    setBusy(true);
    try {
      const id = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
      const { user } = await api("/api/peers", { method: "POST", body: { id, label: name.trim() || id } });
      const client = await api(`/api/peers/${user.id}/clients`, { method: "POST", body: { label: "setup wizard" } });
      setIssued({ user, token: client.token });
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
  };
  const command = issued ? `claude mcp add --transport http griffin ${window.location.origin}/mcp --header "Authorization: Bearer ${issued.token}"` : "";
  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Plug className="size-5" /> {t("اتصال یک ایجنت دیگر")}</h2>
      <p className="text-sm leading-7 text-muted-foreground">{t("برای Claude Code یا هر کلاینت MCP یک توکن جدا می‌سازد. دسترسی‌اش پیش‌فرض فقط‌خواندنی است و از صفحهٔ «همتاها» قابل تغییر و ابطال است.")}</p>
      {issued ? (
        <div className="space-y-2 rounded-2xl border bg-card p-4">
          <p className="text-xs text-bad">{t("این توکن فقط همین یک بار نشان داده می‌شود.")}</p>
          <pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs" dir="ltr">{command}</pre>
          <button type="button" onClick={() => navigator.clipboard?.writeText(command).then(() => toast.success(t("کپی شد")))} className="press inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm"><Copy className="size-4" /> {t("کپی")}</button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("نام (مثلاً laptop-claude)")} />
          <button type="button" onClick={issue} disabled={busy} className={primary}>{busy ? <Loader2 className="size-4 animate-spin" /> : null} {t("ساخت توکن")}</button>
        </div>
      )}
      {issued ? <button type="button" onClick={onNext} className={primary}>{t("بعدی")}</button> : null}
    </div>
  );
}

function Done({ onClose }) {
  const [report, setReport] = useState(null);
  useEffect(() => {
    api("/api/doctor").then(setReport).catch(() => {});
  }, []);
  const bad = report?.checks?.filter((c) => c.level !== "ok") || [];
  return (
    <div className="space-y-4">
      <Check className="size-8 text-ok" />
      <h2 className="text-xl font-semibold">{t("آماده است")}</h2>
      {!report ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("چک نهایی…")}</p> : bad.length ? (
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">{t("چک نهایی چند مورد پیدا کرد (تنظیمات → سلامت):")}</p>
          {bad.map((c) => <p key={c.id} className={c.level === "error" ? "text-bad" : "text-amber-600"}>• {tr(c.title, c.vars)}</p>)}
        </div>
      ) : <p className="text-sm text-ok">{t("چک نهایی: همه‌چیز سالم است.")}</p>}
      <button type="button" onClick={onClose} className={primary}>{t("شروع گفتگو")}</button>
    </div>
  );
}

