import { useCallback, useEffect, useState } from "react";
import { Dialog, Switch } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { Activity, ArrowRight, BookOpen, Bot, Check, ChevronDown, Copy, ExternalLink, KeyRound, Loader2, LogOut, Plus, RefreshCw, Send, ShieldOff, Trash2, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { StatusSection, Pill } from "./Health.jsx";
import { Group, Item, SectionHeader } from "./SettingsParts.jsx";
import { agentMeta } from "../brand.js";

const KIND_META = {
  telegram_bot: { label: "ربات تلگرام", icon: Send, tint: "text-sky-500 bg-sky-500/12", link: (u, code) => `https://t.me/${u}?start=${code}`, help: "در تلگرام از @BotFather یک ربات بساز و توکنش را اینجا بگذار." },
  bale_bot: { label: "ربات بله", icon: Bot, tint: "text-emerald-500 bg-emerald-500/12", link: (u, code) => `https://ble.ir/${u}?start=${code}`, help: "در بله از @botfather یک ربات بساز و توکنش را اینجا بگذار." },
  telegram_account: { label: "اکانت تلگرام", icon: UserRound, tint: "text-sky-500 bg-sky-500/12" },
};

const SECTIONS = [
  { id: "status", label: "وضعیت", icon: Activity, title: "وضعیت", description: "مدل‌ها، کارگزار ابزارها، دریافت هشدار و مسیرهای کلاستر." },
  { id: "connections", label: "اتصال‌ها", icon: Send, title: "اتصال‌ها", description: "ربات‌ها و اکانت تلگرامی که گریفین از آن‌ها پیام می‌گیرد و جواب می‌دهد." },
  { id: "knowledge", label: "دانش", icon: BookOpen, title: "دانش ایجنت‌ها", description: "فقط یادداشت‌های تأییدشده به قواعد همان ایجنت اضافه می‌شوند؛ بقیه اثری ندارند." },
  { id: "account", label: "حساب", icon: KeyRound, title: "حساب", description: "نشست‌های ورود به گریفین." },
];

const readSection = () => {
  try {
    const saved = localStorage.getItem("griffin.settings.section");
    return SECTIONS.some((s) => s.id === saved) ? saved : "status";
  } catch {
    return "status";
  }
};

export function SettingsPage({ onBack }) {
  const [section, setSectionState] = useState(readSection);
  const setSection = (id) => {
    setSectionState(id);
    try { localStorage.setItem("griffin.settings.section", id); } catch { /* private mode */ }
  };
  const current = SECTIONS.find((s) => s.id === section);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <aside className="hidden w-60 shrink-0 flex-col border-e bg-card/50 sm:flex">
        <div className="flex items-center gap-2 px-4 pb-4 pt-[max(env(safe-area-inset-top),1rem)]">
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label="بازگشت">
            <ArrowRight className="size-4" />
          </button>
          <h1 className="font-semibold">تنظیمات</h1>
        </div>
        <nav className="space-y-0.5 px-3">
          {SECTIONS.map(({ id, label, icon: Icon }) => {
            const active = section === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={active ? "page" : undefined}
                className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                {active ? <motion.span layoutId="settings-nav" className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-primary" /> : null}
                <Icon className={`size-4 ${active ? "text-primary" : ""}`} />
                {label}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-[max(env(safe-area-inset-top),1rem)] sm:px-8 sm:pt-10">
          <div className="mb-4 flex items-center gap-2 sm:hidden">
            <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label="بازگشت">
              <ArrowRight className="size-4" />
            </button>
            <h1 className="font-semibold">تنظیمات</h1>
          </div>
          <div className="scrollbar-none -mx-4 mb-6 flex gap-1.5 overflow-x-auto px-4 sm:hidden">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                className={`press flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${
                  section === id ? "border-primary/40 bg-primary/10 font-medium text-foreground" : "text-muted-foreground"
                }`}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>

          <motion.div key={section} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
            {section === "connections" ? (
              <ConnectionsSection meta={current} />
            ) : (
              <>
                <SectionHeader title={current.title} description={current.description} />
                {section === "status" ? <StatusSection /> : section === "knowledge" ? <KnowledgeSection /> : <AccountSection />}
              </>
            )}
          </motion.div>
        </div>
      </div>
    </div>
  );
}

function ConnectionsSection({ meta }) {
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api("/api/integrations").then(setData, (e) => toast.error(e.message)), []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <>
      <SectionHeader
        title={meta.title}
        description={meta.description}
        action={
          <button type="button" onClick={() => setAdding(true)} className="press flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm">
            <Plus className="size-4" /> اتصال جدید
          </button>
        }
      />
      {!data ? (
        <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : data.integrations.length === 0 ? (
        <button type="button" onClick={() => setAdding(true)} className="press flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed py-12 text-sm text-muted-foreground hover:border-primary/60 hover:text-foreground">
          <Send className="size-6" />
          هنوز اتصالی نیست — ربات تلگرام/بله یا اکانت تلگرام اضافه کن
        </button>
      ) : (
        <Group>
          {data.integrations.map((integration) => (
            <IntegrationRow key={integration.id} integration={integration} onChange={load} />
          ))}
        </Group>
      )}
      <AddDialog open={adding} onOpenChange={setAdding} onAdded={load} />
    </>
  );
}

const STATUS = {
  polling: ["ok", "وصل"],
  starting: ["warn", "در حال اتصال"],
  error: ["bad", "خطا"],
  unavailable: ["warn", "اختلال دریافت"],
  stopped: ["none", "متوقف"],
  disabled: ["none", "غیرفعال"],
};

function IntegrationRow({ integration, onChange }) {
  const meta = KIND_META[integration.kind] || { label: integration.kind, icon: Bot, tint: "bg-muted" };
  const [open, setOpen] = useState(false);
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
  const [tone, statusLabel] = STATUS[!integration.enabled ? "disabled" : integration.status?.state] || STATUS.stopped;
  const problem = integration.status?.userMessage || (integration.status?.state === "error" ? integration.status.lastError : null);
  const isBot = integration.kind !== "telegram_account";
  const link = integration.username && integration.pairingCode && meta.link ? meta.link(integration.username, integration.pairingCode) : null;
  const subtitle = (
    <>
      {meta.label}
      {integration.username ? <> · <bdi dir="ltr">@{integration.username}</bdi></> : null}
      {isBot ? ` · ${integration.paired.length.toLocaleString("fa")} گفتگو` : null}
    </>
  );

  return (
    <Item
      icon={meta.icon}
      tint={meta.tint}
      title={integration.name}
      subtitle={subtitle}
      trailing={
        <>
          <Pill state={problem && integration.enabled ? "warn" : tone} title={problem || ""}>{statusLabel}</Pill>
          <Switch.Root
            checked={integration.enabled}
            disabled={busy}
            onCheckedChange={(enabled) => patch({ enabled })}
            onClick={(e) => e.stopPropagation()}
            dir="ltr"
            className="relative h-5 w-9 shrink-0 rounded-full bg-muted-foreground/25 transition-colors data-[state=checked]:bg-primary"
            aria-label="فعال"
          >
            <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.125rem]" />
          </Switch.Root>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="جزئیات" className="press flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted">
            <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </>
      }
    >
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="space-y-3 border-t bg-muted/30 px-4 py-3 text-sm">
              {problem ? <p className="rounded-lg bg-warn/10 px-3 py-2 text-xs" dir="auto">{problem}</p> : null}
              {isBot ? (
                <>
                  {integration.paired.length ? (
                    <ul className="space-y-1">
                      {integration.paired.map((p) => (
                        <li key={p.id} className="flex items-center gap-2">
                          <Check className="size-3.5 text-ok" />
                          <span dir="auto">{p.name}</span>
                          <button type="button" onClick={() => patch({ unpair: p.id })} className="press ms-auto rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-bad">قطع</button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">هنوز گفتگویی وصل نشده.</p>
                  )}
                  {integration.pairingCode ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-background p-2.5">
                      <span className="text-xs text-muted-foreground">در ربات بفرست:</span>
                      <code className="ltr rounded-md bg-muted px-2 py-1 font-mono text-sm tracking-wider">/start {integration.pairingCode}</code>
                      <CopyButton text={`/start ${integration.pairingCode}`} />
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer" className="press ms-auto flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
                          باز کردن ربات <ExternalLink className="size-3" />
                        </a>
                      ) : null}
                    </div>
                  ) : (
                    <button type="button" onClick={() => patch({ newPairingCode: true })} className="press flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                      <RefreshCw className="size-3.5" /> کد اتصال برای گفتگوی دیگر
                    </button>
                  )}
                </>
              ) : (
                <p className="text-xs leading-5 text-muted-foreground">گریفین با این اکانت در Saved Messages با تو حرف می‌زند، رشته‌های گفتگو با هم‌تیمی‌ها را جواب می‌دهد و ابزارهای تلگرام را دارد.</p>
              )}
              <div className="flex justify-end">
                <button type="button" onClick={remove} className="press flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-bad/10 hover:text-bad">
                  <Trash2 className="size-3.5" /> حذف اتصال
                </button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Item>
  );
}

function AccountSection() {
  const logout = () => api("/api/auth/logout", { method: "POST" }).finally(() => window.location.reload());
  const revokeAll = async () => {
    if (!window.confirm("از همهٔ دستگاه‌ها (از جمله همین) خارج شوی؟")) return;
    await api("/api/auth/revoke-all", { method: "POST" }).catch((e) => toast.error(e.message));
    window.location.reload();
  };
  return (
    <Group title="نشست‌ها">
      <Item icon={LogOut} title="خروج از این دستگاه" subtitle="کوکی همین مرورگر پاک می‌شود" onClick={logout} />
      <Item icon={ShieldOff} tint="bg-bad/10 text-bad" title="خروج از همهٔ دستگاه‌ها" subtitle="همهٔ نشست‌ها باطل می‌شوند؛ برای ورود دوباره توکن لازم است" onClick={revokeAll} />
    </Group>
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
const KNOWLEDGE_FILTERS = [
  ["pending", "در انتظار تأیید"],
  ["reviewed", "تأییدشده"],
  ["all", "همه"],
];

function KnowledgeSection() {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("pending");
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
  const all = Object.entries(data.agents || {});
  const counts = {
    pending: all.reduce((n, [, notes]) => n + notes.filter((x) => !x.reviewed).length, 0),
    reviewed: all.reduce((n, [, notes]) => n + notes.filter((x) => x.reviewed).length, 0),
  };
  counts.all = counts.pending + counts.reviewed;
  const shown = all
    .map(([agent, notes]) => [agent, notes.filter((x) => filter === "all" || (filter === "reviewed") === Boolean(x.reviewed))])
    .filter(([, notes]) => notes.length);

  return (
    <div className="space-y-6">
      <div className="flex gap-1 rounded-xl bg-muted p-1">
        {KNOWLEDGE_FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${filter === id ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
          >
            {label}
            <span className="rounded-full bg-muted-foreground/15 px-1.5 text-[11px] tabular-nums">{counts[id].toLocaleString("fa")}</span>
          </button>
        ))}
      </div>

      {!shown.length ? (
        <p className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {counts.all ? "در این دسته یادداشتی نیست." : "هنوز یادداشتی نیست. ایجنت‌ها با knowledge_write می‌نویسند و اینجا تأییدش می‌کنی."}
        </p>
      ) : (
        shown.map(([agent, notes]) => (
          <Group key={agent} title={`${agentMeta(agent).label} · ${notes.length.toLocaleString("fa")}`}>
            {notes.map((note) => {
              const key = `${agent}/${note.file}`;
              const expanded = open === key;
              return (
                <Item
                  key={key}
                  title={note.title}
                  subtitle={
                    <>
                      <bdi dir="ltr">{note.at || note.file}</bdi>
                      {note.expires ? <> · انقضا <bdi dir="ltr">{note.expires}</bdi></> : null}
                    </>
                  }
                  onClick={() => setOpen(expanded ? null : key)}
                  trailing={
                    <>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); if (busy !== key) flip(agent, note.file, !note.reviewed); }}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); flip(agent, note.file, !note.reviewed); } }}
                        className={`press inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${
                          note.reviewed ? "bg-ok/12 text-ok" : "bg-primary text-primary-foreground"
                        }`}
                      >
                        {busy === key ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                        {note.reviewed ? "تأییدشده" : "تأیید"}
                      </span>
                      <ChevronDown className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
                    </>
                  }
                >
                  {expanded ? (
                    <div className="border-t bg-muted/30 px-4 py-3">
                      <p className="ltr mb-2 text-[11px] text-muted-foreground">{note.file}</p>
                      <pre className="scrollbar-thin max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-background p-3 text-xs leading-5" dir="auto">{note.body}</pre>
                    </div>
                  ) : null}
                </Item>
              );
            })}
          </Group>
        ))
      )}
    </div>
  );
}
