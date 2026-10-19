// Block direction: any Persian/Arabic (or Hebrew) script forces RTL, even if the line
// opens with Latin (GitLab, paths, English words). Pure Latin stays LTR.

const RTL = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const LTR = /[A-Za-z]/;

export function textDir(value) {
  const text = String(value || "");
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
