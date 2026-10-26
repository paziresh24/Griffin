// The MR board's words and order, kept apart from React so they are tested on their own (board.jsx
// draws what this returns). The rows come from server.mjs (categorize.mjs put each on a shelf).

const fa = (n) => Number(n).toLocaleString("fa-IR");

// The shelves the board shows for open MRs, in the order the eye should go: what needs a hand first,
// then what can be merged, then what is only waiting.
export const SHELVES = [
  { key: "attention", label: "نیاز به رسیدگی", tone: "bad", hint: "پایپ‌لاین قرمز، تداخل یا عقب‌ماندن از شاخهٔ مقصد" },
  { key: "ready", label: "آمادهٔ مرج", tone: "ok", hint: "مانعی ندارد؛ فقط تصمیم مرج مانده" },
  { key: "running", label: "در حال بررسی", tone: "info", hint: "پایپ‌لاین هنوز تمام نشده" },
  { key: "waiting", label: "منتظر بازبینی", tone: "warn", hint: "تأیید یا بحثی مانده" },
  { key: "draft", label: "پیش‌نویس", tone: "muted", hint: "نویسنده هنوز تمامش نکرده" },
  { key: "merged", label: "مرج‌شده", tone: "muted", hint: "" },
  { key: "closed", label: "بسته‌شده", tone: "muted", hint: "" },
];
const KNOWN = new Set(SHELVES.map((s) => s.key));

export const STATES = [
  { value: "opened", label: "باز" },
  { value: "merged", label: "مرج‌شده" },
  { value: "closed", label: "بسته‌شده" },
];

/** A project path's short name (the last part), the full path stays in the tooltip. */
export const projectName = (path) => String(path || "").split("/").filter(Boolean).pop() || "";

/** The pipeline as one small sign: { tone, text } or null when the MR has none (status = GitLab's). */
export function pipelineSign(status, label = "") {
  if (!status) return null;
  const tone = status === "success" ? "ok" : ["failed", "canceled", "cancelled"].includes(status) ? "bad" : ["running", "pending", "created", "preparing", "waiting_for_resource", "scheduled"].includes(status) ? "info" : "muted";
  return { tone, text: label || status };
}

const list = (value) => (Array.isArray(value) ? value : String(value || "").split("،")).map((s) => String(s).trim()).filter(Boolean);

// A conventional-commit title («feat(scope): …») says what kind of change it is; the board says that
// in words and keeps the rest as the title.
const KINDS = { feat: "قابلیت تازه", fix: "رفع اشکال", perf: "سرعت", refactor: "بازنویسی", docs: "متن راهنما", chore: "نگهداری", ci: "CI", test: "تست", build: "ساخت", style: "ظاهر", revert: "برگرداندن" };

/** «Draft: feat(ui)!: x» -> { kind: "قابلیت تازه", scope: "ui", text: "x" }; a plain title stays as it is. */
export function splitTitle(title) {
  const clean = String(title || "").replace(/^\s*(Draft|WIP)\s*:\s*/i, "").replace(/^\[(Draft|WIP)\]\s*/i, "").trim();
  const m = /^([a-z]+)(?:\(([^)]{1,60})\))?!?:\s*(.+)$/i.exec(clean);
  if (!m || !KINDS[m[1].toLowerCase()]) return { kind: "", scope: "", text: clean };
  return { kind: KINDS[m[1].toLowerCase()], scope: m[2] || "", text: m[3] };
}

/** What one card says, in the order it says it. */
export function card(row) {
  const shelf = KNOWN.has(row?.category) ? row.category : "waiting";
  const facts = [];
  const files = Number(row?.changesCount);
  if (Number.isFinite(files) && files > 0) facts.push(`${fa(files)} فایل`);
  if (row?.comments > 0) facts.push(`${fa(row.comments)} نظر`);
  const reviewers = list(row?.reviewers);
  if (reviewers.length) facts.push(`بازبین: ${reviewers.join("، ")}`);
  const t = splitTitle(row?.title);
  return {
    id: row.id,
    kind: t.kind,
    scope: t.scope,
    shelf,
    tone: SHELVES.find((s) => s.key === shelf).tone,
    title: t.text,
    ref: `!${row.iid}`,
    project: projectName(row.project),
    projectPath: row.project || "",
    author: row.author || "",
    when: row.updatedAt || row.createdAt || null,
    reason: row.reason || "",
    pipeline: pipelineSign(row.pipelineStatus, row.pipeline),
    from: row.sourceBranch || "",
    to: row.targetBranch || "",
    facts,
    labels: list(row.labels),
    url: row.webUrl || "",
  };
}

/** Every word of the search must be in the card (title, number, author, project, branch, label). */
export function matches(c, text) {
  const words = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [c.title, c.kind, c.scope, c.ref, c.author, c.projectPath, c.from, c.to, c.reason, ...c.labels].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The people who wrote these MRs, most MRs first, for the author chips. */
export function authors(cards) {
  const count = new Map();
  for (const c of cards) if (c.author) count.set(c.author, (count.get(c.author) || 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n }));
}

/**
 * The board: cards filtered by search, author and shelf, put on their shelves in SHELVES order.
 * `counts` is per shelf before the shelf filter (so the tiles keep their numbers when one is picked).
 */
export function board(rows, { search = "", author = "", shelf = "" } = {}) {
  const all = (rows || []).map(card);
  const pool = all.filter((c) => matches(c, search) && (!author || c.author === author));
  const counts = Object.fromEntries(SHELVES.map((s) => [s.key, pool.filter((c) => c.shelf === s.key).length]));
  const shown = SHELVES.map((s) => ({ ...s, cards: pool.filter((c) => c.shelf === s.key && (!shelf || s.key === shelf)) })).filter((s) => s.cards.length);
  return { shelves: shown, counts, total: pool.length, all: all.length, authors: authors(all) };
}

/** One line on top: what in this list wants the owner, in words. */
export function headline(counts, total) {
  if (!total) return "";
  const parts = [];
  if (counts.attention) parts.push(`${fa(counts.attention)} مورد به رسیدگی نیاز دارد`);
  if (counts.ready) parts.push(`${fa(counts.ready)} مورد آمادهٔ مرج است`);
  if (!parts.length) return `${fa(total)} MR؛ چیزی منتظر شما نیست.`;
  return `${parts.join(" و ")}.`;
}
