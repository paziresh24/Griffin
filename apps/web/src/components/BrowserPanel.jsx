import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Loader2, MonitorPlay, Plus, RotateCw, X } from "lucide-react";
import { api } from "../api.js";
import { isRtl, t } from "../i18n.js";

// This chat's own browser beside the chat (owner 2026-10-31: «هر چتی اگر نیاز شد مرورگر‌های کوچولو بسازه
// برای خودش و کلا اونتو کنترل بشه»). The chat's headless Chromium in the sandbox streams its current tab
// here as JPEG frames (server browser-view.mjs → daemon /stream); mouse, wheel, keys, paste, the address
// bar and the tabs go back into the same tab while the agent keeps working in it. One chat, one browser.
// Open/closed and width are remembered on this device; the panel always shows the chat in front.

const OPEN_KEY = "griffin.browserPanel.open";
const WIDTH_KEY = "griffin.browserPanel.width";
const read = (key, fallback) => { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

export function useChatBrowser(chatId) {
  const [open, setOpenState] = useState(() => read(OPEN_KEY, false));
  const [exists, setExists] = useState(false);
  useEffect(() => {
    if (!chatId) return undefined;
    let alive = true;
    const look = () => api(`/api/chats/${chatId}/browser`).then((r) => alive && setExists(Boolean(r?.exists))).catch(() => {});
    look();
    const timer = setInterval(look, 8000);
    return () => { alive = false; clearInterval(timer); };
  }, [chatId]);
  const setOpen = (value) => { setOpenState(value); write(OPEN_KEY, value); };
  return { open, exists, toggle: () => setOpen(!open), close: () => setOpen(false) };
}

export function BrowserButton({ open, exists, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={open}
      className={`g-chip relative flex items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-muted ${open ? "bg-muted text-foreground" : "text-muted-foreground"}`}
      title={exists ? t("مرورگر این چت: ببینید و کنترل کنید") : t("مرورگر این چت (هنوز ندارد؛ با باز کردن ساخته می‌شود)")}
    >
      <MonitorPlay className="size-4" />
      <span className="hidden sm:inline">{t("مرورگر")}</span>
      {exists && !open ? <span className="absolute -top-0.5 end-0.5 size-1.5 rounded-full bg-primary" /> : null}
    </button>
  );
}

const MOD = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

export function BrowserPanel({ chatId, exists, onClose, standalone = false }) {
  const [width, setWidth] = useState(() => read(WIDTH_KEY, 620));
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | connecting | on | error
  const [error, setError] = useState("");
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const img = useRef(null);
  const surface = useRef(null);
  const ws = useRef(null);
  const pending = useRef(null);
  const drag = useRef(null);
  const lastMove = useRef(0);

  const sendMsg = (m) => { if (ws.current?.readyState === 1) ws.current.send(JSON.stringify(m)); };

  const connect = useCallback(async (firstUrl) => {
    setStatus("connecting");
    setError("");
    pending.current = firstUrl || null;
    try {
      const { ticket } = await api(`/api/chats/${chatId}/browser/ticket`, { method: "POST" });
      const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/browser-view/ws?t=${encodeURIComponent(ticket)}`);
      ws.current = sock;
      sock.onopen = () => {
        setStatus("on");
        if (pending.current) { sock.send(JSON.stringify({ type: "nav", url: pending.current })); pending.current = null; }
      };
      sock.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === "frame" && img.current) img.current.src = `data:image/jpeg;base64,${m.data}`;
        else if (m.type === "state") { setState(m); }
        else if (m.type === "error") setError(m.error || "");
      };
      sock.onclose = () => {
        if (ws.current !== sock) return;
        ws.current = null;
        setStatus("error");
      };
    } catch (err) {
      setStatus("error");
      setError(err.message || String(err));
    }
  }, [chatId]);

  // The panel is keyed by chat (App.jsx), so one stream per mount: close it on the way out.
  useEffect(() => () => { const s = ws.current; ws.current = null; s?.close(); }, []);
  // The chat got a browser (the agent opened one) while the panel waited: start watching it.
  useEffect(() => { if (exists && !ws.current && status === "idle") connect(); }, [exists, status, connect]);

  useEffect(() => { if (!editing) setAddress(state?.url && state.url !== "about:blank" ? state.url : ""); }, [state?.url, editing]);

  // Width: drag the inner edge.
  useEffect(() => {
    if (!dragging) return undefined;
    const move = (e) => setWidth(Math.round(Math.min(Math.max(drag.current.w + (isRtl ? e.clientX - drag.current.x : drag.current.x - e.clientX), 360), window.innerWidth * 0.8)));
    const up = () => { setDragging(false); setWidth((w) => { write(WIDTH_KEY, w); return w; }); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [dragging]);

  // Wheel needs a non-passive listener to keep the chat from scrolling instead.
  useEffect(() => {
    const el = surface.current;
    if (!el) return undefined;
    const wheel = (e) => { e.preventDefault(); const p = rel(e); if (p) sendMsg({ type: "wheel", ...p, dx: e.deltaX, dy: e.deltaY, modifiers: MOD(e) }); };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });

  const rel = (e) => {
    const r = img.current?.getBoundingClientRect();
    if (!r || !r.width) return null;
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const mouse = (event) => (e) => {
    if (event === "move") { const n = performance.now(); if (n - lastMove.current < 33) return; lastMove.current = n; }
    if (event === "down") surface.current?.focus();
    const p = rel(e);
    if (p) sendMsg({ type: "mouse", event, ...p, button: e.button, clicks: e.detail || 1, modifiers: MOD(e) });
  };
  const key = (event) => (e) => {
    // Paste stays a paste (below); everything else goes to the page.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    sendMsg({ type: "key", event, key: e.key, code: e.code, modifiers: MOD(e) });
  };

  const go = (url) => {
    let target = String(url || "").trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) target = /\s/.test(target) || !/\./.test(target) ? `https://duckduckgo.com/?q=${encodeURIComponent(target)}` : `https://${target}`;
    if (status === "on") sendMsg({ type: "nav", url: target });
    else connect(target);
    setEditing(false);
  };

  const tabs = state?.tabs || [];
  const isWide = typeof window !== "undefined" && window.innerWidth >= 768;

  return (
    <aside className={standalone ? "browser-panel flex h-dvh w-full flex-col bg-background" : "browser-panel fixed inset-0 z-40 flex flex-col bg-background md:relative md:inset-auto md:z-auto md:shrink-0 md:border-s"} style={{ width: isWide && !standalone ? width : undefined }} aria-label={t("مرورگر این چت")}>
      {standalone ? null : <div
        role="separator"
        aria-orientation="vertical"
        title={t("کشیدن برای تغییر پهنا")}
        className="absolute inset-y-0 start-0 z-10 hidden w-1.5 cursor-col-resize hover:bg-primary/30 md:block"
        onPointerDown={(e) => { drag.current = { x: e.clientX, w: width }; setDragging(true); e.preventDefault(); }}
      />}
      <header className="flex min-w-0 items-center gap-1 border-b px-2 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)]">
        <button type="button" className="g-icon-btn rounded-lg p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40" disabled={status !== "on"} onClick={() => sendMsg({ type: "nav", go: "back" })} title={t("عقب")}>
          {isRtl ? <ArrowRight className="size-4" /> : <ArrowLeft className="size-4" />}
        </button>
        <button type="button" className="g-icon-btn rounded-lg p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40" disabled={status !== "on"} onClick={() => sendMsg({ type: "nav", go: "forward" })} title={t("جلو")}>
          {isRtl ? <ArrowLeft className="size-4" /> : <ArrowRight className="size-4" />}
        </button>
        <button type="button" className="g-icon-btn rounded-lg p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40" disabled={status !== "on"} onClick={() => sendMsg({ type: "nav", go: "reload" })} title={t("بارگذاری دوباره")}>
          <RotateCw className="size-4" />
        </button>
        <form className="min-w-0 flex-1" onSubmit={(e) => { e.preventDefault(); go(address); }}>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => { setEditing(true); e.target.select(); }}
            onBlur={() => setEditing(false)}
            placeholder={t("آدرس یا جستجو")}
            dir="ltr"
            className="w-full min-w-0 rounded-lg border bg-muted/40 px-2 py-1 font-mono text-xs outline-none focus:border-primary/60"
          />
        </form>
        {standalone ? null : (
          <a href={`#/browser/${chatId}`} target="_blank" rel="noopener" className="g-icon-btn rounded-lg p-1.5 text-muted-foreground hover:bg-muted" title={t("باز کردن در صفحهٔ جدا")}>
            <ExternalLink className="size-4" />
          </a>
        )}
        <button type="button" className="g-icon-btn rounded-lg p-1.5 text-muted-foreground hover:bg-muted" onClick={onClose} title={standalone ? t("برگشت به چت") : t("بستن (مرورگر چت می‌ماند)")}>
          <X className="size-4" />
        </button>
      </header>
      {status === "on" ? (
        <div className="scrollbar-thin flex min-w-0 items-end gap-0.5 overflow-x-auto border-b bg-muted/50 px-2 pt-1.5" dir="ltr">
          {tabs.map((tab) => (
            <div
              key={tab.index}
              className={`group flex w-44 min-w-24 shrink items-center gap-1.5 rounded-t-lg border border-b-0 px-2.5 py-1.5 text-xs ${tab.index === state?.current ? "bg-background text-foreground" : "border-transparent text-muted-foreground hover:bg-background/60"}`}
            >
              <Globe className="size-3.5 shrink-0 opacity-60" />
              <button type="button" className="min-w-0 flex-1 truncate text-start" dir="auto" onClick={() => sendMsg({ type: "tab", index: tab.index })} title={tab.url}>{tab.title || tab.url || t("تب خالی")}</button>
              <button type="button" className="shrink-0 rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100" onClick={() => sendMsg({ type: "tab", action: "close", index: tab.index })} title={t("بستن تب")}><X className="size-3" /></button>
            </div>
          ))}
          <button type="button" className="mb-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-background" onClick={() => sendMsg({ type: "tab", action: "new" })} title={t("تب تازه")}>
            <Plus className="size-4" />
          </button>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-auto bg-muted/30">
        {status === "idle" ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            <Globe className="size-8 opacity-50" />
            <p>{t("این چت هنوز مرورگر ندارد. آدرسی بالا بزنید، یا وقتی ایجنت مرورگر باز کرد همین‌جا دیده می‌شود.")}</p>
            <button type="button" className="rounded-lg border px-3 py-1.5 hover:bg-muted" onClick={() => connect()}>{t("باز کردن مرورگر خالی")}</button>
          </div>
        ) : null}
        {status === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            <p>{error || t("اتصال به مرورگر قطع شد.")}</p>
            <button type="button" className="rounded-lg border px-3 py-1.5 hover:bg-muted" onClick={() => connect()}>{t("اتصال دوباره")}</button>
          </div>
        ) : null}
        {status === "connecting" ? <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div> : null}
        <div
          ref={surface}
          tabIndex={0}
          className={`outline-none ${status === "on" ? "" : "hidden"}`}
          onPointerDown={mouse("down")}
          onPointerUp={mouse("up")}
          onPointerMove={mouse("move")}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={key("down")}
          onKeyUp={key("up")}
          onPaste={(e) => { const text = e.clipboardData?.getData("text"); if (text) { e.preventDefault(); sendMsg({ type: "text", text }); } }}
        >
          <img ref={img} alt="" draggable={false} className="block w-full select-none" />
        </div>
        {dragging ? <div className="absolute inset-0 cursor-col-resize" /> : null}
      </div>
    </aside>
  );
}
