import { t } from "./i18n.js";

// A message the server wrote into a chat for the agent («[گزارش خودکار زیرکارها … — این پیام را سیستم
// فرستاده، نه Owner]», network.mjs, peers.mjs, runner.mjs, tool-builder.mjs, verify.mjs,
// follow-through.mjs, colleague-access.mjs). Its bubble is not the owner's words: a card with a plain
// title, the status, what came back — and the lines that only tell the agent what to do next folded
// behind «متن کامل» (owner 2026-11-05: «دیزاین خوبی ندارن و قابل فهم نیستن»).

const HEAD = /^\s*\[([^\]\n]*)\]\s*/;
const SYSTEM = /سیستم فرستاده|^ادامه پس از ری‌استارت سرور$/; // i18n-ignore
const SIGNED = /[\s؛،—]*(?:این پیام وقتی[^؛]*؛\s*)?این پیام را سیستم فرستاده(?:، نه Owner)?\s*$/; // i18n-ignore
const QUEUED = /این پیام وقتی آن ایجنت در دسترس نبود/; // i18n-ignore

// What only the agent acts on (the server's own sentences, to the end of their line or message).
const AGENT_ONLY = [
  /\n*این نتیجه(?:‌ها)? را برای کسی که کار را خواسته جمع‌بندی کن[\s\S]*$/, // i18n-ignore
  /\n*اگر کار هنوز لازم است، دوباره با network_ask[\s\S]*$/, // i18n-ignore
  /\.?\s*اگر هنوز لازم است، با network_reply[^\n]*/, // i18n-ignore
  /\n*جواب را با network_reply[^\n]*/, // i18n-ignore
  / — نتیجه‌شان خودکار می‌رسد؛ منتظر نمان\./, // i18n-ignore
  /\n*(?:اگر هنوز لازم است، اول ببین|هر کدام که هنوز لازم است را)[^\n]*/, // i18n-ignore
  /\n*به کسی که کار را گزارش کردی یک خط اصلاح بفرست[^\n]*/, // i18n-ignore
  /\n*گفتگوی ساخت: [\s\S]*$/, // i18n-ignore
];
// Notes that are only an instruction to the agent: the title says all the owner needs.
const QUIET = /^(?:تذکر سیستمی|ابزار «.*» حالا|دسترسی کامل|شل برگشت)/; // i18n-ignore

export function statusLabel(status) {
  switch (String(status || "").toLowerCase()) {
    case "completed":
    case "finished":
      return t("انجام شد");
    case "failed":
    case "error":
      return t("ناموفق");
    case "canceled":
    case "cancelled":
    case "stopped":
      return t("متوقف شد");
    case "rejected":
      return t("رد شد");
    case "submitted":
    case "working":
    case "running":
      return t("در کار");
    case "input-required":
      return t("سؤال دارد");
    case "auth-required":
      return t("منتظر تأیید");
    default:
      return status || "";
  }
}

export const statusTone = (status) =>
  /^(completed|finished)$/i.test(status) ? "ok" : /^(failed|error|rejected)$/i.test(status) ? "bad" : status ? "wait" : "";

/** null, or { kind, title, status, reason, queued, sections, still, text, chatId, folded, raw }. */
export function systemNote(message) {
  const raw = String(message ?? "");
  const head = HEAD.exec(raw);
  if (!head || !SYSTEM.test(head[1])) return null;
  const header = head[1];
  const full = raw.slice(head[0].length);
  let body = full;
  for (const pattern of AGENT_ONLY) body = body.replace(pattern, "");
  const tool = /گفتگوی ساخت: ([\w-]+)/.exec(full); // i18n-ignore
  const note = { kind: "note", title: header.replace(SIGNED, "").trim(), status: "", reason: "", queued: QUEUED.test(header), sections: [], still: "", text: "", chatId: tool?.[1] || "", raw };

  const network = /پاسخ «(.+)»(?: به درخواست taskId \S+)?/.exec(note.title); // i18n-ignore
  if (network && /شبکهٔ ایجنت‌ها/.test(note.title)) { // i18n-ignore
    note.kind = "network";
    note.title = t("پاسخ ایجنت «{who}»", { who: network[1] });
    const state = /^وضعیت: (\S+)(?: \(([^)\n]*)\))?\s*/.exec(body); // i18n-ignore
    const asked = /^آن ایجنت سؤالی پرسیده: /.exec(body); // i18n-ignore
    if (state) [note.status, note.reason, body] = [state[1], state[2] || "", body.slice(state[0].length)];
    else if (asked) [note.status, body] = ["input-required", body.slice(asked[0].length)];
  } else if (/^گزارش خودکار زیرکارها$/.test(note.title)) { // i18n-ignore
    note.kind = "subtasks";
    note.title = t("نتیجهٔ زیرکارها");
    const still = /^هنوز در کار: (.*)$/m.exec(body); // i18n-ignore
    if (still) {
      note.still = still[1].replace(/ \([\w-]+\)/g, "");
      body = body.replace(still[0], "");
    }
    note.sections = body.split(/^### /m).slice(1).map((part) => {
      const [first, ...rest] = part.split("\n");
      const m = /^(.+?) — (\S+) \(subtask ([^)\s]+)\)\s*$/.exec(first);
      return {
        label: m ? m[1] : first.trim(),
        status: m ? m[2] : "",
        chatId: m ? m[3] : "",
        text: rest.filter((line) => !/^ابزارهای اجراشده: /.test(line)).join("\n").trim(), // i18n-ignore
      };
    });
    body = "";
  } else if (/^گزارش خودکار ساخت ابزار /.test(note.title)) { // i18n-ignore
    note.kind = "tool";
    note.title = note.title.replace(/^گزارش خودکار /, ""); // i18n-ignore
  } else if (QUIET.test(note.title) || (/^ادامه پس از ری‌استارت/.test(note.title) && !/^این (?:کارهای پس‌زمینه|بیدارباش‌های)/.test(body))) { // i18n-ignore
    body = "";
  }
  // A lost background task is usually a shell command: as code, left to right, not a Persian line.
  note.text = body.replace(/^- «([^\n]*)»$/gm, (line, task) => (/[؀-ۿ]/.test(task) ? line : `- \`${task}\``)).trim(); // i18n-ignore
  // Folded: the card leaves out something the agent was told; «متن کامل» shows it as sent.
  note.folded = note.kind === "subtasks" || note.text !== full.trim();
  return note;
}
