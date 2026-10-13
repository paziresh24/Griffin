// Persian names for the Telegram page: every name there reads in Persian.
// Every Telegram person whose name has no Persian letter gets one: one tool-less completion per
// batch writes them all, and only an answer that is a clean Persian name is kept. The owner's own
// edits (updatePerson) are never overwritten: only rows with fa_name still empty are filled.
// ponytail: a name is made once, so a colleague who renames himself in Telegram keeps the old Persian
// name until the owner clears it; add a source-name column if that matters.
import { nameOf } from "../profile.mjs";
import { syncMotherNames } from "./mother.mjs";

const PERSIAN = /[؀-ۿ]/;
const NUMERIC = /^-?\d+$/;

function promptOf(rows, hints) {
  const lines = [
    "Write each Telegram name below in Persian script, the way an Iranian colleague would write it.",
    "- People: their real name in natural Persian spelling (Kaveh Nouri → کاوه نوری, Leila Ahmadi → لیلا احمدی); translate extra words (Infra → زیرساخت).",
    "- Groups and channels: a natural Persian title (Build Alerts → هشدارهای بیلد, Backend Team → تیم بک‌اند).",
    "- No آقای/خانم, no emoji, no quotes.",
  ];
  const known = Object.entries(hints || {});
  if (known.length) {
    lines.push("", "The owner's own spellings (hints only):");
    for (const [key, value] of known) lines.push(`${key} = ${value}`);
  }
  lines.push("", "id | Telegram name | username | kind");
  for (const r of rows) lines.push(`${r.id} | ${r.display_name} | ${r.username ? `@${r.username}` : "-"} | ${String(r.external_id).startsWith("-") ? "گروه" : "شخص"}`);
  lines.push("", 'Answer ONLY with JSON {"<id>": "<Persian name>"}.');
  return lines.join("\n");
}

function parse(answer) {
  const text = String(answer || "");
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  try {
    const value = JSON.parse(text.slice(from, to + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Fills persons.fa_name for Telegram persons without a Persian name (only `ids`, when given: the
 *  one the owner just handed back to automatic). Returns how many were filled. */
export async function fillPersianNames({ store, generate, log = console, batch = 40, ids = null }) {
  const only = ids ? new Set(ids) : null;
  const rows = store.db
    .prepare("SELECT id, display_name, username, external_id FROM persons WHERE source = 'telegram' AND fa_name IS NULL")
    .all()
    .filter((r) => (!only || only.has(r.id)) && !PERSIAN.test(String(r.display_name || "")) && !NUMERIC.test(String(r.display_name || "").trim()));
  const hints = store.getKv("owner-names") || {};
  const write = store.db.prepare("UPDATE persons SET fa_name = ? WHERE id = ? AND fa_name IS NULL");
  let filled = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch);
    const ids = new Set(part.map((r) => r.id));
    let answer;
    try {
      answer = await generate(promptOf(part, hints));
    } catch (e) {
      log.error?.(`[fa-names] ${e.message}`);
      continue;
    }
    const names = parse(answer);
    if (!names) {
      log.info?.(`[fa-names] no JSON in the answer (${part.length} names left as they are)`);
      continue;
    }
    for (const [id, value] of Object.entries(names)) {
      const name = nameOf(value);
      if (!ids.has(id) || !name || !PERSIAN.test(name)) continue;
      filled += write.run(name, id).changes;
    }
  }
  if (filled) syncMotherNames(store);
  return filled;
}
