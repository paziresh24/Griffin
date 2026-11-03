import { useState } from "react";
import { Popover } from "radix-ui";
import { ListTodo, Loader2, Plus, Search, X } from "lucide-react";
import { toast } from "sonner";
import { api, usePolling } from "../api.js";
import { useModuleRows, useModules } from "../module-hooks.js";
import { refHref } from "../modules.js";
import { t } from "../i18n.js";

// «تسک‌های مرتبط»: what this chat is about in another system (chat_refs: a Board task made from or for the
// chat). Each chip opens the thing in its module and has an ✕ to unlink it; «+ تسک» links one by hand (any
// task of Board, searched by words). Nothing shows for a chat with no refs unless Board is on.
const chip = "g-chip inline-flex h-7 max-w-64 shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 text-[11px] text-primary hover:bg-primary/15 [&_svg]:size-3.5";

function TaskPicker({ chatId, linked, onDone }) {
  const state = useModuleRows("board-app", "sprint", { sprint: "all" });
  const [search, setSearch] = useState("");
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (state.rows || []).filter((r) => !linked.has(r.id) && words.every((w) => [r.title, r.product, r.owner].join(" ").toLowerCase().includes(w))).slice(0, 30);
  async function pick(task) {
    try {
      await api(`/api/chats/${encodeURIComponent(chatId)}/refs`, { method: "POST", body: { refs: [{ kind: "board-app-task", ref: task.id, title: task.title }] } });
      onDone();
    } catch (e) {
      toast.error(e.message);
    }
  }
  return (
    <div className="w-80 space-y-2">
      <label className="relative block">
        <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("جستجو در کارهای بورد")} className="w-full rounded-lg border bg-background py-1.5 pe-2 ps-8 text-sm" />
      </label>
      {state.loading && !state.rows ? <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t("در حال بارگذاری…")}</p> : null}
      {state.error ? <p className="px-1 text-xs text-bad">{state.error}</p> : null}
      <ul className="max-h-60 space-y-0.5 overflow-y-auto">
        {list.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => pick(r)} className="w-full rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted" dir="auto">
              {r.title}
              {r.product ? <span className="ms-2 text-xs text-muted-foreground">{r.product}</span> : null}
            </button>
          </li>
        ))}
        {state.rows && !list.length ? <li className="px-2 py-1.5 text-xs text-muted-foreground">{t("کاری پیدا نشد.")}</li> : null}
      </ul>
    </div>
  );
}

export function RefChips({ chatId }) {
  const [n, setN] = useState(0);
  const [open, setOpen] = useState(false);
  const modules = useModules();
  const data = usePolling(chatId ? `/api/chats/${encodeURIComponent(chatId)}/refs?n=${n}` : null, 60_000);
  const refs = (data?.refs || []).map((r) => ({ ...r, href: refHref(r.kind, r.ref) })).filter((r) => r.href);
  const linked = new Set(refs.map((r) => r.ref));
  const hasBoard = modules.some((m) => m.id === "board-app");
  async function unlink(r) {
    try {
      await api(`/api/chats/${encodeURIComponent(chatId)}/refs?kind=${encodeURIComponent(r.kind)}&ref=${encodeURIComponent(r.ref)}`, { method: "DELETE" });
      setN((x) => x + 1);
    } catch (e) {
      toast.error(e.message);
    }
  }
  return (
    <>
      {refs.map((r) => (
        <span key={`${r.kind}:${r.ref}`} className={chip}>
          <a href={r.href} className="inline-flex min-w-0 items-center gap-1.5" title={t("تسک بورد: {title}", { title: r.title || r.ref })}>
            <ListTodo /> <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" dir="auto">{r.title || r.ref}</span>
          </a>
          <button type="button" onClick={() => unlink(r)} className="-me-1 rounded-full px-1 hover:text-foreground" aria-label={t("جدا کردن این تسک از گفتگو")} title={t("جدا کردن این تسک از گفتگو")}><X className="size-3" /></button>
        </span>
      ))}
      {chatId && hasBoard ? (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger className={`${chip} bg-muted text-muted-foreground hover:text-foreground`} title={t("اتصال این گفتگو به یک تسک بورد")}>
            <Plus /> <span>{t("تسک")}</span>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="start" sideOffset={6} className="z-50 rounded-xl border bg-card p-3 shadow-xl">
              <TaskPicker chatId={chatId} linked={linked} onDone={() => { setOpen(false); setN((x) => x + 1); }} />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </>
  );
}
