import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Bot, Check, CircleAlert, Copy, Cpu, Globe, History, Loader2, Palette, Plug, RefreshCw, Send, Shuffle, SkipForward, Sparkles, Stethoscope, Trash2, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { clockLabel, exactTime } from "../elapsed.js";
import { useFlag } from "../ui-prefs.js";
import { AGENT_META, BRAND } from "../brand.js";
import { BrandPicker } from "./BrandPicker.jsx";
import { ClaudeSignin } from "./Providers.jsx";
import { AccountLogin } from "./Settings.jsx";
import { t } from "../i18n.js";

// Translates a text and its string values (the wizard passes labels as values).
export const tr = (text, vars) => t(text, vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "string" ? t(v) : v])));

// Setup wizards: first run (engine → name → look → messenger), and each piece on its own from
// Settings or from a doctor finding. #/setup/<flow>. Every step tests what it saved for real before
// moving on; every step can be skipped, and the summary at the end says what is still missing.

export const FLOWS = {
  first: { title: t("راه‌اندازی"), steps: ["agent", "welcome", "proxy", "engine", "name", "import", "appearance", "telegram", "done"] },
  engine: { title: t("افزودن موتور"), steps: ["engine", "done"] },
  proxy: { title: t("پراکسی خروجی"), steps: ["proxy", "done"] },
  name: { title: t("نام دستیار"), steps: ["name", "done"] },
  appearance: { title: t("لوگو و رنگ"), steps: ["appearance", "done"] },
  telegram: { title: t("ربات تلگرام یا بله"), steps: ["telegram", "done"] },
  import: { title: t("انتقال از ابزار قبلی"), steps: ["import", "done"] },
  mcp: { title: t("اتصال یک ایجنت دیگر (MCP)"), steps: ["mcp", "done"] },
};

// One line per step: what it is for, shown on the welcome page and above the step itself.
const STEPS = {
  agent: { label: t("با ایجنت خودت") },
  welcome: { label: t("خوش‌آمد") },
  proxy: { label: t("پراکسی"), optional: true, why: t("اول خودش امتحان می‌کند این سرور به سرویس‌های هوش مصنوعی می‌رسد یا نه. اگر رسید، پراکسی لازم نیست و رد می‌شوی؛ اگر نه (معمولاً سرور در ایران)، این‌جا یک پراکسی HTTP می‌دهی.") },
  engine: { label: t("موتور هوش مصنوعی"), why: t("مغز دستیار: یک اشتراک یا کلید API (Claude، OpenAI، OpenRouter، Ollama، …). بدون آن دستیار جواب نمی‌دهد. کلید رمزنگاری‌شده روی همین سرور می‌ماند.") },
  name: { label: t("نام دستیار"), why: t("اسمی که همکاران با آن صدایش می‌زنند و زیر پیام‌هایش می‌آید. بعداً هم عوض می‌شود.") },
  import: { label: t("انتقال از ابزار قبلی"), optional: true, why: t("اگر قبلاً با Claude Code یا Claude دسکتاپ کار کرده‌ای، گفتگوهایت را بیاور تا همین‌جا با همان حافظه ادامه بدهی.") },
  appearance: { label: t("لوگو و رنگ"), optional: true, why: t("ظاهر همین نصب: یک لوگو و یک پالت رنگ (روشن و تیره) انتخاب کن یا لوگوی خودت را بگذار. پیش‌فرض، ظاهر گریفین است.") },
  telegram: { label: t("پیام‌رسان"), optional: true, why: t("یک ربات تلگرام یا بله، یا اکانت تلگرام خودت، تا از گوشی هم با دستیار حرف بزنی و سؤال‌های تأیید را آن‌جا جواب بدهی.") },
  mcp: { label: t("ایجنت دیگر (MCP)"), optional: true, why: t("یک توکن برای Claude Code یا هر کلاینت MCP تا از بیرون کار به دستیار بسپارد.") },
  done: { label: t("خلاصه") },
};

export function setupFlowFromHash(hash = window.location.hash) {
  const m = /^#\/setup(?:\/(\w+))?$/.exec(hash);
  return m ? (FLOWS[m[1]] ? m[1] : "first") : null;
}

// Each engine in plain words: what it is, what it costs, where its key comes from, what the key looks
// like (checked before sending), and whether a server in Iran needs the proxy for it.
const ENGINES = [
  { id: "claude-sub", provider: "claude", label: t("اشتراک Claude (Pro/Max)"), blurb: t("اگر اشتراک ماهانهٔ Claude داری"), what: t("با همان اکانت Claude وارد می‌شوی؛ کلید API لازم نیست. گریفین یک توکن بلندمدت می‌گیرد و رمزنگاری‌شده نگه می‌دارد."), cost: t("هزینهٔ جدا ندارد، همان اشتراک ماهانه است؛ ولی سقف استفادهٔ چندساعته و هفتگی دارد."), link: "https://claude.ai/upgrade", linkLabel: t("خرید اشتراک در claude.ai"), placeholder: "sk-ant-oat01-…", keyRe: /^sk-ant-oat/, keyHint: t("توکن اشتراک با sk-ant-oat شروع می‌شود"), proxy: true },
  { id: "claude-api", provider: "claude", label: t("کلید API Claude"), blurb: t("پرداخت به ازای مصرف"), what: t("کلید رسمی Anthropic برای کسی که اشتراک ندارد یا مصرف زیاد دارد."), cost: t("به ازای مصرف؛ برای کار شخصی معمولاً چند تا چند ده دلار در ماه. پرداخت با کارت بین‌المللی."), link: "https://platform.claude.com/settings/keys", linkLabel: "platform.claude.com → API Keys", placeholder: "sk-ant-…", keyRe: /^sk-ant-(?!oat)/, keyHint: t("کلید API با sk-ant- شروع می‌شود (sk-ant-oat یعنی اشتراک؛ گزینهٔ اول را بزن)"), proxy: true },
  { id: "zai", provider: "openai", preset: "zai", label: "Z.ai (GLM)", blurb: t("ارزان، معمولاً بدون پراکسی"), what: t("مدل‌های GLM با پلن کدنویسی Z.ai. از ایران معمولاً بدون پراکسی جواب می‌دهد."), cost: t("پلن ماهانه از چند دلار."), link: "https://z.ai/manage-apikey/apikey-list", linkLabel: "z.ai → API Keys", placeholder: t("کلید Z.ai"), model: "glm-5.3", proxy: false },
  { id: "openai", provider: "openai", preset: "openai", label: "OpenAI (GPT)", blurb: t("کلید API اوپن‌ای‌آی"), what: t("مدل‌های GPT با کلید API رسمی OpenAI."), cost: t("به ازای مصرف، با کارت بین‌المللی."), link: "https://platform.openai.com/api-keys", linkLabel: "platform.openai.com/api-keys", placeholder: "sk-…", keyRe: /^sk-/, keyHint: t("کلید OpenAI با sk- شروع می‌شود"), model: "gpt-4o-mini", proxy: true },
  { id: "openrouter", provider: "openai", preset: "openrouter", label: "OpenRouter", blurb: t("صدها مدل با یک کلید"), what: t("یک کلید برای صدها مدل (Claude، GPT، Gemini، …). مدل را به شکل provider/model می‌نویسی."), cost: t("پیش‌پرداخت اعتبار؛ هر مدل قیمت خودش را دارد. چند مدل رایگان هم دارد."), link: "https://openrouter.ai/keys", linkLabel: "openrouter.ai/keys", placeholder: "sk-or-v1-…", keyRe: /^sk-or-/, keyHint: t("کلید OpenRouter با sk-or- شروع می‌شود"), model: "openai/gpt-4o-mini", proxy: true },
  { id: "ollama", provider: "openai", preset: "ollama", label: t("Ollama (مدل محلی)"), blurb: t("روی همین سرور، بدون کلید"), what: t("مدلی که روی همین ماشین با Ollama اجرا می‌شود؛ نه کلید می‌خواهد نه اینترنت. به سخت‌افزار قوی (ترجیحاً GPU) نیاز دارد."), cost: t("رایگان."), link: "https://ollama.com/download", linkLabel: "ollama.com", noKey: true, model: "llama3.1", proxy: false, extra: t("اگر گریفین در Docker است، کانتینر را با ‎--add-host=host.docker.internal:host-gateway‎ اجرا کن تا به Ollama روی خود سرور برسد.") },
  { id: "custom", provider: "openai", label: t("سرویس سازگار با OpenAI"), blurb: t("vLLM، LM Studio، هر /chat/completions"), what: t("هر سرویسی که API آن مثل OpenAI است (آدرسی که به /v1 ختم می‌شود)."), cost: t("بسته به سرویس."), placeholder: t("کلید"), model: "", custom: true },
  { id: "cursor", provider: "cursor", label: "Cursor", blurb: t("کلید API کرسر"), what: t("ایجنت‌های Cursor با کلید API حساب Cursor."), cost: t("طبق پلن Cursor (سقف مصرف ماهانه)."), link: "https://cursor.com/settings", linkLabel: "cursor.com → Settings → API keys", placeholder: "key_…", keyRe: /^(key_|crsr_)/, keyHint: t("کلید Cursor معمولاً با key_ شروع می‌شود"), proxy: true },
];

// What to do next for each reason the doctor gives (doctor.mjs classifyEngineError).
const CAUSE = {
  no_key: t("کلیدی ذخیره نشد. کلید را در کادر بالا بگذار."),
  bad_key: t("کلید رد شد. دوباره از صفحهٔ کلیدها کپی کن (بدون فاصلهٔ اول و آخر). اگر کلید را تازه ساخته‌ای، یک دقیقه صبر کن."),
  region: t("این سرویس IP این سرور را رد کرد (محدودیت کشور). یک پراکسی خروجی لازم است."),
  network: t("سرور اصلاً به این سرویس نرسید (فیلتر، DNS یا فایروال). یک پراکسی خروجی لازم است، یا اگر داری، خاموش است."),
  quota: t("کلید درست است ولی اعتبار یا سهمیه‌اش تمام شده. حساب را شارژ کن یا صبر کن سهمیه برگردد."),
  limited: t("کلید درست است ولی به سقف مصرف پلن (۵ ساعته یا هفتگی) خورده؛ تا باز شدن سقف کار به موتور بعدی می‌رود."),
  credit: t("کلید درست است ولی اعتبار (Credit) حساب تمام شده. حساب را شارژ کن یا کلید دیگری بگذار."),
  model: t("این مدل یا آدرس پیدا نشد. نام مدل را دقیقاً همان‌طور که در فهرست سرویس آمده بنویس (آدرس هم باید به ‎/v1‎ ختم شود)."),
  forbidden: t("دسترسی رد شد (۴۰۳). معمولاً یعنی این کلید اجازهٔ این مدل/حساب را ندارد، یا سرویس این کشور را نمی‌پذیرد (پراکسی را امتحان کن)."),
  other: t("خطای ناشناخته — متن خطا پایین است."),
};

const field = "g-input w-full rounded-lg border bg-background px-3 py-2 text-sm";
const primary = "g-btn g-btn-primary press inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60";

export function SetupPage({ flow = "first", onClose }) {
  const steps = FLOWS[flow].steps;
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const meta = STEPS[step];
  const next = () => setIndex((i) => Math.min(i + 1, steps.length - 1));
  const goto = (id) => {
    const at = steps.indexOf(id);
    if (at >= 0) setIndex(at);
    else window.location.hash = `/setup/${id}`;
  };
  const finish = async () => {
    if (flow === "first") await api("/api/setup/done", { method: "POST" }).catch(() => {});
    // A single wizard opened from Settings (or a doctor finding) goes back there.
    if (flow !== "first") window.location.hash = "/settings";
    else onClose();
  };
  // The stepper counts the real steps, not the welcome and summary pages around them.
  const real = steps.filter((s) => s !== "agent" && s !== "welcome" && s !== "done");
  const flat = useFlag("setupFlat"); // «ویزارد راه‌اندازی ساده» (karsara.css .g-setup[data-flat])

  return (
    <div data-flat={flat || undefined} className="g-setup flex h-dvh min-w-0 flex-1 flex-col overflow-y-auto bg-background">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Wand2 className="g-deco size-5 text-primary" />
        <h1 className="text-base font-semibold">{FLOWS[flow].title}</h1>
        <span className="text-xs text-muted-foreground">{index + 1} / {steps.length}</span>
        <button type="button" onClick={finish} className="press ms-auto rounded-lg p-1.5 text-muted-foreground hover:bg-muted" aria-label={t("بستن")}><X className="size-5" /></button>
      </header>
      <div className="h-1 bg-muted"><div className="h-1 bg-primary transition-all" style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></div>
      {real.length > 1 ? (
        <ol className="mx-auto flex w-full max-w-xl flex-wrap gap-1.5 px-4 pt-4" aria-label={t("قدم‌ها")}>
          {real.map((s, i) => {
            const at = steps.indexOf(s);
            const state = at === index ? "now" : at < index ? "past" : "next";
            return (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => setIndex(at)}
                  aria-current={state === "now" ? "step" : undefined}
                  className={`g-choice press inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${state === "now" ? "border-primary bg-primary/10 text-foreground g-choice-on" : state === "past" ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {/* A number, not a tick: a skipped step is behind you but not done (the summary says which). */}
                  <span className="tabular-nums">{i + 1}</span>
                  {STEPS[s].label}
                  {STEPS[s].optional ? <span className="text-[10px] text-muted-foreground">{t("(اختیاری)")}</span> : null}
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-6">
        {meta?.why && step !== "agent" && step !== "welcome" && step !== "done" ? <p className="mb-4 rounded-xl bg-muted/60 px-3 py-2 text-xs leading-6 text-muted-foreground">{meta.why}</p> : null}
        {AGENT_SECTIONS.includes(step) ? <AskMyAgent section={step} key={step} /> : null}
        {step === "agent" ? <AgentStep onNext={next} /> : null}
        {step === "welcome" ? <Welcome onNext={next} steps={real} onPick={(s) => setIndex(steps.indexOf(s))} /> : null}
        {step === "engine" ? <EngineStep onNext={next} moveDefault={flow === "first"} goto={goto} /> : null}
        {step === "proxy" ? <ProxyStep onSaved={next} /> : null}
        {step === "name" ? <NameStep onNext={next} /> : null}
        {step === "import" ? <ImportStep onNext={next} /> : null}
        {step === "appearance" ? <AppearanceStep onNext={next} /> : null}
        {step === "telegram" ? <TelegramStep onNext={next} optional={flow === "first"} /> : null}
        {step === "mcp" ? <McpStep onNext={next} /> : null}
        {step === "done" ? <Done onClose={finish} goto={goto} first={flow === "first"} /> : null}
        {step !== "agent" && step !== "welcome" && step !== "done" ? (
          <div className="mt-8 flex items-center gap-3 border-t pt-4 text-sm">
            {index > 0 ? (
              <button type="button" onClick={() => setIndex((i) => i - 1)} className="press inline-flex items-center gap-1 text-muted-foreground">
                <ArrowRight className="size-4 rtl:rotate-0 ltr:rotate-180" /> قبلی
              </button>
            ) : null}
            <button type="button" onClick={next} className="press ms-auto inline-flex items-center gap-1 text-muted-foreground">
              {meta?.optional ? t("رد شدن") : t("بعداً، رد شدن")} <SkipForward className="size-4 ltr:rotate-180" />
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}

// First page: hand the setup to the agent the owner already works with (owner 2026-10-17: «آدم‌ها
// ایجنتِ ایجنت‌ها نیستند»). The owner first answers what only he can decide (name, account, proxy,
// secrets, what to bring over); the prompt then holds only those steps. It carries no secret: the agent
// reads the owner token on the server itself.
const AGENT_CHOICES = [
  { id: "claude", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "zcode", label: "ZCode" },
  { id: "other", label: t("ایجنت دیگر") },
];
const PROXY_CHOICES = [
  { id: "auto", label: t("خودش بسنجد"), blurb: t("اگر سرور مستقیم به سرویس می‌رسد پراکسی لازم نیست؛ اگر نه، از من می‌پرسد") },
  { id: "move", label: t("همان پراکسی فعلی‌ام"), blurb: t("پراکسی‌ای که الان با آن به Claude/ChatGPT وصل می‌شوم را روی سرور هم راه بیندازد") },
  { id: "link", label: t("لینک v2ray می‌دهم"), blurb: t("vless/vmess/trojan؛ Xray را روی سرور نصب و وصل می‌کند") },
  { id: "none", label: t("پراکسی نمی‌خواهم"), blurb: t("اگر سرویس بدون پراکسی جواب نداد، فقط به من بگوید") },
];
const SECRET_CHOICES = [
  { id: "ask", label: t("هر کلیدی را از من بپرسد"), blurb: t("ایجنت خودش دنبال کلید و رمز نمی‌گردد") },
  { id: "move", label: t("کلیدهایی که دارد را منتقل کند"), blurb: t("کلیدهای لازم را که خودش دارد، رمزنگاری‌شده در گریفین می‌گذارد؛ هیچ‌جا چاپشان نمی‌کند") },
];
const TRANSFER_CHOICES = [
  { id: "chats", label: t("گفتگوهای قبلی Claude"), blurb: t("تاریخچهٔ Claude Code / Claude دسکتاپ؛ هر ایجنتی می‌تواند منتقلش کند و با همان حافظه ادامه پیدا می‌کند") },
  { id: "memory", label: t("دستورها و حافظه"), blurb: t("CLAUDE.md، قواعد و یادداشت‌های حافظه؛ بدون رمز") },
  { id: "skills", label: t("مهارت‌ها (skills)"), blurb: t("پوشه‌های ~/.claude/skills"), only: ["claude"] },
  { id: "mcp", label: t("سرورهای MCP"), blurb: t("آن‌هایی که از سرور هم کار می‌کنند") },
  { id: "git", label: t("دسترسی گیت"), blurb: t("GitLab/GitHub برای کلون و push ریپوها") },
];

function Choice({ on, onClick, label, blurb, multi }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={`press flex w-full items-start gap-2 g-card rounded-xl border p-3 text-start ${on ? "border-primary bg-primary/5 g-choice-on" : "hover:bg-muted/50"}`}>
      <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border ${multi ? "rounded" : "rounded-full"} ${on ? "border-primary bg-primary text-primary-foreground" : ""}`}>{on ? <Check className="size-3" /> : null}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {blurb ? <span className="block text-xs leading-5 text-muted-foreground">{blurb}</span> : null}
      </span>
    </button>
  );
}

function Question({ n, title, children }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold"><span className="tabular-nums text-primary">{n}.</span> {title}</h3>
      {children}
    </section>
  );
}

function AgentStep({ onNext }) {
  const [agent, setAgent] = useState("claude");
  const [name, setName] = useState("");
  const [latin, setLatin] = useState("");
  const [engine, setEngine] = useState("");
  const [proxy, setProxy] = useState("auto");
  const [secrets, setSecrets] = useState("ask");
  const [transfer, setTransfer] = useState(["chats", "memory"]);
  const [telegram, setTelegram] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/api/setup").then((r) => { setName(r.persona?.name || ""); setLatin(r.persona?.latin || ""); }).catch(() => {});
  }, []);
  // Any change after the prompt was built means the shown prompt is stale.
  useEffect(() => setPrompt(""), [agent, name, latin, engine, proxy, secrets, transfer, telegram]);
  const shuffle = () => api(`/api/setup/random-name?not=${encodeURIComponent(name)}`).then((r) => { setName(r.name); setLatin(r.latin); }).catch((e) => toast.error(e.message));
  const toggle = (id) => setTransfer((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const usable = TRANSFER_CHOICES.filter((t) => !t.only || t.only.includes(agent));
  const build = async () => {
    setBusy(true);
    try {
      if (name.trim()) {
        await api("/api/setup/persona", { method: "POST", body: { name, latin } });
        BRAND.name = AGENT_META.griffin.label = AGENT_META.griffin.short = name.trim();
        if (latin.trim()) BRAND.nameEn = latin.trim();
      }
      const chosen = transfer.filter((id) => usable.some((t) => t.id === id));
      const r = await api("/api/setup/agent-prompt", { method: "POST", body: { agent, engine, proxy, secrets, transfer: chosen, telegram } });
      setPrompt(r.prompt || "");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success(t("کپی شد؛ در ایجنت خودت بچسبان"));
    } catch {
      toast.error(t("کپی نشد؛ متن را انتخاب و کپی کن"));
    }
  };
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Bot className="g-deco size-8 text-primary" />
        <h2 className="text-xl font-semibold">{t("راه‌اندازی را به ایجنت خودت بسپار")}</h2>
        <p className="text-sm leading-7 text-muted-foreground">
          اگر این صفحه را می‌بینی، بخشی از راه‌اندازی هنوز کامل نشده. چند سؤال کوتاه را جواب بده تا یک متن آماده برای
          ایجنتی که با آن کار می‌کنی ساخته شود. ایجنت بقیه را خودش انجام و تست می‌کند و فقط چیزی را می‌پرسد که فقط تو
          داری. ایجنت باید به ترمینال همین سرور دسترسی داشته باشد. هیچ رمزی داخل متن نیست.
        </p>
      </div>

      <Question n={t("۱")} title={t("با کدام ایجنت کار می‌کنی؟")}>
        <div className="flex flex-wrap gap-2">
          {AGENT_CHOICES.map((a) => (
            <button key={a.id} type="button" onClick={() => setAgent(a.id)} aria-pressed={agent === a.id} className={`g-choice press rounded-full border px-3 py-1.5 text-sm ${agent === a.id ? "border-primary bg-primary/10 g-choice-on" : ""}`}>{a.label}</button>
          ))}
        </div>
      </Question>

      <Question n={t("۲")} title={t("اسم دستیارت")}>
        <div className="flex gap-2">
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("مثلاً آوا")} />
          <button type="button" onClick={shuffle} className="press inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm"><Shuffle className="size-4" /> {t("یک اسم دیگر")}</button>
        </div>
        <input className={field} dir="ltr" value={latin} onChange={(e) => setLatin(e.target.value)} placeholder="Latin, e.g. Ava" />
      </Question>

      <Question n={t("۳")} title={t("از کدام حساب هوش مصنوعی استفاده می‌کنی؟")}>
        <div className="grid gap-2 sm:grid-cols-2">
          {ENGINES.map((e) => <Choice key={e.id} on={engine === e.id} onClick={() => setEngine(e.id)} label={e.label} blurb={e.blurb} />)}
          <Choice on={engine === ""} onClick={() => setEngine("")} label={t("هنوز نمی‌دانم")} blurb={t("ایجنت گزینه‌ها را توضیح می‌دهد و می‌پرسد")} />
        </div>
      </Question>

      <Question n={t("۴")} title={t("پراکسی")}>
        <div className="grid gap-2">
          {PROXY_CHOICES.map((p) => <Choice key={p.id} on={proxy === p.id} onClick={() => setProxy(p.id)} label={p.label} blurb={p.blurb} />)}
        </div>
      </Question>

      <Question n={t("۵")} title={t("کلیدها و رمزها")}>
        <div className="grid gap-2">
          {SECRET_CHOICES.map((p) => <Choice key={p.id} on={secrets === p.id} onClick={() => setSecrets(p.id)} label={p.label} blurb={p.blurb} />)}
        </div>
      </Question>

      <Question n={t("۶")} title={t("از ایجنت فعلی چه چیزهایی منتقل شود؟")}>
        <div className="grid gap-2 sm:grid-cols-2">
          {usable.map((t) => <Choice key={t.id} multi on={transfer.includes(t.id)} onClick={() => toggle(t.id)} label={t.label} blurb={t.blurb} />)}
        </div>
        {agent !== "claude" ? <p className="text-xs text-muted-foreground">مهارت‌ها فقط از Claude Code منتقل می‌شوند؛ تاریخچهٔ خود {AGENT_CHOICES.find((a) => a.id === agent)?.label} منتقل نمی‌شود.</p> : null}
      </Question>

      <Question n={t("۷")} title={t("پیام‌رسان")}>
        <Choice multi on={telegram} onClick={() => setTelegram((t) => !t)} label={t("ربات تلگرام/بله یا اکانت تلگرامم را هم وصل کند")} blurb={t("قدم‌به‌قدم می‌گوید چه بکنی؛ کد ورود و رمز را فقط از خودت می‌پرسد")} />
      </Question>

      {prompt ? (
        <div className="space-y-3">
          <div className="relative">
            <pre dir="ltr" className="max-h-80 overflow-auto whitespace-pre-wrap g-card rounded-xl border bg-muted/50 p-3 pt-10 text-start font-mono text-xs leading-5">{prompt}</pre>
            <button type="button" onClick={copy} className="press absolute end-2 top-2 inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs">
              <Copy className="size-3.5" /> کپی
            </button>
          </div>
          <p className="text-xs leading-6 text-muted-foreground">این متن را در {AGENT_CHOICES.find((a) => a.id === agent)?.label} بچسبان. وقتی کارش تمام شد، این صفحه را تازه کن.</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {prompt ? (
          <button type="button" onClick={copy} className={primary}><Copy className="size-4" /> {t("کپی متن برای ایجنت")}</button>
        ) : (
          <button type="button" onClick={build} disabled={busy} className={primary}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} ساختن متن برای ایجنت</button>
        )}
        <button type="button" onClick={onNext} className="press inline-flex items-center gap-1 text-sm text-muted-foreground">
          ایجنت ندارم، خودم قدم‌به‌قدم <ArrowLeft className="size-4 ltr:rotate-180" />
        </button>
      </div>
    </div>
  );
}

// Every step can be handed to the owner's own agent on its own (owner 2026-10-17: Claude ran out and
// they wanted ZCode to bring their chats over). Same server prompt, limited to this one section.
const AGENT_SECTIONS = ["proxy", "engine", "name", "import", "telegram"];

function AskMyAgent({ section }) {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState("claude");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setPrompt(""), [agent]);
  const build = async () => {
    setBusy(true);
    try {
      const r = await api("/api/setup/agent-prompt", { method: "POST", body: { agent, section } });
      setPrompt(r.prompt || "");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success(t("کپی شد؛ در ایجنت خودت بچسبان"));
    } catch {
      toast.error(t("کپی نشد؛ متن را انتخاب و کپی کن"));
    }
  };
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="press mb-4 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
        <Bot className="size-3.5" /> این قدم را به ایجنت خودت بسپار
      </button>
    );
  }
  return (
    <div className="mb-6 space-y-3 rounded-2xl border bg-card p-4">
      <p className="text-sm leading-6">{t("ایجنتی که با آن کار می‌کنی (و به ترمینال این سرور یا سیستم قبلی‌ات دسترسی دارد) فقط همین قدم را انجام می‌دهد و چیزی را که فقط تو داری از تو می‌پرسد. هیچ رمزی داخل متن نیست.")}</p>
      <div className="flex flex-wrap gap-2">
        {AGENT_CHOICES.map((a) => (
          <button key={a.id} type="button" onClick={() => setAgent(a.id)} aria-pressed={agent === a.id} className={`g-choice press rounded-full border px-3 py-1 text-xs ${agent === a.id ? "border-primary bg-primary/10 g-choice-on" : ""}`}>{a.label}</button>
        ))}
      </div>
      {prompt ? (
        <div className="relative">
          <pre dir="ltr" className="max-h-64 overflow-auto whitespace-pre-wrap g-card rounded-xl border bg-muted/50 p-3 pt-10 text-start font-mono text-xs leading-5">{prompt}</pre>
          <button type="button" onClick={copy} className="press absolute end-2 top-2 inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs"><Copy className="size-3.5" /> {t("کپی")}</button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {prompt ? (
          <button type="button" onClick={copy} className={primary}><Copy className="size-4" /> {t("کپی متن")}</button>
        ) : (
          <button type="button" onClick={build} disabled={busy} className={primary}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} ساختن متن این قدم</button>
        )}
        <button type="button" onClick={() => setOpen(false)} className="press rounded-lg border px-3 py-2 text-sm">{t("بستن")}</button>
      </div>
    </div>
  );
}

function Welcome({ onNext, steps, onPick }) {
  return (
    <div className="space-y-4">
      <Sparkles className="g-deco size-8 text-primary" />
      <h2 className="text-xl font-semibold">{t("خوش آمدی")}</h2>
      <p className="text-sm leading-7 text-muted-foreground">
        چند قدم کوتاه تا دستیارت آماده شود. هر قدم همان لحظه واقعی تست می‌شود، هر کدام را می‌شود رد کرد و بعداً از
        تنظیمات → سلامت دوباره باز کرد. آخر کار یک خلاصه می‌بینی که چه چیزی تنظیم شد و چه چیزی مانده.
      </p>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={s}>
            <button type="button" onClick={() => onPick(s)} className="press flex w-full gap-3 g-card rounded-xl border bg-card p-3 text-start hover:border-primary/60">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium tabular-nums text-primary">{i + 1}</span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{STEPS[s].label}{STEPS[s].optional ? <span className="ms-1 text-xs font-normal text-muted-foreground">{t("(اختیاری)")}</span> : null}</span>
              <span className="block text-xs leading-6 text-muted-foreground">{STEPS[s].why}</span>
            </span>
            </button>
          </li>
        ))}
      </ol>
      <button type="button" onClick={onNext} className={primary}>{t("شروع")} <ArrowLeft className="size-4 ltr:rotate-180" /></button>
    </div>
  );
}

function AppearanceStep({ onNext }) {
  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Palette className="size-5" /> {t("لوگو و رنگ")}</h2>
      <BrandPicker onSaved={onNext} saveLabel={t("ذخیره و بعدی")} />
    </div>
  );
}

// Adding an engine, one plain question at a time (owner 2026-10-19: colleagues could not follow the old
// form — «فقط … رو در موتورها دارم، چطور بقیه رو اضافه کنم؟»):
//   ۱) با چه چیزی وصل می‌شوید؟ (اشتراک Claude / کلید API / مدل محلی یا سرویس دیگر)
//   ۲) وصل شدن: برای اشتراک سه قدم شمارهٔ‌دار (باز کردن صفحه ← وارد شدن ← گذاشتن کد)، برای کلید فقط
//      «کلید را از کجا بگیرم» و جای کلید
//   ۳) وصل شد: یک اسم، و این‌که ایجنت اصلی هم از آن استفاده کند.
// The account is made only when the connection starts, and the base account of a kind is used while it
// has no key; otherwise a new account is made, so a second Claude never overwrites the one that works.
const ROUTES = [
  { id: "sub", title: t("اشتراک Claude"), blurb: t("اگر در claude.ai اشتراک (Pro یا Max) دارید یا شخصی اشتراکش را در اختیارتان می‌گذارد. فقط وارد حساب می‌شوید؛ کلید لازم نیست."), tag: t("ساده‌ترین راه"), engine: "claude-sub" },
  { id: "key", title: t("کلید API"), blurb: t("از Claude، OpenAI، Z.ai، OpenRouter یا Cursor یک کلید می‌گیرید و این‌جا می‌گذارید."), services: ["claude-api", "zai", "openai", "openrouter", "cursor"] },
  { id: "other", title: t("مدل روی سرور خودم یا سرویس دیگر"), blurb: t("Ollama، یا هر سرویسی که مثل OpenAI کار می‌کند."), services: ["ollama", "custom"] },
];

function EngineStep({ onNext, moveDefault, goto }) {
  const [stage, setStage] = useState("route"); // route → service → connect → done
  const [route, setRoute] = useState(null);
  const [choice, setChoice] = useState(null);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState([]);
  const [useForMain, setUseForMain] = useState(moveDefault);
  const [account, setAccount] = useState(null); // { id, kind } once made or picked
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const engine = ENGINES.find((e) => e.id === choice);
  // Checked in the browser before anything is sent: a subscription token pasted as an API key once
  // made every run of a colleague's install finish empty. A warning, not a block.
  const keyWarning = engine && key.trim() && engine.keyRe && !engine.keyRe.test(key.trim()) ? `این شبیه کلید ${engine.label} نیست: ${engine.keyHint}.` : null;

  const pick = (e) => {
    setChoice(e.id);
    setModel(e.model ?? "");
    setModels([]);
    setResult(null);
    setKey("");
    if (account && account.kind !== e.provider) setAccount(null);
    setStage("connect");
  };
  const chooseRoute = (r) => {
    setRoute(r);
    if (r.engine) pick(ENGINES.find((e) => e.id === r.engine));
    else setStage("service");
  };
  const back = () => {
    setResult(null);
    if (stage === "connect") setStage(route?.engine ? "route" : "service");
    else setStage("route");
  };
  const again = () => {
    setStage("route");
    setRoute(null);
    setChoice(null);
    setAccount(null);
    setName("");
    setKey("");
    setResult(null);
    setModels([]);
  };

  const resolveAccount = async () => {
    if (account) return account.id;
    const { providers } = await api("/api/providers");
    const base = providers.find((p) => p.id === engine.provider);
    let id;
    if (base && !base.hasKey) {
      id = base.id;
      await api(`/api/providers/${id}`, { method: "PATCH", body: { enabled: true } });
    } else {
      // A second Claude has no name yet: the list then shows «Claude · email» or «Claude · 2», and the
      // name asked at the end replaces it. A service keeps its own name.
      ({ id } = await api("/api/providers", { method: "POST", body: { kind: engine.provider, label: engine.provider === "claude" ? "" : engine.label, preset: engine.preset || "" } }));
    }
    setAccount({ id, kind: engine.provider });
    return id;
  };

  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      const id = await resolveAccount();
      const body = {};
      const apiKey = key.trim() || (engine.noKey ? "ollama" : "");
      if (apiKey) body.apiKey = apiKey;
      if (engine.preset) body.preset = engine.preset;
      if (engine.custom) body.baseUrl = baseUrl.trim();
      if (model.trim()) body.model = model.trim();
      await api(`/api/providers/${id}`, { method: "PATCH", body });
      await verify(id);
    } catch (e) {
      setResult({ ok: false, cause: "other", detail: e.message });
    }
    setBusy(false);
  };

  // After a key or a browser sign-in: test it for real; on success list its models and go to the last page.
  const verify = async (id) => {
    const r = await api(`/api/doctor/engine/${id}`);
    setResult(r);
    if (!r.ok) return;
    await api("/api/doctor/heal", { method: "POST" }).catch(() => {});
    const list = await api(`/api/models?provider=${encodeURIComponent(id)}`).then((d) => d.models || []).catch(() => []);
    setModels(list);
    setStage("done");
  };

  const saveModel = async (value) => {
    setModel(value);
    if (account && value) await api(`/api/providers/${account.id}`, { method: "PATCH", body: { model: value } }).catch((e) => toast.error(e.message));
  };

  // The last page's buttons: the name (saved alone, nothing to test) and the main agent's engine.
  const finish = async (then) => {
    setBusy(true);
    try {
      if (account && name.trim()) await api(`/api/providers/${account.id}`, { method: "PATCH", body: { label: name.trim() } });
      if (account && useForMain) await api("/api/agents/griffin", { method: "PATCH", body: { provider: account.id } }).catch(() => {});
      then();
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
  };

  const services = route?.services ? route.services.map((id) => ENGINES.find((e) => e.id === id)).filter(Boolean) : [];
  const backButton = stage === "route" || stage === "done" ? null : (
    <button type="button" onClick={back} className="press -mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ArrowRight className="size-3.5 rtl:rotate-0 ltr:rotate-180" /> برگشت
    </button>
  );

  return (
    <div className="space-y-4">
      {backButton}
      {stage === "route" ? (
        <>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Cpu className="size-5" /> {t("با چه چیزی وصل شویم؟")}</h2>
          <p className="text-sm leading-7 text-muted-foreground">{t("موتور همان چیزی است که دستیار با آن فکر می‌کند و جواب می‌دهد. یکی را انتخاب کنید؛ هر وقت خواستید می‌توانید موتور دیگری هم اضافه کنید.")}</p>
          <div className="space-y-2">
            {ROUTES.map((r) => (
              <button key={r.id} type="button" onClick={() => chooseRoute(r)} className="press g-card flex w-full items-start gap-3 rounded-xl border p-4 text-start hover:border-primary/60 hover:bg-muted/40">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-semibold">{r.title}{r.tag ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-normal text-primary">{r.tag}</span> : null}</span>
                  <span className="mt-1 block text-xs leading-6 text-muted-foreground">{r.blurb}</span>
                </span>
                <ArrowLeft className="mt-1 size-4 shrink-0 text-muted-foreground ltr:rotate-180" />
              </button>
            ))}
          </div>
        </>
      ) : null}

      {stage === "service" ? (
        <>
          <h2 className="text-lg font-semibold">{route?.id === "key" ? t("کلید کدام سرویس را دارید؟") : t("کدام یک؟")}</h2>
          <div className="space-y-2">
            {services.map((e) => (
              <button key={e.id} type="button" onClick={() => pick(e)} className="press g-card flex w-full items-start gap-3 rounded-xl border p-3 text-start hover:border-primary/60 hover:bg-muted/40">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{e.label}</span>
                  <span className="mt-0.5 block text-xs leading-6 text-muted-foreground">{e.blurb}</span>
                </span>
                <ArrowLeft className="mt-1 size-4 shrink-0 text-muted-foreground ltr:rotate-180" />
              </button>
            ))}
          </div>
        </>
      ) : null}

      {stage === "connect" && engine ? (
        <>
          <h2 className="text-lg font-semibold">{engine.id === "claude-sub" ? t("ورود با اشتراک Claude") : `اتصال ${engine.label}`}</h2>
          {engine.id === "claude-sub" ? (
            <ClaudeSignin id={() => resolveAccount()} onDone={(id) => verify(id).catch((e) => setResult({ ok: false, cause: "other", detail: e.message }))} />
          ) : (
            <div className="space-y-3">
              {engine.link ? (
                <p className="text-sm leading-7">
                  {engine.noKey ? t("اول Ollama را نصب کنید: ") : t("کلید را از این صفحه بگیرید: ")}
                  <a href={engine.link} target="_blank" rel="noreferrer" className="text-primary underline" dir="ltr">{engine.linkLabel}</a>
                </p>
              ) : null}
              <p className="text-xs leading-6 text-muted-foreground">{engine.cost}</p>
              {engine.custom ? <input className={field} dir="ltr" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={t("آدرس سرویس، مثلاً https://api.example.com/v1")} aria-label={t("آدرس سرویس")} /> : null}
              {engine.noKey ? null : (
                <label className="block space-y-1">
                  <span className="text-sm font-medium">{t("کلید را این‌جا بگذارید")}</span>
                  <input className={field} dir="ltr" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={engine.placeholder} />
                </label>
              )}
              {keyWarning ? <p className="text-xs text-amber-600">{keyWarning}</p> : null}
              {engine.extra ? <p className="text-xs leading-6 text-muted-foreground">{engine.extra}</p> : null}
              {engine.provider === "openai" ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">{t("تنظیم پیشرفته (مدل)")}</summary>
                  <label className="mt-2 block">
                    <span className="mb-1 block text-muted-foreground">{t("اسم مدل؛ خالی بگذارید تا پیش‌فرض بیاید. بعد از وصل شدن فهرست مدل‌ها را می‌بینید.")}</span>
                    <input className={field} dir="ltr" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model" />
                  </label>
                </details>
              ) : null}
              <button type="button" onClick={test} disabled={busy || (!engine.noKey && !key.trim()) || (engine.custom && !baseUrl.trim())} className={primary}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Stethoscope className="size-4" />} وصل کن و امتحان کن
              </button>
            </div>
          )}
          {result && !result.ok ? <ProbeResult result={result} engine={engine} onProxy={goto ? () => goto("proxy") : null} /> : null}
          {result && !result.ok && (result.cause === "region" || result.cause === "network") ? <ProxyStep onSaved={test} inline /> : null}
        </>
      ) : null}

      {stage === "done" && engine ? (
        <div className="space-y-4">
          <p className="flex items-center gap-2 rounded-xl bg-ok/10 px-3 py-3 text-sm font-medium text-ok"><Check className="size-5" /> {t("وصل شد و جواب داد.")}</p>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t("این حساب را چه بنامیم؟")} <span className="text-xs font-normal text-muted-foreground">{t("(اختیاری)")}</span></span>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder={engine.provider === "claude" ? t("مثلاً: Claude آیدا") : `مثلاً: ${engine.label} شخصی`} />
            <span className="block text-xs leading-6 text-muted-foreground">{t("این اسم را در فهرست موتورها، انتخاب مدل و بخش مصرف می‌بینید. خالی بگذارید تا خودکار نام‌گذاری شود. بعداً هم با مداد کنار اسم عوض می‌شود.")}</span>
          </label>
          {models.length > 1 ? (
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t("مدل پیش‌فرض این موتور")}</span>
              <select className={field} dir="ltr" value={model} onChange={(e) => saveModel(e.target.value)}>
                <option value="">{t("پیش‌فرض سرویس")}</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
              </select>
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useForMain} onChange={(e) => setUseForMain(e.target.checked)} className="size-4 accent-[var(--color-primary)]" />
            ایجنت اصلی با این موتور کار کند
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => finish(onNext)} disabled={busy} className={primary}>{busy ? <Loader2 className="size-4 animate-spin" /> : null} بعدی <ArrowLeft className="size-4 ltr:rotate-180" /></button>
            <button type="button" onClick={() => finish(again)} disabled={busy} className="press rounded-lg border px-3 py-2 text-sm">{t("یک موتور دیگر هم اضافه می‌کنم")}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ProbeResult({ result, engine = null, onProxy = null }) {
  if (result.state === "limited") return <p className="rounded-lg bg-warn/10 p-3 text-sm text-warn">{CAUSE.limited}{result.until ? ` باز شدن سقف: ${new Date(result.until).toLocaleString("fa-IR", { weekday: "long", hour: "2-digit", minute: "2-digit" })}` : ""}</p>;
  if (result.ok) return <p className="flex items-center gap-2 text-sm text-ok"><Check className="size-4" /> {result.busy ? t("کلید درست است (سرویس الان شلوغ است)") : t("جواب داد")}{result.ms ? ` (${result.ms}ms)` : ""}.</p>;
  const needsProxy = result.cause === "region" || result.cause === "network";
  return (
    <div className="space-y-2 rounded-lg bg-bad/10 p-3 text-sm">
      <p className="text-bad">{CAUSE[result.cause] || CAUSE.other}</p>
      {engine?.link && (result.cause === "bad_key" || result.cause === "quota" || result.cause === "credit") ? (
        <a href={engine.link} target="_blank" rel="noreferrer" className="inline-block text-xs text-primary underline">{result.cause === "quota" || result.cause === "credit" ? t("حساب و اعتبار") : t("صفحهٔ کلیدها")}: {engine.linkLabel}</a>
      ) : null}
      {needsProxy && onProxy ? <button type="button" onClick={onProxy} className="press inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs"><Globe className="size-3.5" /> {t("برو قدم پراکسی")}</button> : null}
      {result.detail ? <p className="break-all font-mono text-xs text-muted-foreground" dir="ltr">{String(result.detail).slice(0, 300)}</p> : null}
    </div>
  );
}

// What each probe result means and what to do, directly and through the proxy (egress-probe.mjs).
const REACH = {
  direct: {
    ok: t("در دسترس"),
    region: t("این کشور را رد کرد — پراکسی لازم است"),
    unreachable: t("جوابی نیامد (فیلتر، DNS یا فایروال) — پراکسی لازم است"),
  },
  proxy: {
    ok: t("از پراکسی در دسترس"),
    region: t("از پراکسی هم رد شد: خروجی پراکسی در کشوری است که این سرویس قبول نمی‌کند. سرور یا کانفیگ پراکسی را عوض کن."),
    unreachable: t("پراکسی وصل شد ولی به این سرویس نرسید: اینترنت خود پراکسی (یا کانفیگ VPN پشتش) را چک کن."),
    proxy: t("خود پراکسی جواب نداد: آدرس و پورت را چک کن و ببین برنامهٔ پراکسی روشن است. اگر گریفین در Docker است، 127.0.0.1 یعنی خود کانتینر: IP سرور یا host.docker.internal را بنویس. «407» یعنی نام کاربری و رمز لازم است."),
  },
};

function Reach({ rows, via }) {
  // One reason for every host (a dead proxy, a fully filtered server) is said once.
  const one = rows.length > 1 && rows[0].result !== "ok" && rows.every((r) => r.result === rows[0].result);
  if (one) {
    return (
      <div className="flex items-start gap-2 g-card rounded-xl border bg-card px-3 py-2 text-sm">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" />
        <span className="min-w-0">
          <span className="block font-medium">هیچ‌کدام ({rows.map((r) => r.label).join(t("، "))})</span>
          <span className="block text-xs leading-6 text-muted-foreground">{REACH[via][rows[0].result] || rows[0].result}{rows[0].status || rows[0].error ? <span dir="ltr"> ({rows[0].status || rows[0].error})</span> : null}</span>
        </span>
      </div>
    );
  }
  return (
    <ul className="divide-y g-card rounded-xl border bg-card text-sm">
      {rows.map((r) => (
        <li key={r.host} className="flex items-start gap-2 px-3 py-2">
          {r.result === "ok" ? <Check className="mt-0.5 size-4 shrink-0 text-ok" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" />}
          <span className="min-w-0">
            <span className="block font-medium">{r.label} <span className="text-xs font-normal text-muted-foreground" dir="ltr">{r.host}</span></span>
            <span className="block text-xs leading-6 text-muted-foreground">{REACH[via][r.result] || r.result}{r.result !== "ok" && (r.status || r.error) ? <span dir="ltr"> ({r.status || r.error})</span> : null}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// Proxy: first finds out whether one is needed at all, then takes one and checks it the same way.
export function ProxyStep({ onSaved, inline = false, heading = true }) {
  const [url, setUrl] = useState("");
  const [state, setState] = useState(null);
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false);
  const check = () => {
    setBusy(true);
    return api("/api/setup/egress").then(setProbe).catch((e) => toast.error(e.message)).finally(() => setBusy(false));
  };
  useEffect(() => {
    api("/api/setup/proxy").then((r) => { setUrl(r.url || ""); setState(r.fromEnv ? "env" : null); }).catch(() => {});
    if (!inline) check();
  }, [inline]);
  const typed = url.trim();
  const formError = !typed ? null
    : /^socks/i.test(typed) ? t("SOCKS پشتیبانی نمی‌شود؛ پورت HTTP همان برنامه را بده (v2rayN و Xray معمولاً هر دو را دارند، مثلاً 10809 برای HTTP و 10808 برای SOCKS).")
    : /^(vless|vmess|trojan|ss|hysteria2?|tuic):\/\//i.test(typed) ? "این لینک خود VPN است، نه آدرس پراکسی؛ آن را در کادر «لینک VPN» بالا بچسبان."
    : !/^https?:\/\/([^\s/@]+@)?[^\s/@:]+:\d+\/?$/i.test(typed) ? t("شکلش باید این باشد: http://host:port (مثلاً http://127.0.0.1:10809)")
    : null;
  const save = async () => {
    try {
      await api("/api/setup/proxy", { method: "POST", body: { url: typed } });
      toast.success(typed ? t("پراکسی ذخیره شد؛ دوباره تست می‌شود") : t("پراکسی برداشته شد"));
      await check();
      if (inline) onSaved?.();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const direct = probe?.direct || [];
  const allDirect = direct.length > 0 && direct.every((r) => r.result === "ok");
  const viaOk = probe?.viaProxy?.some((r) => r.result === "ok");
  return (
    <div className={inline ? "space-y-3 border-t pt-3" : "space-y-4"}>
      {heading ? <h3 className="flex items-center gap-2 text-sm font-semibold"><Globe className="size-4" /> {t("پراکسی خروجی")}</h3> : null}
      {inline ? null : busy && !probe ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("دارم امتحان می‌کنم این سرور مستقیم به کدام سرویس‌ها می‌رسد…")}</p>
      ) : probe ? (
        <div className="space-y-2">
          {allDirect ? (
            <p className="flex items-center gap-2 rounded-lg bg-ok/10 px-3 py-2 text-sm text-ok"><Check className="size-4" /> {t("پراکسی لازم نیست: این سرور مستقیم به همهٔ سرویس‌ها می‌رسد.")}</p>
          ) : (
            <p className="text-sm leading-7">{t("بدون پراکسی، این سرور به بعضی سرویس‌ها نمی‌رسد. اگر فقط از سرویس‌های سبز (یا Ollama روی همین سرور) استفاده می‌کنی، پراکسی لازم نیست؛ وگرنه پایین یکی بده.")}</p>
          )}
          <p className="text-xs text-muted-foreground">{t("مستقیم، بدون پراکسی:")}</p>
          <Reach rows={direct} via="direct" />
          {allDirect && onSaved ? <button type="button" onClick={onSaved} className={primary}>{t("رد شو، بعدی")} <ArrowLeft className="size-4 ltr:rotate-180" /></button> : null}
        </div>
      ) : null}
      {state === "env" ? null : <VpnBox onConnected={check} />}
      <details className="g-card rounded-xl border bg-muted/30 px-3 py-2 text-xs leading-6 text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">{t("لینک VPN ندارم، پراکسی HTTP دارم")}</summary>
        <div className="space-y-2 pt-2">
          <p>{t("برنامه‌ای روی همین سرور (یا ماشینی که سرور به آن می‌رسد) که ترافیک را از یک VPN بیرون می‌برد و یک «پورت HTTP» باز می‌کند. همهٔ درخواست‌های خروجی گریفین (جز آدرس‌های لوکال) از آن می‌رود. اگر می‌خواهی فقط تلگرام و پروایدرها از VPN بروند و IPهای ایران و شبکهٔ داخلی مستقیم بمانند، به‌جای این از کادر «لینک VPN» بالا استفاده کن.")}</p>
          <p>{t("شکل‌های قابل قبول:")}</p>
          <ul className="list-inside list-disc space-y-0.5">
            <li><span dir="ltr">http://127.0.0.1:10809</span> {t("— Xray، v2ray یا v2rayN روی همین سرور (پورت HTTP)")}</li>
            <li><span dir="ltr">http://192.168.1.10:8118</span> {t("— پراکسی روی ماشین دیگری در شبکه")}</li>
            <li><span dir="ltr">http://user:pass@host:3128</span> {t("— پراکسی با نام کاربری و رمز")}</li>
          </ul>
          <p>{t("SOCKS (مثل")} <span dir="ltr">socks5://…</span>{t(") پشتیبانی نمی‌شود؛ پورت HTTP همان برنامه را بده.")}</p>
        </div>
        {state === "env" ? (
          <p className="text-xs text-muted-foreground">{t("پراکسی از متغیر محیطی (HTTPS_PROXY / CURSOR_PROXY) آمده؛ همان‌جا عوضش کن.")}</p>
        ) : (
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <input className={field} dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:10809" />
              <button type="button" onClick={save} disabled={Boolean(formError) || busy} className={`${primary} shrink-0`}>{busy ? <Loader2 className="size-4 animate-spin" /> : null} ذخیره و تست</button>
            </div>
            {formError ? <p className="text-xs text-amber-600">{formError}</p> : null}
          </div>
        )}
      </details>
      {probe?.viaProxy ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("از راه پراکسی")} <bdi dir="ltr">{probe.proxy}</bdi></p>
          <Reach rows={probe.viaProxy} via="proxy" />
          {viaOk && onSaved && !inline ? <button type="button" onClick={onSaved} className={primary}>{t("بعدی")} <ArrowLeft className="size-4 ltr:rotate-180" /></button> : null}
        </div>
      ) : null}
    </div>
  );
}

const faN = (n) => Number(n).toLocaleString("fa-IR");
const STALE_MS = 10 * 60_000;

// The owner's own routes for the built-in VPN (owner 2026-10-19: «بشه اونی که میخوایم دایرکت بشه رو مشخص کنیم»):
// what must always go direct, and what must always go through the VPN. A domain, an IP or a CIDR, one per
// line; the server cleans them and names the line it refuses. What is built in (the LAN, .ir) needs no line.
function RoutingBox({ list, onSaved }) {
  const saved = list.routing || {};
  const joined = (items) => (items || []).join("\n");
  const [direct, setDirect] = useState(joined(saved.direct));
  const [proxied, setProxied] = useState(joined(saved.proxied));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDirect(joined(saved.direct));
    setProxied(joined(saved.proxied));
  }, [joined(saved.direct), joined(saved.proxied)]);
  const dirty = direct.trim() !== joined(saved.direct) || proxied.trim() !== joined(saved.proxied);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api("/api/setup/vpn/rules", { method: "PUT", body: { direct, proxied } });
      onSaved(r.vpn);
      toast.success(t("مسیرها ذخیره شد"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const count = (saved.direct?.length || 0) + (saved.proxied?.length || 0);
  return (
    <details className="rounded-lg border bg-background px-3 py-2 text-xs leading-6" open={count > 0}>
      <summary className="cursor-pointer text-sm font-medium">
        مسیر ترافیک: چه چیزی مستقیم برود؟ {count ? <span className="text-xs font-normal text-muted-foreground">({count.toLocaleString("fa-IR")} مورد)</span> : null}
      </summary>
      <div className="space-y-3 pt-2">
        <p className="text-muted-foreground">
          بدون نوشتن چیزی، این‌ها همیشه مستقیم می‌روند: IPهای لوکال و شبکهٔ داخلی، دامنه‌های <span dir="ltr">.ir</span>، و هر چیزی که پروایدر یا تلگرام نیست.
          اگر چیز دیگری را هم می‌خواهی مستقیم باشد (یا برعکس، حتماً از VPN برود)، این‌جا بنویس: دامنه (<span dir="ltr">example.com</span>{t(")، IP یا رنج (")}<span dir="ltr">10.20.0.0/16</span>{t(")؛ هر خط یکی. آدرس کامل (")}<span dir="ltr">https://…</span>) هم می‌شود.
        </p>
        <label className="block space-y-1">
          <span className="font-medium">{t("همیشه مستقیم (بدون VPN)")}</span>
          <textarea className={`${field} min-h-20 font-mono text-xs`} dir="ltr" value={direct} onChange={(e) => setDirect(e.target.value)} placeholder={"api.z.ai\n185.10.20.0/24"} />
          <span className="block text-muted-foreground">{t("روی فهرست پروایدرها مقدم است؛ مثلاً اگر موتوری بدون VPN کار می‌کند، آدرسش را این‌جا بنویس.")}</span>
        </label>
        <label className="block space-y-1">
          <span className="font-medium">{t("همیشه از VPN")}</span>
          <textarea className={`${field} min-h-16 font-mono text-xs`} dir="ltr" value={proxied} onChange={(e) => setProxied(e.target.value)} placeholder={"my-tool.example.com"} />
          <span className="block text-muted-foreground">{t("برای سرویس خارجی که پروایدر نیست و بدون VPN باز نمی‌شود. لوکال و")} <span dir="ltr">.ir</span> {t("هیچ‌وقت از VPN نمی‌روند.")}</span>
        </label>
        <button type="button" onClick={save} disabled={busy || !dirty} className={primary}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null} ذخیره
        </button>
      </div>
    </details>
  );
}

// The built-in VPN (server vpn.mjs / setup-checks): v2ray links, a subscription URL or a v2ray JSON
// config are ADDED to a list. Every server stays on it with how its last test went (owner 2026-10-19:
// «ببینیم تا الان چیا اد کردیم و کدوما دارن کار میکنن»). Telegram and the AI providers go through the
// working ones; local, Iranian and all other traffic stays direct (decided inside Xray, not by the app).
// A country code → its flag and Persian name (the list shows where each server comes out).
const flagOf = (cc) => (cc ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "");
const countryName = (cc) => {
  try {
    return new Intl.DisplayNames(["fa"], { type: "region" }).of(cc) || cc;
  } catch {
    return cc;
  }
};
// Fastest first: working servers by their time, then the untested, then the dead ones.
const RANK = { live: 0, unknown: 1, dead: 2 };
const byDelay = (a, b) => RANK[a.state] - RANK[b.state] || (a.ms ?? 1e9) - (b.ms ?? 1e9);

function VpnBox({ onConnected }) {
  const [text, setText] = useState("");
  const [vpn, setVpn] = useState(null);
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState("");
  // Owner 2026-10-19: «به ترتیب تاخیر مرتب کرد و بتوان سرور و یا سرورهایی رو فعال و غیرفعال کرد».
  const [sort, setSort] = useState("delay");
  const [picked, setPicked] = useState(() => new Set());
  const load = () => api("/api/setup/vpn").then((r) => { setList(r.vpn); return r.vpn; }).catch(() => null);
  const recheck = async ({ quiet = false } = {}) => {
    setBusy("recheck");
    try {
      const r = await api("/api/setup/vpn/recheck", { method: "POST", body: { rewrite: !quiet } });
      setList(r.vpn);
      if (!quiet) toast.success(`${faN(r.vpn.servers.filter((s) => s.state === "live").length)} سرور از ${faN(r.vpn.servers.length)} الان کار می‌کند`);
    } catch (e) {
      if (!quiet) toast.error(e.message);
    } finally {
      setBusy("");
    }
  };
  useEffect(() => {
    api("/api/setup/status").then((r) => setVpn(r.vpn || null)).catch(() => {});
    // A list not tested for a while is tested again when the page opens (status only, the running config stays).
    load().then((l) => { if (l?.servers?.length && (!l.checkedAt || Date.now() - l.checkedAt > STALE_MS)) recheck({ quiet: true }); });
  }, []);
  if (vpn && !vpn.kit) return null;
  const add = async () => {
    setBusy("add");
    try {
      const r = await api("/api/setup/vpn", { method: "POST", body: { link: text.trim() } });
      setVpn(r.vpn);
      setText("");
      const v = r.vpn || {};
      toast.success(v.added ? `${faN(v.addedLive)} سرور از ${faN(v.added)} سرور تازه کار می‌کند؛ ${faN(v.servers)} سرور در حال استفاده است` : t("این سرورها از قبل در فهرست بودند؛ دوباره امتحان شدند"));
      await load();
      await onConnected?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  };
  const drop = async (s) => {
    setBusy(s.id);
    try {
      const r = await api(`/api/setup/vpn/servers/${s.id}`, { method: "DELETE" });
      setList(r.vpn);
      await onConnected?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  };
  const turn = async (ids, enabled) => {
    setBusy(ids.length === 1 ? `turn:${ids[0]}` : "turn");
    try {
      const r = await api("/api/setup/vpn/servers/enabled", { method: "PUT", body: { ids, enabled } });
      setList(r.vpn);
      setPicked(new Set());
      if (ids.length > 1) toast.success(`${faN(ids.length)} سرور ${enabled ? t("فعال") : t("غیرفعال")} شد`);
      await onConnected?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  };
  const pick = (id) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const clear = async () => {
    if (!window.confirm(t("همهٔ سرورهای VPN پاک شوند؟ تلگرام و موتورها دوباره مستقیم وصل می‌شوند."))) return;
    setBusy("clear");
    try {
      const r = await api("/api/setup/vpn", { method: "DELETE" });
      setList(r.vpn);
      await onConnected?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  };
  const all = list?.builtin ? list.servers : [];
  const servers = sort === "delay" ? [...all].sort(byDelay) : all;
  const liveCount = servers.filter((s) => s.state === "live").length;
  const offCount = servers.filter((s) => s.enabled === false).length;
  const chosen = servers.filter((s) => picked.has(s.id)).map((s) => s.id);
  const allPicked = servers.length > 0 && chosen.length === servers.length;
  const hosts = list?.routing?.hosts || [];
  return (
    <div className="space-y-3 g-card rounded-xl border p-3">
      <p className="text-sm font-medium">VPN (v2ray)</p>
      <p className="text-xs leading-6 text-muted-foreground">
        از VPN فقط <b>{t("تلگرام")}</b> {t("و")} <b>{t("پروایدرها")}</b> (Claude، Cursor، OpenAI، OpenRouter{hosts.length ? <>{t("، و آدرس موتورهایی که تنظیم کرده‌ای:")} <bdi dir="ltr">{hosts.join(", ")}</bdi></> : null}) رد می‌شوند.
        IPهای لوکال و شبکهٔ داخلی، دامنه‌ها و IPهای ایرانی و هر چیز دیگر مستقیم می‌مانند.
      </p>
      {servers.length ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className={`font-medium ${liveCount ? "" : "text-amber-600"}`}>{faN(servers.length)} سرور اضافه شده · {faN(liveCount)} سالم{offCount ? ` · ${faN(offCount)} غیرفعال` : ""}</span>
            <span className="flex items-center gap-1.5">
              <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label={t("ترتیب فهرست")} className="rounded-md border bg-background px-1.5 py-1">
                <option value="delay">{t("به ترتیب تأخیر")}</option>
                <option value="added">{t("به ترتیب اضافه شدن")}</option>
              </select>
              <button type="button" onClick={() => recheck()} disabled={Boolean(busy)} className="press inline-flex items-center gap-1 rounded-md border px-2 py-1 disabled:opacity-60">
                <RefreshCw className={`size-3.5 ${busy === "recheck" ? "animate-spin" : ""}`} /> {busy === "recheck" ? t("دارم امتحان می‌کنم…") : t("بررسی دوباره")}
              </button>
              <button type="button" onClick={clear} disabled={Boolean(busy)} className="press inline-flex items-center gap-1 rounded-md border px-2 py-1 text-bad disabled:opacity-60">{t("حذف همه")}</button>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(servers.map((s) => s.id)))} />
              {chosen.length ? `${faN(chosen.length)} انتخاب شده` : t("انتخاب همه")}
            </label>
            {chosen.length ? (
              <>
                <button type="button" onClick={() => turn(chosen, true)} disabled={Boolean(busy)} className="press rounded-md border px-2 py-1 disabled:opacity-60">{t("فعال کن")}</button>
                <button type="button" onClick={() => turn(chosen, false)} disabled={Boolean(busy)} className="press rounded-md border px-2 py-1 disabled:opacity-60">{t("غیرفعال کن")}</button>
                {busy === "turn" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              </>
            ) : null}
          </div>
          <ul className="divide-y rounded-lg border bg-background text-sm">
            {servers.map((s) => (
              <li key={s.id} className={`flex items-start gap-2 px-3 py-2 ${s.enabled === false ? "opacity-60" : ""}`}>
                <input type="checkbox" className="mt-1 shrink-0" checked={picked.has(s.id)} onChange={() => pick(s.id)} aria-label={`انتخاب ${s.name}`} />
                {s.state === "live" ? <Check className="mt-0.5 size-4 shrink-0 text-ok" /> : s.state === "dead" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" /> : <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-muted-foreground/40" />}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <bdi className="truncate font-medium" dir="auto">{s.name}</bdi>
                    {s.country ? (
                      <span className="rounded bg-muted px-1.5 text-[11px]" title={s.countryFrom === "exit" ? t("کشوری که ترافیک از آن بیرون می‌رود (اندازه‌گیری‌شده)") : t("از روی اسم سرور؛ هنوز اندازه‌گیری نشده")}>
                        {flagOf(s.country)} {countryName(s.country)}{s.countryFrom === "exit" ? "" : t("؟")}
                      </span>
                    ) : null}
                    {s.enabled === false ? <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">{t("غیرفعال")}</span> : s.inUse ? <span className="rounded bg-ok/10 px-1.5 text-[11px] text-ok">{t("در حال استفاده")}</span> : null}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground" dir="ltr">{s.protocol} · {s.address}{s.port ? `:${s.port}` : ""} · {s.network}{s.security !== "none" ? `/${s.security}` : ""}</span>
                  <span className="block text-[11px] leading-5 text-muted-foreground" title={s.checkedAt ? exactTime(s.checkedAt) : ""}>
                    {s.state === "live"
                      ? `Claude ${s.claude ? "✓" : "✗"} · تلگرام ${s.telegram ? "✓" : "✗"}${s.ms ? ` · ${faN(s.ms)} میلی‌ثانیه` : ""}`
                      : s.state === "dead" ? t("به Claude و تلگرام نرسید") : t("هنوز امتحان نشده")}
                    {s.checkedAt ? ` · ${clockLabel(s.checkedAt)}` : ""}
                  </span>
                </span>
                <button type="button" role="switch" aria-checked={s.enabled !== false} onClick={() => turn([s.id], s.enabled === false)} disabled={Boolean(busy)} dir="ltr" title={s.enabled === false ? t("فعال کن") : t("غیرفعال کن")} aria-label={s.enabled === false ? t("فعال کردن این سرور") : t("غیرفعال کردن این سرور")} className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60 ${s.enabled !== false ? "bg-primary" : "bg-muted"}`}>
                  {busy === `turn:${s.id}` ? <Loader2 className="mx-auto size-3.5 animate-spin" /> : <span className={`block size-4 rounded-full bg-background shadow transition-transform ${s.enabled !== false ? "translate-x-[1.125rem]" : "translate-x-0.5"}`} />}
                </button>
                <button type="button" onClick={() => drop(s)} disabled={Boolean(busy)} aria-label={t("حذف این سرور")} title={t("حذف این سرور")} className="press mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground hover:text-bad disabled:opacity-60">
                  {busy === s.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {list?.builtin ? <RoutingBox list={list} onSaved={setList} /> : null}
      <div className="space-y-2">
        <p className="text-xs leading-6 text-muted-foreground">
          {servers.length ? (
            t("سرور تازه به فهرست بالا اضافه می‌شود (قبلی‌ها پاک نمی‌شوند).")
          ) : (
            <>{t("یک یا چند لینک")} <span dir="ltr">vless:// vmess:// trojan:// ss://</span>{t("، لینک اشتراک (subscription) یا متن کانفیگ JSON را بچسبان. هر سرور جدا امتحان می‌شود؛ فقط آن‌هایی که واقعاً به Claude یا تلگرام می‌رسند در کار می‌مانند و سریع‌ترینشان خودکار انتخاب می‌شود.")}</>
          )}
        </p>
        <textarea className={`${field} min-h-24 font-mono text-xs`} dir="ltr" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("vless://…  یا  https://…/sub/…")} />
        <button type="button" onClick={add} disabled={Boolean(busy) || !text.trim()} className={primary}>
          {busy === "add" ? <Loader2 className="size-4 animate-spin" /> : null} {busy === "add" ? t("دارم وصل می‌کنم و امتحان می‌کنم…") : servers.length ? t("اضافه کن و امتحان کن") : t("وصل کن")}
        </button>
      </div>
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
  const shuffle = () => api(`/api/setup/random-name?not=${encodeURIComponent(name)}`).then((r) => { setName(r.name); setLatin(r.latin); }).catch((e) => toast.error(e.message));
  const save = async () => {
    try {
      const r = await api("/api/setup/persona", { method: "POST", body: { name, latin } });
      // The next steps (the monogram logo, the preview) show the new name at once.
      BRAND.name = AGENT_META.griffin.label = AGENT_META.griffin.short = name.trim();
      if (latin.trim()) BRAND.nameEn = latin.trim();
      if (r.restart) toast.message(t("نام تازه بعد از ری‌استارت سرور روی همه‌جا می‌نشیند."));
      onNext();
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Bot className="size-5" /> {t("نام دستیار")}</h2>
      <p className="text-sm leading-7 text-muted-foreground">{t("همکاران با این اسم صدایش می‌زنند و زیر پیام‌هایش امضا می‌شود. یک اسم تصادفی برایش گذاشته شده؛ نگهش دار، یکی دیگر بخواه یا خودت بنویس. «گریفین» (اسم خود برنامه) هم همچنان صدایش می‌زند.")}</p>
      {fromEnv ? <p className="text-xs text-muted-foreground">{t("اسم از متغیر محیطی GRIFFIN_ASSISTANT_NAME آمده؛ آن بر این فرم مقدم است.")}</p> : null}
      <div className="flex gap-2">
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("مثلاً آوا")} />
        <button type="button" onClick={shuffle} className="press inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm"><Shuffle className="size-4" /> {t("یک اسم دیگر")}</button>
      </div>
      <input className={field} dir="ltr" value={latin} onChange={(e) => setLatin(e.target.value)} placeholder="Latin, e.g. Ava" />
      <div className="flex gap-2">
        <button type="button" onClick={save} disabled={!name.trim()} className={primary}>{t("ذخیره")}</button>
        <button type="button" onClick={onNext} className="press rounded-lg border px-4 py-2 text-sm">{t("همین بماند")}</button>
      </div>
    </div>
  );
}

const SOURCES = [
  { id: "claude", label: t("Claude Code / Claude دسکتاپ"), blurb: t("گفتگوهای Claude Code (ترمینال، VS Code، تب Code دسکتاپ)") },
  { id: "karsara", label: t("کارسرا"), blurb: t("کل یک نصب کارسرا") },
  { id: "cursor", label: "Cursor", blurb: t("گفتگوهای ایجنت Cursor") },
];
const PACK = "tar -czf claude-history.tgz -C ~/.claude projects";
const PACK_WIN = "tar -czf claude-history.tgz -C $env:USERPROFILE\\.claude projects";

// Brings the owner's history from the tool he used before. Claude Code sessions come in as chats that
// resume the same Claude session (history-import.mjs, scripts/from-claude-desktop.mjs).
function ImportStep({ onNext }) {
  const [source, setSource] = useState(null);
  const [info, setInfo] = useState(null);
  const [where, setWhere] = useState("upload");
  const [dir, setDir] = useState("");
  const [upload, setUpload] = useState(null);
  const [sent, setSent] = useState(null); // upload progress 0..1
  const [preview, setPreview] = useState(null);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/api/setup/import").then((r) => { setInfo(r); setDir(r.defaultPath); if (r.found) setWhere("server"); }).catch(() => {});
  }, []);
  const target = () => (where === "upload" ? { upload } : { path: dir.trim() });
  const look = async (body = target()) => {
    setBusy(true);
    setPreview(null);
    setDone(null);
    try {
      setPreview(await api("/api/setup/import", { method: "POST", body: { ...body, dryRun: true } }));
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
  };
  const send = (file) => {
    if (!file) return;
    setSent(0);
    setPreview(null);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/setup/import/upload");
    xhr.upload.onprogress = (e) => e.lengthComputable && setSent(e.loaded / e.total);
    xhr.onload = () => {
      setSent(null);
      let r = {};
      try {
        r = JSON.parse(xhr.responseText);
      } catch {
        r = {};
      }
      if (xhr.status !== 200) return toast.error(r.error || `http ${xhr.status}`);
      setUpload(r.upload);
      look({ upload: r.upload });
    };
    xhr.onerror = () => {
      setSent(null);
      toast.error(t("فرستادن فایل قطع شد"));
    };
    xhr.send(file);
  };
  const run = async () => {
    setBusy(true);
    try {
      setDone(await api("/api/setup/import", { method: "POST", body: { ...target(), dryRun: false } }));
      setPreview(null);
      setUpload(null);
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
  };
  const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast.success(t("کپی شد")));
  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><History className="size-5" /> {t("انتقال از ابزار قبلی")}</h2>
      <div className="grid gap-2 sm:grid-cols-3">
        {SOURCES.map((s) => (
          <button key={s.id} type="button" onClick={() => setSource(s.id)} aria-pressed={source === s.id} className={`press g-card rounded-xl border p-3 text-start ${source === s.id ? "border-primary bg-primary/10 g-choice-on" : "hover:bg-muted/50"}`}>
            <span className="block text-sm font-medium">{s.label}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{s.blurb}</span>
          </button>
        ))}
      </div>
      {source === "cursor" ? (
        <p className="rounded-xl bg-muted/60 p-3 text-xs leading-6 text-muted-foreground">
          فعلاً نمی‌شود. Cursor گفتگوهایش را در پایگاه‌دادهٔ داخلی خودش با قالب بسته نگه می‌دارد و جلسه‌هایش بیرون از خود Cursor ادامه پیدا نمی‌کنند؛ هر انتقالی فقط متن خام بدون حافظه می‌شد. قواعد پروژه‌ات (پوشهٔ ‎.cursor/rules‎) داخل ریپو است و با خود ریپو می‌آید.
        </p>
      ) : null}
      {source === "karsara" ? (
        <div className="space-y-2 rounded-xl bg-muted/60 p-3 text-xs leading-6 text-muted-foreground">
          <p>{t("کارسرا کل نصب را (گفتگوها، جاب‌ها، دانش، تنظیمات) جابه‌جا می‌کند و از مرورگر نمی‌شود: یک دیتابیس تازه می‌سازد، پس باید پیش از شروع کار با این نصب و با هر دو برنامهٔ خاموش، روی سرور اجرا شود. اول با ‎--dry-run‎ ببین چه منتقل می‌شود؛ راهنمای کامل در README، بخش «Moving from Karsara».")}</p>
          <pre className="whitespace-pre-wrap break-all rounded-lg bg-background p-2" dir="ltr">node apps/server/scripts/from-karsara.mjs karsara.sqlite griffin.sqlite --dry-run</pre>
        </div>
      ) : null}
      {source === "claude" ? (
        <div className="space-y-3 rounded-2xl border bg-card p-4">
          <p className="text-xs leading-6 text-muted-foreground">{t("هر جلسهٔ Claude Code یک گفتگو این‌جا می‌شود و همان جلسه با حافظهٔ کامل ادامه پیدا می‌کند. ادامه دادنشان یک موتور Claude (اشتراک یا کلید) می‌خواهد. گفتگوهای معمولی سایت claude.ai فایلی روی کامپیوترت ندارند و منتقل نمی‌شوند. چیزی که قبلاً منتقل شده دوباره نمی‌آید.")}</p>
          <div className="flex flex-wrap gap-2 text-sm">
            <button type="button" onClick={() => { setWhere("upload"); setPreview(null); }} aria-pressed={where === "upload"} className={`press rounded-lg border px-3 py-1.5 ${where === "upload" ? "border-primary bg-primary/10 g-choice-on" : ""}`}>{t("از کامپیوتر خودم")}</button>
            <button type="button" onClick={() => { setWhere("server"); setPreview(null); }} aria-pressed={where === "server"} className={`press rounded-lg border px-3 py-1.5 ${where === "server" ? "border-primary bg-primary/10 g-choice-on" : ""}`}>{t("از پوشه‌ای روی همین سرور")}</button>
          </div>
          {where === "upload" ? (
            <div className="space-y-2 text-xs leading-6 text-muted-foreground">
              <p>{t("روی کامپیوتری که Claude Code داشتی، این دستور تاریخچه را در یک فایل می‌گذارد (مک و لینوکس در ترمینال، ویندوز در PowerShell):")}</p>
              {[PACK, PACK_WIN].map((cmd) => (
                <div key={cmd} className="flex items-center gap-2">
                  <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-muted p-2" dir="ltr">{cmd}</pre>
                  <button type="button" onClick={() => copy(cmd)} className="press shrink-0 rounded-lg border p-2" aria-label={t("کپی")}><Copy className="size-4" /></button>
                </div>
              ))}
              <p>{t("بعد فایل ‎claude-history.tgz‎ را این‌جا بده (تا ۱ گیگابایت؛ zip نه):")}</p>
              <input type="file" accept=".tgz,.gz,.tar,application/gzip,application/x-tar" onChange={(e) => send(e.target.files?.[0])} className="block w-full text-sm" />
              {sent !== null ? <p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> فرستادن… {Math.round(sent * 100)}٪</p> : null}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs leading-6 text-muted-foreground">پوشهٔ ‎.claude‎ (یا ‎projects‎ داخل آن) روی همین سرور. {info?.found ? t("در پوشهٔ پیش‌فرض تاریخچه پیدا شد.") : t("در پوشهٔ پیش‌فرض چیزی نیست.")} فقط داخل: <span dir="ltr">{info?.roots?.join(", ")}</span></p>
              <div className="flex gap-2">
                <input className={field} dir="ltr" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~/.claude" />
                <button type="button" onClick={() => look()} disabled={busy || !dir.trim()} className={`${primary} shrink-0`}>{busy ? <Loader2 className="size-4 animate-spin" /> : null} بررسی</button>
              </div>
            </div>
          )}
          {busy && !preview && !done ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("دارم گفتگوها را می‌خوانم…")}</p> : null}
          {preview ? (
            <div className="space-y-2 g-card rounded-xl border p-3 text-sm">
              <p>{preview.sessions} گفتگو در {preview.projects} پوشه پیدا شد: <b>{preview.toImport}</b> تازه{preview.already ? `، ${preview.already} قبلاً این‌جا هست` : ""}{preview.missing ? `، ${preview.missing} بدون فایل` : ""}.</p>
              {preview.titles?.length ? (
                <ul className="list-inside list-disc text-xs text-muted-foreground">
                  {preview.titles.map((t, i) => <li key={i} dir="auto" className="truncate">{t}</li>)}
                  {preview.toImport > preview.titles.length ? <li>…</li> : null}
                </ul>
              ) : null}
              {preview.toImport ? (
                <button type="button" onClick={run} disabled={busy} className={primary}>{busy ? <Loader2 className="size-4 animate-spin" /> : <History className="size-4" />} انتقال {preview.toImport} گفتگو</button>
              ) : <p className="text-xs text-muted-foreground">{t("چیز تازه‌ای برای انتقال نیست.")}</p>}
            </div>
          ) : null}
          {done ? <p className="flex items-center gap-2 text-sm text-ok"><Check className="size-4" /> {done.imported} گفتگو منتقل شد؛ در فهرست گفتگوها هستند و با همان حافظه ادامه می‌دهند.</p> : null}
        </div>
      ) : null}
      <button type="button" onClick={onNext} className="press rounded-lg border px-4 py-2 text-sm">{done ? t("بعدی") : t("فعلاً نه")}</button>
    </div>
  );
}

// Messenger: three ways, each spelled out (owner 2026-10-17: «اتصال تلگرام ویزارد درست ندارد»).
// A bot is the safe default; the owner's own account lets the assistant read and act in his chats.
const MESSENGERS = [
  { id: "telegram_bot", label: t("ربات تلگرام"), blurb: t("یک ربات تازه فقط برای تو؛ از گوشی با دستیار حرف می‌زنی و سؤال‌های تأیید را آن‌جا جواب می‌دهی."), link: "https://t.me/BotFather", where: t("در تلگرام ‎@BotFather را باز کن") },
  { id: "bale_bot", label: t("ربات بله"), blurb: t("همان ربات، در بله. اگر تلگرام از سرور در دسترس نیست، بله بدون پراکسی کار می‌کند."), link: "https://ble.ir/botfather", where: t("در بله ‎@botfather را باز کن") },
  { id: "telegram_account", label: t("اکانت تلگرام خودم"), blurb: t("دستیار با اکانت خودت وصل می‌شود: گروه‌ها و کانال‌ها را می‌خواند، در Saved Messages با تو حرف می‌زند و فقط با تأیید تو از طرفت پیام می‌فرستد.") },
];
const BOT_TOKEN = /^\d{5,}:[\w-]{30,}$/;

function TelegramStep({ onNext, optional }) {
  const [kind, setKind] = useState(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [bot, setBot] = useState(null);
  const [account, setAccount] = useState(false);
  const meta = MESSENGERS.find((m) => m.id === kind);
  const add = async () => {
    setBusy(true);
    try {
      const r = await api("/api/integrations", { method: "POST", body: { kind, token: token.trim(), name: kind === "bale_bot" ? "Bale" : "Telegram" } });
      setBot(r.integration);
    } catch (e) {
      toast.error(`${e.message} — توکن را دوباره از BotFather کپی کن؛ اگر درست است، احتمالاً سرور به ${kind === "bale_bot" ? t("بله") : t("تلگرام")} نمی‌رسد (قدم پراکسی).`);
    }
    setBusy(false);
  };
  // Waits for the Start press: the pairing link makes the owner's chat the bot's only chat.
  useEffect(() => {
    if (!bot || bot.paired?.length) return undefined;
    const t = setInterval(() => {
      api("/api/integrations").then((r) => {
        const now = (r.integrations || []).find((i) => i.id === bot.id);
        if (now?.paired?.length) setBot(now);
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [bot]);
  const link = bot?.username && bot?.pairingCode ? (kind === "bale_bot" ? `https://ble.ir/${bot.username}?start=${bot.pairingCode}` : `https://t.me/${bot.username}?start=${bot.pairingCode}`) : null;
  const done = account || bot?.paired?.length;
  const tokenBad = token.trim() && !BOT_TOKEN.test(token.trim());
  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Send className="size-5" /> {t("پیام‌رسان")}</h2>
      {!kind ? (
        <div className="grid gap-2">
          {MESSENGERS.map((m) => <Choice key={m.id} on={false} onClick={() => setKind(m.id)} label={m.label} blurb={m.blurb} />)}
        </div>
      ) : (
        <div className="space-y-3">
          <button type="button" onClick={() => { setKind(null); setBot(null); setToken(""); }} disabled={Boolean(bot) || account} className="press text-xs text-muted-foreground disabled:opacity-50">← {meta.label} (عوض کردن)</button>
          {kind === "telegram_account" ? (
            account ? (
              <p className="flex items-center gap-2 text-sm text-ok"><Check className="size-4" /> {t("اکانت تلگرام وصل شد. در Saved Messages به دستیار پیام بده.")}</p>
            ) : (
              <AccountLogin onDone={() => setAccount(true)} />
            )
          ) : bot ? (
            <ol className="space-y-3 rounded-2xl border bg-card p-4 text-sm">
              <li className="flex items-center gap-2 text-ok"><Check className="size-4" /> ربات وصل شد{bot.username ? ` (@${bot.username})` : ""}.</li>
              {bot.paired?.length ? (
                <li className="flex items-center gap-2 text-ok"><Check className="size-4" /> چت تو جفت شد ({bot.paired.map((p) => p.name).join(t("، "))}). یک پیام به ربات بده؛ جوابش همین‌جا هم دیده می‌شود.</li>
              ) : (
                <li className="space-y-1">
                  <p>{t("این لینک را باز کن و Start را بزن تا ربات فقط مال تو شود:")}</p>
                  {link ? <a href={link} target="_blank" rel="noreferrer" className="block break-all text-primary underline" dir="ltr">{link}</a> : null}
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> {t("منتظر زدن Start…")}</p>
                </li>
              )}
            </ol>
          ) : (
            <ol className="list-decimal space-y-2 ps-5 text-sm leading-7">
              <li>{meta.where}: <a href={meta.link} target="_blank" rel="noreferrer" className="text-primary underline" dir="ltr">{meta.link.replace("https://", "")}</a></li>
              <li>{t("بفرست")} <code dir="ltr">/newbot</code>{t("، یک اسم بده و بعد یک نام کاربری که به")} <code dir="ltr">bot</code> {t("ختم شود.")}</li>
              <li>{t("توکنی که می‌دهد (شبیه")} <code dir="ltr">123456:ABC…</code>{t(") را این‌جا بگذار:")}</li>
              <li className="list-none space-y-2">
                <input className={field} dir="ltr" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456:ABC…" />
                {tokenBad ? <p className="text-xs text-destructive">{t("این شبیه توکن ربات نیست؛ کل توکن را از پیام BotFather کپی کن (عدد، دونقطه، بعد حروف).")}</p> : null}
                <button type="button" onClick={add} disabled={busy || !token.trim() || tokenBad} className={primary}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />} وصل کن و تست کن</button>
              </li>
            </ol>
          )}
        </div>
      )}
      <button type="button" onClick={onNext} className="press rounded-lg border px-4 py-2 text-sm">{done ? t("بعدی") : optional ? t("فعلاً نه") : t("رد شدن")}</button>
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
      <p className="text-sm leading-7 text-muted-foreground">{t("برای Claude Code یا هر کلاینت MCP یک توکن جدا می‌سازد. دسترسی‌اش پیش‌فرض فقط‌خواندنی است و از صفحهٔ «ایجنت‌های همکاران» قابل تغییر و ابطال است.")}</p>
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

// The last page: what is set, what is still missing (each with a way back to it), and the doctor's
// own check of the install.
function Done({ onClose, goto, first }) {
  const [report, setReport] = useState(null);
  const [state, setState] = useState(null);
  useEffect(() => {
    api("/api/doctor").then(setReport).catch(() => {});
    if (!first) return;
    Promise.all([
      api("/api/setup").catch(() => ({})),
      api("/api/setup/proxy").catch(() => ({})),
      api("/api/setup/brand").catch(() => ({})),
      api("/api/integrations").catch(() => ({})),
    ]).then(([setup, proxy, brand, integrations]) => setState({ setup, proxy, brand, integrations: integrations.integrations || [] }));
  }, [first]);
  const bad = report?.checks?.filter((c) => c.level !== "ok") || [];
  const messenger = state?.integrations.find((i) => /telegram|bale/.test(i.kind || ""));
  const rows = state
    ? [
        { step: "engine", ok: !state.setup.needsEngine, value: state.setup.needsEngine ? t("هنوز هیچ موتوری وصل نیست — بدون آن دستیار جواب نمی‌دهد") : t("وصل است") },
        { step: "proxy", ok: Boolean(state.proxy.url || state.proxy.fromEnv), optional: true, value: state.proxy.fromEnv ? t("از متغیر محیطی") : state.proxy.url || t("تنظیم نشده (اگر موتور جواب داد لازم نیست)") },
        { step: "name", ok: Boolean(state.setup.persona?.name), value: state.setup.persona?.name || "—" },
        { step: "appearance", ok: true, value: state.brand.custom ? t("لوگو و رنگ خودت") : t("ظاهر پیش‌فرض گریفین") },
        { step: "telegram", ok: Boolean(messenger), optional: true, value: messenger ? `${messenger.name || messenger.kind}${messenger.username ? ` (@${messenger.username})` : ""}` : t("وصل نیست") },
      ]
    : [];
  return (
    <div className="space-y-5">
      <Check className="size-8 text-ok" />
      <h2 className="text-xl font-semibold">{first ? t("خلاصهٔ راه‌اندازی") : t("آماده است")}</h2>
      {first ? (
        !state ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("در حال خواندن…")}</p> : (
          <ul className="divide-y rounded-2xl border bg-card">
            {rows.map((r) => (
              <li key={r.step} className="flex items-center gap-3 px-3 py-2.5">
                {r.ok ? <Check className="size-4 shrink-0 text-ok" /> : <CircleAlert className={`size-4 shrink-0 ${r.optional ? "text-muted-foreground" : "text-bad"}`} />}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{STEPS[r.step].label}{r.optional ? <span className="ms-1 text-xs font-normal text-muted-foreground">{t("(اختیاری)")}</span> : null}</span>
                  <span className="block truncate text-xs text-muted-foreground" dir="auto">{r.value}</span>
                </span>
                <button type="button" onClick={() => goto(r.step)} className="press shrink-0 rounded-lg border px-3 py-1 text-xs">{r.ok ? t("تغییر") : t("تنظیم")}</button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {!report ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("چک نهایی…")}</p> : bad.length ? (
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">{t("چک نهایی چند مورد پیدا کرد (تنظیمات → سلامت):")}</p>
          {bad.map((c) => <p key={c.id} className={c.level === "error" ? "text-bad" : "text-amber-600"}>• {tr(c.title, c.vars)}</p>)}
        </div>
      ) : <p className="text-sm text-ok">{t("چک نهایی: همه‌چیز سالم است.")}</p>}
      {first ? <p className="text-xs leading-6 text-muted-foreground">{t("هر کدام را بعداً هم می‌شود عوض کرد: تنظیمات → سلامت (ویزاردها) و تنظیمات → ظاهر.")}</p> : null}
      <button type="button" onClick={onClose} className={primary}>{first ? t("شروع گفتگو") : t("تمام")}</button>
    </div>
  );
}

