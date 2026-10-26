// Which shelf a merge request sits on and why, in words the owner reads. Pure: the page shows what
// this says; the order of the shelves is module.json (groupBy.groups).

const RUNNING = new Set(["created", "pending", "running", "preparing", "waiting_for_resource", "scheduled"]);
const FAILED = new Set(["failed", "canceled", "cancelled"]);
const PIPELINE = {
  success: "پایپ‌لاین سبز",
  failed: "پایپ‌لاین قرمز",
  canceled: "پایپ‌لاین لغو شد",
  running: "پایپ‌لاین در حال اجرا",
  pending: "پایپ‌لاین در صف",
  created: "پایپ‌لاین در صف",
  preparing: "پایپ‌لاین آماده می‌شود",
  waiting_for_resource: "پایپ‌لاین منتظر منبع",
  scheduled: "پایپ‌لاین زمان‌بندی‌شده",
  manual: "پایپ‌لاین منتظر دکمهٔ دستی",
  skipped: "پایپ‌لاین رد شد",
};
const WAITING = {
  not_approved: "منتظر تأیید یک نفر",
  discussions_not_resolved: "بحث‌های حل‌نشده دارد",
  blocked_status: "به MR دیگری وابسته است",
  external_status_checks: "منتظر بررسی بیرونی",
  requested_changes: "بازبین تغییر خواسته",
  jira_association_missing: "به تسک وصل نیست",
  merge_request_blocked: "به MR دیگری وابسته است",
};

export const pipelineLabel = (status) => (status ? PIPELINE[status] || `پایپ‌لاین: ${status}` : "");

/** @returns {{category: string, reason: string}} */
export function categorize(mr) {
  if (mr.state === "merged") return { category: "merged", reason: "مرج شده" };
  if (mr.state === "closed") return { category: "closed", reason: "بسته شده" };
  const detailed = mr.detailedMergeStatus || "";
  if (mr.draft || detailed === "draft_status") return { category: "draft", reason: "پیش‌نویس است؛ هنوز آمادهٔ بازبینی نیست" };
  if (mr.hasConflicts || detailed === "conflict") return { category: "attention", reason: "با شاخهٔ مقصد تداخل دارد" };
  if (detailed === "need_rebase") return { category: "attention", reason: "عقب‌تر از شاخهٔ مقصد است و باید rebase شود" };
  if (FAILED.has(mr.pipeline)) return { category: "attention", reason: pipelineLabel(mr.pipeline) };
  if (RUNNING.has(mr.pipeline) || detailed === "ci_still_running" || detailed === "checking" || detailed === "unchecked") return { category: "running", reason: pipelineLabel(mr.pipeline) || "GitLab هنوز وضعیت مرج را حساب می‌کند" };
  if (WAITING[detailed]) return { category: "waiting", reason: WAITING[detailed] };
  if (detailed === "ci_must_pass") return { category: "attention", reason: "پایپ‌لاین باید سبز شود" };
  if (detailed === "mergeable" || (!detailed && (mr.pipeline === "success" || !mr.pipeline))) return { category: "ready", reason: mr.pipeline === "success" ? "پایپ‌لاین سبز و بدون مانع" : "بدون مانع" };
  return { category: "waiting", reason: detailed ? `وضعیت: ${detailed}` : "وضعیتش معلوم نیست" };
}
