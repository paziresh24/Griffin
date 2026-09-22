import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Bot, Check, Loader2, Plus, Settings2, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { agentMeta, PROVIDER_META } from "../brand.js";
import { AgentGlyph } from "./Controls.jsx";

const input = "w-full rounded-xl border bg-background px-3 py-2 text-sm";
const pill = "press rounded-full border px-3 py-1.5 text-sm";

// Callers that exist in every install, beyond the other agents and connected peers.
const FIXED_CALLERS = [
  { id: "scheduler", label: "زمان‌بند (جاب‌ها)" },
  { id: "team", label: "همکار (پیام‌رسان)" },
  { id: "ops", label: "اتاق عملیات" },
];

export function AgentsPage({ onBack }) {
  const [data, setData] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    Promise.all([api("/api/agents"), api("/api/tool-catalog")])
      .then(([agents, tools]) => {
        setData(agents);
        setCatalog((tools?.tools || []).map((t) => t.name));
      })
      .catch((e) => toast.error(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return undefined;
    }
    let alive = true;
    api(`/api/agents/${selected}`)
      .then((body) => alive && setDetail(body.agent))
      .catch((e) => toast.error(e.message));
    return () => {
      alive = false;
    };
  }, [selected]);

  const patchAgent = async (body, { quiet = false } = {}) => {
    if (!selected) return null;
    setBusy(true);
    try {
      const res = await api(`/api/agents/${selected}`, { method: "PATCH", body });
      setDetail(res.agent);
      load();
      if (!quiet) toast.success("ذخیره شد");
      return res.agent;
    } catch (e) {
      toast.error(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const createAgent = async (body) => {
    setBusy(true);
    try {
      const res = await api("/api/agents", { method: "POST", body });
      setCreating(false);
      load();
      setSelected(res.agent.id);
      toast.success(`ایجنت «${res.agent.label}» ساخته شد`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removeAgent = async (agent) => {
    if (!window.confirm(`ایجنت «${agent.label}» حذف شود؟ گفتگوهای قبلی‌اش می‌مانند.`)) return;
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}`, { method: "DELETE" });
      setSelected(null);
      load();
      toast.success("حذف شد");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (creating) {
    return <NewAgent catalog={catalog} busy={busy} onCancel={() => setCreating(false)} onCreate={createAgent} />;
  }

  if (selected && detail) {
    return (
      <AgentDetail
        agent={detail}
        agents={data?.agents || []}
        catalog={catalog}
        busy={busy}
        onBack={() => setSelected(null)}
        onPatch={patchAgent}
        onDelete={() => removeAgent(detail)}
      />
    );
  }

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:px-6">
        <div className="mb-6 flex items-center gap-2">
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label="بازگشت">
            <ArrowRight className="size-4" />
          </button>
          <h1 className="flex-1 text-lg font-semibold">ایجنت‌ها</h1>
          <button type="button" onClick={() => setCreating(true)} className={`${pill} border-primary/40 bg-primary/10 text-primary`}>
            <Plus className="me-1 inline size-3.5" /> ایجنت جدید
          </button>
        </div>
        <p className="mb-5 text-sm leading-6 text-muted-foreground">
          هر ایجنت یک پروفایل است: دستورالعملش (که چه کسی است و چطور کار می‌کند)، موتور و مدل، ابزارهای روشن،
          و اینکه چه کسی می‌تواند صدایش بزند و با کدام ابزارها.
        </p>

        {!data ? (
          <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : data.agents.length === 0 ? (
          <div className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed py-12 text-muted-foreground">
            <Bot className="size-6" />
            هنوز ایجنتی ثبت نشده.
          </div>
        ) : (
          <ul className="space-y-3">
            {data.agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} onOpen={() => setSelected(agent.id)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AgentDetail({ agent, agents, catalog, busy, onBack, onPatch, onDelete }) {
  const [toolQuery, setToolQuery] = useState("");
  const [instructions, setInstructions] = useState(agent.instructions || "");
  const [callerEdit, setCallerEdit] = useState(null);

  useEffect(() => {
    setInstructions(agent.instructions || "");
  }, [agent.id, agent.instructions]);

  const enabled = useMemo(() => new Set(agent.tools || []), [agent]);
  const disabled = useMemo(() => new Set(agent.disabled || []), [agent]);
  const toolRows = useMemo(() => {
    const q = toolQuery.trim().toLowerCase();
    return catalog
      .filter((n) => !q || n.toLowerCase().includes(q))
      .map((name) => ({ name, on: agent.allTools ? !disabled.has(name) : enabled.has(name) }))
      .sort((a, b) => Number(b.on) - Number(a.on) || a.name.localeCompare(b.name));
  }, [catalog, toolQuery, agent, enabled, disabled]);

  const callers = agent.callers || [];
  const missingCallers = [
    ...FIXED_CALLERS,
    ...agents.filter((a) => a.id !== agent.id).map((a) => ({ id: a.id, label: a.label })),
  ].filter((c) => !callers.some((row) => row.id === c.id));

  if (callerEdit) {
    const row = callers.find((c) => c.id === callerEdit.id);
    return (
      <CallerTools
        agent={agent}
        caller={callerEdit}
        current={row?.tools === "*" ? "*" : row?.tools || []}
        catalog={catalog.filter((n) => (agent.allTools ? true : enabled.has(n)))}
        busy={busy}
        onBack={() => setCallerEdit(null)}
        onSave={async (tools) => {
          await onPatch({ callers: { [callerEdit.id]: { tools } } });
          setCallerEdit(null);
        }}
      />
    );
  }

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:px-6">
        <div className="mb-6 flex items-center gap-2">
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label="بازگشت">
            <ArrowRight className="size-4" />
          </button>
          <AgentGlyph id={agent.id} className="size-8" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold" dir="auto">{agent.label}</h1>
            <p className="ltr text-xs text-muted-foreground">{agent.id}</p>
          </div>
          {agent.id === "griffin" ? null : (
            <button type="button" onClick={onDelete} disabled={busy} className="press flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label="حذف ایجنت">
              <Trash2 className="size-4" />
            </button>
          )}
        </div>

        <section className="mb-6 space-y-3 rounded-2xl border bg-card p-4">
          <h2 className="text-sm font-medium">هویت</h2>
          <label className="block text-xs text-muted-foreground">
            نام
            <input
              className={`${input} mt-1`}
              dir="auto"
              defaultValue={agent.label}
              key={`${agent.id}-label`}
              onBlur={(e) => e.target.value.trim() && e.target.value !== agent.label && onPatch({ label: e.target.value.trim() })}
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            یک خط دربارهٔ کارش (در فهرست و برای ایجنت‌های دیگر دیده می‌شود)
            <input
              className={`${input} mt-1`}
              dir="auto"
              defaultValue={agent.domain}
              key={`${agent.id}-domain`}
              onBlur={(e) => e.target.value !== agent.domain && onPatch({ domain: e.target.value })}
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            دستورالعمل — چه کسی است، چطور کار می‌کند، چه چیزی را هرگز نکند
            <textarea
              className={`${input} mt-1 min-h-40 resize-y leading-6`}
              dir="auto"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || instructions === (agent.instructions || "")}
              onClick={() => onPatch({ instructions })}
              className={`${pill} border-primary/40 bg-primary/10 text-primary disabled:opacity-40`}
            >
              ذخیرهٔ دستورالعمل
            </button>
            <p className="text-xs text-muted-foreground">قواعد مشترک (صداقت، تفویض، اجازه) خودکار بالای این متن می‌نشیند.</p>
          </div>
        </section>

        <section className="mb-6 space-y-3 rounded-2xl border bg-card p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium"><Settings2 className="size-4" /> موتور و مدل</h2>
          <div className="flex flex-wrap gap-2">
            {Object.values(PROVIDER_META).map((p) => {
              const active = (agent.provider || "cursor") === p.id;
              return (
                <button key={p.id} type="button" disabled={busy} onClick={() => onPatch({ provider: p.id, model: null })} className={`${pill} ltr ${active ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>
                  {active ? <Check className="me-1 inline size-3.5" /> : null}
                  {p.label}
                </button>
              );
            })}
          </div>
          <label className="block text-xs text-muted-foreground">
            مدل پیش‌فرض
            <input
              className={`${input} mt-1 ltr`}
              dir="ltr"
              defaultValue={agent.model || ""}
              key={`${agent.id}-${agent.provider}-${agent.model || ""}`}
              placeholder="auto"
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value === (agent.model || "")) return;
                onPatch({ model: value || null });
              }}
            />
          </label>
        </section>

        <section className="mb-6 space-y-3 rounded-2xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex items-center gap-2 text-sm font-medium"><Users className="size-4" /> چه کسی می‌تواند صدایش بزند</h2>
          </div>
          <ul className="space-y-1">
            {callers.map((row) => (
              <li key={row.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60">
                <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{row.label}</span>
                <span className="ltr text-xs text-muted-foreground">
                  {row.tools === "*" ? "همهٔ ابزارهای این ایجنت" : `${(row.tools || []).length} ابزار`}
                </span>
                {row.id === "owner" ? null : (
                  <>
                    <button type="button" disabled={busy} onClick={() => setCallerEdit(row)} className="press rounded-full bg-muted px-2.5 py-0.5 text-[11px]">
                      ویرایش
                    </button>
                    <button type="button" disabled={busy} onClick={() => onPatch({ callers: { [row.id]: null } })} className="press rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:text-destructive">
                      حذف
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {missingCallers.length ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground">افزودن:</span>
              {missingCallers.map((c) => (
                <button key={c.id} type="button" disabled={busy} onClick={() => onPatch({ callers: { [c.id]: { tools: [] } } })} className="press rounded-full border px-2.5 py-0.5 text-[11px] hover:bg-muted">
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}
          <p className="text-xs leading-5 text-muted-foreground">
            سهمیه در کد اعمال می‌شود: ابزاری که اینجا نیست، اصلاً به مدل داده نمی‌شود. صداکنندهٔ بدون ردیف، هیچ ابزاری ندارد.
          </p>
        </section>

        <section className="space-y-3 rounded-2xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">ابزارهای خودش</h2>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPatch({ allTools: !agent.allTools })}
              className={`press rounded-full px-2.5 py-0.5 text-[11px] ${agent.allTools ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}
            >
              {agent.allTools ? "همهٔ ابزارهای نصب‌شده" : "فهرست دستی"}
            </button>
            <input value={toolQuery} onChange={(e) => setToolQuery(e.target.value)} placeholder="جستجوی ابزار…" className="ms-auto w-40 rounded-lg border bg-background px-2 py-1 text-xs ltr" dir="ltr" />
          </div>
          <ul className="max-h-[28rem] space-y-1 overflow-y-auto">
            {toolRows.map(({ name, on }) => (
              <li key={name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60">
                <span className="ltr min-w-0 flex-1 truncate text-sm">{name}</span>
                <button
                  type="button"
                  disabled={busy || name.startsWith("agent_") || name === "list_agents"}
                  onClick={() => onPatch(on ? { disable: [name] } : { enable: [name] }, { quiet: true })}
                  className={`press rounded-full px-2.5 py-0.5 text-[11px] ${on ? "bg-ok/15 text-ok" : "bg-muted text-muted-foreground"}`}
                >
                  {on ? "روشن" : "خاموش"}
                </button>
              </li>
            ))}
          </ul>
          {catalog.length === 0 ? (
            <p className="text-xs text-muted-foreground" dir="rtl">
              هنوز ابزاری نصب نیست. ایجنت بدون ابزار هم کار می‌کند (فقط گفتگو)؛ برای ابزارهای زیرساختی، بروکر را با
              <span className="ltr"> config/site.json </span> بالا بیاور.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function CallerTools({ agent, caller, current, catalog, busy, onBack, onSave }) {
  const [picked, setPicked] = useState(() => (current === "*" ? new Set(catalog) : new Set(current)));
  const [query, setQuery] = useState("");
  const rows = catalog.filter((n) => !query || n.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (name) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:px-6">
        <div className="mb-4 flex items-center gap-2">
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label="بازگشت">
            <ArrowRight className="size-4" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold" dir="auto">
            {caller.label} → {agent.label}
          </h1>
          <button type="button" disabled={busy} onClick={() => onSave([...picked])} className={`${pill} border-primary/40 bg-primary/10 text-primary`}>
            ذخیره
          </button>
        </div>
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          وقتی «{caller.label}» این ایجنت را صدا می‌زند، فقط این ابزارها را دارد.
        </p>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="جستجوی ابزار…" className={`${input} ltr mb-3`} dir="ltr" />
        <ul className="space-y-1">
          {rows.map((name) => (
            <li key={name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60">
              <span className="ltr min-w-0 flex-1 truncate text-sm">{name}</span>
              <button type="button" onClick={() => toggle(name)} className={`press rounded-full px-2.5 py-0.5 text-[11px] ${picked.has(name) ? "bg-ok/15 text-ok" : "bg-muted text-muted-foreground"}`}>
                {picked.has(name) ? "دارد" : "ندارد"}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function NewAgent({ catalog, busy, onCancel, onCreate }) {
  const [form, setForm] = useState({ id: "", label: "", domain: "", instructions: "", provider: "cursor", allTools: false });
  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));
  const valid = /^[a-z0-9][a-z0-9-]{0,39}$/.test(form.id);
  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:px-6">
        <div className="mb-6 flex items-center gap-2">
          <button type="button" onClick={onCancel} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label="بازگشت">
            <ArrowRight className="size-4" />
          </button>
          <h1 className="text-lg font-semibold">ایجنت جدید</h1>
        </div>
        <form
          className="space-y-4 rounded-2xl border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            onCreate({ ...form, label: form.label.trim() || form.id });
          }}
        >
          <label className="block text-xs text-muted-foreground">
            شناسه (انگلیسی، با خط تیره)
            <input className={`${input} ltr mt-1`} dir="ltr" value={form.id} onChange={(e) => set({ id: e.target.value.toLowerCase() })} placeholder="release-manager" required />
          </label>
          <label className="block text-xs text-muted-foreground">
            نام نمایشی
            <input className={`${input} mt-1`} dir="auto" value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder="مدیر انتشار" />
          </label>
          <label className="block text-xs text-muted-foreground">
            یک خط دربارهٔ کارش
            <input className={`${input} mt-1`} dir="auto" value={form.domain} onChange={(e) => set({ domain: e.target.value })} placeholder="آماده‌سازی و بررسی انتشارها" />
          </label>
          <label className="block text-xs text-muted-foreground">
            دستورالعمل
            <textarea
              className={`${input} mt-1 min-h-40 resize-y leading-6`}
              dir="auto"
              value={form.instructions}
              onChange={(e) => set({ instructions: e.target.value })}
              placeholder="چه کسی است، چطور کار می‌کند، چه چیزی را هرگز نکند…"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {Object.values(PROVIDER_META).map((p) => (
              <button key={p.id} type="button" onClick={() => set({ provider: p.id })} className={`${pill} ltr ${form.provider === p.id ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>
                {p.label}
              </button>
            ))}
            <button type="button" onClick={() => set({ allTools: !form.allTools })} className={`${pill} ${form.allTools ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>
              {form.allTools ? "همهٔ ابزارها" : `ابزارهای پایه (${Math.max(catalog.length, 0) ? "قابل تغییر بعد از ساخت" : "پایه"})`}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy || !valid} className={`${pill} border-primary/40 bg-primary/10 text-primary disabled:opacity-40`}>
              بساز
            </button>
            <button type="button" onClick={onCancel} className={`${pill} hover:bg-muted`}>انصراف</button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            بعد از ساخت: ابزارها را روشن کن و بگو چه کسی می‌تواند صدایش بزند. پروفایل آماده هم می‌توانی وارد کنی
            (<span className="ltr">examples/agents/*.json</span>).
          </p>
        </form>
      </div>
    </div>
  );
}

function AgentCard({ agent, onOpen }) {
  const meta = agentMeta(agent.id);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="press w-full rounded-2xl border bg-card p-4 text-start shadow-sm hover:border-primary/40"
        style={{ borderColor: `${meta.color}40` }}
      >
        <div className="flex items-center gap-3">
          <AgentGlyph id={agent.id} className="size-10" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium" dir="auto">{agent.label}</p>
            <p className="ltr text-xs text-muted-foreground">{agent.id} · {PROVIDER_META[agent.provider]?.label || agent.provider}</p>
          </div>
        </div>
        {agent.domain ? <p className="mt-3 text-sm leading-6 text-muted-foreground" dir="auto">{agent.domain}</p> : null}
        <p className="mt-3 text-xs text-muted-foreground">
          {agent.allTools ? "همهٔ ابزارها" : `${(agent.tools || []).length} ابزار فعال`} · {(agent.callers || []).length} صداکننده
        </p>
      </button>
    </li>
  );
}
