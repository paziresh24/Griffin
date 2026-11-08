import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { Check, CheckCircle2, ChevronDown, Circle, GitCompare, Globe, Lightbulb, ListChecks, Loader2, MessagesSquare, PanelLeft, Pin, Plus, RefreshCw, SquareTerminal, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { emptyPane, cleanPane, diffRows, missingViews, paneReducer, planSummary, taskDone, PANE_VIEWS } from "../chat-pane.js";
import { isRtl, num, t } from "../i18n.js";
import { BrowserPanel } from "./BrowserPanel.jsx";
import { SidePanel } from "./SideChat.jsx";
import { Terminal } from "./Workbench.jsx";

// The pane beside a chat (owner 2026-11-05, the «Claude دسکتاپ» design): the chat's plan, its git
// changes, its terminals, its browser and its side chats, as tabs it opens itself. The top button of
// the chat shows the pinned view and opens the pane on it; nothing shows while it is closed.

const VIEW = {
  plan: { label: () => t("پلن"), Icon: ListChecks },
  changes: { label: () => t("تغییرات"), Icon: GitCompare },
  terminal: { label: () => t("ترمینال"), Icon: SquareTerminal },
  browser: { label: () => t("مرورگر"), Icon: Globe },
  side: { label: () => t("چت کناری"), Icon: MessagesSquare },
};

const STORE_KEY = "griffin.chatPane";
const WIDTH_KEY = "griffin.chatPane.width";
const read = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* this browser keeps nothing */ } };

export function useChatPane() {
  // On a phone the pane covers the chat, so a chat always opens with it closed.
  const [pane, dispatch] = useReducer(paneReducer, undefined, () => {
    if (typeof localStorage === "undefined") return emptyPane();
    const stored = cleanPane(read(STORE_KEY));
    return window.innerWidth < 768 ? { ...stored, open: false } : stored;
  });
  useEffect(() => write(STORE_KEY, pane), [pane]);
  return [pane, dispatch];
}

/** The chat's plan, kept fresh: agents change it through a tool, so it is read again while the chat runs. */
export function useChatPlan(chatId, running) {
  const [plan, setPlan] = useState(null);
  useEffect(() => {
    setPlan(null);
    if (!chatId) return undefined;
    let alive = true;
    let timer = null;
    const load = async () => {
      if (!document.hidden) {
        try {
          const data = await api(`/api/chats/${chatId}/plan`);
          if (alive) setPlan(data?.plan || null);
        } catch { /* the next round tries again */ }
      }
      if (alive) timer = setTimeout(load, running ? 2500 : 15000);
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [chatId, running]);
  const act = useCallback(async (path, body) => {
    try {
      const data = await api(`/api/chats/${chatId}/plan/${path}`, { method: "POST", body });
      setPlan(data?.plan || null);
      return true;
    } catch (error) {
      toast.error(error.message);
      return false;
    }
  }, [chatId]);
  return { plan, act };
}

function useChanges(chatId, active) {
  const [changes, setChanges] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    try {
      const data = await api(`/api/chats/${chatId}/changes`);
      setChanges(data?.changes || null);
    } catch { /* keeps what it showed */ }
    setLoaded(true);
  }, [chatId]);
  useEffect(() => {
    setChanges(null);
    setLoaded(false);
    if (!chatId || !active) return undefined;
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 8000);
    return () => clearInterval(timer);
  }, [chatId, active, load]);
  return { changes, loaded, load };
}

function PlanLabel({ summary }) {
  if (summary.proposed) return <><span className="size-1.5 rounded-full bg-warn" />{t("پلن")}<span className="hidden font-normal lg:inline">{t("· منتظر تأیید")}</span></>;
  if (summary.active && !summary.finished) return <>{t("پلن")} <bdi className="ltr tabular-nums">{num(summary.done)}/{num(summary.total)}</bdi></>;
  return t("پلن");
}

/** Top of the chat: its body opens and closes the pane, its arrow lists every view with a pin. */
export function PaneButton({ pane, dispatch, summary, available, counts }) {
  const [menu, setMenu] = useState(false);
  const pinned = pane.pinned && available.includes(pane.pinned) ? pane.pinned : null;
  const Icon = pinned ? VIEW[pinned].Icon : PanelLeft;
  const open = pane.open;
  return (
    <div className={`g-chip flex h-[1.875rem] shrink-0 items-stretch rounded-lg border text-xs ${open ? "border-transparent bg-accent text-primary" : "text-foreground"}`}>
      <button type="button" className="flex items-center gap-1.5 rounded-s-[0.45rem] px-2 font-medium hover:bg-foreground/10" onClick={() => dispatch({ type: "toggle" })} aria-pressed={open} title={open ? t("بستن پنل") : t("باز کردن پنل")}>
        <Icon className="size-3.5" />
        {pinned === "plan" ? <span className="flex items-center gap-1"><PlanLabel summary={summary} /></span> : (
          <span className="hidden items-center gap-1 sm:flex">{pinned ? VIEW[pinned].label() : t("نماها")}{pinned && counts[pinned] ? <bdi className="tabular-nums opacity-70">{counts[pinned]}</bdi> : null}</span>
        )}
        {pinned !== "plan" && summary.proposed ? <span className="size-1.5 rounded-full bg-warn" title={t("پلن منتظر تأیید است")} /> : null}
      </button>
      <Popover.Root open={menu} onOpenChange={setMenu}>
        <Popover.Trigger asChild>
          <button type="button" className={`hidden w-6 items-center justify-center rounded-e-[0.45rem] border-s hover:bg-foreground/10 sm:flex ${open ? "border-primary/30" : "text-muted-foreground"}`} title={t("همهٔ نماها")} aria-label={t("همهٔ نماها")}>
            <ChevronDown className="size-3.5" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="end" sideOffset={6} dir={isRtl ? "rtl" : "ltr"} className="pop z-50 w-60 rounded-xl border bg-card p-1 text-sm text-foreground shadow-xl">
            {available.map((id) => {
              const { Icon: ViewIcon, label } = VIEW[id];
              const isPin = pane.pinned === id;
              const showing = pane.open && pane.tabs.includes(id);
              return (
                <div key={id} className="flex items-center gap-0.5">
                  <button type="button" className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-start hover:bg-muted" onClick={() => { dispatch({ type: "tab", id }); setMenu(false); }}>
                    <ViewIcon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{label()}</span>
                    {counts[id] ? <bdi className="text-xs tabular-nums text-muted-foreground">{counts[id]}</bdi> : null}
                    <span className="flex size-4 shrink-0 items-center justify-center text-primary">{showing ? <Check className="size-3.5" /> : null}</span>
                  </button>
                  <button type="button" className={`flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted ${isPin ? "text-primary" : "text-muted-foreground"}`} onClick={() => dispatch({ type: "pin", id })} aria-pressed={isPin} title={isPin ? t("برداشتن پین") : t("پین کردن")} aria-label={`${isPin ? t("برداشتن پین") : t("پین کردن")} ${label()}`}>
                    <Pin className={`size-3.5 ${isPin ? "fill-current" : ""}`} />
                  </button>
                </div>
              );
            })}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function ViewTab({ id, pane, dispatch, full }) {
  const { Icon, label } = VIEW[id];
  const active = pane.tab === id;
  const isPin = pane.pinned === id;
  return (
    <div className={`group relative flex h-8 shrink-0 items-center rounded-lg text-xs ${active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
      <button type="button" className={`flex h-8 items-center gap-1.5 rounded-lg ${full ? "px-2.5" : "px-2"} ${active ? "pe-1" : ""}`} onClick={() => dispatch({ type: "tab", id })} aria-pressed={active} title={label()} aria-label={label()}>
        <Icon className="size-4 shrink-0" />
        {full ? <span>{label()}</span> : null}
        {isPin && !active ? <Pin className="size-2.5 fill-current text-primary" /> : null}
      </button>
      {active ? (
        <button type="button" className={`flex size-[1.375rem] items-center justify-center rounded-md hover:bg-border ${isPin ? "me-1 text-primary" : "text-muted-foreground"}`} onClick={() => dispatch({ type: "pin", id })} aria-pressed={isPin} title={isPin ? t("برداشتن پین") : t("پین کردن: این نما اول می‌ماند و پنل با آن باز می‌شود")} aria-label={`${isPin ? t("برداشتن پین") : t("پین کردن")} ${label()}`}>
          <Pin className={`size-3 ${isPin ? "fill-current" : ""}`} />
        </button>
      ) : null}
      {!isPin && full ? (
        // A view not on screen shows its close on hover, over its own end, so the row never shifts.
        <button type="button" className={`flex size-[1.375rem] items-center justify-center rounded-md text-muted-foreground hover:bg-border ${active ? "me-1" : "absolute end-1 top-[0.3125rem] bg-border opacity-0 focus-visible:opacity-100 group-hover:opacity-100"}`} onClick={() => dispatch({ type: "closeTab", id })} title={`${t("بستن")} ${label()}`} aria-label={`${t("بستن")} ${label()}`}>
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

export function ChatPane({ chatId, pane, dispatch, available, plan, act, onSend, browserExists, sideProps, onRefine }) {
  const [width, setWidth] = useState(() => (typeof localStorage === "undefined" ? null : read(WIDTH_KEY)) || 470);
  const drag = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState(false);
  // The terminals keep their output while another view is on screen.
  const [terminalSeen, setTerminalSeen] = useState(pane.tab === "terminal");
  useEffect(() => { if (pane.tab === "terminal") setTerminalSeen(true); }, [pane.tab]);
  useEffect(() => { setTerminalSeen(pane.tab === "terminal"); }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (event) => {
      const moved = (event.clientX - drag.current.x) * (isRtl ? 1 : -1);
      setWidth(Math.min(Math.max(360, drag.current.width + moved), Math.round(window.innerWidth * 0.65)));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [dragging]);
  useEffect(() => { if (!dragging) write(WIDTH_KEY, width); }, [dragging, width]);

  const tabs = pane.tabs.filter((id) => available.includes(id));
  const tab = tabs.includes(pane.tab) ? pane.tab : tabs[0];
  const missing = missingViews(pane, available);
  // Many open views: only the active and the pinned one keep a name, the rest stay as icons on one line.
  const full = (id) => id === tab || id === pane.pinned || tabs.length <= 3;
  const isWide = typeof window !== "undefined" && window.innerWidth >= 768;
  return (
    <aside className="chat-pane fixed inset-0 z-40 flex min-w-0 flex-col bg-background md:relative md:inset-auto md:z-auto md:shrink-0 md:border-s" style={{ width: isWide ? width : undefined }} aria-label={t("پنل گفتگو")} dir={isRtl ? "rtl" : "ltr"}>
      <div
        role="separator"
        aria-orientation="vertical"
        title={t("کشیدن برای تغییر پهنا")}
        className="absolute inset-y-0 start-0 z-10 hidden w-1.5 cursor-col-resize hover:bg-primary/30 md:block"
        onPointerDown={(e) => { drag.current = { x: e.clientX, width }; setDragging(true); e.preventDefault(); }}
      />
      <div className="flex h-[3.25rem] shrink-0 items-center gap-0.5 border-b px-2 pt-[env(safe-area-inset-top)]">
        {tabs.map((id) => <ViewTab key={id} id={id} pane={pane} dispatch={dispatch} full={full(id)} />)}
        {missing.length ? (
          <Popover.Root open={menu} onOpenChange={setMenu}>
            <Popover.Trigger asChild>
              <button type="button" className="g-icon-btn flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" title={t("افزودن نما")} aria-label={t("افزودن نما")}>
                <Plus className="size-4" />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="start" sideOffset={6} dir={isRtl ? "rtl" : "ltr"} className="pop z-50 w-48 rounded-xl border bg-card p-1 text-sm shadow-xl">
                {missing.map((id) => {
                  const { Icon, label } = VIEW[id];
                  return (
                    <button key={id} type="button" className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-start hover:bg-muted" onClick={() => { dispatch({ type: "tab", id }); setMenu(false); }}>
                      <Icon className="size-4 shrink-0" /><span>{label()}</span>
                    </button>
                  );
                })}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        ) : null}
        <button type="button" className="g-icon-btn ms-auto flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => dispatch({ type: "close" })} title={t("بستن پنل")} aria-label={t("بستن پنل")}>
          <X className="size-4" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {tab === "plan" ? <PlanView plan={plan} act={act} onRefine={onRefine} /> : null}
        {tab === "changes" ? <ChangesView chatId={chatId} onSend={onSend} /> : null}
        {terminalSeen ? <div className={tab === "terminal" ? "flex min-h-0 flex-1 flex-col" : "hidden"}><Terminals key={chatId} chatId={chatId} /></div> : null}
        {tab === "browser" ? <BrowserPanel key={chatId} chatId={chatId} exists={browserExists} embedded onClose={() => dispatch({ type: "closeTab", id: "browser" })} /> : null}
        {tab === "side" ? <SidePanel {...sideProps} embedded /> : null}
        {dragging ? <div className="absolute inset-0 cursor-col-resize" /> : null}
      </div>
    </aside>
  );
}

const PlanMark = ({ done, doing }) => (done ? <CheckCircle2 className="size-4 shrink-0 text-ok" /> : doing ? <Loader2 className="size-4 shrink-0 animate-spin text-primary" /> : <Circle className="size-4 shrink-0 text-muted-foreground/70" />);

function AddInput({ placeholder, onAdd, className = "" }) {
  const [text, setText] = useState("");
  const submit = async () => {
    const value = text.trim();
    if (value && (await onAdd(value))) setText("");
  };
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
      placeholder={placeholder}
      aria-label={placeholder}
      dir="auto"
      className={`min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground ${className}`}
    />
  );
}

export function PlanView({ plan, act, onRefine }) {
  const [closed, setClosed] = useState(() => new Set());
  const summary = planSummary(plan);
  const addTask = (title) => act("edit", { op: "add-task", title });
  const addTaskRow = (
    <label className="flex h-9 items-center gap-2 rounded-lg border bg-card px-3 text-sm focus-within:border-primary/60">
      <Plus className="size-4 shrink-0 text-muted-foreground" />
      <AddInput placeholder={t("تسک تازه برای این گفتگو")} onAdd={addTask} />
    </label>
  );
  if (!plan) {
    return (
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-12">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-2 text-center">
          <ListChecks className="size-7 text-muted-foreground" />
          <p className="font-semibold">{t("این گفتگو هنوز پلنی ندارد")}</p>
          <p className="text-sm text-muted-foreground">{t("خودتان تسک بنویسید، یا از ایجنت بخواهید پیشنهاد بدهد.")}</p>
          <div className="mt-3 w-full text-start">{addTaskRow}</div>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-2">
          <div className="flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
            <span className={`rounded-full px-2.5 py-0.5 font-medium ${summary.proposed ? "bg-warn/15 text-warn" : summary.finished ? "bg-ok/15 text-ok" : "bg-signal/15 text-signal"}`}>
              {summary.proposed ? t("پیشنهاد · منتظر تأیید") : summary.finished ? t("تمام شد") : t("در حال اجرا")}
            </span>
            {summary.active ? <span className="ms-auto tabular-nums">{t("{done} از {total} زیرتسک", { done: num(summary.done), total: num(summary.total) })}</span> : null}
          </div>
          {summary.active ? <progress value={summary.done} max={Math.max(summary.total, 1)} aria-label={t("پیشرفت پلن")} className="chat-plan-progress" /> : null}
          {plan.tasks.map((task) => {
            const allDone = summary.active && taskDone(task);
            const doing = summary.active && !allDone && task.subs.includes(summary.current);
            // The finished ones fold by themselves; a click flips either.
            const open = closed.has(task.id) ? allDone : !allDone;
            const doneCount = task.subs.filter((s) => s.status === "done").length;
            const flip = () => setClosed((prev) => { const next = new Set(prev); if (next.has(task.id)) next.delete(task.id); else next.add(task.id); return next; });
            return (
              <div key={task.id} className="rounded-xl border bg-card">
                <button type="button" className="flex min-h-10 w-full items-center gap-2 rounded-xl px-2.5 text-start text-sm font-medium hover:bg-muted" onClick={flip} aria-expanded={open}>
                  <PlanMark done={allDone} doing={doing} />
                  <span className={`min-w-0 flex-1 ${allDone ? "text-muted-foreground" : ""}`} dir="auto">{task.title}</span>
                  <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{summary.active ? `${num(doneCount)}/${num(task.subs.length)}` : t("{n} زیرتسک", { n: num(task.subs.length) })}</span>
                  <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
                </button>
                {open ? (
                  <div className="flex flex-col gap-px px-1.5 pb-1.5">
                    {task.subs.map((sub) => {
                      const subDone = summary.active && sub.status === "done";
                      const subDoing = summary.current?.id === sub.id;
                      return (
                        <div key={sub.id} className="flex items-center">
                          <button type="button" className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-0.5 text-start text-[13px] hover:bg-muted disabled:hover:bg-transparent" disabled={!summary.active} aria-pressed={subDone} onClick={() => act("edit", { op: "set", id: sub.id, status: subDone ? "pending" : "done" })}>
                            {subDone ? <Check className="size-4 shrink-0 text-ok" /> : subDoing ? <Loader2 className="size-4 shrink-0 animate-spin text-primary" /> : <Circle className="size-3.5 shrink-0 text-muted-foreground/70" />}
                            <span className={`min-w-0 flex-1 ${subDone ? "text-muted-foreground line-through" : subDoing ? "font-medium" : ""}`} dir="auto">{sub.title}</span>
                            {subDoing ? <span className="shrink-0 text-[11px] text-primary">{t("الان")}</span> : null}
                          </button>
                          {summary.proposed ? (
                            <button type="button" className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-bad" onClick={() => act("edit", { op: "remove-sub", id: sub.id })} aria-label={t("حذف زیرتسک")} title={t("حذف زیرتسک")}>
                              <X className="size-3" />
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                    <label className="flex min-h-7 items-center gap-2 px-1.5 text-xs text-muted-foreground">
                      <Plus className="size-3.5 shrink-0" />
                      <AddInput placeholder={t("زیرتسک تازه")} onAdd={(title) => act("edit", { op: "add-sub", taskId: task.id, title })} className="text-foreground" />
                    </label>
                  </div>
                ) : null}
              </div>
            );
          })}
          <PlanSuggestions plan={plan} act={act} />
          {addTaskRow}
        </div>
      </div>
      {summary.proposed ? (
        <div className="flex shrink-0 flex-col gap-2 border-t p-3">
          <p className="text-xs text-muted-foreground">{t("تا تأیید نکنید ایجنت کاری شروع نمی‌کند. می‌توانید تسک‌ها را عوض کنید.")}</p>
          <PlanAnswers act={act} onRefine={onRefine} wide />
        </div>
      ) : null}
    </>
  );
}

function PlanAnswers({ act, onRefine, wide = false, small = false }) {
  const size = small ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" className={`press rounded-lg bg-primary ${size} font-medium text-primary-foreground ${wide ? "flex-1" : ""}`} onClick={() => act("approve")}>{t("تأیید و شروع")}</button>
      <button type="button" className={`press rounded-lg border ${size} hover:bg-muted`} onClick={onRefine}>{t("ادامهٔ برنامه‌ریزی")}</button>
      <button type="button" className={`press rounded-lg border ${size} text-bad hover:bg-bad/10`} onClick={() => act("reject")}>{t("رد")}</button>
    </div>
  );
}

/** Above the chat box: a plan that waits for him, or the list of the one running. Finished: nothing. */
// The agent's suggestions for the plan, as one list (owner 2026-11-07: «این پیشنهاد ها رو یه طوری مدیریت کن
// خیلی زیادن»): a line each with its task, accept or drop one or all; more than two start folded.
function PlanSuggestions({ plan, act, className = "" }) {
  const list = plan.suggestions || [];
  const [open, setOpen] = useState(list.length <= 2);
  const [busy, setBusy] = useState(false);
  if (!list.length) return null;
  const taskOf = (s) => plan.tasks.find((x) => x.id === s.taskId)?.title || "";
  const all = async (op) => {
    setBusy(true);
    for (const s of list) if (!(await act("edit", { op, id: s.id }))) break;
    setBusy(false);
  };
  return (
    <section className={`rounded-xl border border-dashed border-primary/50 bg-card text-[13px] ${className}`} aria-label={t("پیشنهادهای ایجنت")}>
      <div className="flex items-center gap-1.5 px-3 py-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-start text-xs font-semibold text-primary" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Lightbulb className="size-3.5 shrink-0" />
          <span className="truncate">{t("{n} پیشنهاد ایجنت برای پلن", { n: num(list.length) })}</span>
          <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {list.length > 1 ? (
          <>
            <button type="button" disabled={busy} className="press shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50" onClick={() => all("accept")}>{t("همه را اضافه کن")}</button>
            <button type="button" disabled={busy} className="press shrink-0 rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50" onClick={() => all("dismiss")}>{t("هیچ‌کدام")}</button>
          </>
        ) : null}
      </div>
      {open ? (
        <ul className="scrollbar-thin max-h-48 overflow-y-auto border-t border-dashed border-primary/30 py-1">
          {list.map((s) => (
            <li key={s.id} className="flex items-center gap-2 px-3 py-1 hover:bg-muted/50">
              <span className="min-w-0 flex-1 truncate" dir="auto" title={`${taskOf(s)}: ${s.title}`}>
                <span className="text-muted-foreground">{taskOf(s)} · </span>{s.title}
              </span>
              <button type="button" disabled={busy} className="flex size-7 shrink-0 items-center justify-center rounded-md text-ok hover:bg-ok/15 disabled:opacity-50" onClick={() => act("edit", { op: "accept", id: s.id })} title={t("اضافه کن")} aria-label={`${t("اضافه کن")}: ${s.title}`}><Check className="size-4" /></button>
              <button type="button" disabled={busy} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-bad/10 hover:text-bad disabled:opacity-50" onClick={() => act("edit", { op: "dismiss", id: s.id })} title={t("نه")} aria-label={`${t("نه")}: ${s.title}`}><X className="size-4" /></button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * The plan in the chat. part "waiting" (above the chat box): what waits for him — a proposal, the
 * agent's suggestions. part "running" (the floating widget): the list of the plan in progress.
 */
export function PlanInChat({ plan, act, onOpen, onRefine, part }) {
  const summary = planSummary(plan);
  if (summary.none) return null;
  if (part === "waiting") {
    if (!summary.proposed) return <PlanSuggestions key={plan.suggestions?.length > 2 ? "many" : "few"} plan={plan} act={act} className="mb-2" />;
  } else if (summary.proposed || summary.finished) return null;
  if (summary.proposed) {
    const subs = plan.tasks.reduce((sum, task) => sum + task.subs.length, 0);
    return (
      <section className="g-box mb-2 rounded-xl border bg-card text-sm" aria-label={t("پیشنهاد پلن")}>
        <div className="flex items-center gap-2 px-3 pt-2.5 font-semibold">
          <ListChecks className="size-4 text-primary" />
          {t("پیشنهاد پلن")}
          <span className="text-xs font-normal tabular-nums text-muted-foreground">{t("{tasks} تسک · {subs} زیرتسک", { tasks: num(plan.tasks.length), subs: num(subs) })}</span>
          <button type="button" className="ms-auto text-xs font-medium text-primary hover:underline" onClick={onOpen}>{t("جزئیات")}</button>
        </div>
        <ol className="flex max-h-28 flex-col gap-0.5 overflow-y-auto px-3 py-2 text-[13px]">
          {plan.tasks.map((task, i) => <li key={task.id} className="flex gap-2"><span className="tabular-nums text-muted-foreground">{num(i + 1)}.</span><span dir="auto">{task.title}</span></li>)}
        </ol>
        <div className="border-t px-3 py-2"><PlanAnswers act={act} onRefine={onRefine} /></div>
      </section>
    );
  }
  return (
    <div className="g-box mb-2 max-h-36 overflow-y-auto rounded-xl border bg-card p-1 text-[13px]">
      {plan.tasks.map((task) => {
        const allDone = taskDone(task);
        const doing = !allDone && task.subs.includes(summary.current);
        const doneCount = task.subs.filter((s) => s.status === "done").length;
        return (
          <button key={task.id} type="button" className="flex min-h-7 w-full items-center gap-2 rounded-lg px-2 text-start hover:bg-muted" onClick={onOpen}>
            <PlanMark done={allDone} doing={doing} />
            <span className={`min-w-0 flex-1 truncate ${allDone ? "text-muted-foreground" : doing ? "font-medium" : ""}`} dir="auto">{doing && summary.current ? `${task.title} — ${summary.current.title}` : task.title}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{num(doneCount)}/{num(task.subs.length)}</span>
          </button>
        );
      })}
    </div>
  );
}

function ChangesView({ chatId, onSend }) {
  const { changes, loaded, load } = useChanges(chatId, true);
  const [picked, setPicked] = useState(null);
  const [diff, setDiff] = useState(null);
  const files = changes?.files || [];
  const current = files.some((f) => f.path === picked) ? picked : files[0]?.path || null;
  // Asked again when the file's numbers change: the agent may be editing it right now.
  const stamp = files.find((f) => f.path === current);
  const stampKey = stamp ? `${stamp.add}/${stamp.del}` : "";
  useEffect(() => {
    setDiff(null);
    if (!current) return undefined;
    let alive = true;
    api(`/api/chats/${chatId}/changes/file?path=${encodeURIComponent(current)}`).then((data) => alive && setDiff(data), () => alive && setDiff({ failed: true }));
    return () => { alive = false; };
  }, [chatId, current, stampKey]);
  if (!loaded) return <div className="flex flex-1 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  if (!changes) return <p className="px-6 py-12 text-center text-sm text-muted-foreground">{t("این گفتگو پوشهٔ کد ندارد. وقتی ایجنت روی یک ریپو کار کند، تغییراتش همین‌جا می‌آید.")}</p>;
  return (
    <>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-3 py-1.5 text-xs">
        <bdi className="ltr max-w-52 truncate">{changes.branch}</bdi>
        <span className="tabular-nums text-muted-foreground">{t("{n} فایل", { n: num(files.length) })}</span>
        <bdi className="ltr tabular-nums"><span className="text-ok">+{changes.add}</span> <span className="text-bad">−{changes.del}</span></bdi>
        <span className="ms-auto flex items-center gap-1">
          <button type="button" className="g-icon-btn rounded-md p-1 text-muted-foreground hover:bg-muted" onClick={load} title={t("تازه کردن")} aria-label={t("تازه کردن")}><RefreshCw className="size-3.5" /></button>
          {files.length ? <button type="button" className="press rounded-md border px-2 py-1 hover:bg-muted" onClick={() => onSend(t("تغییرات این گفتگو را کامیت کن."))}>{t("کامیت")}</button> : null}
          {files.length ? <button type="button" className="press rounded-md border px-2 py-1 hover:bg-muted" onClick={() => onSend(t("برای تغییرات این گفتگو MR باز کن."))}>{t("باز کردن MR")}</button> : null}
        </span>
      </div>
      {files.length ? (
        <>
          <div className="scrollbar-thin max-h-[35%] shrink-0 overflow-y-auto border-b" dir="ltr">
            {files.map((file) => (
              <button key={file.path} type="button" className={`flex h-8 w-full items-center gap-2.5 border-b border-border/50 px-3 text-left font-mono text-xs last:border-b-0 ${file.path === current ? "bg-accent" : "hover:bg-muted"}`} onClick={() => setPicked(file.path)}>
                <span className="shrink-0 tabular-nums">{file.status === "new" ? <span className="text-ok">{t("تازه")}</span> : <><span className="text-ok">+{file.add}</span> <span className="text-bad">−{file.del}</span></>}</span>
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
              </button>
            ))}
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-auto py-2 font-mono text-xs leading-relaxed" dir="ltr">
            {diff?.failed ? <p className="px-3 text-muted-foreground" dir="auto">{t("این فایل خوانده نشد.")}</p> : null}
            {diff && !diff.failed && !diffRows(diff.diff).length ? <p className="px-3 text-muted-foreground" dir="auto">{t("فایل باینری است یا متنی برای نمایش ندارد.")}</p> : null}
            {diff && !diff.failed ? diffRows(diff.diff).map((row, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={i} className={`whitespace-pre-wrap break-words px-3 ${row.kind === "add" ? "bg-ok/15" : row.kind === "del" ? "bg-bad/15" : row.kind === "hunk" ? "py-1 text-muted-foreground" : ""}`}>{row.text || " "}</div>
            )) : null}
            {diff?.truncated ? <p className="px-3 pt-2 text-muted-foreground" dir="auto">{t("این فایل بلند است و فقط اولش نشان داده شد.")}</p> : null}
          </div>
        </>
      ) : <p className="px-6 py-12 text-center text-sm text-muted-foreground">{t("این گفتگو هنوز چیزی را تغییر نداده است.")}</p>}
    </>
  );
}

function Terminals({ chatId }) {
  const [tabs, setTabs] = useState([1]);
  const [current, setCurrent] = useState(1);
  const add = () => { const id = Math.max(...tabs) + 1; setTabs([...tabs, id]); setCurrent(id); };
  const close = (id) => {
    const rest = tabs.filter((x) => x !== id);
    setTabs(rest);
    if (current === id) setCurrent(rest[rest.length - 1]);
  };
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2">
        {tabs.map((id) => (
          <div key={id} className={`flex h-7 shrink-0 items-center rounded-md text-xs ${id === current ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted"}`}>
            <button type="button" className="h-7 px-2.5" onClick={() => setCurrent(id)}>{t("ترمینال {n}", { n: num(id) })}</button>
            {tabs.length > 1 ? <button type="button" className="me-1 flex size-5 items-center justify-center rounded hover:bg-border" onClick={() => close(id)} aria-label={t("بستن ترمینال {n}", { n: num(id) })}><X className="size-3" /></button> : null}
          </div>
        ))}
        <button type="button" className="g-icon-btn flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" onClick={add} title={t("ترمینال تازه")} aria-label={t("ترمینال تازه")}><Plus className="size-4" /></button>
      </div>
      {tabs.map((id) => (
        <div key={id} className={id === current ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <Terminal path={`/api/chats/${chatId}/terminal`} startCwd="" intro={t("ترمینال این گفتگو، در پوشهٔ همین چت. هر دستور تا ۲ دقیقه اجرا می‌شود.")} />
        </div>
      ))}
    </>
  );
}

export const paneViews = (hasSide) => PANE_VIEWS.filter((id) => id !== "side" || hasSide);
