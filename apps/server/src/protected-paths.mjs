// The access fences, apart from tool-builder.mjs so CI can load them without the app's packages
// (deploy/ci/auto-merge.mjs runs in a scheduled pipeline with no npm ci).

// The files that decide who may do what. A tool built on request never changes them.
export const PROTECTED = [
  /^apps\/server\/src\/guard\.mjs$/,
  /^apps\/server\/src\/review\.mjs$/,
  /^apps\/server\/src\/tool-builder\.mjs$/,
  /^apps\/server\/src\/protected-paths\.mjs$/,
  /^apps\/server\/src\/prompt\.mjs$/,
  /^apps\/server\/src\/auth\.mjs$/,
  /^apps\/server\/src\/peer-auth\.mjs$/,
  /^apps\/server\/src\/redact\.mjs$/,
  /^apps\/server\/src\/sim\.mjs$/,
  /^apps\/server\/src\/agents\/profiles\.mjs$/,
  /^apps\/server\/src\/providers\/file-scope\.mjs$/,
  /^apps\/server\/src\/providers\/host-spawn\.mjs$/,
  /^apps\/broker\/src\/(vault|secretbox|server)\.mjs$/,
  /^deploy\//,
  /^Dockerfile/,
  /^\.gitlab-ci/,
];
// The quota lists: a new tool name may be added, nothing removed or widened.
const ADD_ONLY = /^apps\/server\/src\/agents\/registry\.mjs$/;

/** Why a diff (gitlab_mr_changes files) may not be merged by an agent, or null. */
export function protectedTouch(files = []) {
  const hit = files.filter((f) => [f.path, f.oldPath].some((p) => p && PROTECTED.some((re) => re.test(p))));
  if (hit.length) return `به فایل‌های مرز دسترسی دست می‌زند: ${hit.map((f) => (f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path)).join("، ")}`;
  for (const f of files) {
    if (!ADD_ONLY.test(f.path || "")) continue;
    if (f.diffOmitted || f.tooLargeForGitlab) return `دیف ${f.path} کامل دیده نشد`;
    if (f.removed > 0 || /^-(?!--)/m.test(f.diff || "")) return `در ${f.path} سطری حذف یا عوض شده (فقط افزودن نام ابزار مجاز است)`;
  }
  return null;
}
