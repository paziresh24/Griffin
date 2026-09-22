import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Bot, Check, Loader2, Plus, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { agentMeta, PROVIDER_META } from "../brand.js";
import { AgentGlyph } from "./Controls.jsx";

export function AgentsPage({ onBack }) {
  const [data, setData] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toolQuery, setToolQuery] = useState("");

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
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return undefined;
    }
    let alive = true;
    api(`/api/agents/${selected}`)
      .then((body) => {
        if (alive) setDetail(body.agent);
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
      toast.success("ذخیره شد");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleTool = async (name, on) => {
    await patchAgent(on ? { disable: [name] } : { enable: [name] });
  };

  if (selected && detail) {
    const meta = agentMeta(detail.id);
    return (
      <div className="scrollbar-thin h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:px-6">
          <div className="mb-6 flex items-center gap-2">
            <button type="button" onClick={() => setSelected(null)} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label="بازگشت">
              <ArrowRight className="size-4" />
            </button>
            <AgentGlyph id={detail.id} className="size-8" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold" dir="auto">{detail.label}</h1>
              <p className="ltr text-xs text-muted-foreground">{detail.id}</p>
            </div>
          </div>

          <section className="mb-6 space-y-3 rounded-2xl border bg-card p-4">
            <h2 className="flex items-center gap-2 text-sm font-medium"><Settings2 className="size-4" /> موتور و مدل</h2>
            <div className="flex flex-wrap gap-2">
              {Object.values(PROVIDER_META).map((p) => {
                const active = (detail.provider || "cursor") === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={busy}
                    onClick={() => patchAgent({ provider: p.id, model: null })}
                    className={`press rounded-full border px-3 py-1.5 text-sm ltr ${active ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}
                  >
                    {active ? <Check className="me-1 inline size-3.5" /> : null}
                    {p.label}
                  </button>
                );
              })}
            </div>
            <label className="block text-xs text-muted-foreground">
              مدل پیش‌فرض
              <input
                className="mt-1 w-full rounded-xl border bg-background px-3 py-2 text-sm ltr"
                dir="ltr"
                defaultValue={detail.model || ""}
                key={`${detail.id}-${detail.provider}-${detail.model || ""}`}
                placeholder="auto"
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (value === (detail.model || "")) return;
                  patchAgent({ model: value || null });
                }}
              />
            </label>
            <p className="text-xs text-muted-foreground" dir="rtl">{detail.domain}</p>
          </section>

          <section className="space-y-3 rounded-2xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-medium">ابزارها</h2>
              {detail.allPlatform ? (
                <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">دامنهٔ پلتفرم (همه به‌جز CDN)</span>
              ) : null}
              <input
                value={toolQuery}
                onChange={(e) => setToolQuery(e.target.value)}
                placeholder="جستجوی ابزار…"
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
                    {on ? "روشن" : "خاموش"}
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground" dir="rtl">
              ایجنت هم می‌تواند با agent_tools_enable / disable خودش را مدیریت کند. تغییر از چت بعدی اعمال می‌شود.
            </p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:px-6">
        <div className="mb-6 flex items-center gap-2">
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label="بازگشت">
            <ArrowRight className="size-4" />
          </button>
          <h1 className="text-lg font-semibold">ایجنت‌ها</h1>
        </div>
        <p className="mb-5 text-sm leading-6 text-muted-foreground">
          هر ایجنت پروفایل خودش را دارد: موتور (Cursor/Claude)، مدل، و ابزارهای روشن. برای تنظیم، روی کارت بزن.
        </p>

        {!data ? (
          <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : data.agents.length === 0 ? (
          <div className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed py-12 text-muted-foreground">
            <Bot className="size-6" />
            هنوز ایجنتی ثبت نشده.
          </div>
        ) : (
          <div className="space-y-8">
            {main.length ? (
              <section>
                <h2 className="mb-3 text-sm font-medium text-muted-foreground">اصلی</h2>
                <ul className="space-y-3">
                  {main.map((agent) => (
                    <AgentCard key={agent.id} agent={agent} onOpen={() => setSelected(agent.id)} />
                  ))}
                </ul>
              </section>
            ) : null}
            {specialists.length ? (
              <section>
                <h2 className="mb-3 text-sm font-medium text-muted-foreground">متخصص‌ها</h2>
                <ul className="space-y-3">
                  {specialists.map((agent) => (
                    <AgentCard key={agent.id} agent={agent} onOpen={() => setSelected(agent.id)} />
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
          <Plus className="size-4 text-muted-foreground" />
        </div>
        {(agent.blurb || meta.blurb) ? (
          <p className="mt-3 text-sm leading-6 text-muted-foreground" dir="auto">{agent.blurb || meta.blurb}</p>
        ) : null}
        <p className="mt-2 text-sm leading-6 text-muted-foreground" dir="auto">{agent.domain}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          {agent.allPlatform ? "ابزار: دامنهٔ پلتفرم" : `${(agent.tools || []).length} ابزار فعال`}
        </p>
      </button>
    </li>
  );
}
