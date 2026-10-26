import { useEffect, useState } from "react";
import { Fingerprint, KeyRound, ShieldCheck } from "lucide-react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { BRAND, iconUrl } from "../brand.js";
import { loginError } from "../login-error.js";
import { t } from "../i18n.js";
import { TwoStepSection } from "./TwoStep.jsx";

export function AuthGate({ children }) {
  // "checking" | "in" | "out" | "setup" (signed in, but this install requires two-step sign-in first)
  const [state, setState] = useState("checking");
  const [round, setRound] = useState(0);

  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer = null;
    // Only a real "not signed in" answer shows the login page. A server that is restarting or
    // unreachable is retried quietly, so a signed-in owner never meets a surprise login screen.
    const check = () =>
      fetch("/api/auth/me", { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((body) => alive && setState(!body.authenticated ? "out" : body.setupRequired ? "setup" : "in"))
        .catch(() => {
          if (!alive) return;
          setOffline(true);
          timer = setTimeout(check, 3000);
        });
    check();
    const onUnauthorized = () => setState("out");
    const onSetup = () => setState("setup");
    window.addEventListener("griffin:unauthorized", onUnauthorized);
    window.addEventListener(SETUP_EVENT, onSetup);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener("griffin:unauthorized", onUnauthorized);
      window.removeEventListener(SETUP_EVENT, onSetup);
    };
  }, [round]);
  const recheck = () => setRound((n) => n + 1);

  if (state === "checking") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3">
        <img src={iconUrl()} alt="" className="g-login-logo size-12 rounded-xl ring-2 ring-brand/40" />
        <span className="agent-dots text-brand" aria-hidden><i /><i /><i /></span>
        {offline ? <p className="text-sm text-muted-foreground">{t("سرور در دسترس نیست؛ دوباره وصل می‌شوم…")}</p> : null}
      </div>
    );
  }
  if (state === "setup") return <RequiredTwoStep onDone={recheck} />;
  return state === "in" ? children : <Login onDone={recheck} />;
}

// api.js raises it when the server answers 403 { setupRequired }.
export const SETUP_EVENT = "griffin:setup-2fa";

// The first sign-in on an install that requires two-step sign-in (owner 2026-10-25): nothing else
// opens until the authenticator app is set up and the recovery codes are saved.
function RequiredTwoStep({ onDone }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-3 px-1">
          <img src={iconUrl()} alt="" className="size-10" />
          <div>
            <h1 className="font-semibold">{t("ورود دومرحله‌ای را راه بیندازید")}</h1>
            <p className="text-xs leading-5 text-muted-foreground">{t("از این به بعد ورود با توکن به‌تنهایی کافی نیست؛ یک بار اپ Authenticator گوشی را وصل کنید.")}</p>
          </div>
        </div>
        <TwoStepSection required onDone={onDone} />
      </div>
    </div>
  );
}

const post = (url, body) =>
  fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function Login({ onDone }) {
  const [token, setToken] = useState("");
  // Two-step sign-in is on: after a right token the server asks for the authenticator code.
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // A passkey for this name (Windows Hello, Touch ID, a phone) signs in alone — no token, no code.
  const [passkey, setPasskey] = useState(false);
  useEffect(() => {
    if (!window.isSecureContext || !browserSupportsWebAuthn()) return;
    post("/api/auth/passkey/options", { probe: true })
      .then((r) => r.json())
      .then((r) => setPasskey(Boolean(r.available)), () => {});
  }, []);

  const withPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await (await post("/api/auth/passkey/options", {})).json();
      if (!challengeId) return setPasskey(false);
      const response = await startAuthentication({ optionsJSON: options });
      const done = await post("/api/auth/passkey/login", { challengeId, response });
      if (done.ok) return onDone();
      const body = await done.json().catch(() => ({}));
      setError(done.status === 429 ? loginError(429, body) : t("passkey پذیرفته نشد؛ دوباره امتحان کنید یا با توکن وارد شوید."));
    } catch (e) {
      // The person closed the Windows Hello / browser prompt: nothing to say.
      if (e?.name !== "NotAllowedError" && e?.name !== "AbortError") setError(t("passkey در دسترس نبود؛ با توکن وارد شوید."));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim(), ...(needCode ? { code: code.trim() } : {}) }),
      });
      if (response.ok) return onDone();
      const body = await response.json().catch(() => ({}));
      if (body.needCode && !needCode) {
        setNeedCode(true);
        return;
      }
      setCode("");
      setError(loginError(response.status, body));
    } catch {
      setError(loginError(0));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <img src={iconUrl()} alt="" className="size-10" />
          <div>
            <h1 className="font-semibold">{BRAND.title}</h1>
            <p className="text-xs text-muted-foreground">{t("ورود با توکن Owner")}</p>
          </div>
        </div>
        <input type="text" name="username" value="owner" autoComplete="username" readOnly hidden />
        <label className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 focus-within:border-primary/60">
          <KeyRound className="size-4 text-muted-foreground" />
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="ltr w-full bg-transparent outline-none"
            autoFocus={!needCode}
            readOnly={needCode}
          />
        </label>
        {needCode ? (
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 focus-within:border-primary/60">
              <ShieldCheck className="size-4 text-muted-foreground" />
              <input
                name="one-time-code"
                autoComplete="one-time-code"
                inputMode="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t("کد ۶ رقمی")}
                className="ltr w-full bg-transparent text-center tracking-[0.3em] outline-none"
                autoFocus
              />
            </label>
            <p className="text-xs leading-5 text-muted-foreground">{t("کد اپ Authenticator گوشی‌تان را بزنید؛ اگر گوشی دم دست نیست، یکی از کدهای بازیابی.")}</p>
          </div>
        ) : null}
        {error ? <p className="text-sm text-bad">{error}</p> : null}
        <button
          type="submit"
          disabled={!token.trim() || (needCode && !code.trim()) || busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2 font-medium text-primary-foreground disabled:opacity-40"
        >
          {busy ? <span className="agent-dots" aria-hidden><i /><i /><i /></span> : null} {t("ورود")}
        </button>
        {passkey && !needCode ? (
          <button
            type="button"
            onClick={withPasskey}
            disabled={busy}
            className="press flex w-full items-center justify-center gap-2 rounded-lg border py-2 text-sm font-medium hover:bg-muted/50 disabled:opacity-40"
          >
            <Fingerprint className="size-4" /> {t("ورود با passkey (Windows Hello، اثر انگشت…)")}
          </button>
        ) : null}
      </form>
    </div>
  );
}
