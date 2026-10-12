// "Why?" rows: the server's steps (GET /api/chats/:id/runs/:runId/why) as a handful
// of plain lines. A stretch of tools that went fine is one line ("7 tools"), opened to see each; a
// tool that failed, a review or guard decision, a note, a message sent mid-run, or an unusual end
// stands on its own.

import { num as fa, t } from "./i18n.js";

const SEP = t("، ");

const firstLine = (text, max = 90) => {
  const line = String(text || "").split("\n").find((l) => l.trim()) || "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

// Wall time of a stretch of tools: from the first one's start to the last one's end (they can run
// in parallel, so the sum of their durations would overstate it).
function span(items) {
  const end = Date.parse(items.at(-1).at);
  const start = Date.parse(items[0].at) - (items[0].durationMs || 0);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, end - start);
}

function toolsSummary(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.name, (counts.get(item.name) || 0) + (item.count || 1));
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${fa(n)}` : name)).join(SEP);
}

export const DECISIONS = {
  reviewed: t("دو بازبین تأیید کردند"),
  "review-rejected": t("بازبین‌ها رد کردند"),
  "review-overridden": t("بازبین‌ها رد کردند و شما گفتید انجام شود"),
  "review-upheld": t("بازبین‌ها رد کردند و شما هم نخواستید"),
  approved: t("شما تأیید کردید"),
  denied: t("شما رد کردید"),
  blocked: t("گارد جلویش را گرفت"),
  refused: t("گارد رد کرد (کسی برای تأیید نبود)"),
  throttled: t("به سقف تکرار خورد"),
  vetoed: t("قبلاً رد شده بود"),
  blessed: t("قبلاً تأیید شده بود"),
  trusted: t("در محدودهٔ مورد اعتماد بود"),
  "peer-card": t("روش کار به همکار داده شد"),
};

const PHASES = { stale: t("بی‌خبر ماند و لغو شد"), verified: t("راستی‌آزمایی: همان ماند"), "verify-mismatch": t("راستی‌آزمایی: نمی‌خواند") };

export function whyRows(steps) {
  const rows = [];
  let tools = null;
  const flush = () => {
    if (!tools) return;
    const total = tools.reduce((sum, item) => sum + (item.count || 1), 0);
    rows.push({ kind: "tools", label: total > 1 ? t("{n} ابزار اجرا شد", { n: fa(total) }) : t("{name} اجرا شد", { name: tools[0].name }), detail: total > 1 ? toolsSummary(tools) : "", durationMs: span(tools), items: tools });
    tools = null;
  };
  for (const step of steps || []) {
    if (step.kind === "tool" && step.status === "success") {
      (tools ||= []).push(step);
      continue;
    }
    flush();
    if (step.kind === "tool") {
      rows.push({ kind: "tool", tone: "bad", label: step.status === "cancelled" ? t("{name} متوقف شد", { name: step.name }) : t("{name} خطا داد", { name: step.name }), text: step.error || "", durationMs: step.durationMs ?? null });
    } else if (step.kind === "decision") {
      rows.push({ kind: "decision", tone: step.bad ? "bad" : null, label: `${step.tool}: ${DECISIONS[step.decision] || step.decision}`, text: step.text || "" });
    } else if (step.kind === "note") {
      rows.push({ kind: "note", label: firstLine(step.text), text: step.text || "" });
    } else if (step.kind === "message") {
      rows.push({ kind: "message", label: t("پیام شما وسط کار رسید"), text: step.text || "" });
    } else if (step.kind === "phase") {
      rows.push({ kind: "phase", tone: step.phase === "verified" ? null : "bad", label: PHASES[step.phase] || step.phase, text: step.text || "" });
    } else if (step.kind === "end" && step.status !== "finished") {
      rows.push({ kind: "end", tone: "bad", label: step.status === "cancelled" ? t("متوقف شد") : t("با خطا تمام شد"), text: step.error || "" });
    }
  }
  flush();
  return rows;
}

/** One line per manifest change since the session before. */
export function changeLabel(change) {
  const names = change.names?.length ? ` (${change.names.slice(0, 6).join(SEP)}${change.names.length > 6 ? `${SEP}…` : ""})` : "";
  switch (change.kind) {
    case "engine":
      return { provider: t("موتور عوض شد"), model: t("مدل عوض شد"), effort: t("میزان فکر عوض شد") }[change.key] || t("موتور عوض شد");
    case "tools":
      return `${change.change === "added" ? t("ابزار اضافه شد") : t("ابزار برداشته شد")}${names}`;
    case "knowledge":
      return `${change.change === "added" ? t("یادداشت دانش اضافه شد") : t("یادداشت دانش برداشته شد")}${names}`;
    case "rules":
      return t("قاعده‌ها عوض شدند");
    case "agent":
      return t("ایجنت عوض شد");
    case "caller":
      return t("درخواست‌کننده عوض شد");
    case "repo":
      return t("ریپو عوض شد");
    case "mode":
      return t("حالت (ایجنت/برنامه‌ریزی) عوض شد");
    case "guards":
      return t("گاردها عوض شدند");
    default:
      return change.kind;
  }
}
