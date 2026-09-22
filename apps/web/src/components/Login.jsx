import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";

export function AuthGate({ children }) {
  const [state, setState] = useState("checking");

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((body) => alive && setState(body.authenticated ? "in" : "out"))
      .catch(() => alive && setState("out"));
    const onUnauthorized = () => setState("out");
    window.addEventListener("griffin:unauthorized", onUnauthorized);
    return () => {
      alive = false;
      window.removeEventListener("griffin:unauthorized", onUnauthorized);
    };
  }, []);

  if (state === "checking") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3">
        <img src="/icon.svg" alt="" className="size-12 rounded-xl ring-2 ring-brand/40" />
        <span className="agent-dots text-brand" aria-hidden><i /><i /><i /></span>
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
      setError(response.status === 429 ? "تلاش زیادی شد؛ ۱۵ دقیقه بعد دوباره امتحان کنید." : "توکن درست نیست.");
    } catch {
      setError("سرور در دسترس نیست.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="" className="size-10" />
          <div>
            <h1 className="font-semibold">گریفین</h1>
            <p className="text-xs text-muted-foreground">ورود با توکن Owner</p>
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
          {busy ? <span className="agent-dots" aria-hidden><i /><i /><i /></span> : null} ورود
        </button>
      </form>
    </div>
  );
}
