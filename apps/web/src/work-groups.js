// «روایت بین مراحل» (flag workInline, like Claude Desktop): a run's work log is cut at the agent's own
// narration. Narration stays on the page as text; the thinking and tool calls between two narrations
// fold into one group with a plain one-line label («۳ دستور اجرا شد»).
import { num, t } from "./i18n.js";

const SHELL = new Set(["debug_exec", "ssh_exec", "kube_exec", "mikrotik_exec", "Bash"]);

/** [{ kind: "text", part } | { kind: "steps", parts: [...] }], in the run's order; blank narration dropped. */
export function groupWork(parts) {
  const out = [];
  for (const part of parts || []) {
    if (!part) continue;
    if (part.type === "text") {
      if (String(part.text || "").trim()) out.push({ kind: "text", part });
      continue;
    }
    const last = out.at(-1);
    if (last?.kind === "steps") last.parts.push(part);
    else out.push({ kind: "steps", parts: [part] });
  }
  return out;
}

/** The label of a folded group: one tool says what it did; several shell calls are counted; a mix names the first. */
export function groupLabel(parts, lineOf = () => null) {
  const tools = (parts || []).filter((p) => p?.type === "tool");
  if (!tools.length) return t("فکر کردن");
  const first = lineOf(tools[0].name, tools[0].args) || tools[0].name;
  if (tools.length === 1) return first;
  if (tools.every((tool) => SHELL.has(tool.name))) return t("{n} دستور اجرا شد", { n: num(tools.length) });
  return t("{first} و {n} مورد دیگر", { first, n: num(tools.length - 1) });
}

/** The line of a group still running: the newest tool's own line (or that it is thinking). */
export function groupNow(parts, lineOf = () => null) {
  const last = (parts || []).at(-1);
  if (!last) return t("در حال کار");
  if (last.type === "reasoning") return t("در حال فکر کردن…");
  return lineOf(last.name, last.args) || t("در حال اجرای یک ابزار…");
}
