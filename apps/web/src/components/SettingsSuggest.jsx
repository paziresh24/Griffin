// The cards of «پرسش از دستیار» in Settings and of settings_suggest in a chat (settings-suggest.mjs, owner
// 2026-11-23): one card per setting the model picked — where it is, what it is now, what it would become and
// for whom — with «اعمال تغییر» only where one click may do it (settings-catalog.js applyPlan) and only on
// the person's own click; «لغو تغییر» puts it back. A shared or guest page shows the cards without buttons.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Loader2, Sparkles } from "lucide-react";
import { api } from "../api.js";
import { useApiBase } from "../base.js";
import { t } from "../i18n.js";
import { CONFIG_EVENT, NO_CLICK, applyPlan, configChanged, scopeLabel, settingsCatalog, undoPatch, valueLabel } from "../settings-catalog.js";
import { settingsLink } from "../settings-map.js";
import { setUiPrefs, useUiPrefs } from "../ui-prefs.js";

// /api/config, shared by the cards on the page; read again after a card changes something.
let rowsRead = null;
const rowsListeners = new Set();
function readRows(force = false) {
  if (!rowsRead || force) {
    rowsRead = api("/api/config").then((d) => d.settings || [], () => null);
    rowsRead.then((rows) => rowsListeners.forEach((fn) => fn(rows)));
  }
  return rowsRead;
}
// A row of Settings changed under a card: the card reads it again (only once it has read at all).
if (typeof window !== "undefined") window.addEventListener(CONFIG_EVENT, (e) => rowsRead && e.detail?.source !== "card" && readRows(true));
function useConfigRows(enabled) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    rowsListeners.add(setRows);
    readRows().then(setRows);
    return () => rowsListeners.delete(setRows);
  }, [enabled]);
  return rows;
}

/** The live catalogue: what each setting is now, on this page. */
export function useLiveCatalog(enabled = true) {
  const rows = useConfigRows(enabled);
  const prefs = useUiPrefs();
  return useMemo(() => settingsCatalog({ rows, prefs }), [rows, prefs]);
}

async function applyPatch(patch) {
  if (patch.config) await api("/api/config", { method: "PATCH", body: patch.config });
  if (patch.flags || patch.look) await setUiPrefs({ ...(patch.look ? { look: patch.look } : {}), ...(patch.flags ? { flags: patch.flags } : {}) });
  if (patch.config) {
    await readRows(true);
    configChanged("card");
  }
}

function SuggestionItem({ pick, entries, readOnly, onOpen, onApplied }) {
  const entry = entries.find((e) => e.id === pick.id);
  const [state, setState] = useState({ step: "idle", undo: null, error: "" });
  const place = (entry?.kind || pick.kind) === "place";
  const plan = !entry || pick.value == null ? { ok: false, why: place ? "place" : "text" } : applyPlan(entry, pick.value, entries);
  const now = entry && !place && entry.current != null && entry.options ? valueLabel(entry, entry.current) : "";
  const next = entry && pick.value != null ? valueLabel(entry, pick.value) : "";
  const done = state.step === "done";

  const apply = async () => {
    const undo = undoPatch(entry, plan, entries);
    setState({ step: "busy", undo: null, error: "" });
    try {
      await applyPatch(plan.patch);
      setState({ step: "done", undo, error: "" });
      onApplied?.(pick);
    } catch (error) {
      setState({ step: "idle", undo: null, error: error?.message || t("ذخیره نشد") });
    }
  };
  const revert = async () => {
    setState((s) => ({ ...s, step: "busy" }));
    try {
      await applyPatch(state.undo);
      setState({ step: "idle", undo: null, error: "" });
    } catch (error) {
      setState((s) => ({ ...s, step: "done", error: error?.message || t("ذخیره نشد") }));
    }
  };
  const open = () => (onOpen ? onOpen({ section: entry?.section || pick.section, focus: entry?.focus ?? pick.focus }) : (window.location.hash = settingsLink(entry?.section || pick.section, entry?.focus ?? pick.focus)));
  const note = done || plan.ok || plan.why === "place" ? "" : plan.why === "same" ? "" : (NO_CLICK[plan.why] || "").replace("{by}", plan.by || "");

  return (
    <li className="rounded-xl border bg-card p-3" data-suggest={pick.id}>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{entry?.title || pick.title}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{entry?.where || pick.where}</span>
        </span>
      </div>
      {pick.why ? <p className="mt-1.5 text-sm leading-6" dir="auto">{pick.why}</p> : null}
      {next && !place ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {plan.why === "same" && !done
            ? <span className="inline-flex items-center gap-1 text-ok"><Check className="size-3.5" />{t("همین الان «{v}» است.", { v: next })}</span>
            : done
              ? t("حالا: {v}", { v: next })
              : now ? t("الان: {now} ← می‌شود: {v}", { now, v: next }) : t("می‌شود: {v}", { v: next })}
        </p>
      ) : null}
      {!place && (entry?.scope || pick.scope) ? <p className="mt-1 text-[11px] text-muted-foreground">{scopeLabel(entry?.scope || pick.scope)}</p> : null}
      {plan.ok && plan.also?.length && !done ? <p className="mt-1 text-xs text-muted-foreground">{t("همراهش روشن می‌شود: {v}", { v: plan.also.join(t("، ")) })}</p> : null}
      {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
      {state.error ? <p className="mt-1 text-xs text-bad">{state.error}</p> : null}
      {readOnly ? null : (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {done ? (
            <>
              <span className="inline-flex items-center gap-1 text-xs text-ok"><Check className="size-3.5" />{t("اعمال شد")}</span>
              {state.undo ? <button type="button" onClick={revert} className="press rounded-lg border px-2.5 py-1 text-xs hover:bg-muted">{t("لغو تغییر")}</button> : null}
            </>
          ) : plan.ok ? (
            <button type="button" disabled={state.step === "busy"} onClick={apply} className="press inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-60">
              {state.step === "busy" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("اعمال تغییر")}
            </button>
          ) : null}
          <button type="button" onClick={open} className="press inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            {t("مشاهده در تنظیمات")}
            <ArrowLeft className="rtl-mirror size-3" />
          </button>
        </div>
      )}
    </li>
  );
}

/** The cards for one answer: { suggestions, none } from /api/settings/suggest or the tool. */
export function SettingsSuggestions({ result, onOpen, onApplied, readOnly = false }) {
  const entries = useLiveCatalog(!readOnly);
  const picks = Array.isArray(result?.suggestions) ? result.suggestions : [];
  if (!picks.length) return <p className="px-1 py-2 text-xs text-muted-foreground" dir="auto">{result?.none || t("تنظیمی پیدا نشد.")}</p>;
  return (
    <ul className="space-y-2">
      {picks.map((pick) => <SuggestionItem key={pick.id} pick={pick} entries={entries} readOnly={readOnly} onOpen={onOpen} onApplied={onApplied} />)}
    </ul>
  );
}

/** settings_suggest in a chat: the cards under the answer; while it runs, one line. */
export function SettingsSuggestCard({ result, isError, status }) {
  const readOnly = useApiBase() !== "/api";
  const running = status?.type === "running" || result === undefined;
  return (
    <div className="my-2 rounded-2xl border bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        {running ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
        {running ? t("در حال پیدا کردن تنظیم مناسب…") : t("تنظیم پیشنهادی")}
      </div>
      {running ? null : isError ? <p className="text-xs text-bad" dir="auto">{result?.error || t("پیشنهادی ساخته نشد.")}</p> : <SettingsSuggestions result={result} readOnly={readOnly} />}
    </div>
  );
}

/** «پرسش از دستیار» under the search of Settings: what was typed → the cards. */
export function useSettingsAsk() {
  const [state, setState] = useState({ query: "", busy: false, result: null, error: "" });
  const ask = useCallback(async (query) => {
    const q = String(query || "").trim();
    if (!q) return;
    setState({ query: q, busy: true, result: null, error: "" });
    try {
      const result = await api("/api/settings/suggest", { method: "POST", body: { query: q } });
      setState({ query: q, busy: false, result, error: "" });
    } catch (error) {
      setState({ query: q, busy: false, result: null, error: error?.message || t("جوابی نیامد") });
    }
  }, []);
  const reset = useCallback(() => setState({ query: "", busy: false, result: null, error: "" }), []);
  return { ...state, ask, reset };
}

/**
 * The sidebar's card of a setting offered from how the owner works (settings-nudges.mjs, SETTINGS_NUDGES):
 * at most one a week; «بعداً» puts it off, applying it closes it — both keep that one quiet for 60 days.
 */
export function SettingsNudge() {
  const [nudge, setNudge] = useState(null);
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    let live = true;
    api("/api/settings/nudge").then((d) => live && setNudge(d?.nudge || null), () => {});
    return () => {
      live = false;
    };
  }, []);
  if (!nudge) return null;
  const close = (outcome) => api("/api/settings/nudge/close", { method: "POST", body: { rule: nudge.rule, outcome } }).catch(() => {});
  return (
    <div className="g-settings-nudge mx-2 mt-2 rounded-xl border border-primary/30 bg-primary/5 p-2">
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <Sparkles className="size-3.5 text-primary" />
        <span className="flex-1">{t("پیشنهاد تنظیم")}</span>
        <button
          type="button"
          onClick={() => {
            if (!applied) close("later");
            setNudge(null);
          }}
          className="press rounded-lg border px-2 py-0.5 text-[11px] hover:bg-muted"
          title={applied ? undefined : t("تا دو ماه دیگر همین پیشنهاد نمی‌آید")}
        >
          {applied ? t("بستن") : t("بعداً")}
        </button>
      </div>
      <SettingsSuggestions
        result={{ suggestions: [nudge] }}
        onApplied={() => {
          setApplied(true);
          close("applied");
        }}
      />
    </div>
  );
}
