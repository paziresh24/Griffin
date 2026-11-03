// Griffin's own dialogs instead of the browser's confirm/prompt/alert: the same promise-returning calls,
// shown as a card in the page (owner 2026-11-02: «پیام‌ها داخل خود گریفین هندل شود»).
// askConfirm(text, { yes, no, danger }) -> boolean · askPrompt(text, initial) -> string | null · askAlert(text) -> void
import { useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { AlertTriangle } from "lucide-react";
import { isRtl, t } from "./i18n.js";

let current = null; // { kind, text, initial, yes, no, danger, resolve }
const listeners = new Set();
const queue = [];

function show(next) {
  return new Promise((resolve) => {
    queue.push({ ...next, resolve });
    if (!current) advance();
  });
}
function advance() {
  current = queue.shift() || null;
  for (const l of listeners) l(current);
}
function close(value) {
  const done = current;
  advance();
  done?.resolve(value);
}

export const askConfirm = (text, opts = {}) => show({ kind: "confirm", text, ...opts });
export const askPrompt = (text, initial = "") => show({ kind: "prompt", text, initial });
export const askAlert = (text) => show({ kind: "alert", text });

export function DialogHost() {
  const [item, setItem] = useState(current);
  const [value, setValue] = useState("");
  const input = useRef(null);
  useEffect(() => {
    listeners.add(setItem);
    return () => listeners.delete(setItem);
  }, []);
  useEffect(() => {
    setValue(item?.initial || "");
  }, [item]);
  const answer = (ok) => close(item.kind === "prompt" ? (ok ? value : null) : item.kind === "alert" ? undefined : ok);
  return (
    <Dialog.Root open={Boolean(item)} onOpenChange={(open) => !open && item && answer(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-[2px] overlay" />
        <Dialog.Content
          dir={isRtl ? "rtl" : "ltr"}
          onOpenAutoFocus={(e) => {
            if (item?.kind === "prompt") {
              e.preventDefault();
              input.current?.focus();
              input.current?.select();
            }
          }}
          className="pop fixed left-1/2 top-1/2 z-[70] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-card p-5 shadow-2xl"
        >
          {item ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                answer(true);
              }}
            >
              <Dialog.Title className="sr-only">{item.kind === "alert" ? t("پیام") : t("تأیید")}</Dialog.Title>
              <Dialog.Description className="flex items-start gap-2 whitespace-pre-line text-sm leading-6">
                {item.danger ? <AlertTriangle className="mt-1 size-4 shrink-0 text-amber-500" /> : null}
                <span>{item.text}</span>
              </Dialog.Description>
              {item.kind === "prompt" ? (
                <input ref={input} value={value} onChange={(e) => setValue(e.target.value)} className="mt-3 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
              ) : null}
              <div className="mt-4 flex justify-end gap-2">
                {item.kind !== "alert" ? (
                  <button type="button" onClick={() => answer(false)} className="press rounded-full border px-4 py-1.5 text-sm hover:bg-muted">{item.no || t("انصراف")}</button>
                ) : null}
                <button type="submit" autoFocus={item.kind === "confirm" || item.kind === "alert"} className="press rounded-full bg-primary px-4 py-1.5 text-sm text-primary-foreground">{item.yes || (item.kind === "alert" ? t("باشه") : t("ادامه"))}</button>
              </div>
            </form>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
