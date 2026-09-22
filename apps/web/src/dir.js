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

export function isRtlText(value) {
  return textDir(value) === "rtl";
}
