import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, Globe, Link2, Loader2, Lock, Share2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";

export function shareUrl(token) {
  return `${window.location.origin}/#/s/${token}`;
}

// Public read-only link for one chat. Anyone with the link sees the whole conversation, including
// tool output, files and charts of this chat; revoking kills the link.
export function ShareButton({ chatId }) {
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
      else toast("لینک عمومی غیرفعال شد");
    } catch (error) {
      toast.error(`خطا: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (token) => {
    try {
      await navigator.clipboard.writeText(shareUrl(token));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      toast.success("لینک کپی شد");
    } catch {
      // clipboard blocked (e.g. plain HTTP): the link is visible in the field to copy by hand
    }
  };

  if (!chatId) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="press flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted" aria-label="اشتراک‌گذاری">
          <Share2 className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="pop z-50 w-80 rounded-xl border bg-card p-3 text-sm shadow-xl">
          <div className="flex items-center gap-2">
            <span className={`flex size-8 items-center justify-center rounded-lg ${share ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
              {share ? <Globe className="size-4" /> : <Lock className="size-4" />}
            </span>
            <div className="min-w-0">
              <p className="font-medium">{share ? "با لینک عمومی قابل مشاهده است" : "خصوصی"}</p>
              <p className="text-xs text-muted-foreground">{share ? "هر کس لینک را دارد، بدون ورود می‌بیند" : "فقط شما بعد از ورود می‌بینید"}</p>
            </div>
          </div>
          <AnimatePresence initial={false}>
            {share ? (
              <motion.div key="link" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="mt-3 flex items-center gap-1 rounded-lg border bg-background p-1">
                  <Link2 className="ms-1.5 size-3.5 shrink-0 text-muted-foreground" />
                  <input readOnly value={shareUrl(share.token)} onFocus={(e) => e.target.select()} className="ltr min-w-0 flex-1 bg-transparent px-1 font-mono text-xs outline-none" />
                  <button type="button" onClick={() => copy(share.token)} className="press flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label="کپی">
                    {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
                  </button>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            خروجی ابزارها، فایل‌ها و نمودارهای همین گفتگو هم دیده می‌شوند؛ پیام‌های بعدی هم در لینک می‌آیند.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            {share === undefined ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : share ? (
              <button type="button" disabled={busy} onClick={() => act("DELETE")} className="press rounded-lg px-3 py-1.5 text-bad hover:bg-bad/10 disabled:opacity-50">
                غیرفعال کردن لینک
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => act("POST")} className="press flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-50">
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />} ساخت لینک عمومی
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
