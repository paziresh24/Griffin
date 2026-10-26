// Block direction (owner 2026-10-25: «انگلیسی فورس چپ‌چین، فارسی فورس راست‌چین»): a Persian sentence
// full of English names (GitLab, pod, namespace) stays RTL; an English sentence that only quotes a
// Persian word («روایت», "سلام", `code`) is LTR. Quoted, code and URL spans don't vote; then a block
// is RTL when at least one word in five is Persian. Nothing left to vote: any Persian → RTL.

const RTL = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const LTR = /[A-Za-z]/;
const RTL_WORD = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g;
const LTR_WORD = /[A-Za-z]+/g;
const NOT_VOTING = /```[\s\S]*?(```|$)|`[^`\n]*`|«[^»\n]*»|"[^"\n]*"|“[^”\n]*”|\bhttps?:\/\/\S+|\]\([^)\s]*\)/g;

export function textDir(value) {
  const text = String(value || "");
  const voting = text.replace(NOT_VOTING, " ");
  const rtl = (voting.match(RTL_WORD) || []).length;
  const ltr = (voting.match(LTR_WORD) || []).length;
  if (rtl || ltr) return rtl && rtl * 4 >= ltr ? "rtl" : "ltr";
  if (RTL.test(text)) return "rtl";
  if (LTR.test(text)) return "ltr";
  return "auto";
}

// A tool row's short target (Karsara skin): paths, commands, URLs and patterns stay LTR monospace;
// text that opens with a Persian letter (AskUserQuestion's question) reads right to left, in the text
// face. The first strong letter decides, so «/docs/<Persian name>.md» stays a path.
const FIRST_STRONG = /[A-Za-z\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
export function targetLook(value) {
  const first = String(value || "").match(FIRST_STRONG)?.[0] || "";
  return RTL.test(first) ? { dir: "rtl", className: "min-w-0 truncate text-xs" } : { dir: "ltr", className: "ltr min-w-0 truncate font-mono text-xs" };
}

export function isRtlText(value) {
  return textDir(value) === "rtl";
}
