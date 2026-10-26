import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Fingerprint, Loader2, Plus, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { toast } from "sonner";
import { api } from "../api.js";
import { Group, Item } from "./SettingsParts.jsx";
import { TWO_STEP_EVENT } from "../two-step-nudge.js";
import { t } from "../i18n.js";

// Two-step sign-in (auth.mjs): once on, the token alone no longer opens this from the network — the
// authenticator app's 6-digit code (or a one-time recovery code) is needed too, and the token as a
// Bearer header works only on the server itself.
// required: the setup screen after sign-in (Login.jsx) — setup starts at once, onDone once the codes are saved.
export function TwoStepSection({ required = false, onDone = null }) {
  const [state, setState] = useState(null);
  // "setup" (QR shown, waiting for the first code) | "codes" (recovery codes shown once) | "off" | "renew"
  const [step, setStep] = useState(null);
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api("/api/auth/2fa").then(
        (s) => {
          setState(s);
          // The sidebar's «روشن کنید» line (TwoStepNotice.jsx) follows what this page sees.
          window.dispatchEvent(new CustomEvent(TWO_STEP_EVENT, { detail: s }));
        },
        () => setState({ enabled: false, failed: true }),
      ),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  const started = useRef(false);
  useEffect(() => {
    if (!required || started.current) return;
    started.current = true;
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [required]);

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      // The QR waited more than ten minutes: a fresh one, scanned again.
      if (e.message === "setup expired") {
        toast(t("کد QR منقضی شد؛ کد تازه را دوباره اسکن کنید"));
        return start();
      }
      toast.error(e.message === "invalid code" ? t("کد درست نیست یا قبلاً استفاده شده") : e.message);
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    run(async () => {
      setSetup(await api("/api/auth/2fa/setup", { method: "POST" }));
      setCode("");
      setStep("setup");
    });
  const confirm = (event) => {
    event.preventDefault();
    run(async () => {
      const r = await api("/api/auth/2fa/enable", { method: "POST", body: { code: code.trim() } });
      setSetup(null);
      setCode("");
      setCodes(r.recoveryCodes || []);
      setStep("codes");
      load();
      toast.success(t("ورود دومرحله‌ای روشن شد؛ بقیهٔ دستگاه‌ها خارج شدند"));
    });
  };
  const submitCode = (event) => {
    event.preventDefault();
    run(async () => {
      if (step === "off") {
        await api("/api/auth/2fa/disable", { method: "POST", body: { code: code.trim() } });
        toast(t("ورود دومرحله‌ای خاموش شد"));
        setStep(null);
      } else {
        const r = await api("/api/auth/2fa/recovery", { method: "POST", body: { code: code.trim() } });
        setCodes(r.recoveryCodes || []);
        setStep("codes");
      }
      setCode("");
      load();
    });
  };

  const field = "ltr w-full rounded-lg border bg-background px-3 py-2 text-center text-sm tracking-[0.3em] outline-none focus:border-primary";
  const button = "press rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm disabled:opacity-50";
  const codeForm = (label, onSubmit) => (
    <form onSubmit={onSubmit} className="mx-4 mb-3 flex items-center gap-2">
      <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" placeholder={t("کد ۶ رقمی")} className={field} autoFocus aria-label={t("کد")} />
      <button type="submit" disabled={!code.trim() || busy} className={button}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : label}
      </button>
    </form>
  );

  if (!state) return null;
  const on = state.enabled;
  return (
    <>
    <Group title={t("ورود دومرحله‌ای")}>
      <Item
        icon={on ? ShieldCheck : ShieldAlert}
        tint={on ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"}
        title={on ? t("روشن است") : t("خاموش است — فقط توکن کافی است")}
        subtitle={
          on
            ? t("ورود از شبکه: توکن + کد اپ Authenticator · {toLocaleString} کد بازیابی مانده", { toLocaleString: Number(state.recoveryLeft || 0).toLocaleString("fa-IR") })
            : t("اگر توکن لو برود هر کسی وارد می‌شود؛ روشنش کنید")
        }
        onClick={on || step ? undefined : start}
      >
        {step === "setup" && setup ? (
          <div className="mx-4 mb-3 space-y-3 rounded-xl border bg-muted/40 p-3">
            <p className="text-xs leading-5 text-muted-foreground">
              {t("با اپ Authenticator گوشی (Google Authenticator، Microsoft Authenticator، 1Password، Bitwarden…) این کد QR را اسکن کنید، بعد کد ۶ رقمی‌ای را که اپ نشان می‌دهد بزنید.")}
            </p>
            <div className="mx-auto w-44 overflow-hidden rounded-lg bg-white p-1" dangerouslySetInnerHTML={{ __html: setup.svg }} />
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("کلید دستی:")}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs" dir="ltr">{setup.secret}</code>
              <CopyButton text={setup.secret} />
            </div>
            {codeForm(t("روشن کن"), confirm)}
          </div>
        ) : null}
        {step === "codes" && codes.length ? (
          <div className="mx-4 mb-3 space-y-2 rounded-xl border bg-muted/40 p-3">
            <p className="text-xs leading-5 text-muted-foreground">
              {t("کدهای بازیابی فقط همین یک بار نشان داده می‌شوند. هر کدام یک بار به‌جای کد اپ کار می‌کند (اگر گوشی گم شد). جای امن نگهشان دارید، مثلاً Infisical — نه در چت.")}
            </p>
            <div className="grid grid-cols-2 gap-1 font-mono text-xs" dir="ltr">
              {codes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <CopyButton text={codes.join("\n")} />
              <button type="button" onClick={() => (required ? onDone?.() : setStep(null))} className="press rounded-full border px-3 py-1 text-xs">
                {t("ذخیره کردم")}
              </button>
            </div>
          </div>
        ) : null}
      </Item>
      {on && !required ? (
        <>
          <Item icon={ShieldCheck} title={t("کدهای بازیابی تازه")} subtitle={t("کدهای قبلی باطل می‌شوند؛ کد اپ لازم است")} onClick={step ? undefined : () => setStep("renew")}>
            {step === "renew" ? codeForm(t("بساز"), submitCode) : null}
          </Item>
          {state.required ? null : <Item icon={ShieldAlert} tint="bg-bad/10 text-bad" title={t("خاموش کردن ورود دومرحله‌ای")} subtitle={t("کد اپ لازم است؛ بعدش دوباره فقط توکن کافی است")} onClick={step ? undefined : () => setStep("off")}>
            {step === "off" ? codeForm(t("خاموش کن"), submitCode) : null}
          </Item>}
        </>
      ) : null}
    </Group>
    {required ? null : <PasskeysSection twoStep={on} onChange={load} />}
    </>
  );
}

// A name for the new passkey from the device it is made on.
function deviceName() {
  const ua = navigator.userAgent || "";
  if (/Windows/i.test(ua)) return "Windows Hello";
  if (/iPhone|iPad/i.test(ua)) return "iPhone / iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Mac OS X/i.test(ua)) return "Mac (Touch ID)";
  return "Passkey";
}

// Passkeys (passkeys.mjs): Windows Hello, Touch ID or a phone signs in alone. Adding one asks for the
// authenticator code (two-step on) or the token (off), so a stolen session cannot plant one.
function PasskeysSection({ twoStep, onChange }) {
  const [items, setItems] = useState(null);
  const [adding, setAdding] = useState(false);
  const [proof, setProof] = useState("");
  const [name, setName] = useState(deviceName);
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== "undefined" && window.isSecureContext && browserSupportsWebAuthn();
  const load = useCallback(() => api("/api/auth/passkeys").then((r) => setItems(r.passkeys || []), () => setItems([])), []);
  useEffect(() => {
    load();
  }, [load]);

  const add = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { challengeId, options } = await api("/api/auth/passkeys/options", { method: "POST", body: twoStep ? { code: proof.trim() } : { token: proof.trim() } });
      const response = await startRegistration({ optionsJSON: options });
      await api("/api/auth/passkeys", { method: "POST", body: { challengeId, response, name: name.trim() } });
      toast.success(t("passkey اضافه شد؛ از این به بعد با همین دستگاه وارد شوید"));
      setAdding(false);
      setProof("");
      load();
      onChange?.();
    } catch (e) {
      if (e?.name === "NotAllowedError" || e?.name === "AbortError") toast(t("لغو شد"));
      else if (e?.name === "InvalidStateError") toast.error(t("این دستگاه قبلاً passkey دارد"));
      else toast.error(e.message === "invalid code" ? t("کد درست نیست یا قبلاً استفاده شده") : e.message === "invalid token" ? t("توکن درست نیست") : e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (item) => {
    if (!window.confirm(t("passkey «{name}» پاک شود؟ آن دستگاه دیگر بدون توکن وارد نمی‌شود.", { name: item.name }))) return;
    try {
      await api(`/api/auth/passkeys/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (!items) return null;
  const field = "ltr w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary";
  return (
    <Group title={t("Passkey (Windows Hello، اثر انگشت، گوشی)")}>
      {items.map((item) => (
        <Item
          key={item.id}
          icon={Fingerprint}
          tint="bg-primary/10 text-primary"
          title={item.name}
          subtitle={`${item.rpID} · ${item.lastUsedAt ? t("آخرین ورود {toLocaleDateString}", { toLocaleDateString: new Date(item.lastUsedAt).toLocaleDateString("fa-IR") }) : t("هنوز استفاده نشده")}`}
          trailing={
            <button type="button" onClick={() => remove(item)} className="press flex size-8 items-center justify-center rounded-md text-bad hover:bg-bad/10" aria-label={t("پاک کردن")}>
              <Trash2 className="size-4" />
            </button>
          }
        />
      ))}
      <Item
        icon={Plus}
        title={t("افزودن passkey برای همین دستگاه")}
        subtitle={supported ? t("بعدش ورود فقط با Windows Hello / اثر انگشت؛ بدون توکن") : t("فقط وقتی صفحه با نشانی اصلی و HTTPS باز شده (نه با IP)")}
        onClick={supported && !adding ? () => setAdding(true) : undefined}
      >
        {adding ? (
          <form onSubmit={add} className="mx-4 mb-3 space-y-2">
            <input
              value={proof}
              onChange={(e) => setProof(e.target.value)}
              type={twoStep ? "text" : "password"}
              autoComplete={twoStep ? "one-time-code" : "current-password"}
              placeholder={twoStep ? t("کد ۶ رقمی اپ Authenticator") : t("توکن ورود")}
              className={field}
              autoFocus
              aria-label={twoStep ? t("کد") : t("توکن")}
            />
            <div className="flex items-center gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} dir="auto" placeholder={t("نام دستگاه")} className={`${field} flex-1`} aria-label={t("نام دستگاه")} />
              <button type="submit" disabled={!proof.trim() || busy} className="press rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm disabled:opacity-50">
                {busy ? <Loader2 className="size-4 animate-spin" /> : t("بساز")}
              </button>
            </div>
            {!twoStep ? <p className="text-xs leading-5 text-muted-foreground">{t("توکن هنوز به‌تنهایی هم کار می‌کند؛ برای بستنش ورود دومرحله‌ای را هم روشن کنید.")}</p> : null}
          </form>
        ) : null}
      </Item>
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
      aria-label={t("کپی")}
    >
      {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}
