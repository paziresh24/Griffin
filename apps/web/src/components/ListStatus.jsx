import { Loader2, RotateCcw } from "lucide-react";
import { t } from "../i18n.js";

// What the chat list says while it holds nothing: loading (with placeholder rows), a read that
// failed (with a retry), or, only once the server answered, that there really are no chats. An
// empty list that stays silent looks like deleted chats.
export function ListStatus({ loading = false, failed = false, onRetry = null, empty = true, k = false, children = null }) {
  if (loading) {
    return (
      <div className="px-2 py-3" role="status" aria-live="polite">
        <p className="mb-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("در حال بارگذاری گفتگوها…")}
        </p>
        <div className="space-y-2" aria-hidden>
          {[78, 56, 68, 44, 62].map((width, i) => (
            <div key={i} className="flex items-center gap-2 px-2 py-1.5">
              <span className={`size-4 shrink-0 animate-pulse bg-muted ${k ? "rounded" : "rounded-md"}`} />
              <span className="h-3 animate-pulse rounded bg-muted" style={{ width: `${width}%`, animationDelay: `${i * 120}ms` }} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (failed && empty) {
    return (
      <div className="px-3 py-6 text-center text-sm text-muted-foreground" role="status">
        <p>{t("گفتگوها هنوز بارگذاری نشد؛ چیزی پاک نشده است.")}</p>
        <p className="mt-1 text-xs">{t("دوباره تلاش می‌کنم…")}</p>
        {onRetry ? (
          <button type="button" onClick={onRetry} className="mt-2 inline-flex items-center gap-1 rounded-lg px-3 py-1 text-xs text-primary hover:bg-muted">
            <RotateCcw className="size-3" />
            {t("تلاش دوباره")}
          </button>
        ) : null}
      </div>
    );
  }
  return empty ? children : null;
}
