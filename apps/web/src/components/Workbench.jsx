import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, File, Folder, Loader2, RefreshCw, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { t } from "../i18n.js";

const TABS = [
  { id: "terminal", label: t("ترمینال"), icon: TerminalSquare },
  { id: "files", label: t("فایل‌ها"), icon: Folder },
];

export function WorkbenchPage({ onBack }) {
  const [tab, setTab] = useState("terminal");
  // The workbench runs on the broker's sandbox host; without it, say so instead of failing per command.
  const [probe, setProbe] = useState({ state: "checking" });
  useEffect(() => {
    let alive = true;
    api("/api/sandbox/exec", { method: "POST", body: { command: "true" } })
      .then((r) => alive && setProbe(r?.error ? { state: "off", error: r.error } : { state: "ok" }))
      .catch((e) => alive && setProbe({ state: "off", error: e.message }));
    return () => { alive = false; };
  }, []);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-3 pb-2 pt-[max(env(safe-area-inset-top),0.6rem)] sm:px-4">
        <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت")}><ArrowRight className="rtl-mirror size-4" /></button>
        <h1 className="font-semibold">{t("میز کار")}</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t("sandbox — بدون دسترسی به کلاستر")}</span>
        <nav className="ms-auto flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={`press flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${tab === id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60"}`}>
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {probe.state === "checking" ? (
          <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : probe.state === "off" ? (
          <div className="mx-auto max-w-md space-y-2 p-8 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{t("sandbox پیکربندی نشده است")}</p>
            <p>{t("میز کار روی میزبان sandbox کارگزار ابزارها اجرا می‌شود. کارگزار و سرویس sandbox را راه بینداز (راهنمای استقرار) و دوباره باز کن.")}</p>
            {probe.error ? <p className="ltr break-words font-mono text-xs" dir="ltr">{probe.error}</p> : null}
          </div>
        ) : tab === "terminal" ? <Terminal /> : <Files />}
      </div>
    </div>
  );
}

function Terminal() {
  const [lines, setLines] = useState([{ kind: "info", text: t("ترمینال sandbox. یک دستور بنویس و Enter بزن.") }]);
  const [cmd, setCmd] = useState("");
  const [cwd, setCwd] = useState("/root");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [hi, setHi] = useState(-1);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView(); }, [lines]);

  const run = async () => {
    const command = cmd.trim();
    if (!command || busy) return;
    setLines((l) => [...l, { kind: "cmd", text: `${cwd} $ ${command}` }]);
    setHistory((h) => [command, ...h].slice(0, 100));
    setHi(-1);
    setCmd("");
    setBusy(true);
    try {
      // Track cwd across commands: run the command then print the resulting directory.
      const r = await api("/api/sandbox/exec", { method: "POST", body: { command: `${command}\nprintf '\\n__CWD__%s' "$(pwd)"`, cwd } });
      const out = (r.stdout || "");
      const m = out.lastIndexOf("__CWD__");
      const body = m >= 0 ? out.slice(0, m).replace(/\n$/, "") : out;
      const next = m >= 0 ? out.slice(m + 7).trim() : cwd;
      if (body) setLines((l) => [...l, { kind: "out", text: body }]);
      if (r.stderr) setLines((l) => [...l, { kind: "err", text: r.stderr }]);
      if (next && next !== cwd) setCwd(next);
    } catch (e) {
      setLines((l) => [...l, { kind: "err", text: e.message || t("خطا") }]);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); run(); }
    else if (e.key === "ArrowUp" && history.length) { e.preventDefault(); const n = Math.min(hi + 1, history.length - 1); setHi(n); setCmd(history[n]); }
    else if (e.key === "ArrowDown" && hi >= 0) { e.preventDefault(); const n = hi - 1; setHi(n); setCmd(n < 0 ? "" : history[n]); }
  };

  return (
    <div className="flex h-full flex-col bg-[#0b0e14] text-[#d7dce5]">
      <div className="scrollbar-thin flex-1 overflow-y-auto p-3 font-mono text-[13px] leading-6" dir="ltr">
        {lines.map((l, i) => (
          <pre key={i} className={`whitespace-pre-wrap break-words ${l.kind === "cmd" ? "text-sky-400" : l.kind === "err" ? "text-rose-400" : l.kind === "info" ? "text-slate-500" : ""}`}>{l.text}</pre>
        ))}
        {busy ? <Loader2 className="size-4 animate-spin text-slate-500" /> : null}
        <div ref={endRef} />
      </div>
      <div className="flex items-center gap-2 border-t border-white/10 px-3 py-2 font-mono text-[13px]" dir="ltr">
        <span className="shrink-0 text-emerald-400">{cwd} $</span>
        <input value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={onKey} autoFocus spellCheck={false} className="flex-1 bg-transparent text-[#d7dce5] outline-none" placeholder={t("دستور…")} />
      </div>
    </div>
  );
}

const fmtSize = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}M` : n >= 1024 ? `${Math.round(n / 1024)}K` : `${n}B`);

function Files() {
  const [path, setPath] = useState("/root");
  const [data, setData] = useState(null);
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);

  const list = async (p) => {
    setLoading(true); setFile(null);
    try {
      const d = await api(`/api/sandbox/fs?path=${encodeURIComponent(p)}`);
      if (d.error) throw new Error(d.error);
      setData(d); setPath(d.path);
    } catch (e) { toast.error(e.message); } finally { setLoading(false); }
  };
  const open = async (p) => {
    setLoading(true);
    try { const d = await api(`/api/sandbox/file?path=${encodeURIComponent(p)}`); setFile({ path: p, content: d.content }); }
    catch (e) { toast.error(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { list("/root"); }, []);
  const parent = path.replace(/\/[^/]+\/?$/, "") || "/";

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-full min-w-0 flex-col sm:w-80 sm:border-e">
        <div className="flex items-center gap-1 border-b px-2 py-2">
          <button type="button" onClick={() => list(parent)} disabled={path === "/"} className="press rounded-md p-1.5 hover:bg-muted disabled:opacity-40"><ChevronLeft className="size-4 rotate-180" /></button>
          <input value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && list(path)} dir="ltr" className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 font-mono text-xs" />
          <button type="button" onClick={() => list(path)} className="press rounded-md p-1.5 hover:bg-muted"><RefreshCw className="size-4" /></button>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto">
          {loading && !data ? <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div> : null}
          {(data?.entries || []).map((e) => (
            <button key={e.name} type="button" onClick={() => (e.dir ? list(`${path.replace(/\/$/, "")}/${e.name}`) : open(`${path.replace(/\/$/, "")}/${e.name}`))} className="flex w-full items-center gap-2 px-3 py-1.5 text-start text-sm hover:bg-muted/60">
              {e.dir ? <Folder className="size-4 shrink-0 text-sky-500" /> : <File className="size-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate" dir="ltr">{e.name}</span>
              {!e.dir ? <span className="shrink-0 text-xs text-muted-foreground">{fmtSize(e.size)}</span> : null}
            </button>
          ))}
          {data && !data.entries.length ? <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t("خالی")}</div> : null}
        </div>
      </div>
      <div className="hidden min-w-0 flex-1 flex-col sm:flex">
        {file ? (
          <>
            <div className="border-b px-3 py-2 font-mono text-xs text-muted-foreground" dir="ltr">{file.path}</div>
            <pre className="scrollbar-thin flex-1 overflow-auto p-3 font-mono text-[13px] leading-6" dir="ltr">{file.content || t("(خالی یا دودویی)")}</pre>
          </>
        ) : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t("یک فایل را انتخاب کن")}</div>}
      </div>
    </div>
  );
}
