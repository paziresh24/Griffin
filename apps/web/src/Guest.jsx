import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Lock, Moon, Send, Sun } from "lucide-react";
import { ApiBase } from "./base.js";
import { GriffinRuntime } from "./runtime.jsx";
import { Thread } from "./components/Thread.jsx";
import { pollDelay, pollQuery } from "./guest-poll.js";
import { BRAND, iconUrl } from "./brand.js";
import { codeDigits } from "./guest.js";
import { isRtl, t } from "./i18n.js";

const noop = () => {};
const NOTE_MAX = 2000;

async function call(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, data };
}

// A chat shared privately with one person: first a code from their Telegram binds this device, then
// the chat reads live and they may leave notes. They never talk to the agent.
export function GuestChat({ token }) {
  const base = `/api/guest/${token}`;
  const [state, setState] = useState({ loading: true });
  const [theme, setTheme] = useState(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));
  const timer = useRef(null);
  const last = useRef(null); // what the page holds: { timeline, rev } (guest-poll.js)

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const { status, data } = await call(`${base}${pollQuery(last.current)}`);
      if (status === 404) return setState({ error: t("این لینک وجود ندارد یا صاحب گفتگو آن را بسته است.") });
      // Another device holds the link: a fresh code (to the same Telegram) moves it here.
      if (status === 403 && data.state === "other_device") return setState({ needsCode: true, moved: true, grantee: data.grantee });
      if (data.state === "needs_code") return setState({ needsCode: true, grantee: data.grantee });
      // A passing server or CDN error (a deploy, a 502): keep what is on screen and try again.
      if (data.state !== "open") throw new Error(`http ${status}`);
      // Nothing new since what the page holds: one line, the screen stays.
      if (data.unchanged && last.current) {
        timer.current = setTimeout(load, pollDelay(last.current.timeline));
        return;
      }
      last.current = { timeline: data.timeline, rev: data.rev || null };
      setState({ chat: data.chat, grantee: data.grantee, timeline: data.timeline });
      document.title = `${data.chat.title} · ${BRAND.title}`;
      timer.current = setTimeout(load, pollDelay(data.timeline));
    } catch {
      setState((s) => (s.chat ? s : { error: t("اتصال برقرار نشد؛ چند لحظه بعد خودش دوباره تلاش می‌کند.") }));
      timer.current = setTimeout(load, 15000);
    }
  }, [base]);

  useEffect(() => {
    load();
    return () => clearTimeout(timer.current);
  }, [load]);

  if (state.needsCode) return <CodeStep base={base} grantee={state.grantee} moved={state.moved} onDone={load} />;
  if (state.error || state.loading) {
    return (
      <Centered>
        <p className="text-muted-foreground">{state.error || t("در حال بارگذاری…")}</p>
      </Centered>
    );
  }

  return (
    <ApiBase.Provider value={base}>
      <div className="flex h-dvh flex-col">
        <GriffinRuntime chatId={null} timeline={state.timeline || { messages: [], lastEventId: 0 }} settings={{ mode: "agent", model: "" }} onError={noop}>
          <Thread
            readOnly
            header={
              <header className="flex items-center gap-2 border-b px-3 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)] sm:px-4">
                <img src={iconUrl()} alt="" className="size-6" />
                <h1 className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">{state.chat.title}</h1>
                <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                  <Lock className="size-3.5" /> {t("فقط برای شما")}
                </span>
                <button type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="press flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label={t("تم")}>
                  {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                </button>
              </header>
            }
          />
        </GriffinRuntime>
        <NoteBox base={base} onSent={load} />
      </div>
    </ApiBase.Provider>
  );
}

function Centered({ children }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center" dir={isRtl ? "rtl" : "ltr"}>
      <img src={iconUrl()} alt="" className="size-12 opacity-80" />
      {children}
    </div>
  );
}

function CodeStep({ base, grantee, moved, onDone }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const sendCode = async () => {
    setBusy(true);
    setError("");
    const { ok, data } = await call(`${base}/code`, { method: "POST" }).catch(() => ({ ok: false, data: {} }));
    setBusy(false);
    if (ok) setSent(true);
    else setError(data.error || t("ارسال کد ممکن نشد."));
  };

  const claim = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const { ok, data } = await call(`${base}/claim`, { method: "POST", body: { code } }).catch(() => ({ ok: false, data: {} }));
    setBusy(false);
    if (ok) onDone();
    else setError(data.error || t("کد پذیرفته نشد."));
  };

  return (
    <Centered>
      <h1 className="text-base font-medium">{moved ? t("این لینک روی دستگاه دیگری باز شده") : t("گفتگویی با شما به اشتراک گذاشته شده")}</h1>
      <p className="max-w-sm text-sm leading-6 text-muted-foreground">
        {moved
          ? t("با کدی که به تلگرامِ {who} می‌رود، روی همین دستگاه باز می‌شود و روی دستگاه قبلی بسته.", { who: grantee || t("شما") })
          : t("برای باز کردن آن، کدی به تلگرامِ {who} فرستاده می‌شود. بعد از ورودِ کد، این لینک فقط روی همین دستگاه باز می‌شود.", { who: grantee || t("شما") })}
      </p>
      {sent ? (
        <form onSubmit={claim} className="flex w-full max-w-xs flex-col gap-2">
          <input
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(codeDigits(e.target.value))}
            placeholder={t("کد ۶ رقمی")}
            className="ltr rounded-lg border bg-background px-3 py-2 text-center font-mono text-lg tracking-widest outline-none focus:ring-2 focus:ring-primary/40"
          />
          <button type="submit" disabled={busy || code.length !== 6} className="press flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 font-medium text-primary-foreground disabled:opacity-50">
            {busy ? <Loader2 className="size-4 animate-spin" /> : null} {t("ورود")}
          </button>
          <button type="button" disabled={busy} onClick={sendCode} className="text-xs text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50">
            {t("کد نرسید؟ دوباره بفرست")}
          </button>
        </form>
      ) : (
        <button type="button" disabled={busy} onClick={sendCode} className="press flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("ارسال کد به تلگرام")}
        </button>
      )}
      {error ? <p className="text-sm text-bad">{error}</p> : null}
    </Centered>
  );
}

function NoteBox({ base, onSent }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setBusy(true);
    setError("");
    const { ok, data } = await call(`${base}/notes`, { method: "POST", body: { text: value } }).catch(() => ({ ok: false, data: {} }));
    setBusy(false);
    if (!ok) return setError(data.error || t("ثبت یادداشت ممکن نشد."));
    setText("");
    onSent();
  };

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-3xl border-t px-3 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2 sm:px-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, NOTE_MAX))}
          rows={1}
          placeholder={t("یادداشتی برای صاحب گفتگو…")}
          className="max-h-40 min-h-10 flex-1 resize-none rounded-xl border bg-background px-3 py-2 text-sm leading-6 outline-none focus:ring-2 focus:ring-primary/40"
          dir={text ? "auto" : isRtl ? "rtl" : "ltr"}
        />
        <button type="submit" disabled={busy || !text.trim()} className="press flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50" aria-label={t("ثبت یادداشت")}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{error || t("یادداشت در همین گفتگو به صاحبش نشان داده می‌شود؛ ایجنت آن را اجرا نمی‌کند.")}</p>
    </form>
  );
}
