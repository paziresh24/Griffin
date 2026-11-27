import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Bot, Check, ChevronLeft, Loader2, PenLine, Plus, Settings2, Trash2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { agentMeta, PROVIDER_META } from "../brand.js";
import { textDir } from "../dir.js";
import { AgentGlyph } from "./Controls.jsx";
import { accountLabel } from "./Providers.jsx";
import { t, isRtl } from "../i18n.js";
import { askConfirm } from "../dialog.jsx";

const fieldClass = "w-full rounded-xl border bg-background px-3 py-2 text-sm";

// Make an agent: a name, its line of work and how it should work. Engine and tools start at the
// safe defaults and are edited on the agent's own page.
function NewAgentForm({ busy, onCreate, onCancel }) {
  const [label, setLabel] = useState("");
  const [domain, setDomain] = useState("");
  const [instructions, setInstructions] = useState("");
  const ready = label.trim() && domain.trim();
  return (
    <section className="mb-6 space-y-3 rounded-2xl border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium"><Plus className="size-4" /> {t("ایجنت تازه")}</h2>
      <label className="block text-xs text-muted-foreground">
        {t("نام")}
        <input className={`${fieldClass} mt-1`} value={label} maxLength={32} onChange={(e) => setLabel(e.target.value)} placeholder={t("مثلاً نویسندهٔ گزارش")} />
      </label>
      <label className="block text-xs text-muted-foreground">
        {t("کارش چیست؟ (یک خط)")}
        <input className={`${fieldClass} mt-1`} value={domain} maxLength={500} onChange={(e) => setDomain(e.target.value)} placeholder={t("مثلاً خلاصهٔ هفتگی فروش و ترافیک")} />
      </label>
      <label className="block text-xs text-muted-foreground">
        {t("چطور کار کند؟ (اختیاری)")}
        <textarea className={`${fieldClass} mt-1 min-h-28 leading-6`} value={instructions} maxLength={6000} onChange={(e) => setInstructions(e.target.value)} placeholder={t("لحن، قدم‌ها، چیزهایی که نباید بکند…")} />
      </label>
      <div className="flex gap-2">
        <button type="button" disabled={busy || !ready} onClick={() => onCreate({ label: label.trim(), domain: domain.trim(), instructions: instructions.trim() })} className="press inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40">
          <Check className="size-3.5" /> {t("بساز")}
        </button>
        <button type="button" onClick={onCancel} className="press rounded-lg border px-3 py-1.5 text-xs">{t("انصراف")}</button>
      </div>
    </section>
  );
}

// Name, line of work, card line and instructions: every agent's, the built-in ones too. A built-in
// agent keeps its written rules; what is written here is added on top of them.
function ProfileEditor({ agent, busy, onSave, onDelete }) {
  const initial = { label: agent.label || "", domain: agent.domain || "", blurb: agent.blurb || "", instructions: agent.instructions || "" };
  const [form, setForm] = useState(initial);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const changed = Object.keys(initial).filter((key) => form[key].trim() !== initial[key].trim());
  const save = () => {
    const body = {};
    for (const key of changed) body[key] = form[key].trim();
    onSave(body);
  };
  return (
    <section className="mb-6 space-y-3 rounded-2xl border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium"><PenLine className="size-4" /> {t("مشخصات و دستور کار")}</h2>
      <label className="block text-xs text-muted-foreground">
        {t("نام")}
        <input className={`${fieldClass} mt-1`} dir={textDir(form.label)} value={form.label} maxLength={32} onChange={set("label")} />
      </label>
      <label className="block text-xs text-muted-foreground">
        {t("کارش چیست؟ (یک خط)")}
        <input className={`${fieldClass} mt-1`} dir={textDir(form.domain)} value={form.domain} maxLength={500} onChange={set("domain")} />
      </label>
      <label className="block text-xs text-muted-foreground">
        {t("معرفی کوتاه روی کارت (اختیاری)")}
        <input className={`${fieldClass} mt-1`} dir={textDir(form.blurb)} value={form.blurb} maxLength={500} onChange={set("blurb")} />
      </label>
      <label className="block text-xs text-muted-foreground">
        {agent.builtIn ? t("دستور اضافه (روی قواعد خود این ایجنت اضافه می‌شود)") : t("چطور کار کند؟")}
        <textarea className={`${fieldClass} mt-1 min-h-32 leading-6`} dir={textDir(form.instructions)} value={form.instructions} maxLength={6000} onChange={set("instructions")} placeholder={agent.builtIn ? t("مثلاً جواب‌ها کوتاه‌تر باشد؛ قبل از هر تغییر روی X بپرسد…") : t("لحن، قدم‌ها، چیزهایی که نباید بکند…")} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || !changed.length || !form.label.trim() || !form.domain.trim()} onClick={save} className="press inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40">
          <Check className="size-3.5" /> {t("ذخیره")}
        </button>
        {changed.length ? (
          <button type="button" disabled={busy} onClick={() => setForm(initial)} className="press rounded-lg border px-3 py-1.5 text-xs">{t("برگرداندن")}</button>
        ) : null}
        <span className="text-[11px] text-muted-foreground">{t("از گفتگوی بعدی اعمال می‌شود.")}</span>
        {agent.builtIn ? null : (
          <button type="button" disabled={busy} onClick={onDelete} className="press ms-auto inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs text-bad hover:bg-bad/10">
            <Trash2 className="size-3.5" /> {t("حذف ایجنت")}
          </button>
        )}
      </div>
    </section>
  );
}

// embedded: inside Settings → «ایجنت‌ها» (no page scroll, back button or title of its own).
export function AgentsPage({ onBack, embedded = false }) {
  const [data, setData] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toolQuery, setToolQuery] = useState("");
  // «افزودن ایجنت» in the sidebar's agent menu opens #/agents/new: the form is open from the start.
  const [creating, setCreating] = useState(() => window.location.hash === "#/agents/new");
  useEffect(() => {
    const onHash = () => window.location.hash === "#/agents/new" && setCreating(true);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [accounts, setAccounts] = useState([]);

  const load = useCallback(() => {
    Promise.all([api("/api/agents"), api("/api/tool-catalog")])
      .then(([agents, tools]) => {
        setData(agents);
        setCatalog(tools?.tools || []);
      })
      .catch((e) => toast.error(e.message));
  }, []);

  useEffect(() => {
    load();
    api("/api/providers").then((d) => setAccounts(d.providers || [])).catch(() => {});
    const onChanged = (ev) => {
      const kind = ev?.detail?.kind || "all";
      if (kind === "agents" || kind === "providers" || kind === "settings" || kind === "all") {
        load();
        api("/api/providers").then((d) => setAccounts(d.providers || [])).catch(() => {});
      }
    };
    window.addEventListener("griffin:settings-changed", onChanged);
    return () => window.removeEventListener("griffin:settings-changed", onChanged);
  }, [load]);
  // The engine a card names: the account it actually runs on now, by the account's own name.
  const engineLabel = (agent) => {
    const id = agent.route?.provider || agent.provider;
    const acct = accounts.find((a) => a.id === id);
    return acct ? accountLabel(acct) : PROVIDER_META[id]?.label || id;
  };

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return undefined;
    }
    let alive = true;
    api(`/api/agents/${selected}`)
      .then((body) => {
        if (!alive) return;
        setDetail(body.agent);
      })
      .catch((e) => toast.error(e.message));
    return () => {
      alive = false;
    };
  }, [selected]);

  const { main, specialists } = useMemo(() => {
    const agents = data?.agents || [];
    return {
      main: agents.filter((a) => a.id === "griffin"),
      specialists: agents.filter((a) => a.id !== "griffin"),
    };
  }, [data]);

  const enabledSet = useMemo(() => new Set(detail?.tools || []), [detail]);
  const disabledSet = useMemo(() => new Set(detail?.disabled || []), [detail]);

  const toolRows = useMemo(() => {
    const names = catalog.map((t) => t.name);
    const q = toolQuery.trim().toLowerCase();
    return names
      .filter((n) => !q || n.toLowerCase().includes(q))
      .map((name) => {
        const on = detail?.allPlatform ? !disabledSet.has(name) : enabledSet.has(name);
        return { name, on };
      })
      .sort((a, b) => Number(b.on) - Number(a.on) || a.name.localeCompare(b.name));
  }, [catalog, toolQuery, detail, enabledSet, disabledSet]);

  const patchAgent = async (body) => {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await api(`/api/agents/${selected}`, { method: "PATCH", body });
      setDetail(res.agent);
      load();
      toast.success(t("ذخیره شد"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleTool = async (name, on) => {
    await patchAgent(on ? { disable: [name] } : { enable: [name] });
  };

  const createAgent = async (body) => {
    setBusy(true);
    try {
      const res = await api("/api/agents", { method: "POST", body });
      toast.success(t("ایجنت ساخته شد"));
      setCreating(false);
      if (window.location.hash === "#/agents/new") window.location.hash = "/agents"; // a reload does not reopen the form
      load();
      setSelected(res.agent.id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!detail || !(await askConfirm(t("ایجنت «{label}» حذف شود؟", { label: detail.label }), { danger: true, yes: t("حذف") }))) return;
    setBusy(true);
    try {
      await api(`/api/agents/${detail.id}`, { method: "DELETE" });
      toast.success(t("حذف شد"));
      setSelected(null);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (selected && detail) {
    return (
      <div className="scrollbar-thin h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:px-6">
          <div className="mb-6 flex items-center gap-2">
            <button type="button" onClick={() => setSelected(null)} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت")}>
              <ArrowRight className="rtl-mirror size-4" />
            </button>
            <AgentGlyph id={detail.id} className="size-8" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold" dir="auto">{detail.label}</h1>
              <p className="ltr text-xs text-muted-foreground">{detail.id}</p>
            </div>
            <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{detail.builtIn ? t("پیش‌فرض") : t("ساخته‌شده")}</span>
          </div>

          <ProfileEditor key={detail.id} agent={detail} busy={busy} onSave={patchAgent} onDelete={deleteAgent} />

          <section className="mb-6 space-y-3 rounded-2xl border bg-card p-4">
            <h2 className="flex items-center gap-2 text-sm font-medium"><Settings2 className="size-4" /> {t("فکر کردن")}</h2>
            <p className="text-xs leading-6 text-muted-foreground">{t("موتور را صفحهٔ «موتورها» تعیین می‌کند: هر ایجنت با اولین موتور آماده کار می‌کند و اگر خطا بدهد خودش به بعدی می‌رود.")}</p>
            <label className="block text-xs text-muted-foreground">
              {t("میزان فکر پیش‌فرض")}
              <select
                className="mt-1 w-full rounded-xl border bg-background px-3 py-2 text-sm"
                value={detail.effort || ""}
                disabled={busy}
                onChange={(e) => patchAgent({ effort: e.target.value })}
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

          <section className="space-y-3 rounded-2xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="flex items-center gap-2 text-sm font-medium"><Wrench className="size-4" /> {t("ابزارها")} <span className="text-xs font-normal text-muted-foreground">{t("({length} روشن)", { length: toolRows.filter((t) => t.on).length })}</span></h2>
              {detail.allPlatform ? (
                <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t("دامنهٔ پلتفرم (همه به‌جز CDN)")}</span>
              ) : null}
              <input
                value={toolQuery}
                onChange={(e) => setToolQuery(e.target.value)}
                placeholder={t("جستجوی ابزار…")}
                className="ms-auto w-40 rounded-lg border bg-background px-2 py-1 text-xs ltr"
                dir="ltr"
              />
            </div>
            <ul className="max-h-[28rem] space-y-1 overflow-y-auto">
              {toolRows.map(({ name, on }) => (
                <li key={name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60">
                  <span className="ltr min-w-0 flex-1 truncate text-sm">{name}</span>
                  <button
                    type="button"
                    disabled={busy || name.startsWith("agent_") || name === "list_agents"}
                    onClick={() => toggleTool(name, on)}
                    className={`press rounded-full px-2.5 py-0.5 text-[11px] ${on ? "bg-ok/15 text-ok" : "bg-muted text-muted-foreground"}`}
                  >
                    {on ? t("روشن") : t("خاموش")}
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground" dir={isRtl ? "rtl" : "ltr"}>
              {t("ایجنت هم می‌تواند با agent_tools_enable / disable خودش را مدیریت کند. تغییر از چت بعدی اعمال می‌شود.")}
            </p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={embedded ? "" : "scrollbar-thin h-full overflow-y-auto"}>
      <div className={embedded ? "" : "mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:px-6"}>
        {embedded ? null : (
          <>
            <div className="mb-6 flex items-center gap-2">
              <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت")}>
                <ArrowRight className="rtl-mirror size-4" />
              </button>
              <h1 className="text-lg font-semibold">{t("ایجنت‌ها")}</h1>
            </div>
            <p className="mb-5 text-sm leading-6 text-muted-foreground">
              {t("هر ایجنت نام، کار، دستور کار و ابزارهای خودش را دارد. برای دیدن و ویرایش روی کارت بزنید؛ ایجنت تازه را هم از همین‌جا بسازید.")}
            </p>
          </>
        )}

        {creating ? (
          <NewAgentForm busy={busy} onCreate={createAgent} onCancel={() => setCreating(false)} />
        ) : (
          <button type="button" onClick={() => setCreating(true)} className="press mb-6 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
            <Plus className="size-4" /> {t("ایجنت تازه")}
          </button>
        )}

        {!data ? (
          <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : data.agents.length === 0 ? (
          <div className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed py-12 text-muted-foreground">
            <Bot className="size-6" />
            {t("هنوز ایجنتی ثبت نشده.")}
          </div>
        ) : (
          <div className="space-y-8">
            {main.length ? (
              <section>
                <h2 className="mb-3 text-sm font-medium text-muted-foreground">{t("اصلی")}</h2>
                <ul className="space-y-3">
                  {main.map((agent) => (
                    <AgentCard key={agent.id} agent={agent} engine={engineLabel(agent)} onOpen={() => setSelected(agent.id)} />
                  ))}
                </ul>
              </section>
            ) : null}
            {specialists.length ? (
              <section>
                <h2 className="mb-3 text-sm font-medium text-muted-foreground">{t("متخصص‌ها")}</h2>
                <ul className="space-y-3">
                  {specialists.map((agent) => (
                    <AgentCard key={agent.id} agent={agent} engine={engineLabel(agent)} onOpen={() => setSelected(agent.id)} />
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentCard({ agent, engine, onOpen }) {
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
            <p className="text-xs text-muted-foreground"><span className="ltr">{agent.id}</span> · {engine}{agent.builtIn ? "" : t(" · ساخته‌شده")}</p>
          </div>
          <ChevronLeft className="rtl-mirror size-4 text-muted-foreground" />
        </div>
        {(agent.blurb || meta.blurb) ? (
          <p className="mt-3 text-sm leading-6 text-muted-foreground" dir={textDir(agent.blurb || meta.blurb)}>{agent.blurb || meta.blurb}</p>
        ) : null}
        <p className="mt-2 text-sm leading-6 text-muted-foreground" dir={textDir(agent.domain)}>{agent.domain}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          {agent.allPlatform ? t("ابزار: دامنهٔ پلتفرم") : t("{length} ابزار فعال", { length: (agent.tools || []).length })}
        </p>
      </button>
    </li>
  );
}
