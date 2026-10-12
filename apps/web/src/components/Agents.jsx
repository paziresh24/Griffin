import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Bot, Check, Loader2, Plus, Settings2, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { agentMeta, PROVIDER_META } from "../brand.js";
import { isRtl, num, t } from "../i18n.js";
import { AgentGlyph } from "./Controls.jsx";
import { accountLabel } from "./Providers.jsx";

// The engines/models an agent runs on, in order: the first one that is switched on, has a key and is
// not at its plan limit runs; the rest are fallbacks (a second Claude account, then GLM, …).
function ModelPriority({ agent, busy, onSave }) {
  const [accounts, setAccounts] = useState([]);
  const initial = agent.models?.length ? agent.models : [agent.model ? `${agent.provider}:${agent.model}` : agent.provider || "cursor"];
  const [rows, setRows] = useState(() => initial.map((entry) => {
    const i = String(entry).indexOf(":");
    return i < 0 ? { account: entry, model: "" } : { account: entry.slice(0, i), model: entry.slice(i + 1) };
  }));
  useEffect(() => {
    api("/api/providers").then((d) => setAccounts(d.providers || [])).catch(() => {});
  }, []);
  const dirty = JSON.stringify(rows.map((r) => (r.model ? `${r.account}:${r.model}` : r.account))) !== JSON.stringify(initial);
  const set = (i, patch) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i, d) => setRows((list) => {
    const next = [...list];
    const [row] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + d)), 0, row);
    return next;
  });
  const field = "rounded-lg border bg-background px-2 py-1.5 text-sm";
  return (
    <div className="space-y-2">
      <p className="text-xs leading-6 text-muted-foreground">{t("مدل‌ها به ترتیب اولویت: اولین حسابِ روشن، کلیددار و بدون سقف اجرا می‌شود؛ بقیه جایگزین‌اند.")}</p>
      {rows.map((row, i) => {
        const acct = accounts.find((a) => a.id === row.account);
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <span className="w-5 text-center text-xs text-muted-foreground">{i + 1}</span>
            <select className={`${field} min-w-36`} value={row.account} onChange={(e) => set(i, { account: e.target.value, model: "" })}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}{a.enabled ? "" : t(" (خاموش)")}</option>)}
              {!acct ? <option value={row.account}>{row.account}</option> : null}
            </select>
            <input className={`${field} min-w-0 flex-1`} dir="ltr" list={`models-${row.account}`} value={row.model} onChange={(e) => set(i, { model: e.target.value })} placeholder={acct?.defaultModel || t("مدل پیش‌فرض حساب")} />
            <datalist id={`models-${row.account}`}>{(acct?.models || []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
            <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="press rounded-md p-1 hover:bg-muted disabled:opacity-30" aria-label={t("بالا")}><ArrowUp className="size-4" /></button>
            <button type="button" disabled={i === rows.length - 1} onClick={() => move(i, 1)} className="press rounded-md p-1 hover:bg-muted disabled:opacity-30" aria-label={t("پایین")}><ArrowDown className="size-4" /></button>
            <button type="button" disabled={rows.length === 1} onClick={() => setRows((list) => list.filter((_, j) => j !== i))} className="press rounded-md p-1 hover:bg-bad/10 hover:text-bad disabled:opacity-30" aria-label={t("حذف")}><X className="size-4" /></button>
          </div>
        );
      })}
      <div className="flex gap-2">
        <button type="button" onClick={() => setRows((list) => [...list, { account: accounts.find((a) => a.enabled)?.id || "claude", model: "" }])} className="press inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs">
          <Plus className="size-3.5" /> {t("جایگزین")}
        </button>
        {dirty ? (
          <button type="button" disabled={busy} onClick={() => onSave(rows.map((r) => (r.model.trim() ? `${r.account}:${r.model.trim()}` : r.account)))} className="press inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground">
            <Check className="size-3.5" /> {t("ذخیرهٔ ترتیب")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

const input = "w-full rounded-xl border bg-background px-3 py-2 text-sm";
const pill = "press rounded-full border px-3 py-1.5 text-sm";

// Callers that exist in every install, beyond the other agents and connected peers.
const FIXED_CALLERS = [
  { id: "scheduler", label: t("زمان‌بند (جاب‌ها)") },
  { id: "team", label: t("همکار (پیام‌رسان)") },
  { id: "ops", label: t("اتاق عملیات") },
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
      if (!quiet) toast.success(t("ذخیره شد"));
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
      toast.success(t("ایجنت «{name}» ساخته شد", { name: res.agent.label }));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removeAgent = async (agent) => {
    if (!window.confirm(t("ایجنت «{name}» حذف شود؟ گفتگوهای قبلی‌اش می‌مانند.", { name: agent.label }))) return;
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}`, { method: "DELETE" });
      setSelected(null);
      load();
      toast.success(t("حذف شد"));
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
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت")}>
            <ArrowRight className="size-4 rtl-mirror" />
          </button>
          <h1 className="flex-1 text-lg font-semibold">{t("ایجنت‌ها")}</h1>
          <button type="button" onClick={() => setCreating(true)} className={`${pill} border-primary/40 bg-primary/10 text-primary`}>
            <Plus className="me-1 inline size-3.5" /> {t("ایجنت جدید")}
          </button>
        </div>
        <p className="mb-5 text-sm leading-6 text-muted-foreground">
          {t("هر ایجنت یک پروفایل است: دستورالعملش (که چه کسی است و چطور کار می‌کند)، موتور و مدل، ابزارهای روشن، و اینکه چه کسی می‌تواند صدایش بزند و با کدام ابزارها.")}
        </p>

        {!data ? (
          <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : data.agents.length === 0 ? (
          <div className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed py-12 text-muted-foreground">
            <Bot className="size-6" />
            {t("هنوز ایجنتی ثبت نشده.")}
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
  const noToolsHint = t("هنوز ابزاری نصب نیست. ایجنت بدون ابزار هم کار می‌کند (فقط گفتگو)؛ برای ابزارهای زیرساختی، بروکر را با {file} بالا بیاور.").split("{file}");
  const missingCallers = [
    ...FIXED_CALLERS,
    ...agents.filter((a) => a.id !== agent.id).map((a) => ({ id: a.id, label: t(a.label) })),
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
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت")}>
            <ArrowRight className="size-4 rtl-mirror" />
          </button>
          <AgentGlyph id={agent.id} className="size-8" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold" dir="auto">{t(agent.label)}</h1>
            <p className="ltr text-xs text-muted-foreground">{agent.id}</p>
          </div>
          {agent.id === "griffin" ? null : (
            <button type="button" onClick={onDelete} disabled={busy} className="press flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={t("حذف ایجنت")}>
              <Trash2 className="size-4" />
            </button>
          )}
        </div>

        <section className="mb-6 space-y-3 rounded-2xl border bg-card p-4">
          <h2 className="text-sm font-medium">{t("هویت")}</h2>
          <label className="block text-xs text-muted-foreground">
            {t("نام")}
            <input
              className={`${input} mt-1`}
              dir="auto"
              defaultValue={agent.label}
              key={`${agent.id}-label`}
              onBlur={(e) => e.target.value.trim() && e.target.value !== agent.label && onPatch({ label: e.target.value.trim() })}
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            {t("یک خط دربارهٔ کارش (در فهرست و برای ایجنت‌های دیگر دیده می‌شود)")}
            <input
              className={`${input} mt-1`}
              dir="auto"
              defaultValue={agent.domain}
              key={`${agent.id}-domain`}
              onBlur={(e) => e.target.value !== agent.domain && onPatch({ domain: e.target.value })}
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            {t("دستورالعمل — چه کسی است، چطور کار می‌کند، چه چیزی را هرگز نکند")}
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
              {t("ذخیرهٔ دستورالعمل")}
            </button>
            <p className="text-xs text-muted-foreground">{t("قواعد مشترک (صداقت، تفویض، اجازه) خودکار بالای این متن می‌نشیند.")}</p>
          </div>
        </section>

        <section className="mb-6 space-y-3 rounded-2xl border bg-card p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium"><Settings2 className="size-4" /> {t("موتور و مدل")}</h2>
          <ModelPriority key={agent.id} agent={agent} busy={busy} onSave={(models) => onPatch({ models })} />
          <label className="block text-xs text-muted-foreground">
            {t("میزان فکر پیش‌فرض")}
            <select
              className={`${input} mt-1`}
              value={agent.effort || ""}
              disabled={busy}
              onChange={(e) => onPatch({ effort: e.target.value })}
            >
              <option value="">{t("خودکار (پیش‌فرض موتور)")}</option>
              <option value="low">{t("کم — سریع و ارزان")}</option>
              <option value="medium">{t("متوسط")}</option>
              <option value="high">{t("زیاد")}</option>
              <option value="xhigh">{t("خیلی زیاد (فقط Claude)")}</option>
              <option value="max">{t("حداکثر (فقط Claude)")}</option>
            </select>
          </label>
        </section>

        <section className="mb-6 space-y-3 rounded-2xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex items-center gap-2 text-sm font-medium"><Users className="size-4" /> {t("چه کسی می‌تواند صدایش بزند")}</h2>
          </div>
          <ul className="space-y-1">
            {callers.map((row) => (
              <li key={row.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60">
                <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{row.label}</span>
                <span className="ltr text-xs text-muted-foreground">
                  {row.tools === "*" ? t("همهٔ ابزارهای این ایجنت") : t("{n} ابزار", { n: num((row.tools || []).length) })}
                </span>
                {row.id === "owner" ? null : (
                  <>
                    <button type="button" disabled={busy} onClick={() => setCallerEdit(row)} className="press rounded-full bg-muted px-2.5 py-0.5 text-[11px]">
                      {t("ویرایش")}
                    </button>
                    <button type="button" disabled={busy} onClick={() => onPatch({ callers: { [row.id]: null } })} className="press rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:text-destructive">
                      {t("حذف")}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {missingCallers.length ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground">{t("افزودن:")}</span>
              {missingCallers.map((c) => (
                <button key={c.id} type="button" disabled={busy} onClick={() => onPatch({ callers: { [c.id]: { tools: [] } } })} className="press rounded-full border px-2.5 py-0.5 text-[11px] hover:bg-muted">
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}
          <p className="text-xs leading-5 text-muted-foreground">
            {t("سهمیه در کد اعمال می‌شود: ابزاری که اینجا نیست، اصلاً به مدل داده نمی‌شود. صداکنندهٔ بدون ردیف، هیچ ابزاری ندارد.")}
          </p>
        </section>

        <section className="space-y-3 rounded-2xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">{t("ابزارهای خودش")}</h2>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPatch({ allTools: !agent.allTools })}
              className={`press rounded-full px-2.5 py-0.5 text-[11px] ${agent.allTools ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}
            >
              {agent.allTools ? t("همهٔ ابزارهای نصب‌شده") : t("فهرست دستی")}
            </button>
            <input value={toolQuery} onChange={(e) => setToolQuery(e.target.value)} placeholder={t("جستجوی ابزار…")} className="ms-auto w-40 rounded-lg border bg-background px-2 py-1 text-xs ltr" dir="ltr" />
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
                  {on ? t("روشن") : t("خاموش")}
                </button>
              </li>
            ))}
          </ul>
          {catalog.length === 0 ? (
            <p className="text-xs text-muted-foreground" dir={isRtl ? "rtl" : "ltr"}>
              {noToolsHint[0]}
              <span className="ltr"> config/site.json </span>{noToolsHint[1]}
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
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت")}>
            <ArrowRight className="size-4 rtl-mirror" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold" dir="auto">
            {caller.label} → {t(agent.label)}
          </h1>
          <button type="button" disabled={busy} onClick={() => onSave([...picked])} className={`${pill} border-primary/40 bg-primary/10 text-primary`}>
            {t("ذخیره")}
          </button>
        </div>
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          {t("وقتی «{caller}» این ایجنت را صدا می‌زند، فقط این ابزارها را دارد.", { caller: caller.label })}
        </p>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("جستجوی ابزار…")} className={`${input} ltr mb-3`} dir="ltr" />
        <ul className="space-y-1">
          {rows.map((name) => (
            <li key={name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60">
              <span className="ltr min-w-0 flex-1 truncate text-sm">{name}</span>
              <button type="button" onClick={() => toggle(name)} className={`press rounded-full px-2.5 py-0.5 text-[11px] ${picked.has(name) ? "bg-ok/15 text-ok" : "bg-muted text-muted-foreground"}`}>
                {picked.has(name) ? t("دارد") : t("ندارد")}
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
  const afterCreate = t("بعد از ساخت: ابزارها را روشن کن و بگو چه کسی می‌تواند صدایش بزند. پروفایل آماده هم می‌توانی وارد کنی ({file}).").split("{file}");
  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:px-6">
        <div className="mb-6 flex items-center gap-2">
          <button type="button" onClick={onCancel} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت")}>
            <ArrowRight className="size-4 rtl-mirror" />
          </button>
          <h1 className="text-lg font-semibold">{t("ایجنت جدید")}</h1>
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
            {t("شناسه (انگلیسی، با خط تیره)")}
            <input className={`${input} ltr mt-1`} dir="ltr" value={form.id} onChange={(e) => set({ id: e.target.value.toLowerCase() })} placeholder="release-manager" required />
          </label>
          <label className="block text-xs text-muted-foreground">
            {t("نام نمایشی")}
            <input className={`${input} mt-1`} dir="auto" value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder={t("مدیر انتشار")} />
          </label>
          <label className="block text-xs text-muted-foreground">
            {t("یک خط دربارهٔ کارش")}
            <input className={`${input} mt-1`} dir="auto" value={form.domain} onChange={(e) => set({ domain: e.target.value })} placeholder={t("آماده‌سازی و بررسی انتشارها")} />
          </label>
          <label className="block text-xs text-muted-foreground">
            {t("دستورالعمل")}
            <textarea
              className={`${input} mt-1 min-h-40 resize-y leading-6`}
              dir="auto"
              value={form.instructions}
              onChange={(e) => set({ instructions: e.target.value })}
              placeholder={t("چه کسی است، چطور کار می‌کند، چه چیزی را هرگز نکند…")}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {Object.values(PROVIDER_META).map((p) => (
              <button key={p.id} type="button" onClick={() => set({ provider: p.id })} className={`${pill} ltr ${form.provider === p.id ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>
                {p.label}
              </button>
            ))}
            <button type="button" onClick={() => set({ allTools: !form.allTools })} className={`${pill} ${form.allTools ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>
              {form.allTools ? t("همهٔ ابزارها") : t("ابزارهای پایه ({note})", { note: Math.max(catalog.length, 0) ? t("قابل تغییر بعد از ساخت") : t("پایه") })}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy || !valid} className={`${pill} border-primary/40 bg-primary/10 text-primary disabled:opacity-40`}>
              {t("بساز")}
            </button>
            <button type="button" onClick={onCancel} className={`${pill} hover:bg-muted`}>{t("انصراف")}</button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {afterCreate[0]}<span className="ltr">examples/agents/*.json</span>{afterCreate[1]}
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
            <p className="truncate font-medium" dir="auto">{t(agent.label)}</p>
            <p className="ltr text-xs text-muted-foreground">{agent.id} · {PROVIDER_META[agent.provider]?.label || agent.provider}</p>
          </div>
        </div>
        {agent.domain ? <p className="mt-3 text-sm leading-6 text-muted-foreground" dir="auto">{t(agent.domain)}</p> : null}
        <p className="mt-3 text-xs text-muted-foreground">
          {agent.allTools ? t("همهٔ ابزارها") : t("{n} ابزار فعال", { n: num((agent.tools || []).length) })} · {t("{n} صداکننده", { n: num((agent.callers || []).length) })}
        </p>
      </button>
    </li>
  );
}
