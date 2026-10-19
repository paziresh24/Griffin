import { useCallback, useEffect, useState } from "react";
import { Switch } from "radix-ui";
import { ArrowRight, Check, ChevronLeft, Copy, KeyRound, Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api, navigate, usePeerRoute } from "../api.js";
import { BRAND } from "../brand.js";
import { locale, num, t } from "../i18n.js";
import { clockLabel, exactTime } from "../elapsed.js";
import { NetworkSection } from "./Network.jsx";
import { activeClients, initial, lastSeen, openAgents, peerList, taskTitle } from "../peers-list.js";

// External agents (MCP now, A2A later): a short list of colleagues (peers-list.js); a row opens
// what that colleague's agent asked for, what it may use and its device tokens. The agents' network
// and the irreversible-call audit are tabs of their own.

const MCP_URL = `${window.location.origin}/mcp`;
const input = "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary";

const time = (iso) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "—");
const ago = (iso) => (iso ? clockLabel(iso) : t("هرگز"));

const TASK_STATE = {
  submitted: ["bg-muted-foreground", t("در صف")],
  working: ["bg-signal animate-pulse", t("در حال کار")],
  "input-required": ["bg-warn", t("منتظر جواب")],
  completed: ["bg-ok", t("تمام")],
  failed: ["bg-bad", t("خطا")],
  canceled: ["bg-muted-foreground", t("لغو")],
  rejected: ["bg-bad", t("رد")],
};

const DECISION = {
  approved: ["text-ok", t("تأیید شد")],
  denied: ["text-bad", t("تأیید نشد")],
  refused: ["text-warn", t("رد (مسیر ایجنت همکار)")],
  blocked: ["text-bad", t("مسدود (مخرب)")],
};

const TABS = [
  { id: "people", label: t("همکاران") },
  { id: "network", label: t("شبکهٔ ایجنت‌ها") },
  { id: "audit", label: t("کارهای برگشت‌ناپذیر") },
];

export function PeersPage({ onBack }) {
  const [data, setData] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState("people");
  const [query, setQuery] = useState("");
  // The open colleague lives in the address (#/peers/<id>): the browser's back and the sidebar's
  // «ایجنت‌های همکاران» both return to the list.
  const openId = usePeerRoute();
  const setOpenId = (id) => {
    window.location.hash = id ? `/peers/${id}` : "/peers";
  };

  const load = useCallback(() => {
    api("/api/peers").then(setData, (e) => toast.error(e.message));
  }, []);
  useEffect(() => {
    load();
    api("/api/tool-catalog").then((r) => setCatalog((r.tools || r.names || []).map((t) => (typeof t === "string" ? t : t.name))), () => {});
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const users = data?.users || [];
  const opened = openId ? users.find((u) => u.id === openId) : null;
  if (opened) {
    return (
      <Page>
        <PeerDetail user={opened} catalog={catalog} defaults={data?.defaultMessages || {}} onChange={load} onBack={() => setOpenId(null)} />
      </Page>
    );
  }
  const { on, off } = peerList(users, query);

  return (
    <Page>
      <div className="mb-3 flex items-center gap-2">
        <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت")}>
          <ArrowRight className="size-4" />
        </button>
        <h1 className="text-lg font-semibold">{t("ایجنت‌های همکاران")}</h1>
        {tab === "people" ? (
          <button type="button" onClick={() => setAdding((v) => !v)} className="press ms-auto flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:shadow">
            <Plus className="size-4" /> همکار جدید
          </button>
        ) : null}
      </div>
      <p className="mb-4 text-sm leading-6 text-muted-foreground">
        ایجنت هر همکار با توکن خودش به {BRAND.name} وصل می‌شود و فقط ابزارهایی را دارد که شما باز کرده‌اید. کار برگشت‌ناپذیر از این مسیر انجام نمی‌شود.
      </p>

      <div role="tablist" className="mb-4 flex gap-1 rounded-xl bg-muted/60 p-1 text-sm">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`press flex-1 rounded-lg px-3 py-1.5 ${tab === t.id ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "network" ? <NetworkSection /> : tab === "audit" ? <Audit /> : (
        <>
          {adding ? <NewPeer onDone={() => { setAdding(false); load(); }} /> : null}
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("جست‌وجوی همکار")} className={`${input} ps-9`} />
          </div>
          {!data ? (
            <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : on.length || off.length ? (
            <>
              <PeerRows users={on} onOpen={setOpenId} />
              {off.length ? (
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm text-muted-foreground">غیرفعال ({off.length.toLocaleString("fa-IR")})</summary>
                  <div className="mt-2"><PeerRows users={off} onOpen={setOpenId} /></div>
                </details>
              ) : null}
            </>
          ) : (
            <p className="rounded-xl border bg-card px-4 py-8 text-center text-sm text-muted-foreground">{query ? t("همکاری با این نام نیست.") : t("هنوز ایجنتی از همکاران تعریف نشده.")}</p>
          )}
        </>
      )}
    </Page>
  );
}

const Page = ({ children }) => (
  <div className="scrollbar-thin h-full overflow-y-auto">
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 sm:px-6">{children}</div>
  </div>
);

function PeerRows({ users, onOpen }) {
  if (!users.length) return null;
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {users.map((u) => {
        const seen = lastSeen(u);
        const devices = activeClients(u).length;
        return (
          <button key={u.id} type="button" onClick={() => onOpen(u.id)} className="press flex w-full items-center gap-3 border-b px-3 py-2.5 text-start last:border-b-0 hover:bg-muted/60">
            <span className={`flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-medium ${u.enabled ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>{initial(u.label || u.id)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium" dir="auto">{u.label}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {seen ? <>{t("آخرین فعالیت")} <span title={exactTime(seen)}>{ago(seen)}</span></> : t("هنوز وصل نشده")}
                {" · "}
                {devices ? `${devices.toLocaleString("fa-IR")} دستگاه` : t("بدون دستگاه فعال")}
              </span>
            </span>
            <ChevronLeft className="size-4 shrink-0 text-muted-foreground" />
          </button>
        );
      })}
    </div>
  );
}

function Audit() {
  const [approvals, setApprovals] = useState(null);
  useEffect(() => {
    api("/api/approvals?limit=40").then((r) => setApprovals(r.approvals || []), () => setApprovals([]));
  }, []);
  if (!approvals) return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  return (
    <>
      <p className="mb-3 text-xs text-muted-foreground">{t("هر بار که ایجنتی خواست کاری برگشت‌ناپذیر بکند، اینجا ثبت می‌شود: چه کسی، چه کاری، و نتیجه.")}</p>
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
                {a.chat_id ? <button type="button" onClick={() => navigate(a.chat_id)} className="text-primary hover:underline">{t("گفتگو")}</button> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("موردی ثبت نشده.")}</p>
      )}
    </>
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
      toast.success(t("ایجنت همکار ساخته شد؛ سهمیهٔ پیش‌فرضِ فقط‌خواندنی گرفت."));
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mb-4 grid gap-2 rounded-xl border bg-card p-3 sm:grid-cols-[1fr_1fr_auto]">
      <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} required placeholder={t("شناسه (مثل ali-ahmadi)")} className={`ltr ${input}`} />
      <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={t("نام (مثل آقای رضایی)")} className={input} />
      <button type="submit" disabled={busy} className="press rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{t("ساخت")}</button>
    </form>
  );
}

const SECTIONS = [
  { id: "work", label: t("کارها") },
  { id: "access", label: t("دسترسی") },
  { id: "devices", label: t("دستگاه‌ها") },
];

function PeerDetail({ user, catalog, defaults, onChange, onBack }) {
  const [section, setSection] = useState("work");
  const [issued, setIssued] = useState(null);
  const toggle = (enabled) =>
    api(`/api/peers/${user.id}`, { method: "PATCH", body: { enabled } }).then(onChange, (e) => toast.error(e.message));
  const devices = activeClients(user).length;
  const agents = openAgents(user);
  const seen = lastSeen(user);

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <button type="button" onClick={onBack} className="press flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت به فهرست")}>
          <ArrowRight className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold" dir="auto">{user.label}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {seen ? <>{t("آخرین فعالیت")} <span title={exactTime(seen)}>{ago(seen)}</span></> : t("هنوز وصل نشده")}
            {" · "}{devices.toLocaleString("fa-IR")} دستگاه · {agents.toLocaleString("fa-IR")} ایجنت باز
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {user.enabled ? t("فعال") : t("غیرفعال")}
          <Switch.Root
            checked={user.enabled}
            onCheckedChange={toggle}
            dir="ltr"
            className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors data-[state=checked]:bg-primary"
            aria-label={t("فعال")}
          >
            <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.375rem]" />
          </Switch.Root>
        </label>
      </div>

      <div role="tablist" className="mb-4 flex gap-1 rounded-xl bg-muted/60 p-1 text-sm">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={section === s.id} onClick={() => setSection(s.id)} className={`press flex-1 rounded-lg px-3 py-1.5 ${section === s.id ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {s.label}
          </button>
        ))}
      </div>

      {section === "work" ? <PeerWork userId={user.id} label={user.label} /> : section === "access" ? (
        <>
          <p className="mb-2 text-xs text-muted-foreground">{t("این همکار به کدام ایجنت‌ها می‌تواند کار بدهد، با کدام ابزارها و تا چه سقفی. حداکثر ۲ درخواست باز در هر ایجنت.")}</p>
          <div className="space-y-2">
            {user.quotas.map((q) => <QuotaRow key={q.agent} userId={user.id} quota={q} catalog={catalog} defaults={defaults} onChange={onChange} />)}
          </div>
        </>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground">{t("هر دستگاه (لپ‌تاپ، سرور، ایجنت) توکن جدای خودش را دارد؛ با باطل کردن یکی بقیه کار می‌کنند. وصل شدن از نشانی")} <span className="ltr font-mono">{MCP_URL}</span></p>
          <div className="space-y-1">
            {user.clients.map((c) => <ClientRow key={c.id} userId={user.id} client={c} onChange={onChange} />)}
          </div>
          {issued ? <IssuedToken token={issued} onClose={() => setIssued(null)} /> : <NewClient userId={user.id} onIssued={(t) => { setIssued(t); onChange(); }} />}
          <StatusLink userId={user.id} />
        </>
      )}
    </>
  );
}

// What the colleague's agent asked for, and its raw MCP calls behind a fold (for debugging).
function PeerWork({ userId, label }) {
  const [tasks, setTasks] = useState(null);
  const [calls, setCalls] = useState(null);
  useEffect(() => {
    api(`/api/peers/${userId}/tasks`).then((r) => setTasks(r.tasks), () => setTasks([]));
    api(`/api/peers/${userId}/calls`).then((r) => setCalls(r.calls), () => setCalls([]));
  }, [userId]);
  if (tasks === null) return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  return (
    <>
      {tasks.length ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          {tasks.slice(0, 20).map((t) => {
            const [dot, label] = TASK_STATE[t.state] || ["bg-muted-foreground", t.state];
            return (
              <button key={t.id} type="button" onClick={() => navigate(t.chatId)} className="press flex w-full items-center gap-2 border-b px-3 py-2 text-start text-sm last:border-b-0 hover:bg-muted/60">
                <span className={`size-2 shrink-0 rounded-full ${dot}`} />
                <span className="min-w-0 flex-1 truncate" dir="auto">{taskTitle(t.title, label) || t.id}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{label} · <span title={exactTime(t.updatedAt)}>{ago(t.updatedAt)}</span></span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="rounded-xl border bg-card px-4 py-6 text-center text-sm text-muted-foreground">{t("هنوز کاری نخواسته.")}</p>
      )}
      {calls?.length ? (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer text-muted-foreground">جزئیات فنی: آخرین تماس‌های MCP ({calls.length.toLocaleString("fa-IR")})</summary>
          <div className="mt-2 space-y-1">
            {calls.slice(0, 15).map((c) => (
              <div key={c.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5">
                <span className={`mt-1 size-2 shrink-0 rounded-full ${c.outcome === "ok" ? "bg-ok" : "bg-bad"}`} />
                <div className="min-w-0 flex-1">
                  <span className="ltr inline-block font-mono">{c.tool || c.method}{c.arg_keys ? `(${c.arg_keys})` : ""}</span>
                  {c.detail ? <div className="ltr truncate text-start text-muted-foreground" title={c.detail}>{c.detail}</div> : null}
                </div>
                <span className="shrink-0 text-muted-foreground" title={exactTime(c.at)}>{ago(c.at)}</span>
              </div>
            ))}
            {calls.every((c) => c.method !== "tools/call") ? (
              <p className="rounded-lg bg-muted/60 px-2 py-1.5 text-muted-foreground">ایجنتش فقط وصل شده و فهرست ابزار گرفته و هیچ‌وقت ابزاری صدا نزده؛ یعنی مشکل سمت کلاینت اوست، نه {BRAND.name}.</p>
            ) : null}
          </div>
        </details>
      ) : null}
    </>
  );
}

function ClientRow({ userId, client, onChange }) {
  const revoked = Boolean(client.revoked_at);
  const expired = client.expires_at && new Date(client.expires_at) < new Date();
  const revoke = async () => {
    if (!window.confirm(t("توکن «{label}» باطل شود؟ آن دستگاه دیگر وصل نمی‌شود.", { label: client.label }))) return;
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
      <span className="text-muted-foreground" title={exactTime(client.last_used_at)}>{t("آخرین اتصال: {when}", { when: ago(client.last_used_at) })}</span>
      {client.expires_at ? <span className="text-muted-foreground">{t("انقضا: {when}", { when: time(client.expires_at) })}</span> : null}
      {revoked ? (
        <span className="text-bad">{t("باطل‌شده")}</span>
      ) : expired ? (
        <span className="text-bad">{t("منقضی")}</span>
      ) : (
        <button type="button" onClick={revoke} className="press flex items-center gap-1 rounded-full px-2 py-0.5 text-bad hover:bg-bad/10">
          <Trash2 className="size-3.5" /> {t("ابطال")}
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
      <input value={label} onChange={(e) => setLabel(e.target.value)} required placeholder={t("دستگاه جدید (مثل لپ‌تاپ)")} className={`${input} min-w-0 py-1.5`} />
      <select value={ttl} onChange={(e) => setTtl(e.target.value)} className="rounded-lg border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary">
        <option value="">{t("بدون انقضا")}</option>
        <option value="30">{t("{n} روز", { n: num(30) })}</option>
        <option value="90">{t("{n} روز", { n: num(90) })}</option>
        <option value="1">{t("{n} روز (آزمایشی)", { n: num(1) })}</option>
      </select>
      <button type="submit" disabled={busy} className="press rounded-lg border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">{t("توکن")}</button>
    </form>
  );
}

function IssuedToken({ token, onClose }) {
  const command = `claude mcp add --transport http griffin ${MCP_URL} --header "Authorization: Bearer ${token}"`;
  const copy = (text) => navigator.clipboard.writeText(text).then(() => toast.success(t("کپی شد")), () => toast.error(t("کپی نشد")));
  return (
    <div className="mt-2 rounded-lg border border-warn/50 bg-warn/10 p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-medium">{t("توکن فقط همین یک‌بار نمایش داده می‌شود.")}</span>
        <button type="button" onClick={onClose} className="ms-auto rounded p-1 hover:bg-muted" aria-label={t("بستن")}><X className="size-3.5" /></button>
      </div>
      <div className="ltr flex items-center gap-2 rounded bg-background px-2 py-1.5 font-mono">
        <span className="min-w-0 flex-1 truncate">{token}</span>
        <button type="button" onClick={() => copy(token)} className="rounded p-1 hover:bg-muted" aria-label={t("کپی توکن")}><Copy className="size-3.5" /></button>
      </div>
      <div className="ltr mt-2 flex items-center gap-2 rounded bg-background px-2 py-1.5 font-mono">
        <span className="min-w-0 flex-1 truncate">{command}</span>
        <button type="button" onClick={() => copy(command)} className="rounded p-1 hover:bg-muted" aria-label={t("کپی دستور")}><Copy className="size-3.5" /></button>
      </div>
      <p className="mt-2 text-muted-foreground">{t("توکن را در مدیر رمزهای همان همکار بگذار، نه در پیام.")}</p>
    </div>
  );
}

// The editable limits of one agent for a colleague, as form strings (empty cap = no cap).
const limitsForm = (q) => ({
  model: q.model || "",
  models: (q.models || []).join(", "),
  hourly: q.budget?.hourly ?? "",
  daily: q.budget?.daily ?? "",
  overBudget: q.messages?.overBudget || "",
  unavailable: q.messages?.unavailable || "",
});
const compact = (n) => {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
};
const WINDOW_NAME = { hourly: t("یک ساعت"), daily: t("۲۴ ساعت") };

// One token window as a bar (from Karsara): ok, warn from 80%, bad at the cap; grey without a cap.
function UsageMeter({ window, used, limit }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = !limit ? "bg-muted-foreground/40" : pct >= 100 ? "bg-bad" : pct >= 80 ? "bg-warn" : "bg-ok";
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{WINDOW_NAME[window]}</span>
        <span className="ltr font-mono">{compact(used)} / {limit ? compact(limit) : t("بی‌سقف")}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${limit ? Math.max(pct, used ? 2 : 0) : 0}%` }} />
      </div>
    </div>
  );
}

function QuotaRow({ userId, quota, catalog, defaults, onChange }) {
  const [editing, setEditing] = useState(false);
  const [tools, setTools] = useState(quota.tools || []);
  const [pick, setPick] = useState("");
  const [limits, setLimits] = useState(() => limitsForm(quota));
  useEffect(() => setTools(quota.tools || []), [quota.tools]);
  useEffect(() => setLimits(limitsForm(quota)), [quota]);
  const field = (key) => ({ value: limits[key], onChange: (e) => setLimits({ ...limits, [key]: e.target.value }) });

  const save = async () => {
    try {
      const body = { agent: quota.agent, tools };
      // Limits only on an agent the colleague keeps (an empty tool list closes the agent).
      if (tools.length) {
        Object.assign(body, {
          model: limits.model.trim() || null,
          models: limits.models.split(/[\s,،]+/).filter(Boolean), // i18n-ignore (Persian comma)
          budget: { hourly: String(limits.hourly).trim() || null, daily: String(limits.daily).trim() || null },
          messages: { overBudget: limits.overBudget, unavailable: limits.unavailable },
        });
      }
      await api(`/api/peers/${userId}/quota`, { method: "PUT", body });
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
        {editing ? (
          <span className="ms-auto flex gap-1">
            <button type="button" onClick={save} className="press flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-primary-foreground"><Check className="size-3.5" /> {t("ذخیره")}</button>
            <button type="button" onClick={() => { setTools(quota.tools || []); setLimits(limitsForm(quota)); setEditing(false); }} className="press rounded-full px-2.5 py-0.5 hover:bg-muted">{t("انصراف")}</button>
          </span>
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="press ms-auto rounded-full px-2.5 py-0.5 text-primary hover:bg-muted">{t("ویرایش")}</button>
        )}
      </div>
      {tools.length && !editing ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">{tools.length.toLocaleString("fa-IR")} ابزار مجاز</summary>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {tools.map((t) => <span key={t} className="ltr rounded-full border bg-background px-2 py-0.5 font-mono text-[11px]">{t}</span>)}
          </div>
        </details>
      ) : tools.length ? (
        <div className="flex flex-wrap gap-1">
          {tools.map((tool) => (
            <span key={tool} className="ltr flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 font-mono text-[11px]">
              {tool}
              {editing ? (
                <button type="button" onClick={() => setTools(tools.filter((x) => x !== tool))} aria-label={t("حذف {tool}", { tool })}><X className="size-3" /></button>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("بدون دسترسی (بسته) — این همکار نمی‌تواند به این ایجنت کار بدهد.")}</p>
      )}
      {editing ? (
        <div className="mt-2 flex gap-2">
          <input list={`catalog-${userId}-${quota.agent}`} value={pick} onChange={(e) => setPick(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} placeholder={t("نام ابزار")} className={`ltr ${input} py-1 font-mono text-xs`} />
          <datalist id={`catalog-${userId}-${quota.agent}`}>
            {catalog.filter((n) => !tools.includes(n)).map((n) => <option key={n} value={n} />)}
          </datalist>
          <button type="button" onClick={add} className="press rounded-lg border px-3 text-xs hover:bg-muted">{t("افزودن")}</button>
        </div>
      ) : null}
      {quota.tools?.length && !editing ? (
        <>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {t("مدل:")} <span className="ltr font-mono">{quota.model || t("پیش‌فرض ایجنت")}</span>
            {quota.models?.length ? <> · {t("مجاز:")} <span className="ltr font-mono">{quota.models.join(", ")}</span></> : null}
          </p>
          <div className="mt-1.5 flex gap-4">
            <UsageMeter window="hourly" used={quota.usage?.hourly || 0} limit={quota.budget?.hourly} />
            <UsageMeter window="daily" used={quota.usage?.daily || 0} limit={quota.budget?.daily} />
          </div>
        </>
      ) : null}
      {editing && tools.length ? (
        <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-muted-foreground">{t("مدل پیش‌فرض (account:model، خالی = پیش‌فرض ایجنت)")}</span>
            <input {...field("model")} placeholder="claude:sonnet" className={`ltr ${input} py-1 font-mono text-xs`} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">{t("مدل‌های مجاز (با کاما؛ خالی = موتورهای خود ایجنت)")}</span>
            <input {...field("models")} placeholder="claude:sonnet, openai" className={`ltr ${input} py-1 font-mono text-xs`} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">{t("سقف توکن در یک ساعت (خالی = بی‌سقف)")}</span>
            <input {...field("hourly")} inputMode="numeric" className={`ltr ${input} py-1 font-mono text-xs`} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">{t("سقف توکن در ۲۴ ساعت (خالی = بی‌سقف)")}</span>
            <input {...field("daily")} inputMode="numeric" className={`ltr ${input} py-1 font-mono text-xs`} />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="text-muted-foreground">{t("متن سقف پر (جاها: {slots})", { slots: "{window} {used} {limit} {retryAt}" })}</span>
            <textarea {...field("overBudget")} rows={2} placeholder={defaults.overBudget} className={`${input} py-1 text-xs`} />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="text-muted-foreground">{t("متن در دسترس نبودن سرویس")}</span>
            <textarea {...field("unavailable")} rows={2} placeholder={defaults.unavailable} className={`${input} py-1 text-xs`} />
          </label>
        </div>
      ) : null}
    </div>
  );
}

// The colleague's own scoreboard link (#/ps/<token>): their requests, outcome and duration, no content.
function StatusLink({ userId }) {
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/peers/${userId}/status-link`, { method: "POST" });
      const url = `${window.location.origin}/${r.path}`;
      await navigator.clipboard.writeText(url).catch(() => {});
      toast.success(t("لینک صفحهٔ وضعیت کپی شد"), { description: url });
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={make} disabled={busy} className="press mt-4 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60">
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Copy className="size-3.5" />} {t("لینک صفحهٔ وضعیتِ همکار")}
    </button>
  );
}
