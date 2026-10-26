import { Suspense, useMemo, useState } from "react";
import { AlarmClock, ArrowRight, ExternalLink, GitMerge, Inbox, LifeBuoy, Loader2, MessageCircle, Puzzle, Radar, RefreshCw, Search, SquareTerminal, Ticket, Users } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { readSetting, writeSetting } from "../brand.js";
import { actionOutcome, cellText, initialFilters, optionOf, shelves } from "../modules.js";
import { useModuleRows, useModules } from "../module-hooks.js";
import { moduleView } from "../module-views.js";
import { t } from "../i18n.js";

// The page icons a module may name in module.json; an unknown name is the puzzle piece.
// The colour of a shelf's dot and count; the status colours, never the palette (the rule for statuses).
const TONE_DOT = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-signal", muted: "bg-muted-foreground/40" };

export const MODULE_ICONS = { "git-merge": GitMerge, ticket: Ticket, puzzle: Puzzle, "message-circle": MessageCircle, inbox: Inbox, users: Users, radar: Radar, "terminal-square": SquareTerminal, "alarm-clock": AlarmClock, "life-buoy": LifeBuoy };

// The one page every module shares (kind "list"): filters on top, a row per record, a button per
// action. What the rows are and what a button does is the module's server.mjs, not this file.
export function ModulePage({ route, onBack }) {
  const modules = useModules();
  const mod = modules.find((m) => m.id === route.module);
  const page = mod?.pages.find((p) => p.id === route.page);
  if (!page) {
    return (
      <div className="mx-auto w-full max-w-4xl p-6 text-sm text-muted-foreground">
        <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 hover:text-foreground"><ArrowRight className="rtl-mirror size-4" />{t("بازگشت")}</button>
        {modules.length ? t("این بخش در این نصب روشن نیست.") : t("در حال بارگذاری…")}
      </div>
    );
  }
  const View = moduleView(mod.id, page.view);
  if (View) {
    return (
      <Suspense fallback={<p className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("در حال بارگذاری…")}</p>}>
        <View key={`${mod.id}/${page.id}`} mod={mod} page={page} onBack={onBack} />
      </Suspense>
    );
  }
  return <ListPage key={`${mod.id}/${page.id}`} mod={mod} page={page} onBack={onBack} />;
}

// A core section (telegram, jobs, …) whose module is not switched on in this install.
export function SectionOff({ onBack }) {
  return (
    <div className="mx-auto w-full max-w-4xl p-6 text-sm text-muted-foreground">
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 hover:text-foreground"><ArrowRight className="rtl-mirror size-4" />{t("بازگشت")}</button>
      <p>{t("این بخش در این نصب روشن نیست.")}</p>
      <p className="mt-1 text-xs">{t("بخش‌ها ماژول‌اند؛ روشن و خاموششان از تنظیمات ← بازارچه است.")}</p>
    </div>
  );
}

function ListPage({ mod, page, onBack }) {
  const [values, setValues] = useState(() => initialFilters(page));
  const [applied, setApplied] = useState(values);
  const [busy, setBusy] = useState(null);
  const [nonce, setNonce] = useState(0);
  const { rows, error, loading } = useModuleRows(mod.id, page.id, applied, nonce);
  const catKey = `griffin.module.${mod.id}.${page.id}.shelf`;
  const [only, setOnly] = useState(() => readSetting(catKey, ""));
  const [search, setSearch] = useState("");
  const view = useMemo(() => shelves(page, rows, { search, only }), [page, rows, search, only]);
  const pick = (key) => {
    setOnly(key);
    writeSetting(catKey, key);
  };
  const primary = page.fields.find((f) => f.primary) || page.fields[0];
  const cols = page.fields.filter((f) => f !== primary);

  async function run(action, row) {
    setBusy(`${action.id}:${row.id}`);
    try {
      const outcome = actionOutcome(await api(`/api/modules/${mod.id}/actions/${action.id}`, { method: "POST", body: { row } }));
      if (outcome.kind === "message") toast(outcome.message);
      if (outcome.kind === "chat") {
        // The ordinary chat API: the chat is the owner's, with every guard a chat has.
        const { chat } = await api("/api/chats", { method: "POST", body: { agent: outcome.chat.agent, title: outcome.chat.title, text: outcome.chat.text, module: mod.id } });
        navigate(chat.id);
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-6">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden" aria-label={t("بازگشت")}><ArrowRight className="rtl-mirror size-4" /></button>
        <div>
          <h1 className="text-lg font-semibold">{page.title}</h1>
          {mod.description ? <p className="text-xs text-muted-foreground">{mod.description}</p> : null}
        </div>
      </div>

      {page.filters.length ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied(values);
          }}
        >
          {page.filters.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
              {f.label}
              {f.type === "select" ? (
                <select value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} className="rounded-lg border bg-background px-2 py-1.5 text-sm text-foreground">
                  {f.options.map(optionOf).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input dir="ltr" value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} className="w-56 rounded-lg border bg-background px-2 py-1.5 text-sm text-foreground" />
              )}
            </label>
          ))}
          <button type="submit" className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground">{t("نمایش")}</button>
        </form>
      ) : null}

      {page.groupBy || page.search ? (
        <div className="flex flex-wrap items-center gap-2">
          {page.groupBy && rows?.length ? (
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t("دسته‌بندی")}>
              <button type="button" role="tab" aria-selected={!only} onClick={() => pick("")} className={`rounded-full border px-3 py-1 text-xs ${!only ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted"}`}>{t("همه")} <span className="tabular-nums">{view.total}</span></button>
              {[...page.groupBy.groups, { key: "_other", label: t("بقیه"), tone: "muted" }].filter((g) => view.counts[g.key]).map((g) => (
                <button key={g.key} type="button" role="tab" aria-selected={only === g.key} onClick={() => pick(only === g.key ? "" : g.key)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${only === g.key ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted"}`}>
                  <span className={`size-1.5 rounded-full ${TONE_DOT[g.tone] || TONE_DOT.muted}`} />{g.label} <span className="tabular-nums">{view.counts[g.key]}</span>
                </button>
              ))}
            </div>
          ) : null}
          {page.search ? (
            <label className="relative ms-auto">
              <Search className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("جستجو در همین فهرست")} aria-label={t("جستجو")} className="w-56 rounded-lg border bg-background py-1.5 pe-2 ps-7 text-sm" />
            </label>
          ) : null}
          <button type="button" onClick={() => setNonce((n) => n + 1)} disabled={loading} aria-label={t("تازه‌سازی")} className="rounded-lg border p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-60"><RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /></button>
        </div>
      ) : null}

      {error ? <p className="rounded-lg border border-bad/40 p-3 text-sm text-bad">{error}</p> : null}
      {loading && !rows ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("در حال خواندن…")}</p> : null}
      {rows && !rows.length ? <p className="text-sm text-muted-foreground">{t("چیزی پیدا نشد.")}</p> : null}
      {rows?.length && !view.total ? <p className="text-sm text-muted-foreground">{t("با این جستجو چیزی نیست.")}</p> : null}

      {view.shelves.map((shelf) => (
        <section key={shelf.key || "all"} className="space-y-1.5">
          {shelf.label ? (
            <h2 className="flex flex-wrap items-baseline gap-2 text-sm font-medium">
              <span className={`size-2 self-center rounded-full ${TONE_DOT[shelf.tone] || TONE_DOT.muted}`} />{shelf.label}
              <span className="text-xs tabular-nums text-muted-foreground">{shelf.rows.length}</span>
              {shelf.hint ? <span className="text-xs font-normal text-muted-foreground">{shelf.hint}</span> : null}
            </h2>
          ) : null}
          <ul className="divide-y rounded-xl border bg-card">
            {shelf.rows.map((row) => (
              <Row key={row.id} row={row} page={page} primary={primary} cols={cols} busy={busy} run={run} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Row({ row, page, primary, cols, busy, run }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
      <div className="min-w-0 flex-1">
        <div dir="auto" className="truncate text-sm font-medium">{cellText(primary, row)}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {cols.map((f) =>
            f.type === "link" ? (
              row[f.key] ? <a key={f.key} href={row[f.key]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground"><ExternalLink className="size-3" />{f.label}</a> : null
            ) : f.type === "badge" ? (
              row[f.key] ? <span key={f.key} className="rounded-full border px-2 py-0.5">{cellText(f, row)}</span> : null
            ) : row[f.key] ? (
              <span key={f.key} dir="auto">{f.key === "reason" || f.key === "author" ? cellText(f, row) : `${f.label}: ${cellText(f, row)}`}</span>
            ) : null,
          )}
        </div>
      </div>
      {page.actions.map((action) => (
        <button key={action.id} type="button" disabled={busy === `${action.id}:${row.id}`} onClick={() => run(action, row)} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60">
          {busy === `${action.id}:${row.id}` ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {action.label}
        </button>
      ))}
    </li>
  );
}
