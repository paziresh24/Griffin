import { useCallback, useEffect, useState } from "react";
import { Switch } from "radix-ui";
import { ArrowRight, Check, Copy, KeyRound, Loader2, Plus, ShieldAlert, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";

// External agents (MCP now, A2A later): who they are, their device tokens, what they may use,
// what they asked for, and every gated (irreversible) call on record.

const MCP_URL = `${window.location.origin}/mcp`;
const input = "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary";

const time = (iso) => (iso ? new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" }) : "—");
const ago = (iso) => {
  if (!iso) return "هرگز";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s} ثانیه پیش`;
  if (s < 5400) return `${Math.round(s / 60)} دقیقه پیش`;
  if (s < 172800) return `${Math.round(s / 3600)} ساعت پیش`;
  return `${Math.round(s / 86400)} روز پیش`;
};

const TASK_STATE = {
  submitted: ["bg-muted-foreground", "در صف"],
  working: ["bg-primary animate-pulse", "در حال کار"],
  "input-required": ["bg-warn", "منتظر جواب"],
  completed: ["bg-ok", "تمام"],
  failed: ["bg-bad", "خطا"],
  canceled: ["bg-muted-foreground", "لغو"],
  rejected: ["bg-bad", "رد"],
};

const DECISION = {
  approved: ["text-ok", "تأیید شد"],
  denied: ["text-bad", "تأیید نشد"],
  refused: ["text-warn", "رد (مسیر همتا)"],
  blocked: ["text-bad", "مسدود (مخرب)"],
};

export function PeersPage({ onBack }) {
  const [data, setData] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api("/api/peers").then(setData, (e) => toast.error(e.message));
    api("/api/approvals?limit=40").then((r) => setApprovals(r.approvals || []), () => {});
  }, []);
  useEffect(() => {
    load();
    api("/api/tool-catalog").then((r) => setCatalog((r.tools || r.names || []).map((t) => (typeof t === "string" ? t : t.name))), () => {});
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const users = data?.users || [];

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 sm:px-6">
        <div className="mb-4 flex items-center gap-2">
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label="بازگشت">
            <ArrowRight className="size-4" />
          </button>
          <h1 className="text-lg font-semibold">همتاها</h1>
          <button type="button" onClick={() => setAdding((v) => !v)} className="press ms-auto flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:shadow">
            <Plus className="size-4" /> همتای جدید
          </button>
        </div>
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          ایجنت‌های همکاران از راه MCP (<span className="ltr font-mono text-xs">{MCP_URL}</span>) مستقیم با گریفین کار می‌کنند. هویت هر همتا یک شخص است؛ هر دستگاه توکن جدای خودش را دارد. کار برگشت‌ناپذیر از این مسیر رد می‌شود.
        </p>

        {adding ? <NewPeer onDone={() => { setAdding(false); load(); }} /> : null}

        {!data ? (
          <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : users.length ? (
          <div className="space-y-4">
            {users.map((user) => <PeerCard key={user.id} user={user} catalog={catalog} onChange={load} />)}
          </div>
        ) : (
          <p className="rounded-xl border bg-card px-4 py-8 text-center text-sm text-muted-foreground">هنوز همتایی تعریف نشده.</p>
        )}

        <h2 className="mb-2 mt-8 flex items-center gap-1.5 text-sm font-semibold"><ShieldAlert className="size-4" /> کارهای برگشت‌ناپذیر (ممیزی)</h2>
        {approvals.length ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            {approvals.map((a) => {
              const [color, label] = DECISION[a.decision] || ["", a.decision];
              return (
                <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs last:border-b-0">
                  <span className="text-muted-foreground">{time(a.at)}</span>
                  <span className="ltr font-mono">{a.tool}</span>
                  <span className="text-muted-foreground">به درخواست {a.caller}</span>
                  <span className={`ms-auto font-medium ${color}`}>{label}</span>
                  {a.chat_id ? <button type="button" onClick={() => navigate(a.chat_id)} className="text-primary hover:underline">گفتگو</button> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">موردی ثبت نشده.</p>
        )}
      </div>
    </div>
  );
}

function NewPeer({ onDone }) {
  const [form, setForm] = useState({ id: "", label: "" });
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/api/peers", { method: "POST", body: form });
      toast.success("همتا ساخته شد؛ سهمیهٔ پیش‌فرضِ فقط‌خواندنی گرفت.");
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mb-4 grid gap-2 rounded-xl border bg-card p-3 sm:grid-cols-[1fr_1fr_auto]">
      <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} required placeholder="شناسه (مثل ali-ahmadi)" className={`ltr ${input}`} />
      <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="نام (مثل آقای قانع)" className={input} />
      <button type="submit" disabled={busy} className="press rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">ساخت</button>
    </form>
  );
}

function PeerCard({ user, catalog, onChange }) {
  const [tasks, setTasks] = useState(null);
  const [calls, setCalls] = useState(null);
  const [issued, setIssued] = useState(null);

  useEffect(() => {
    api(`/api/peers/${user.id}/tasks`).then((r) => setTasks(r.tasks), () => setTasks([]));
    api(`/api/peers/${user.id}/calls`).then((r) => setCalls(r.calls), () => setCalls([]));
  }, [user.id, user.clients.length]);

  const toggle = (enabled) =>
    api(`/api/peers/${user.id}`, { method: "PATCH", body: { enabled } }).then(onChange, (e) => toast.error(e.message));

  const active = user.clients.filter((c) => !c.revoked_at);

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/12 text-primary"><Users className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{user.label}</div>
          <div className="ltr truncate text-start font-mono text-xs text-muted-foreground">{user.caller}</div>
        </div>
        <Switch.Root
          checked={user.enabled}
          onCheckedChange={toggle}
          dir="ltr"
          className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors data-[state=checked]:bg-primary"
          aria-label="فعال"
        >
          <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.375rem]" />
        </Switch.Root>
      </div>

      <h3 className="mb-1.5 mt-4 text-xs font-medium text-muted-foreground">دستگاه‌ها ({active.length} فعال)</h3>
      <div className="space-y-1">
        {user.clients.map((c) => (
          <ClientRow key={c.id} userId={user.id} client={c} onChange={onChange} />
        ))}
      </div>
      {issued ? <IssuedToken token={issued} onClose={() => setIssued(null)} /> : <NewClient userId={user.id} onIssued={(t) => { setIssued(t); onChange(); }} />}

      <h3 className="mb-1.5 mt-4 text-xs font-medium text-muted-foreground">سهمیهٔ ابزار (به ازای هر ایجنت)</h3>
      <div className="space-y-2">
        {user.quotas.map((q) => <QuotaRow key={q.agent} userId={user.id} quota={q} catalog={catalog} onChange={onChange} />)}
      </div>

      <h3 className="mb-1.5 mt-4 text-xs font-medium text-muted-foreground">کارهای اخیر</h3>
      {tasks === null ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : tasks.length ? (
        <div className="space-y-1">
          {tasks.slice(0, 15).map((t) => {
            const [dot, label] = TASK_STATE[t.state] || ["bg-muted-foreground", t.state];
            return (
              <button key={t.id} type="button" onClick={() => navigate(t.chatId)} className="press flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-xs hover:bg-muted">
                <span className={`size-2 shrink-0 rounded-full ${dot}`} />
                <span className="min-w-0 flex-1 truncate" dir="auto">{t.title || t.id}</span>
                <span className="shrink-0 text-muted-foreground">{label} · {ago(t.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">هنوز کاری نخواسته.</p>
      )}

      <h3 className="mb-1.5 mt-4 text-xs font-medium text-muted-foreground">تماس‌های ایجنتش (MCP)</h3>
      {calls === null ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : calls.length ? (
        <div className="space-y-1">
          {calls.slice(0, 15).map((c) => (
            <div key={c.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs">
              <span className={`mt-1 size-2 shrink-0 rounded-full ${c.outcome === "ok" ? "bg-emerald-500" : "bg-red-500"}`} />
              <div className="min-w-0 flex-1">
                <span className="ltr inline-block font-mono">{c.tool || c.method}{c.arg_keys ? `(${c.arg_keys})` : ""}</span>
                {c.detail ? <div className="ltr truncate text-start text-muted-foreground" title={c.detail}>{c.detail}</div> : null}
              </div>
              <span className="shrink-0 text-muted-foreground">{ago(c.at)}</span>
            </div>
          ))}
          {calls.every((c) => c.method !== "tools/call") ? (
            <p className="rounded-lg bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground">
              ایجنتش فقط وصل شده و فهرست ابزار گرفته — هیچ‌وقت ابزاری صدا نزده. یعنی مشکل سمت کلاینت اوست، نه گریفین.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">هنوز تماسی نگرفته.</p>
      )}
    </section>
  );
}

function ClientRow({ userId, client, onChange }) {
  const revoked = Boolean(client.revoked_at);
  const expired = client.expires_at && new Date(client.expires_at) < new Date();
  const revoke = async () => {
    if (!window.confirm(`توکن «${client.label}» باطل شود؟ آن دستگاه دیگر وصل نمی‌شود.`)) return;
    try {
      await api(`/api/peers/${userId}/clients/${client.id}`, { method: "DELETE" });
      onChange();
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/40 px-3 py-2 text-xs ${revoked || expired ? "opacity-50" : ""}`}>
      <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" dir="auto">{client.label}</span>
      <span className="text-muted-foreground">آخرین اتصال: {ago(client.last_used_at)}</span>
      {client.expires_at ? <span className="text-muted-foreground">انقضا: {time(client.expires_at)}</span> : null}
      {revoked ? (
        <span className="text-bad">باطل‌شده</span>
      ) : expired ? (
        <span className="text-bad">منقضی</span>
      ) : (
        <button type="button" onClick={revoke} className="press flex items-center gap-1 rounded-full px-2 py-0.5 text-bad hover:bg-bad/10">
          <Trash2 className="size-3.5" /> ابطال
        </button>
      )}
    </div>
  );
}

function NewClient({ userId, onIssued }) {
  const [label, setLabel] = useState("");
  const [ttl, setTtl] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const r = await api(`/api/peers/${userId}/clients`, { method: "POST", body: { label, ...(ttl ? { ttlDays: Number(ttl) } : {}) } });
      setLabel("");
      onIssued(r.token);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-2 grid grid-cols-[1fr_auto_auto] gap-2">
      <input value={label} onChange={(e) => setLabel(e.target.value)} required placeholder="دستگاه جدید (مثل لپ‌تاپ)" className={`${input} min-w-0 py-1.5`} />
      <select value={ttl} onChange={(e) => setTtl(e.target.value)} className="rounded-lg border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary">
        <option value="">بدون انقضا</option>
        <option value="30">۳۰ روز</option>
        <option value="90">۹۰ روز</option>
        <option value="1">۱ روز (آزمایشی)</option>
      </select>
      <button type="submit" disabled={busy} className="press rounded-lg border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">توکن</button>
    </form>
  );
}

function IssuedToken({ token, onClose }) {
  const command = `claude mcp add --transport http griffin ${MCP_URL} --header "Authorization: Bearer ${token}"`;
  const copy = (text) => navigator.clipboard.writeText(text).then(() => toast.success("کپی شد"), () => toast.error("کپی نشد"));
  return (
    <div className="mt-2 rounded-lg border border-warn/50 bg-warn/10 p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-medium">توکن فقط همین یک‌بار نمایش داده می‌شود.</span>
        <button type="button" onClick={onClose} className="ms-auto rounded p-1 hover:bg-muted" aria-label="بستن"><X className="size-3.5" /></button>
      </div>
      <div className="ltr flex items-center gap-2 rounded bg-background px-2 py-1.5 font-mono">
        <span className="min-w-0 flex-1 truncate">{token}</span>
        <button type="button" onClick={() => copy(token)} className="rounded p-1 hover:bg-muted" aria-label="کپی توکن"><Copy className="size-3.5" /></button>
      </div>
      <div className="ltr mt-2 flex items-center gap-2 rounded bg-background px-2 py-1.5 font-mono">
        <span className="min-w-0 flex-1 truncate">{command}</span>
        <button type="button" onClick={() => copy(command)} className="rounded p-1 hover:bg-muted" aria-label="کپی دستور"><Copy className="size-3.5" /></button>
      </div>
      <p className="mt-2 text-muted-foreground">بهتر است توکن را در Infisical پروژهٔ همان همکار بگذاری، نه در پیام.</p>
    </div>
  );
}

function QuotaRow({ userId, quota, catalog, onChange }) {
  const [editing, setEditing] = useState(false);
  const [tools, setTools] = useState(quota.tools || []);
  const [pick, setPick] = useState("");
  useEffect(() => setTools(quota.tools || []), [quota.tools]);

  const save = async () => {
    try {
      await api(`/api/peers/${userId}/quota`, { method: "PUT", body: { agent: quota.agent, tools } });
      setEditing(false);
      onChange();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const add = () => {
    const name = pick.trim();
    if (name && !tools.includes(name)) setTools([...tools, name]);
    setPick("");
  };

  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="font-medium">{quota.label}</span>
        <span className="ltr font-mono text-muted-foreground">{quota.agent}</span>
        {editing ? (
          <span className="ms-auto flex gap-1">
            <button type="button" onClick={save} className="press flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-primary-foreground"><Check className="size-3.5" /> ذخیره</button>
            <button type="button" onClick={() => { setTools(quota.tools || []); setEditing(false); }} className="press rounded-full px-2.5 py-0.5 hover:bg-muted">انصراف</button>
          </span>
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="press ms-auto rounded-full px-2.5 py-0.5 text-primary hover:bg-muted">ویرایش</button>
        )}
      </div>
      {tools.length ? (
        <div className="flex flex-wrap gap-1">
          {tools.map((t) => (
            <span key={t} className="ltr flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 font-mono text-[11px]">
              {t}
              {editing ? (
                <button type="button" onClick={() => setTools(tools.filter((x) => x !== t))} aria-label={`حذف ${t}`}><X className="size-3" /></button>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">بدون دسترسی (بسته)</p>
      )}
      {editing ? (
        <div className="mt-2 flex gap-2">
          <input list={`catalog-${userId}-${quota.agent}`} value={pick} onChange={(e) => setPick(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} placeholder="نام ابزار" className={`ltr ${input} py-1 font-mono text-xs`} />
          <datalist id={`catalog-${userId}-${quota.agent}`}>
            {catalog.filter((n) => !tools.includes(n)).map((n) => <option key={n} value={n} />)}
          </datalist>
          <button type="button" onClick={add} className="press rounded-lg border px-3 text-xs hover:bg-muted">افزودن</button>
        </div>
      ) : null}
    </div>
  );
}
