import { useEffect, useState } from "react";
import { AlertTriangle, Archive, Check, Cpu, Globe, History, Loader2, Palette, Plug, RefreshCw, Send, UserRound, Wrench, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { Group, Item } from "./SettingsParts.jsx";
import { tr } from "./Setup.jsx";
import { locale, num, t } from "../i18n.js";

const ICON = { ok: Check, warn: AlertTriangle, error: XCircle };
const TINT = { ok: "bg-ok/12 text-ok", warn: "bg-amber-500/12 text-amber-600", error: "bg-bad/12 text-bad" };
const WIZARDS = [
  { flow: "engine", label: t("موتور هوش مصنوعی"), icon: Cpu },
  { flow: "proxy", label: t("پراکسی خروجی"), icon: Globe },
  { flow: "name", label: t("نام دستیار"), icon: UserRound },
  { flow: "appearance", label: t("لوگو و رنگ"), icon: Palette },
  { flow: "telegram", label: t("ربات تلگرام یا بله"), icon: Send },
  { flow: "import", label: t("انتقال از ابزار قبلی"), icon: History },
  { flow: "mcp", label: t("اتصال ایجنت دیگر (MCP)"), icon: Plug },
  { flow: "first", label: t("راه‌اندازی از اول"), icon: Wrench },
];

// Settings → Health: the doctor's live report, its fixes, and the setup wizards.
export function DoctorSection({ bare = false } = {}) {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(null);
  const [failed, setFailed] = useState(null);
  const load = () => {
    setReport(null);
    setFailed(null);
    api("/api/doctor").then(setReport).catch((e) => {
      toast.error(e.message);
      setFailed(e.message || t("بارگذاری نشد"));
    });
  };
  useEffect(load, []);

  const apply = async (fix) => {
    if (fix.manual) {
      window.location.hash = fix.id === "wizard" ? "/setup/engine" : "/settings";
      return;
    }
    setBusy(fix.id);
    try {
      const r = await api("/api/doctor/fix", { method: "POST", body: { id: fix.id } });
      toast.success(r.done || t("انجام شد"));
      load();
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(null);
  };

  return (
    <div className="space-y-6">
      <Group joined title={t("چک زنده")} action={<button type="button" onClick={load} className="press inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted"><RefreshCw className="size-3.5" /> {t("دوباره")}</button>}>
        {!report && failed ? (
          <div className="flex justify-center px-4 py-6 text-sm text-muted-foreground" role="alert">{t("بارگذاری نشد:")} <span className="ms-1" dir="auto">{failed}</span></div>
        ) : !report ? (
          <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : (
          report.checks.map((c) => (
            <Item
              key={c.id}
              icon={ICON[c.level]}
              tint={TINT[c.level]}
              title={tr(c.title, c.vars)}
              subtitle={c.detail || null}
              trailing={c.fix ? (
                <button type="button" disabled={busy === c.fix.id} onClick={() => apply(c.fix)} className="g-pill press inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs">
                  {busy === c.fix.id ? <Loader2 className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />} {tr(c.fix.title, c.fix.vars)}
                </button>
              ) : null}
            />
          ))
        )}
      </Group>
      {/* `bare` (the Karsara skin's status page): only the live check; the rest is the Health section. */}
      {bare ? null : <>
      <p className="px-1 text-xs leading-6 text-muted-foreground">
        {t("هر ۱۵ دقیقه همین چک خودکار اجرا می‌شود: ایجنتی که موتورش از کار افتاده (کلید رد شده، محدودیت کشور، مدل ناموجود) به موتور سالم می‌رود و وقتی موتور اصلی درست شد برمی‌گردد؛ ران‌های گیرکرده متوقف می‌شوند. دستیار هم با ابزار self_check / self_fix خودش را چک و تعمیر می‌کند.")}
      </p>
      <BackupsGroup />
      <Group title={t("ویزاردها")}>
        {WIZARDS.map((w) => <Item key={w.flow} icon={w.icon} title={w.label} onClick={() => { window.location.hash = `/setup/${w.flow}`; }} />)}
      </Group>
      {report?.errors?.length ? (
        <Group title={t("آخرین خطاهای سرور")}>
          {report.errors.slice().reverse().map((e, i) => <Item key={i} title={e.line} subtitle={`${new Date(e.at).toLocaleString(locale)}${e.count > 1 ? ` · ×${e.count}` : ""}`} />)}
        </Group>
      ) : null}
      </>}
    </div>
  );
}

// Periodic database backups (server backup.mjs): when the last one was, how many are kept, and one now.
function BackupsGroup() {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api("/api/backups").then(setS).catch(() => setS(null));
  useEffect(() => { load(); }, []);
  if (!s) return null;
  const now = async () => {
    setBusy(true);
    try {
      const r = await api("/api/backups", { method: "POST" });
      toast.success(t("بکاپ گرفته شد: {mb} مگابایت، {chats} گفتگو", { mb: num(Math.round(r.bytes / 1024 ** 2)), chats: num(r.chats) }));
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
    load();
  };
  const newest = s.newest ? t("{at} · {mb} مگابایت", { at: new Date(s.newest.at).toLocaleString(locale), mb: num(Math.round((s.newest.bytes || 0) / 1024 ** 2)) }) : t("هنوز بکاپی نیست");
  return (
    <Group title={t("بکاپ گفتگوها")}>
      <Item
        icon={Archive}
        title={s.enabled ? t("هر {hours} ساعت · {n} بکاپ نگه داشته شده", { hours: num(s.everyHours), n: num(s.files.length) }) : t("بکاپ خودکار خاموش است")}
        subtitle={s.last && !s.last.ok ? t("آخرین: {newest} · خطا: {error}", { newest, error: s.last.error }) : t("آخرین: {newest}", { newest })}
        trailing={
          <button type="button" disabled={busy || s.running} onClick={now} className="g-pill press inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs">
            {busy || s.running ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />} {t("بکاپ همین حالا")}
          </button>
        }
      />
    </Group>
  );
}
