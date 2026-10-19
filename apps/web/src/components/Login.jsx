import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { BRAND, iconUrl } from "../brand.js";
import { loginError } from "../login-error.js";
import { t } from "../i18n.js";

export function AuthGate({ children }) {
  const [state, setState] = useState("checking");

  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer = null;
    // Only a real "not signed in" answer shows the login page. A server that is restarting or
    // unreachable is retried quietly, so a signed-in owner never meets a surprise login screen.
    const check = () =>
      fetch("/api/auth/me", { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((body) => alive && setState(body.authenticated ? "in" : "out"))
        .catch(() => {
          if (!alive) return;
          setOffline(true);
          timer = setTimeout(check, 3000);
        });
    check();
    const onUnauthorized = () => setState("out");
    window.addEventListener("griffin:unauthorized", onUnauthorized);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener("griffin:unauthorized", onUnauthorized);
    };
  }, []);

  if (state === "checking") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3">
        <img src={iconUrl()} alt="" className="g-login-logo size-12 rounded-xl ring-2 ring-brand/40" />
        <span className="agent-dots text-brand" aria-hidden><i /><i /><i /></span>
        {offline ? <p className="text-sm text-muted-foreground">{t("سرور در دسترس نیست؛ دوباره وصل می‌شوم…")}</p> : null}
      </div>
    );
  }
  return state === "in" ? children : <Login onDone={() => setState("in")} />;
}

function Login({ onDone }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (response.ok) return onDone();
      setError(loginError(response.status, await response.json().catch(() => ({}))));
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
            autoFocus
          />
        </label>
        {error ? <p className="text-sm text-bad">{error}</p> : null}
        <button
          type="submit"
          disabled={!token.trim() || busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2 font-medium text-primary-foreground disabled:opacity-40"
        >
          {busy ? <span className="agent-dots" aria-hidden><i /><i /><i /></span> : null} {t("ورود")}
        </button>
      </form>
    </div>
  );
}
