import { useCallback, useEffect, useState } from "react";
import { Dialog, Switch } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { Activity, ArrowRight, BookOpen, Bot, Check, ChevronDown, Copy, ExternalLink, KeyRound, Loader2, Plus, RefreshCw, Send, Trash2, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { HealthPanel } from "./Health.jsx";
import { agentMeta } from "../brand.js";

const KIND_META = {
  telegram_bot: { label: "ربات تلگرام", icon: Send, tint: "text-sky-500 bg-sky-500/12", link: (u, code) => `https://t.me/${u}?start=${code}`, help: "در تلگرام از @BotFather یک ربات بساز و توکنش را اینجا بگذار." },
  bale_bot: { label: "ربات بله", icon: Bot, tint: "text-emerald-500 bg-emerald-500/12", link: (u, code) => `https://ble.ir/${u}?start=${code}`, help: "در بله از @botfather یک ربات بساز و توکنش را اینجا بگذار." },
  telegram_account: { label: "اکانت تلگرام", icon: UserRound, tint: "text-sky-500 bg-sky-500/12" },
};

const SETTINGS_NAV = [
  { id: "health", label: "سلامت مسیرها", icon: Activity },
  { id: "connections", label: "اتصال‌ها", icon: Send },
  { id: "knowledge", label: "دانش", icon: BookOpen },
];

export function SettingsPage({ onBack }) {
  const [section, setSection] = useState("health");
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => api("/api/integrations").then(setData, (e) => toast.error(e.message)), []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-56 shrink-0 flex-col border-e bg-card sm:flex">
        <div className="flex items-center gap-2 px-3 pb-3 pt-[max(env(safe-area-inset-top),0.75rem)]">
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label="بازگشت">
            <ArrowRight className="size-4" />
          </button>
          <h1 className="text-sm font-semibold">تنظیمات</h1>
        </div>
        <nav className="space-y-1 px-2">
          {SETTINGS_NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              aria-current={section === id ? "page" : undefined}
              className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm ${
                section === id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              }`}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 sm:px-6">
          <div className="mb-5 flex items-center gap-2 sm:hidden">
            <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label="بازگشت">
              <ArrowRight className="size-4" />
            </button>
            <h1 className="text-lg font-semibold">تنظیمات</h1>
          </div>

          <div className="mb-5 flex gap-1 rounded-xl bg-muted p-1 sm:hidden">
            {SETTINGS_NAV.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                className={`flex-1 rounded-lg px-3 py-2 text-sm ${section === id ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>

          {section === "health" ? (
            <HealthPanel variant="page" />
          ) : section === "knowledge" ? (
            <KnowledgePanel />
          ) : (
            <>
              <div className="mb-5 flex items-center gap-2">
                <h2 className="text-lg font-semibold">اتصال‌ها</h2>
                <button type="button" onClick={() => setAdding(true)} className="press ms-auto flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:shadow">
                  <Plus className="size-4" /> اتصال جدید
                </button>
              </div>
              <p className="mb-5 text-sm leading-6 text-muted-foreground">
                از تلگرام یا بله با گریفین حرف بزن. ربات فقط با گفتگوهایی کار می‌کند که با کد اتصال وصل کرده‌ای.
              </p>

              {!data ? (
                <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
              ) : data.integrations.length === 0 ? (
                <button type="button" onClick={() => setAdding(true)} className="press flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed py-12 text-muted-foreground hover:border-primary/60 hover:text-foreground">
                  <Send className="size-6" />
                  هنوز اتصالی نداری — یک ربات تلگرام یا بله اضافه کن
                </button>
              ) : (
                <motion.ul layout className="space-y-3">
                  <AnimatePresence initial={false}>
                    {data.integrations.map((integration) => (
                      <motion.li key={integration.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}>
                        <IntegrationCard integration={integration} onChange={load} />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </motion.ul>
              )}
            </>
          )}
        </div>
        <AddDialog open={adding} onOpenChange={setAdding} onAdded={load} />
      </div>
    </div>
  );
}

function StatusDot({ status, enabled }) {
  const state = !enabled ? "disabled" : status?.state;
  const map = {
    polling: ["bg-ok", "وصل"],
    starting: ["bg-warn animate-pulse", "در حال اتصال"],
    error: ["bg-bad", "خطا"],
    unavailable: ["bg-warn", "اختلال دریافت"],
    stopped: ["bg-muted-foreground", "متوقف"],
    disabled: ["bg-muted-foreground/50", "غیرفعال"],
  };
  const [color, label] = map[state] || map.stopped;
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={status?.userMessage || status?.lastError || ""}>
      <span className={`size-2 rounded-full ${color}`} /> {label}
    </span>
  );
}

function IntegrationCard({ integration, onChange }) {
  const meta = KIND_META[integration.kind] || { label: integration.kind, icon: Bot, tint: "bg-muted" };
  const Icon = meta.icon;
  const [busy, setBusy] = useState(false);
  const patch = async (body) => {
    setBusy(true);
    try {
      await api(`/api/integrations/${integration.id}`, { method: "PATCH", body });
      await onChange();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`«${integration.name}» حذف شود؟ گفتگوهای ساخته‌شده در گریفین می‌مانند.`)) return;
    await api(`/api/integrations/${integration.id}`, { method: "DELETE" }).catch((e) => toast.error(e.message));
    onChange();
  };
  const link = integration.username && integration.pairingCode && meta.link ? meta.link(integration.username, integration.pairingCode) : null;

  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <span className={`flex size-10 items-center justify-center rounded-xl ${meta.tint}`}><Icon className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" dir="auto">{integration.name}</p>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            {meta.label}
            {integration.username ? <span className="ltr">@{integration.username}</span> : null}
          </p>
        </div>
        <StatusDot status={integration.status} enabled={integration.enabled} />
        <Switch.Root
          checked={integration.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => patch({ enabled })}
          dir="ltr"
          className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors data-[state=checked]:bg-primary"
          aria-label="فعال"
        >
          <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.375rem]" />
        </Switch.Root>
      </div>

      {integration.status?.userMessage ? (
        <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-xs text-foreground" dir="auto">{integration.status.userMessage}</p>
      ) : integration.status?.state === "error" && integration.status.lastError ? (
        <p className="ltr mt-3 rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad">{integration.status.lastError}</p>
      ) : null}

      <div className="mt-4 space-y-2 border-t pt-3 text-sm">
        {integration.paired.length ? (
          integration.paired.map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              <Check className="size-4 text-ok" />
              <span dir="auto">{p.name}</span>
              <button type="button" onClick={() => patch({ unpair: p.id })} className="press ms-auto rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-bad">قطع</button>
            </div>
          ))
        ) : (
          <p className="text-muted-foreground">هنوز گفتگویی وصل نشده.</p>
        )}

        {integration.pairingCode ? (
          <div className="rounded-xl bg-muted/60 p-3">
            <p className="text-xs text-muted-foreground">برای وصل کردن، در ربات بفرست:</p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="ltr rounded-md bg-background px-2 py-1 font-mono text-sm tracking-wider">/start {integration.pairingCode}</code>
              <CopyButton text={`/start ${integration.pairingCode}`} />
              {link ? (
                <a href={link} target="_blank" rel="noreferrer" className="press ms-auto flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
                  باز کردن ربات <ExternalLink className="size-3" />
                </a>
              ) : null}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">کد یک‌بار مصرف است.</p>
          </div>
        ) : (
          <button type="button" onClick={() => patch({ newPairingCode: true })} className="press flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <RefreshCw className="size-3.5" /> کد اتصال برای یک دستگاه دیگر
          </button>
        )}
      </div>

      <div className="mt-3 flex justify-end">
        <button type="button" onClick={remove} className="press flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-bad/10 hover:text-bad">
          <Trash2 className="size-3.5" /> حذف
        </button>
      </div>
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})}
      className="press flex size-7 items-center justify-center rounded-md hover:bg-background"
      aria-label="کپی"
    >
      {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

// Owner's own Telegram account: api credentials from my.telegram.org, then the code Telegram sends,
// then the two-step password if the account has one. Values go straight to the server and Telegram.
function AccountLogin({ onDone }) {
  const [step, setStep] = useState("phone");
  const [form, setForm] = useState({ apiId: "", apiHash: "", phone: "", code: "", password: "" });
  const [loginId, setLoginId] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (step === "phone") {
        const r = await api("/api/integrations/telegram-account/login", { method: "POST", body: { apiId: form.apiId.trim(), apiHash: form.apiHash.trim(), phone: form.phone.trim() } });
        setLoginId(r.loginId);
        setStep("code");
        toast(r.viaApp ? "کد به اپ تلگرامت فرستاده شد" : "کد با پیامک فرستاده شد");
      } else {
        const body = step === "code" ? { code: form.code.trim() } : { password: form.password };
        const r = await api(`/api/integrations/telegram-account/login/${loginId}`, { method: "POST", body });
        if (r.needPassword) {
          setStep("password");
        } else {
          setForm({ apiId: "", apiHash: "", phone: "", code: "", password: "" });
          toast.success("اکانت تلگرام وصل شد");
          onDone();
        }
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary";
  return (
    <form onSubmit={submit} className="space-y-3">
      <ol className="flex items-center gap-2 text-xs text-muted-foreground">
        {[["phone", "شماره"], ["code", "کد"], ["password", "رمز دوم"]].map(([key, label], i) => (
          <li key={key} className={`flex items-center gap-1 ${step === key ? "font-medium text-foreground" : ""}`}>
            <span className={`flex size-5 items-center justify-center rounded-full text-[10px] ${step === key ? "bg-primary text-primary-foreground" : "bg-muted"}`}>{i + 1}</span>{label}
          </li>
        ))}
      </ol>
      {step === "phone" ? (
        <>
          <p className="text-xs leading-5 text-muted-foreground">
            در <a className="text-primary underline" href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">my.telegram.org/apps</a> یک app بساز و api_id و api_hash را اینجا بگذار.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <input value={form.apiId} onChange={set("apiId")} required inputMode="numeric" placeholder="api_id" className={`ltr col-span-1 font-mono ${input}`} />
            <input value={form.apiHash} onChange={set("apiHash")} required autoComplete="off" spellCheck={false} placeholder="api_hash" className={`ltr col-span-2 font-mono ${input}`} />
          </div>
          <input value={form.phone} onChange={set("phone")} required inputMode="tel" placeholder="+98912…" className={`ltr font-mono ${input}`} />
        </>
      ) : step === "code" ? (
        <input value={form.code} onChange={set("code")} required autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder="کد ورود" className={`ltr text-center font-mono text-lg tracking-[0.4em] ${input}`} />
      ) : (
        <input value={form.password} onChange={set("password")} required autoFocus type="password" autoComplete="current-password" placeholder="رمز تأیید دومرحله‌ای" className={`ltr ${input}`} />
      )}
      <button type="submit" disabled={busy} className="press flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 font-medium text-primary-foreground disabled:opacity-50">
        {busy ? <Loader2 className="size-4 animate-spin" /> : null} {step === "phone" ? "ارسال کد" : "ورود"}
      </button>
      <p className="text-center text-xs leading-5 text-muted-foreground">
        گریفین با این اکانت گروه‌ها و کانال‌ها را می‌خواند، در Saved Messages با تو گفتگو می‌کند و فقط بعد از تأیید تو از طرفت پیام می‌فرستد.
      </p>
    </form>
  );
}

function AddDialog({ open, onOpenChange, onAdded }) {
  const [kind, setKind] = useState("telegram_bot");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/api/integrations", { method: "POST", body: { kind, token: token.trim(), name: name.trim() } });
      toast.success("ربات اضافه شد؛ حالا با کد اتصال وصلش کن");
      setToken("");
      setName("");
      onOpenChange(false);
      onAdded();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_150ms]" />
        <Dialog.Content className="pop fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-card p-5 shadow-2xl">
          <div className="mb-4 flex items-center">
            <Dialog.Title className="font-semibold">اتصال جدید</Dialog.Title>
            <Dialog.Close className="press ms-auto rounded-full p-1.5 hover:bg-muted" aria-label="بستن"><X className="size-4" /></Dialog.Close>
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {["telegram_bot", "bale_bot", "telegram_account"].map((k) => {
                const meta = KIND_META[k];
                const Icon = meta.icon;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`press flex flex-col items-center gap-1.5 rounded-xl border p-3 text-xs ${kind === k ? "border-primary bg-primary/8 ring-1 ring-primary" : "hover:bg-muted"}`}
                  >
                    <span className={`flex size-8 items-center justify-center rounded-lg ${meta.tint}`}><Icon className="size-4" /></span>
                    {meta.label}
                  </button>
                );
              })}
            </div>
            {kind === "telegram_account" ? <AccountLogin onDone={() => { onOpenChange(false); onAdded(); }} /> : <form onSubmit={submit} className="space-y-4">
            <p className="text-xs leading-5 text-muted-foreground">{KIND_META[kind].help}</p>
            <label className="block">
              <span className="mb-1 flex items-center gap-1 text-xs text-muted-foreground"><KeyRound className="size-3.5" /> توکن ربات</span>
              <input value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" spellCheck={false} placeholder="123456789:AA…" className="ltr w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">نام (اختیاری)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="گریفین من" className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary" />
            </label>
            <button type="submit" disabled={busy || !token.trim()} className="press flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 font-medium text-primary-foreground disabled:opacity-50">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} افزودن
            </button>
            <p className="text-center text-xs text-muted-foreground">توکن فقط روی سرور گریفین می‌ماند و دیگر نمایش داده نمی‌شود.</p>
            </form>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Knowledge review gate: notes agents write (knowledge_write) land here unreviewed; only
// reviewed:true notes are injected into that agent's rules. Flipping is owner-only (API).
function KnowledgePanel() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => api("/api/knowledge").then(setData, (e) => toast.error(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);

  const flip = async (agent, file, reviewed) => {
    setBusy(`${agent}/${file}`);
    try {
      await api(`/api/knowledge/${agent}/review`, { method: "POST", body: { file, reviewed } });
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  const entries = Object.entries(data.agents || {});
  if (!entries.length) {
    return (
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">دانش ایجنت‌ها</h2>
        <p className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          هنوز یادداشتی نیست. ایجنت‌ها با knowledge_write یادداشت می‌نویسند؛ بعدش اینجا تأییدش می‌کنی تا به قواعدشان تزریق شود.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">دانش ایجنت‌ها</h2>
      <p className="mb-4 text-sm leading-6 text-muted-foreground">
        فقط یادداشت‌های «تأییدشده» به قواعد همان ایجنت تزریق می‌شوند و برایش معتبرند؛ بقیه هیچ اثری ندارند.
      </p>
      {entries.map(([agent, notes]) => (
        <div key={agent} className="rounded-2xl border bg-card">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <span className="text-sm font-medium">{agentMeta(agent).label}</span>
            <span className="ltr text-xs text-muted-foreground">{agent}</span>
            <span className="ms-auto text-xs text-muted-foreground">{notes.length} یادداشت</span>
          </div>
          <ul className="divide-y">
            {notes.map((note) => {
              const key = `${agent}/${note.file}`;
              const expanded = open === key;
              return (
                <li key={key} className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setOpen(expanded ? null : key)} className="flex min-w-0 flex-1 items-center gap-2 text-start">
                      <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
                      <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{note.title}</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy === key}
                      onClick={() => flip(agent, note.file, !note.reviewed)}
                      className={`press inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                        note.reviewed ? "border-ok/40 text-ok" : "border-warn/40 text-warn hover:bg-muted"
                      }`}
                    >
                      {busy === key ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                      {note.reviewed ? "تأییدشده" : "تأیید"}
                    </button>
                  </div>
                  {expanded ? (
                    <div className="mt-2 space-y-1">
                      <p className="ltr text-[11px] text-muted-foreground">{note.file}{note.expires ? ` · انقضا: ${note.expires}` : ""}{note.at ? ` · ${note.at}` : ""}</p>
                      <pre className="scrollbar-thin max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs leading-5" dir="auto">{note.body}</pre>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
