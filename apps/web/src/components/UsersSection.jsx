import { useCallback, useEffect, useState } from "react";
import { Switch } from "radix-ui";
import { Check, Copy, KeyRound, Loader2, Pencil, Plus, Trash2, UserRound, X } from "lucide-react";
import { api } from "../api.js";
import { exactTime } from "../elapsed.js";
import { num, t } from "../i18n.js";
import { toast } from "sonner";
import { askConfirm } from "../dialog.jsx";

function CopyTokenBanner({ entry, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!entry?.token) return null;
  const copy = () => {
    navigator.clipboard?.writeText(entry.token).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="rounded-2xl border border-primary/40 bg-primary/8 p-4 shadow-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {t("توکن ورود برای {name}", { name: entry.displayName })}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("این توکن فقط همین یک بار نشان داده می‌شود؛ آن را به همکار بدهید تا وارد شود.")}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label={t("بستن")} className="press rounded-lg p-1 text-muted-foreground hover:bg-muted">
          <X className="size-4" />
        </button>
      </div>
      <div className="flex items-center gap-2 rounded-xl border bg-background px-3 py-2">
        <code className="min-w-0 flex-1 select-all truncate font-mono text-xs" dir="ltr">{entry.token}</code>
        <button type="button" onClick={copy} className="press inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? t("کپی شد") : t("کپی")}
        </button>
      </div>
    </div>
  );
}

export function UsersSection() {
  const [users, setUsers] = useState(null);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [creating, setCreating] = useState(false);
  const [freshToken, setFreshToken] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    api("/api/users")
      .then((d) => setUsers(d.users || []))
      .catch((e) => {
        toast.error(e.message);
        setUsers([]);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (event) => {
    event.preventDefault();
    const name = displayName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const body = { displayName: name };
      if (username.trim()) body.username = username.trim();
      const res = await api("/api/users", { method: "POST", body });
      setUsers((prev) => [...(prev || []), res.user]);
      setDisplayName("");
      setUsername("");
      setFreshToken({ displayName: res.user.displayName, token: res.token });
      toast.success(t("کاربر ساخته شد"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setCreating(false);
    }
  };

  const toggleEnabled = async (user, enabled) => {
    setBusyId(user.id);
    try {
      const res = await api(`/api/users/${user.id}`, { method: "PATCH", body: { enabled } });
      setUsers((prev) => (prev || []).map((u) => (u.id === user.id ? res.user : u)));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const saveName = async (user) => {
    const next = editName.trim();
    if (!next || next === user.displayName) {
      setEditingId(null);
      return;
    }
    setBusyId(user.id);
    try {
      const res = await api(`/api/users/${user.id}`, { method: "PATCH", body: { displayName: next } });
      setUsers((prev) => (prev || []).map((u) => (u.id === user.id ? res.user : u)));
      setEditingId(null);
      toast.success(t("ذخیره شد"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const resetToken = async (user) => {
    if (!(await askConfirm(t("برای «{name}» توکن تازه ساخته شود؟ توکن قبلی و نشست‌هایش از کار می‌افتند.", { name: user.displayName })))) return;
    setBusyId(user.id);
    try {
      const res = await api(`/api/users/${user.id}/reset-token`, { method: "POST" });
      setFreshToken({ displayName: user.displayName, token: res.token });
      toast.success(t("توکن تازه ساخته شد"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (user) => {
    if (!(await askConfirm(t("کاربر «{name}» حذف شود؟ دسترسی‌اش فوراً قطع می‌شود.", { name: user.displayName }), { danger: true, yes: t("حذف") }))) return;
    setBusyId(user.id);
    try {
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      setUsers((prev) => (prev || []).filter((u) => u.id !== user.id));
      toast.success(t("کاربر حذف شد"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <CopyTokenBanner entry={freshToken} onClose={() => setFreshToken(null)} />

      <section>
        <h3 className="mb-2 px-1 text-xs font-medium text-muted-foreground">{t("افزودن کاربر")}</h3>
        <form onSubmit={create} className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t("نام نمایشی")}</label>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={60}
                dir="auto"
                placeholder={t("مثلاً علی رضایی")}
                className="w-full rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t("نام کاربری (اختیاری)")}</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                maxLength={32}
                dir="ltr"
                placeholder="ali"
                className="w-full rounded-xl border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {t("هر کاربر فقط گفتگوها، پوشه‌ها و یادداشت‌های خودش را می‌بیند و از موتورهای مشترک استفاده می‌کند.")}
            </p>
            <button
              type="submit"
              disabled={!displayName.trim() || creating}
              className="press inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm disabled:opacity-50"
            >
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              {t("ساخت کاربر")}
            </button>
          </div>
        </form>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between px-1">
          <h3 className="text-xs font-medium text-muted-foreground">{t("فهرست کاربران")}</h3>
          {users ? <span className="text-xs tabular-nums text-muted-foreground">{num(users.length)}</span> : null}
        </div>
        {!users ? (
          <div className="space-y-2 rounded-2xl border bg-card p-4 shadow-sm">
            <div className="h-12 animate-pulse rounded-xl bg-muted/60" />
            <div className="h-12 animate-pulse rounded-xl bg-muted/60" />
          </div>
        ) : !users.length ? (
          <div className="rounded-2xl border bg-card p-6 text-center text-sm text-muted-foreground shadow-sm">
            {t("هنوز کاربری اضافه نشده است.")}
          </div>
        ) : (
          <div className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {users.map((u) => {
              const busy = busyId === u.id;
              const editing = editingId === u.id;
              return (
                <div key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${u.enabled ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
                      <UserRound className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      {editing ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            saveName(u);
                          }}
                          className="flex items-center gap-1.5"
                        >
                          <input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            maxLength={60}
                            dir="auto"
                            autoFocus
                            className="min-w-0 flex-1 rounded-lg border bg-background px-2.5 py-1 text-sm outline-none focus:border-primary"
                          />
                          <button type="submit" disabled={busy || !editName.trim()} className="press rounded-lg bg-primary px-2.5 py-1 text-xs text-primary-foreground">
                            {t("ذخیره")}
                          </button>
                          <button type="button" onClick={() => setEditingId(null)} className="press rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted">
                            {t("انصراف")}
                          </button>
                        </form>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{u.displayName}</span>
                          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground" dir="ltr">@{u.username}</code>
                          {!u.enabled ? (
                            <span className="rounded-full bg-bad/12 px-2 py-0.5 text-[11px] text-bad">{t("غیرفعال")}</span>
                          ) : null}
                        </div>
                      )}
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t("{count} گفتگو", { count: num(u.chatCount || 0) })}
                        {" · "}
                        {u.lastLoginAt ? t("آخرین ورود: {when}", { when: exactTime(u.lastLoginAt) }) : t("هنوز وارد نشده")}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Switch.Root
                      checked={Boolean(u.enabled)}
                      disabled={busy}
                      onCheckedChange={(v) => toggleEnabled(u, v)}
                      aria-label={t("فعال‌بودن کاربر")}
                      className="relative h-6 w-10 cursor-pointer rounded-full bg-muted transition-colors data-[state=checked]:bg-primary disabled:opacity-50"
                    >
                      <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform data-[state=checked]:translate-x-[18px] rtl:data-[state=checked]:-translate-x-[18px]" />
                    </Switch.Root>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(u.id);
                        setEditName(u.displayName);
                      }}
                      title={t("ویرایش نام")}
                      aria-label={t("ویرایش نام")}
                      className="press rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => resetToken(u)}
                      title={t("ریست توکن")}
                      aria-label={t("ریست توکن")}
                      className="press rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      <KeyRound className="size-4" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => remove(u)}
                      title={t("حذف کاربر")}
                      aria-label={t("حذف کاربر")}
                      className="press rounded-lg p-1.5 text-muted-foreground hover:bg-bad/10 hover:text-bad disabled:opacity-50"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
