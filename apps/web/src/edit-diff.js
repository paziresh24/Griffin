// The diff a file tool shows (diff §7.2), from Karsara (its Tool.jsx buildEditDiff): Claude Code's Edit,
// MultiEdit and Write carry the text itself in their arguments, so the card shows the change, not raw JSON.

// Edit: old_string → new_string as a line diff; MultiEdit: its edits one after another; Write: every
// line of the new content added.
export function buildEditDiff(args = {}) {
  if (Array.isArray(args.edits) && args.edits.length) {
    return args.edits.map((e) => editLines(e.old_string, e.new_string)).join("\n");
  }
  if (typeof args.old_string === "string" || typeof args.new_string === "string") {
    return editLines(args.old_string, args.new_string);
  }
  if (typeof args.content === "string") {
    return args.content.split("\n").map((line) => `+${line}`).join("\n");
  }
  return "";
}

// A line diff (longest common subsequence): unchanged lines stay as " " context, only what
// changed is -/+. Very large edits (over ~250k line pairs) fall back to old-then-new listing.
function editLines(oldStr = "", newStr = "") {
  const a = String(oldStr || "").split("\n");
  const b = String(newStr || "").split("\n");
  if (a.length * b.length > 250_000) {
    return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)].join("\n");
  }
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`-${a[i]}`);
      i += 1;
    } else {
      out.push(`+${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join("\n");
}

