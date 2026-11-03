import { Suspense, useState } from "react";
import { Dialog } from "radix-ui";
import { Loader2, X } from "lucide-react";
import { MODULE_ICONS } from "./ModulePage.jsx";
import { moduleView } from "../module-views.js";
import { chatDigest, moduleChatActions } from "../modules.js";
import { isRtl, t } from "../i18n.js";

// The enabled modules' buttons on a chat's header (module.json chatActions). Each opens that
// module's own screen in a dialog with the chat — its id, title and recent messages (chatDigest).
// The screen does the rest through its module's actions; closing the dialog does nothing.
export function ModuleChatActions({ modules, chat, messages }) {
  const [open, setOpen] = useState(null); // { module, action }
  const items = moduleChatActions(modules).filter(({ module, action }) => moduleView(module.id, action.view));
  if (!chat?.id || !items.length) return null;
  return (
    <>
      {items.map(({ module, action }) => {
        const Icon = MODULE_ICONS[action.icon] || MODULE_ICONS.puzzle;
        return (
          <button key={`${module.id}:${action.id}`} type="button" onClick={() => setOpen({ module, action })} title={action.label} className="press inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <Icon className="size-3.5" /> <span className="hidden sm:inline">{action.label}</span>
          </button>
        );
      })}
      <ModuleActionDialog open={open} props={open ? { chat: { id: chat.id, title: chat.title || "", messages: chatDigest(messages) } } : null} onClose={() => setOpen(null)} />
    </>
  );
}

/**
 * A module's own screen (module.json chatActions / selectionActions → its view) in a dialog.
 * `open` = { module, action } or null; the view gets { mod, action, onClose, ...props }.
 */
export function ModuleActionDialog({ open, props, onClose }) {
  const View = open ? moduleView(open.module.id, open.action.view) : null;
  return (
    <Dialog.Root open={Boolean(open)} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] overlay" />
        <Dialog.Content dir={isRtl ? "rtl" : "ltr"} aria-describedby={undefined} className="pop fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-5 shadow-2xl">
          <div className="mb-3 flex items-center gap-2">
            <Dialog.Title className="font-semibold">{open?.action.label}</Dialog.Title>
            <Dialog.Close className="press ms-auto rounded-full p-1.5 hover:bg-muted" aria-label={t("بستن")}><X className="size-4" /></Dialog.Close>
          </div>
          {View ? (
            <Suspense fallback={<p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("در حال بارگذاری…")}</p>}>
              <View mod={open.module} action={open.action} onClose={onClose} {...props} />
            </Suspense>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
