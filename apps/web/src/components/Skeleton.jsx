import { t } from "../i18n.js";

// What a page shows while its data is on its way: quiet rows in the shape of what comes, not an empty
// page that fills in with a jump. `rows`: how many; a list page passes about what it will show.
export function SkeletonRows({ rows = 4, className = "" }) {
  return (
    <div className={`space-y-2 ${className}`} role="status" aria-label={t("در حال بارگذاری…")}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-2xl bg-muted/60" style={{ animationDelay: `${i * 90}ms` }} aria-hidden />
      ))}
    </div>
  );
}

// A whole page on its way (a chunk or its first data).
export function PageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
      <div className="mb-5 h-6 w-40 animate-pulse rounded-lg bg-muted/60" aria-hidden />
      <SkeletonRows rows={5} />
    </div>
  );
}
