import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw, Send, Share2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { clockLabel, exactTime } from "../elapsed.js";
import { t } from "../i18n.js";

// The agents' network (server network.mjs): the colleagues' agents this install found — itself, or
// through another member's list — and a conversation with each. The conversation is kept on this
// browser; the other side keeps its own.
const KEY = "griffin.network.chats";
const load = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
};
const save = (all) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode */
  }
};

export function NetworkSection() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = (deep = false) =>
    (deep ? api("/api/network/refresh", { method: "POST" }) : api("/api/network")).then((r) => setData((d) => ({ ...(d || {}), ...r })), (e) => toast.error(e.message));
  useEffect(() => {
    refresh();
    const t = setInterval(() => refresh(), 30_000);
    return () => clearInterval(t);
  }, []);
  const connect = async () => {
    setBusy(true);
    try {
      const r = await api("/api/network/connect", { method: "POST", body: { url: adding.trim() } });
      if (r.ok) {
        toast.success(t("درخواست رفت؛ چند ثانیه بعد آن ایجنت و همهٔ ایجنت‌هایی که می‌شناسد این‌جا می‌آیند."));
        setAdding("");
        setTimeout(() => refresh(), 4_000);
      } else toast.error(r.reason || t("وصل نشد"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const agents = (data?.agents || []).filter((a) => a.connected);
  const waiting = (data?.agents || []).filter((a) => !a.connected);
  return (
    <section className="mb-8 space-y-3">
      <div className="flex items-center gap-2">
        <Share2 className="size-4 text-muted-foreground" />
        <h2 className="font-semibold">{t("شبکهٔ ایجنت‌ها")}</h2>
        <button type="button" onClick={() => refresh(true)} className="press ms-auto flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted">
          <RefreshCw className="size-3.5" /> به‌روز کردن
        </button>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">
        ایجنت‌های همکاران که این نصب پیدا کرده. هر ایجنتی که یکی از این‌ها را بشناسد، بقیه را هم خودکار می‌شناسد. با هر کدام می‌شود همین‌جا یا از داخل گفتگو («از ایجنت آقای … بپرس») حرف زد؛ آن ایجنت فقط در حدی جواب می‌دهد که صاحبش اجازه داده.
      </p>
      {!data ? (
        <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : data.off ? (
        <p className="rounded-xl border px-3 py-2 text-sm text-muted-foreground">{t("شبکهٔ ایجنت‌ها روی این نصب خاموش است (تنظیمات ← پیکربندی ← NETWORK). معمولاً برای نصب آزمایشی کنار نصب اصلی، تا کار همکاران دو جا اجرا نشود.")}</p>
      ) : !data.self ? (
        <p className="rounded-xl border px-3 py-2 text-sm text-muted-foreground">{t("آدرس عمومی این نصب (PUBLIC_URL) تنظیم نشده یا https روی دامنه‌های شرکت نیست، پس در شبکه نیست.")}</p>
      ) : (
        <>
          {agents.length ? (
            <div className="divide-y rounded-xl border">
              {agents.map((a) => (
                <div key={a.id}>
                  <button type="button" onClick={() => setOpen(open === a.id ? null : a.id)} className="press flex w-full items-center gap-3 px-3 py-2.5 text-start hover:bg-muted/50">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">{(a.name || "?").slice(0, 1)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{a.name}{a.owner ? <span className="font-normal text-muted-foreground"> · {a.owner}</span> : null}</span>
                      <span className="block truncate text-xs text-muted-foreground" dir="ltr">{a.url.replace(/^https:\/\//, "")}{a.product ? ` · ${a.product}` : ""}</span>
                    </span>
                    {a.lastSeen ? <span className="shrink-0 text-xs text-muted-foreground" title={exactTime(a.lastSeen)}>{clockLabel(a.lastSeen)}</span> : null}
                  </button>
                  {open === a.id ? <Conversation agent={a} /> : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-xl border px-3 py-2 text-sm text-muted-foreground">{t("هنوز ایجنتی پیدا نشده. آدرس یکی از همکاران را بده؛ بقیه از راه او پیدا می‌شوند.")}</p>
          )}
          {waiting.length ? <p className="text-xs text-muted-foreground">در انتظار وصل شدن: {waiting.map((a) => a.url.replace(/^https:\/\//, "")).join(t("، "))}</p> : null}
          <div className="flex gap-2">
            <input className="w-full rounded-lg border bg-background px-3 py-2 text-sm" dir="ltr" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="https://agent.example.com" />
            <button type="button" onClick={connect} disabled={busy || !adding.trim()} className="press inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm disabled:opacity-60">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} افزودن
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Conversation({ agent }) {
  const [msgs, setMsgs] = useState(() => load()[agent.id] || []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(null); // { taskId, state } while that agent works or asks
  const keep = (next) => {
    setMsgs(next);
    const all = load();
    all[agent.id] = next.slice(-60);
    save(all);
  };
  const push = (list, m) => [...list, { ...m, at: new Date().toISOString() }];
  async function run(body, list) {
    setBusy(true);
    try {
      let r = await api(`/api/network/${agent.id}/ask`, { method: "POST", body });
      let next = list;
      // Still working after the server's wait: keep waiting a few more rounds here.
      for (let i = 0; i < 3 && ["submitted", "working"].includes(r.state); i++) r = await api(`/api/network/${agent.id}/ask`, { method: "POST", body: { taskId: r.taskId, answer: "" } });
      pending.current = ["input-required", "auth-required", "submitted", "working"].includes(r.state) ? { taskId: r.taskId, state: r.state } : null;
      const said = r.answer || r.question || (r.state === "auth-required" ? t("این کار تأیید صاحب آن ایجنت را لازم دارد؛ منتظرش است.") : r.state === "working" ? t("هنوز کار می‌کند؛ بعداً «ادامه» را بزن.") : r.error || t("جوابی نیامد."));
      next = push(next, { from: "them", text: said, state: r.state });
      keep(next);
    } catch (e) {
      keep(push(list, { from: "them", text: e.message, state: "failed" }));
    } finally {
      setBusy(false);
    }
  }
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    const list = push(msgs, { from: "me", text: t });
    keep(list);
    const p = pending.current;
    run(p && p.state === "input-required" ? { taskId: p.taskId, answer: t } : { message: t }, list);
  };
  return (
    <div className="space-y-2 border-t bg-muted/20 px-3 py-3">
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {msgs.map((m, i) => (
          <div key={i} className={`w-fit max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-6 ${m.from === "me" ? "ms-auto bg-primary/10" : "bg-background border"}`} dir="auto">
            {m.text}
          </div>
        ))}
        {busy ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> {agent.name} دارد جواب می‌دهد…</p> : null}
      </div>
      <div className="flex gap-2">
        <textarea className="min-h-10 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm" dir="auto" rows={1} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder={`پیام به ${agent.name}…`} />
        {pending.current && ["working", "submitted", "auth-required"].includes(pending.current.state) ? (
          <button type="button" disabled={busy} onClick={() => run({ taskId: pending.current.taskId, answer: "" }, msgs)} className="press shrink-0 rounded-lg border px-3 text-sm">{t("ادامه")}</button>
        ) : null}
        <button type="button" onClick={send} disabled={busy || !text.trim()} className="press flex shrink-0 items-center justify-center rounded-lg bg-primary px-3 text-primary-foreground disabled:opacity-60" aria-label={t("ارسال")}><Send className="size-4" /></button>
      </div>
    </div>
  );
}
