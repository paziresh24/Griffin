import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Bot, MessageCircle, Search, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { agentMeta } from "../brand.js";
import { AgentPicker } from "./Controls.jsx";

export function TelegramPage({ onBack }) {
  const [persons, setPersons] = useState(null);
  const [selected, setSelected] = useState(null);
  const [chats, setChats] = useState([]);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api("/api/telegram/persons")
      .then((r) => {
        const list = r.persons || [];
        setPersons(list);
        setSelected((cur) => (cur ? list.find((p) => p.id === cur.id) || cur : null));
      })
      .catch(() => setPersons([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setChats([]);
      return;
    }
    api(`/api/telegram/persons/${selected.id}/chats`)
      .then((r) => setChats(r.chats || []))
      .catch(() => setChats([]));
  }, [selected]);

  const filtered = useMemo(() => {
    const list = persons || [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((p) => `${p.display_name || ""} ${p.username || ""} ${p.external_id || ""}`.toLowerCase().includes(needle));
  }, [persons, q]);

  const personAgent = selected?.access?.agent || "platform";

  const setPersonAgent = async (agent) => {
    if (!selected) return;
    setSaving(true);
    try {
      const { person } = await api(`/api/telegram/persons/${selected.id}`, {
        method: "PATCH",
        body: { access: { ...(selected.access || {}), agent } },
      });
      setSelected(person);
      setPersons((list) => (list || []).map((p) => (p.id === person.id ? person : p)));
      toast.success(`ایجنت پوشش: ${agentMeta(agent).label}`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const createChat = async () => {
    if (!selected) return;
    const { chat } = await api("/api/chats", {
      method: "POST",
      body: {
        text: `گفتگوی هم‌تیمی با «${selected.display_name || selected.username || selected.external_id}» شروع شد.`,
        mode: "agent",
        agent: personAgent,
      },
    });
    if (chat?.id) {
      await api(`/api/chats/${chat.id}`, { method: "PATCH", body: { personId: selected.id } });
      navigate(chat.id);
    }
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 pb-10 pt-4 sm:px-6">
        <div className="mb-4 flex items-center gap-2">
          <button type="button" onClick={onBack} className="rounded-full p-2 hover:bg-muted" aria-label="بازگشت">
            <ArrowRight className="size-4" />
          </button>
          <h1 className="text-lg font-semibold">هم‌تیمی‌ها</h1>
          <button
            type="button"
            onClick={() => {
              window.location.hash = "/settings";
            }}
            className="ms-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs"
          >
            <Settings2 className="size-3.5" /> اتصال تلگرام
          </button>
        </div>
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          اینجا فقط پروفایل و گفتگوی هم‌تیمی‌هاست. برای هر نفر می‌توانی بگویی `/agent` با کدام ایجنت باز شود.
        </p>
        {!persons ? (
          <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">در حال بارگذاری…</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[20rem_1fr]">
            <section className="rounded-2xl border bg-card p-3">
              <label className="flex items-center gap-2 rounded-lg bg-muted px-2">
                <Search className="size-4 text-muted-foreground" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="جستجوی هم‌تیمی…"
                  className="w-full bg-transparent py-2 text-sm outline-none"
                />
              </label>
              <ul className="mt-3 max-h-[32rem] space-y-1 overflow-y-auto">
                {filtered.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(p)}
                      className={`w-full rounded-xl px-3 py-2 text-start ${selected?.id === p.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                    >
                      <div className="truncate text-sm" dir="auto">{p.display_name || p.external_id}</div>
                      <div className="truncate text-xs opacity-60 ltr">
                        {p.username ? `@${p.username}` : p.external_id}
                        {p.access?.agent ? ` · ${agentMeta(p.access.agent).short || agentMeta(p.access.agent).label}` : ""}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              {!filtered.length ? (
                <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                  هنوز پروفایل هم‌تیمی نیست. بعد از `/agent` در یک گفتگوی تلگرام اینجا ظاهر می‌شود.
                </p>
              ) : null}
              <button
                type="button"
                onClick={createChat}
                disabled={!selected}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
              >
                <Bot className="size-4" /> افزودن گفتگوی هم‌تیمی
              </button>
            </section>
            <section className="rounded-2xl border bg-card p-4">
              {selected ? (
                <>
                  <h2 className="font-medium" dir="auto">{selected.display_name}</h2>
                  <p className="text-xs text-muted-foreground ltr">
                    {selected.external_id}
                    {selected.username ? ` · @${selected.username}` : ""}
                  </p>
                  <div className="mt-4">
                    <span className="mb-1.5 block text-xs text-muted-foreground">ایجنت پوشش `/agent`</span>
                    <AgentPicker agent={personAgent} onChange={setPersonAgent} locked={saving} className="w-full max-w-sm" />
                    <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
                      از `/agent` بعدی در چت این هم‌تیمی با همین ایجنت باز می‌شود. پیش‌فرض: پلتفرم‌بان.
                    </p>
                  </div>
                  <div className="mt-4 space-y-2">
                    {chats.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => navigate(c.id)}
                        className="w-full rounded-xl border px-3 py-2 text-start hover:bg-muted"
                      >
                        <div className="truncate text-sm" dir="auto">{c.title}</div>
                        <div className="text-xs text-muted-foreground">{c.updatedAt || c.updated_at}</div>
                      </button>
                    ))}
                    {!chats.length ? (
                      <p className="py-10 text-center text-sm text-muted-foreground">
                        هنوز گفتگویی برای این هم‌تیمی نیست — با دکمهٔ «افزودن گفتگوی هم‌تیمی» بساز.
                      </p>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="flex min-h-80 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                  <MessageCircle className="size-6" />
                  یک هم‌تیمی را از فهرست انتخاب کن.
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
