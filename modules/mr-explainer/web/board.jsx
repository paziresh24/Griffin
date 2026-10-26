import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, Clock, ExternalLink, GitMerge, Loader2, MessageSquareText, PencilLine, RefreshCw, Search, Sparkles, X, XCircle } from "lucide-react";
import { chatExists, clockLabel, exactTime, memory, navigate, runAction, textDir, toast, useRows } from "@griffin/module-kit";
import { STATES, SHELVES, board, headline, projectName } from "./view.js";

// The merge requests as a board (owner 2026-10-19: «فرمش خوب نیست… قابل درک نیست»): what wants a
// hand first, a card per MR that says in words where it stands, one button that explains it. The
// rows and the button are the module's server.mjs, exactly as the shared list used them.

const TONE = {
  ok: { text: "text-ok", soft: "bg-ok/10 text-ok", dot: "bg-ok", ring: "border-ok/50 bg-ok/5" },
  bad: { text: "text-bad", soft: "bg-bad/10 text-bad", dot: "bg-bad", ring: "border-bad/50 bg-bad/5" },
  warn: { text: "text-warn", soft: "bg-warn/10 text-warn", dot: "bg-warn", ring: "border-warn/50 bg-warn/5" },
  info: { text: "text-signal", soft: "bg-signal/10 text-signal", dot: "bg-signal", ring: "border-signal/50 bg-signal/5" },
  muted: { text: "text-muted-foreground", soft: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/40", ring: "border-foreground/30 bg-muted/60" },
};
const ICON = { attention: AlertTriangle, ready: CheckCircle2, running: CircleDashed, waiting: Clock, draft: PencilLine, merged: GitMerge, closed: XCircle };
const OPEN_SHELVES = SHELVES.filter((s) => !["merged", "closed"].includes(s.key));
const ALL = "*";
// How many cards a shelf shows before «… مورد دیگر»: drafts are the least urgent, so the fewest.
const limitOf = (key) => (key === "draft" ? 3 : 6);

export default function MrBoard({ mod, page, onBack }) {
  const prefs = useMemo(() => memory(mod.id, "board"), [mod.id]);
  const explained = useMemo(() => memory(mod.id, "explained"), [mod.id]);
  const defaultProject = page.filters.find((f) => f.key === "project")?.default || ALL;
  const saved = prefs.read();
  const [state, setState] = useState(STATES.some((s) => s.value === saved.state) ? saved.state : "opened");
  const [project, setProject] = useState(saved.project || defaultProject);
  const [recent, setRecent] = useState(Array.isArray(saved.recent) ? saved.recent : []);
  const [shelf, setShelf] = useState(saved.shelf || "");
  const [author, setAuthor] = useState(saved.author || "");
  const [search, setSearch] = useState("");
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(null);
  const [chats, setChats] = useState(() => explained.read());
  const [opened, setOpened] = useState(() => (saved.opened && typeof saved.opened === "object" ? saved.opened : {}));

  useEffect(() => prefs.write({ state, project, recent, shelf, author, opened }), [prefs, state, project, recent, shelf, author, opened]);

  const { rows, error, loading } = useRows(mod.id, page.id, { project, state }, nonce);
  const view = useMemo(() => board(rows, { search, author, shelf: state === "opened" ? shelf : "" }), [rows, search, author, shelf, state]);
  const byId = useMemo(() => new Map((rows || []).map((r) => [r.id, r])), [rows]);
  const filtered = Boolean(search || author || (state === "opened" && shelf));

  const chooseProject = (value) => {
    const p = String(value || "").trim();
    if (!p) return;
    setProject(p);
    if (p !== ALL && p !== defaultProject) setRecent((list) => [p, ...list.filter((x) => x !== p)].slice(0, 6));
  };

  async function explain(c, fresh = false) {
    const known = chats[c.id];
    setBusy(c.id);
    try {
      if (known && !fresh && (await chatExists(known))) {
        navigate(known);
        return;
      }
      const out = await runAction(mod.id, "explain", byId.get(c.id));
      if (out.chatId) {
        const next = { ...explained.read(), [c.id]: out.chatId };
        explained.write(next);
        setChats(next);
      } else if (out.message) toast(out.message);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  const clear = () => {
    setSearch("");
    setAuthor("");
    setShelf("");
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-4 md:p-6">
      <header className="flex items-start gap-2">
        <button type="button" onClick={onBack} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden" aria-label="بازگشت"><ArrowRight className="size-4" /></button>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">مرج ریکوئست‌ها</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {state === "opened" && rows?.length ? headline(view.counts, view.all) + " " : ""}
            روی «توضیح بده» بزنید تا به زبان ساده بگوید چه چیزی عوض می‌شود و آمادهٔ مرج هست یا نه.
          </p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border bg-card p-0.5" role="tablist" aria-label="وضعیت">
          {STATES.map((s) => (
            <button key={s.value} type="button" role="tab" aria-selected={state === s.value} onClick={() => setState(s.value)} className={`rounded-md px-3 py-1 text-sm ${state === s.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{s.label}</button>
          ))}
        </div>
        <ProjectPicker value={project} defaultProject={defaultProject} recent={recent} onChange={chooseProject} />
        <label className="relative ms-auto min-w-0 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو: عنوان، شماره، شاخه…" aria-label="جستجو" className="w-full rounded-lg border bg-background py-1.5 pe-2 ps-8 text-sm" />
        </label>
        <button type="button" onClick={() => setNonce((n) => n + 1)} disabled={loading} title="خواندن دوباره از GitLab" aria-label="تازه‌سازی" className="rounded-lg border p-2 text-muted-foreground hover:bg-muted disabled:opacity-60"><RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /></button>
      </div>

      {state === "opened" && rows?.length ? (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-5 sm:overflow-visible sm:px-0 sm:pb-0">
          {OPEN_SHELVES.map((s) => {
            const Icon = ICON[s.key];
            const n = view.counts[s.key] || 0;
            const on = shelf === s.key;
            return (
              <button key={s.key} type="button" disabled={!n && !on} onClick={() => setShelf(on ? "" : s.key)} aria-pressed={on} title={s.hint} className={`min-w-[6.5rem] shrink-0 rounded-xl border p-2.5 text-start sm:min-w-0 sm:p-3 transition disabled:opacity-45 ${on ? TONE[s.tone].ring : "bg-card hover:bg-muted/60"}`}>
                <div className={`flex items-center gap-1.5 text-xs ${n ? TONE[s.tone].text : "text-muted-foreground"}`}><Icon className="size-3.5" />{s.label}</div>
                <div className="mt-0.5 text-xl sm:mt-1 sm:text-2xl font-semibold tabular-nums">{n.toLocaleString("fa-IR")}</div>
              </button>
            );
          })}
        </div>
      ) : null}

      {view.authors.length > 6 ? (
        // Many authors (every project): a short list of chips would be a wall; one picker instead.
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          نویسنده:
          <select value={author} onChange={(e) => setAuthor(e.target.value)} className="rounded-lg border bg-card px-2 py-1 text-sm text-foreground">
            <option value="">همه ({view.authors.length.toLocaleString("fa-IR")} نفر)</option>
            {view.authors.map((a) => <option key={a.name} value={a.name}>{a.name} — {a.n.toLocaleString("fa-IR")}</option>)}
          </select>
        </label>
      ) : view.authors.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">نویسنده:</span>
          <Chip on={!author} onClick={() => setAuthor("")}>همه</Chip>
          {view.authors.map((a) => (
            <Chip key={a.name} on={author === a.name} onClick={() => setAuthor(author === a.name ? "" : a.name)}><span dir="ltr">{a.name}</span> <span className="tabular-nums opacity-70">{a.n.toLocaleString("fa-IR")}</span></Chip>
          ))}
        </div>
      ) : null}

      {filtered && rows?.length ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {view.total.toLocaleString("fa-IR")} از {view.all.toLocaleString("fa-IR")} مورد
          <button type="button" onClick={clear} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-muted"><X className="size-3" />پاک کردن فیلترها</button>
        </p>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-bad/40 bg-bad/5 p-4 text-sm">
          <p className="text-bad">{error}</p>
          <button type="button" onClick={() => setNonce((n) => n + 1)} className="mt-2 rounded-lg border px-3 py-1 text-xs hover:bg-muted">دوباره</button>
        </div>
      ) : null}

      {loading && !rows ? (
        <div className="space-y-2" aria-label="در حال خواندن">
          {[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl border bg-muted/40" />)}
        </div>
      ) : null}

      {rows && !rows.length && !error ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          <p>{project === ALL ? "در هیچ پروژه‌ای" : `در ${projectName(project)}`} MR {STATES.find((s) => s.value === state).label} نیست.</p>
          {project !== ALL ? <button type="button" onClick={() => setProject(ALL)} className="mt-3 rounded-lg border px-3 py-1.5 text-xs hover:bg-muted">در همهٔ پروژه‌ها بگرد</button> : null}
        </div>
      ) : null}
      {rows?.length && !view.total ? <p className="text-sm text-muted-foreground">با این فیلترها چیزی نیست.</p> : null}

      {view.shelves.map((s) => (
        <section key={s.key} className="space-y-2">
          {state === "opened" ? (
            <h2 className="flex flex-wrap items-baseline gap-2 text-sm font-medium">
              <span className={`size-2 self-center rounded-full ${TONE[s.tone].dot}`} />{s.label}
              <span className="text-xs tabular-nums text-muted-foreground">{s.cards.length.toLocaleString("fa-IR")}</span>
              {s.hint ? <span className="text-xs font-normal text-muted-foreground">— {s.hint}</span> : null}
            </h2>
          ) : null}
          <ul className="space-y-2">
            {(opened[s.key] || shelf === s.key || filtered ? s.cards : s.cards.slice(0, limitOf(s.key))).map((c) => (
              <Card key={c.id} c={c} busy={busy === c.id} explainedChat={chats[c.id]} onExplain={(fresh) => explain(c, fresh)} showProject={project === ALL} />
            ))}
          </ul>
          {s.cards.length > limitOf(s.key) && shelf !== s.key && !filtered ? (
            <button type="button" onClick={() => setOpened({ ...opened, [s.key]: !opened[s.key] })} className="w-full rounded-lg border border-dashed py-1.5 text-xs text-muted-foreground hover:bg-muted">
              {opened[s.key] ? "کمتر" : `${(s.cards.length - limitOf(s.key)).toLocaleString("fa-IR")} مورد دیگر در «${s.label}»`}
            </button>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function Card({ c, busy, explainedChat, onExplain, showProject }) {
  const Icon = ICON[c.shelf] || Clock;
  const tone = TONE[c.tone];
  // On the draft, merged and closed shelves the reason only repeats the shelf's name; there the card
  // keeps quiet about it. The pipeline is said once: in the reason when the reason is about it.
  const showReason = ["attention", "waiting", "running"].includes(c.shelf) && c.reason;
  const pipelineInReason = showReason && c.reason.includes("پایپ‌لاین");
  return (
    <li className="flex flex-wrap gap-x-3 gap-y-2 rounded-xl sm:flex-nowrap border bg-card p-3.5">
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone.text}`} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-baseline gap-2">
          <div className="min-w-0 flex-1 leading-snug">
            {c.kind ? <span className="me-1.5 inline-block rounded bg-muted px-1.5 py-px align-[1px] text-[11px] text-muted-foreground" title={c.scope ? `بخش: ${c.scope}` : undefined}>{c.kind}{c.scope ? <span className="ltr"> · {c.scope}</span> : null}</span> : null}
            <span dir={textDir(c.title)} className="text-[15px] font-medium">{c.title}</span>
          </div>
          <span className="ltr shrink-0 text-xs tabular-nums text-muted-foreground">{c.ref}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {c.author ? <span dir="ltr">{c.author}</span> : null}
          {showProject && c.project ? <><span aria-hidden className="px-0.5 opacity-60">·</span><span dir="ltr" title={c.projectPath}>{c.project}</span></> : null}
          {c.when ? <><span aria-hidden className="px-0.5 opacity-60">·</span><time dateTime={c.when} title={exactTime(c.when)}>{clockLabel(c.when)}</time></> : null}
          {c.from ? <><span aria-hidden className="px-0.5 opacity-60">·</span><span dir="ltr" className="truncate font-mono text-[11px]" title={`${c.from} → ${c.to}`}>{c.from} → {c.to}</span></> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {showReason ? <span className={`rounded-md px-2 py-0.5 ${tone.soft}`}>{c.reason}</span> : null}
          {c.pipeline && !pipelineInReason ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground"><span className={`size-1.5 rounded-full ${TONE[c.pipeline.tone].dot}`} />{c.pipeline.text}</span>
          ) : null}
          {c.facts.map((f) => <span key={f} className="text-muted-foreground">{f}</span>)}
          {c.labels.map((l) => <span key={l} dir="auto" className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">{l}</span>)}
        </div>
      </div>
      <div className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto sm:flex-col sm:items-end">
        <button type="button" disabled={busy} onClick={() => onExplain(false)} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm disabled:opacity-60 ${explainedChat ? "bg-primary text-primary-foreground hover:opacity-90" : "bg-primary/10 text-primary hover:bg-primary/15"}`}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : explainedChat ? <MessageSquareText className="size-3.5" /> : <Sparkles className="size-3.5" />}
          {explainedChat ? "دیدن توضیح" : "توضیح بده"}
        </button>
        <div className="flex items-center gap-1">
          {explainedChat ? <button type="button" disabled={busy} onClick={() => onExplain(true)} title="یک توضیح تازه در گفتگوی جدید" className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">توضیح تازه</button> : null}
          {c.url ? <a href={c.url} target="_blank" rel="noreferrer" title="باز کردن در GitLab" aria-label="باز کردن در GitLab" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><ExternalLink className="size-3.5" /></a> : null}
        </div>
      </div>
    </li>
  );
}

function Chip({ on, onClick, children }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={`rounded-full border px-2.5 py-0.5 ${on ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted"}`}>{children}</button>
  );
}

function ProjectPicker({ value, defaultProject, recent, onChange }) {
  const [other, setOther] = useState(false);
  const [text, setText] = useState("");
  const options = [...new Set([defaultProject, ...recent, value].filter((p) => p && p !== ALL))];
  if (other) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!/^[\w.-]+(\/[\w.-]+)+$/.test(text.trim())) return toast.error("پروژه را به شکل group/name بنویسید");
          onChange(text);
          setOther(false);
          setText("");
        }}
      >
        <input autoFocus dir="ltr" value={text} onChange={(e) => setText(e.target.value)} placeholder="group/name" aria-label="پروژه" className="w-44 rounded-lg border bg-background px-2 py-1.5 text-sm" />
        <button type="submit" className="rounded-lg border px-2.5 py-1.5 text-sm hover:bg-muted">برو</button>
        <button type="button" onClick={() => setOther(false)} aria-label="انصراف" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"><X className="size-3.5" /></button>
      </form>
    );
  }
  return (
    <select
      value={value}
      aria-label="پروژه"
      onChange={(e) => (e.target.value === "_other" ? setOther(true) : onChange(e.target.value))}
      className="rounded-lg border bg-card px-2 py-1.5 text-sm"
    >
      {options.map((p) => <option key={p} value={p}>{projectName(p)}{p === defaultProject ? " (پیش‌فرض)" : ""}</option>)}
      <option value={ALL}>همهٔ پروژه‌ها</option>
      <option value="_other">پروژهٔ دیگر…</option>
    </select>
  );
}
