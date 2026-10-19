import { useCallback, useEffect, useRef, useState } from "react";
import { AppWindow, ExternalLink, Loader2, Maximize2, Monitor, RefreshCw, RotateCw, ScrollText, Smartphone, Square, Tablet, X } from "lucide-react";
import { api } from "../api.js";
import { useApiBase } from "../base.js";
import { textDir } from "../dir.js";
import { t } from "../i18n.js";

// Widths a page is tried at (CSS px); 0 = the whole card.
const DEVICES = [
  { id: "phone", label: () => t("موبایل"), width: 390, Icon: Smartphone },
  { id: "tablet", label: () => t("تبلت"), width: 820, Icon: Tablet },
  { id: "full", label: () => t("کامل"), width: 0, Icon: Monitor },
];

const LIVE = new Set(["starting", "running"]);

// The page of an app the agent started in the sandbox (preview_start, previews.mjs). The tool result
// carries only the preview's id: the link holds its token, so it is read from the signed-in API.
// On the preview host the page has an origin of its own and may keep its storage and cookies; on the
// app's own host the server sandboxes it (no allow-same-origin) and so must this frame.
export function PreviewCard({ args = {}, result, isError, status }) {
  const base = useApiBase();
  const running = status?.type === "running" || result === undefined;
  const id = result?.id;
  const [preview, setPreview] = useState(null);
  const [failed, setFailed] = useState(null);
  const [device, setDevice] = useState("full");
  const [reload, setReload] = useState(0);
  const [logs, setLogs] = useState(null); // null = closed
  const [busy, setBusy] = useState(null);
  const [canvas, setCanvas] = useState(false);
  const timer = useRef(null);

  const refresh = useCallback(async () => {
    if (!id) return null;
    try {
      const { preview: next } = await api(`/api/previews/${id}`);
      setPreview(next);
      setFailed(null);
      return next;
    } catch (error) {
      setFailed(error.status === 404 ? t("این پیش‌نمایش دیگر وجود ندارد") : error.message);
      return null;
    }
  }, [id]);

  useEffect(() => {
    if (!id || base !== "/api") return undefined;
    let alive = true;
    const loop = async () => {
      const next = await refresh();
      if (!alive) return;
      // Poll while it lives (it also keeps the preview from idling out while the card is open).
      timer.current = setTimeout(loop, next && LIVE.has(next.status) ? 15_000 : 60_000);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer.current);
    };
  }, [id, base, refresh]);

  const loadLogs = useCallback(async () => {
    try {
      const { log } = await api(`/api/previews/${id}/logs?lines=150`);
      setLogs(log || t("(خالی)"));
    } catch (error) {
      setLogs(t("خطا: {error}", { error: error.message }));
    }
  }, [id]);

  const act = async (name) => {
    setBusy(name);
    try {
      const next = await api(`/api/previews/${id}/${name}`, { method: "POST" });
      setPreview(next.preview);
      if (name === "restart") setReload((n) => n + 1);
      if (logs !== null) await loadLogs();
    } catch (error) {
      setFailed(error.message);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!canvas) return undefined;
    const close = (event) => event.key === "Escape" && setCanvas(false);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", close);
    };
  }, [canvas]);

  const title = preview?.title || result?.title || args.title || t("پیش‌نمایش");
  const live = preview && LIVE.has(preview.status);

  if (isError || result?.error) {
    return (
      <div className="my-2 rounded-lg border border-bad/50 bg-card px-3 py-2 text-sm">
        <p className="flex items-center gap-2 font-medium"><AppWindow className="size-4 text-bad" />{t("{title} — اجرا نشد", { title })}</p>
        {result?.error ? <p className="ltr mt-1 text-xs text-bad">{result.error}</p> : null}
        {result?.log ? <pre className="ltr mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/60 p-2 font-mono text-xs">{result.log}</pre> : null}
      </div>
    );
  }

  if (base !== "/api") {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
        <AppWindow className="size-4" /> {t("{title} — پیش‌نمایش زنده فقط برای صاحب گفتگو دیده می‌شود", { title })}
      </div>
    );
  }

  const sandbox = preview?.mode === "host"
    ? "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"
    : "allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock";
  const width = DEVICES.find((d) => d.id === device)?.width || 0;
  const dot = !preview ? "bg-muted-foreground" : preview.status === "running" ? "bg-ok" : preview.status === "starting" ? "bg-warn" : "bg-bad";
  const statusText = !preview ? "" : { running: t("در حال اجرا"), starting: t("در حال بالا آمدن"), stopped: t("متوقف شد"), failed: t("اجرا نشد") }[preview.status] || preview.status;

  const toolbar = (
    <div className="flex flex-wrap items-center gap-1 px-3 py-2">
      <AppWindow className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1" dir={textDir(title)}>
        <p className={`truncate text-sm font-medium ${running ? "shimmer" : ""}`}>{title}</p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={`inline-block size-1.5 rounded-full ${dot}`} />
          {running && !preview ? t("در حال بالا آوردن…") : statusText}
          {preview ? <span className="ltr font-mono">· :{preview.port}</span> : null}
        </p>
      </div>
      {live ? (
        <>
          <div className="me-1 hidden items-center rounded-md bg-muted/60 p-0.5 sm:flex" role="group" aria-label={t("اندازهٔ صفحه")}>
            {DEVICES.map(({ id: key, label, Icon }) => (
              <Btn key={key} label={label()} active={device === key} onClick={() => setDevice(key)}><Icon className="size-3.5" /></Btn>
            ))}
          </div>
          <Btn label={t("بارگذاری دوباره صفحه")} onClick={() => setReload((n) => n + 1)}><RefreshCw className="size-4" /></Btn>
          <Btn label={t("باز کردن در برگهٔ تازه")} href={preview.url}><ExternalLink className="size-4" /></Btn>
          {canvas ? null : <Btn label={t("تمام‌صفحه")} onClick={() => setCanvas(true)}><Maximize2 className="size-4" /></Btn>}
        </>
      ) : null}
      <Btn label={t("لاگ برنامه")} active={logs !== null} onClick={() => (logs === null ? loadLogs() : setLogs(null))}><ScrollText className="size-4" /></Btn>
      {preview ? (
        <>
          <Btn label={t("اجرای دوباره برنامه")} disabled={busy} onClick={() => act("restart")}>{busy === "restart" ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}</Btn>
          {live ? <Btn label={t("توقف")} disabled={busy} onClick={() => act("stop")}>{busy === "stop" ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}</Btn> : null}
        </>
      ) : null}
      {canvas ? <Btn label={t("بستن")} onClick={() => setCanvas(false)}><X className="size-5" /></Btn> : null}
    </div>
  );

  const frame = live ? (
    <div className={`flex justify-center bg-muted/40 ${canvas ? "min-h-0 flex-1 p-2" : "p-2"}`}>
      <iframe
        key={`${preview.id}-${reload}`}
        title={title}
        src={preview.url}
        sandbox={sandbox}
        className={`rounded-md border bg-white ${canvas ? "h-full" : "h-[28rem]"} ${width ? "" : "w-full"}`}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
      />
    </div>
  ) : preview ? (
    <div className="px-3 py-4 text-sm text-muted-foreground">
      {preview.reason || t("این پیش‌نمایش بسته شده است.")}
      <button type="button" disabled={busy} onClick={() => act("restart")} className="ms-2 rounded-md border px-2 py-0.5 text-foreground hover:bg-muted">{t("اجرای دوباره")}</button>
    </div>
  ) : failed ? (
    <p className="px-3 py-3 text-xs text-bad">{failed}</p>
  ) : (
    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground"><Loader2 className="me-2 size-4 animate-spin" /> {t("در حال بالا آوردن برنامه…")}</div>
  );

  const logPane = logs !== null ? (
    <div className="border-t px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>{t("خروجی برنامه")}</span>
        <button type="button" onClick={loadLogs} className="rounded px-1.5 py-0.5 hover:bg-muted">{t("تازه‌کردن")}</button>
      </div>
      <pre className="ltr max-h-56 overflow-auto whitespace-pre-wrap rounded bg-muted/60 p-2 font-mono text-xs">{logs}</pre>
    </div>
  ) : null;

  if (canvas) {
    return (
      <>
        <div className="my-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">{t("{title} — در حالت تمام‌صفحه باز است", { title })}</div>
        <div className="fixed inset-0 z-50 flex flex-col bg-background/95 p-2 backdrop-blur sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-2xl">
            <div className="shrink-0 border-b">{toolbar}</div>
            {frame}
            {logPane}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border bg-card">
      {toolbar}
      {frame}
      {logPane}
    </div>
  );
}

function Btn({ label, active, onClick, href, disabled, children }) {
  const className = `rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 ${active ? "bg-background text-foreground shadow-sm" : ""}`;
  if (href) return <a href={href} target="_blank" rel="noopener" title={label} aria-label={label} className={className}>{children}</a>;
  return <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label} className={className}>{children}</button>;
}
