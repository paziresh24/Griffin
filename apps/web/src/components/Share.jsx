import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, Globe, Link2, Loader2, Lock, Search, Send, Share2, UserLock, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { BRAND } from "../brand.js";
import { isRtl, locale, num, t } from "../i18n.js";
import { afterRefusal, confirmMatches, failedInviteNotes, needsConfirm, sourceLabel } from "../share-confirm.js";

export function shareUrl(token) {
  return `${window.location.origin}/#/s/${token}`;
}

// Sharing one chat. First choice: privately with one person — the invite and a code go to their
// Telegram from the owner's account; they read live and leave notes, never drive the agent.
// Shown only when the server's PRIVATE_SHARE switch is on.
// Second: a public read-only link — anyone with it sees the whole conversation, including tool
// output, files and charts of this chat; revoking kills the link.
export function ShareButton({ chatId, privateShare = false }) {
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !chatId) return;
    api(`/api/chats/${chatId}/share`).then((r) => setShare(r.share), () => setShare(null));
  }, [open, chatId]);

  const act = async (method) => {
    setBusy(true);
    try {
      const r = await api(`/api/chats/${chatId}/share`, { method });
      setShare(method === "POST" ? r.share : null);
      if (method === "POST") await copy(r.share.token);
      else toast(t("لینک عمومی غیرفعال شد"));
    } catch (error) {
      toast.error(t("خطا: {message}", { message: error.message }));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (token) => {
    try {
      await navigator.clipboard.writeText(shareUrl(token));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      toast.success(t("لینک کپی شد"));
    } catch {
      // clipboard blocked (e.g. plain HTTP): the link is visible in the field to copy by hand
    }
  };

  if (!chatId) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="press flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted" aria-label={t("اشتراک‌گذاری")}>
          <Share2 className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="pop z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border bg-card p-3 text-sm shadow-xl">
          {open ? <PrivateShares chatId={chatId} canInvite={privateShare} /> : null}
          <div className="flex items-center gap-2">
            <span className={`flex size-8 items-center justify-center rounded-lg ${share ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
              {share ? <Globe className="size-4" /> : <Lock className="size-4" />}
            </span>
            <div className="min-w-0">
              <p className="font-medium">{share ? t("با لینک عمومی قابل مشاهده است") : privateShare ? t("لینک عمومی") : t("خصوصی")}</p>
              <p className="text-xs text-muted-foreground">{share ? t("هر کس لینک را دارد، بدون ورود می‌بیند") : privateShare ? t("هر کس لینک را داشته باشد، بدون ورود می‌بیند") : t("فقط شما بعد از ورود می‌بینید")}</p>
            </div>
          </div>
          <AnimatePresence initial={false}>
            {share ? (
              <motion.div key="link" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="mt-3 flex items-center gap-1 rounded-lg border bg-background p-1">
                  <Link2 className="ms-1.5 size-3.5 shrink-0 text-muted-foreground" />
                  <input readOnly value={shareUrl(share.token)} onFocus={(e) => e.target.select()} className="ltr min-w-0 flex-1 bg-transparent px-1 font-mono text-xs outline-none" />
                  <button type="button" onClick={() => copy(share.token)} className="press flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label={t("کپی")}>
                    {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
                  </button>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            {t("خروجی ابزارها، فایل‌ها و نمودارهای همین گفتگو هم دیده می‌شوند؛ پیام‌های بعدی هم در لینک می‌آیند.")}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            {share === undefined ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : share ? (
              <button type="button" disabled={busy} onClick={() => act("DELETE")} className="press rounded-lg px-3 py-1.5 text-bad hover:bg-bad/10 disabled:opacity-50">
                {t("غیرفعال کردن لینک")}
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => act("POST")} className="press flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-50">
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />} {t("ساخت لینک عمومی")}
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const fa = (n) => num(n || 0);
const when = (iso) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "");

// Private shares of this chat: invite one person by their Telegram, see who opened it, close it.
// canInvite: the PRIVATE_SHARE switch. Off, nothing shows — unless shares made while it was on are
// left, which can still be closed here (off pauses them; it does not close them).
function PrivateShares({ chatId, canInvite }) {
  const [shares, setShares] = useState(undefined);
  const [telegram, setTelegram] = useState(true);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState(null);
  const [typed, setTyped] = useState(""); // the exact @username, for someone not in the owner's contacts
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);

  // Search as the owner types, like Telegram's search box; the latest answer wins.
  useEffect(() => {
    const q = query.trim();
    if (picked || !q) {
      setPeople([]);
      setSearching(false);
      return undefined;
    }
    const id = ++asked.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api(`/api/chats/${chatId}/private-shares/people?q=${encodeURIComponent(q)}`).then(
        (r) => id === asked.current && setPeople(r.people || []),
        (error) => id === asked.current && (setPeople([]), toast.error(error.message)),
      ).finally(() => id === asked.current && setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, picked, chatId]);

  const refresh = () =>
    api(`/api/chats/${chatId}/private-shares`).then(
      (r) => {
        setShares(r.shares);
        setTelegram(r.telegram !== false);
        for (const note of failedInviteNotes(r)) toast.error(note);
      },
      () => setShares([]),
    );
  useEffect(() => {
    refresh();
  }, [chatId]);

  const invite = async (event) => {
    event.preventDefault();
    if (!picked || (needsConfirm(picked) && !confirmMatches(picked, typed))) return;
    setBusy(true);
    try {
      const r = await api(`/api/chats/${chatId}/private-shares`, { method: "POST", body: { to: picked.peerId, ...(needsConfirm(picked) ? { confirmUsername: typed } : {}) } });
      toast.success(r.sent === "pending" ? t("دعوت برای {name} در صف تلگرام است؛ اگر نرسید همین‌جا خبر می‌دهیم.", { name: r.share.grantee }) : t("دعوت در تلگرام برای {name} رفت", { name: r.share.grantee }));
      setPicked(null);
      setTyped("");
      setQuery("");
      await refresh();
    } catch (error) {
      // Not a contact: the server asks for the exact @username first (409 + confirm).
      const again = afterRefusal(picked, error);
      if (again) setPicked(again);
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const close = async (token, grantee) => {
    try {
      await api(`/api/chats/${chatId}/private-shares/${token}`, { method: "DELETE" });
      toast(t("دسترسی {name} بسته شد", { name: grantee }));
      await refresh();
    } catch (error) {
      toast.error(error.message);
    }
  };

  if (!canInvite && !shares?.length) return null;
  return (
    <div className="mb-3 border-b pb-3">
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <UserLock className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="font-medium">{t("اشتراکِ خصوصی با یک نفر")}</p>
          <p className="text-xs text-muted-foreground">{t("فقط او، روی دستگاه خودش؛ می‌خواند و یادداشت می‌گذارد")}</p>
        </div>
      </div>
      {shares === undefined ? (
        <Loader2 className="mt-3 size-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          {shares.length ? (
            <ul className="mt-3 space-y-1.5">
              {shares.map((s) => (
                <li key={s.token} className="flex items-center gap-2 rounded-lg border bg-background px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" dir="auto">{s.grantee}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.state === "active" ? t("باز کرده · {n} بار · آخرین بار {when}", { n: fa(s.views), when: when(s.lastSeenAt || s.claimedAt) }) : t("دعوت رفته؛ هنوز باز نکرده")}
                    </p>
                  </div>
                  <button type="button" onClick={() => close(s.token, s.grantee)} className="press flex size-7 items-center justify-center rounded-md text-bad hover:bg-bad/10" aria-label={t("بستن دسترسی")} title={t("بستن دسترسی")}>
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {!canInvite ? null : telegram ? (
            <form onSubmit={invite} className="mt-3">
              {picked ? (
                <div className="flex items-center gap-1 rounded-lg border bg-background p-1">
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5">
                    <span className="truncate font-medium" dir="auto">{picked.title}</span>
                    {picked.username ? <span className="ltr truncate text-xs text-muted-foreground">@{picked.username}</span> : null}
                  </span>
                  <button type="button" onClick={() => (setPicked(null), setTyped(""))} className="press flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label={t("انتخاب دیگری")}>
                    <X className="size-3.5" />
                  </button>
                  <button type="submit" disabled={busy || (needsConfirm(picked) && !confirmMatches(picked, typed))} className="press flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50">
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {t("دعوت")}
                  </button>
                </div>
              ) : null}
              {picked && needsConfirm(picked) ? (
                <div className="mt-1.5 space-y-1 px-1 text-xs text-muted-foreground">
                  <p>{t("{source}؛ برای اطمینان نامِ کاربریِ دقیقش را بنویسید.", { source: sourceLabel(picked) })}</p>
                  {picked.username ? (
                    <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={`@${picked.username}`} dir="ltr" autoComplete="off" className="w-full rounded-md border bg-background px-2 py-1 text-sm outline-none" />
                  ) : (
                    <p className="text-bad">{t("نامِ کاربری ندارد؛ اول او را در تلگرام به مخاطبانتان اضافه کنید.")}</p>
                  )}
                </div>
              ) : null}
              {picked ? null : (
                <>
                  <div className="flex items-center gap-1.5 rounded-lg border bg-background px-2 py-1.5">
                    {searching ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : <Search className="size-3.5 shrink-0 text-muted-foreground" />}
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t("جستجوی نام یا آی‌دی در تلگرام")}
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                      dir={query ? "auto" : isRtl ? "rtl" : "ltr"}
                      autoComplete="off"
                    />
                  </div>
                  {query.trim() && !searching ? (
                    people.length ? (
                      <ul className="mt-1 max-h-56 overflow-y-auto rounded-lg border bg-background p-1">
                        {people.map((p) => (
                          <li key={p.peerId}>
                            <button type="button" onClick={() => setPicked(p)} className="press flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start hover:bg-muted">
                              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">{[...(p.title || "?")][0]}</span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate" dir="auto">{p.title}</span>
                                {p.username ? <span className="ltr block truncate text-xs text-muted-foreground">@{p.username}</span> : null}
                                <span className="block truncate text-[11px] text-muted-foreground">{sourceLabel(p)}</span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 px-1 text-xs text-muted-foreground">{t("کسی با این نام در تلگرامِ شما پیدا نشد.")}</p>
                    )
                  ) : null}
                </>
              )}
            </form>
          ) : (
            <p className="mt-3 text-xs leading-5 text-muted-foreground">{t("برای اشتراکِ خصوصی، اول تلگرامِ خودتان را از تنظیمات به {name} وصل کنید.", { name: BRAND.name })}</p>
          )}
        </>
      )}
    </div>
  );
}
