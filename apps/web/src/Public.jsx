import { useEffect, useState } from "react";
import { Globe, Moon, Sun } from "lucide-react";
import { ApiBase } from "./base.js";
import { GriffinRuntime } from "./runtime.jsx";
import { Thread } from "./components/Thread.jsx";

export function shareToken(hash = window.location.hash) {
  return hash.match(/^#\/s\/([A-Za-z0-9_-]{32})$/)?.[1] || null;
}

const noop = () => {};

// Read-only page for a shared chat; no login. Refreshes while a run is still going.
export function PublicChat({ token }) {
  const [state, setState] = useState({ loading: true });
  const [theme, setTheme] = useState(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    let alive = true;
    let timer;
    const load = async () => {
      try {
        const response = await fetch(`/api/public/${token}`, { credentials: "omit" });
        if (!response.ok) throw new Error(response.status === 404 ? "این لینک وجود ندارد یا غیرفعال شده است." : `خطا ${response.status}`);
        const body = await response.json();
        if (!alive) return;
        setState({ chat: body.chat, timeline: body.timeline });
        document.title = `${body.chat.title} · گریفین`;
        const running = body.timeline.messages.some((m) => m.role === "assistant" && m.status === "running");
        if (running) timer = setTimeout(load, 4000);
      } catch (error) {
        if (alive) setState({ error: error.message });
      }
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [token]);

  if (state.error || state.loading) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <img src="/icon.svg" alt="" className="size-12 opacity-80" />
        <p className="text-muted-foreground">{state.error || "در حال بارگذاری…"}</p>
      </div>
    );
  }

  return (
    <ApiBase.Provider value={`/api/public/${token}`}>
      <div className="flex h-dvh flex-col">
        <GriffinRuntime chatId={null} timeline={state.timeline || { messages: [], lastEventId: 0 }} settings={{ mode: "agent", model: "" }} onError={noop}>
          <Thread
            readOnly
            header={
              <header className="flex items-center gap-2 border-b px-3 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)] sm:px-4">
                <img src="/icon.svg" alt="" className="size-6" />
                <h1 className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">{state.chat.title}</h1>
                <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                  <Globe className="size-3.5" /> فقط خواندنی
                </span>
                <button type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="press flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="تم">
                  {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                </button>
              </header>
            }
          />
        </GriffinRuntime>
      </div>
    </ApiBase.Provider>
  );
}

