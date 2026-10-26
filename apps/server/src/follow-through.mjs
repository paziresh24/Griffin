// A turn that ends on a promise with nothing left to wake it: «بعد از سبز شدن CI ایمیج را می‌سازم»
// and no background task, no subtask, no open question — nobody comes back, and the chat reads
// «تمام شد» while the work is half done (2026-10-20, chat «دیزاین ماژولار»: «نصب شد؟» again and
// again). The OpenAI-compatible engine catches this inside its loop (providers/openai.mjs); the
// runner catches it for every other engine, once per message of the owner.

import { promisesWork } from "./providers/openai.mjs";

// «بعد از … می‌سازم», «وقتی … تمام شد … می‌زنم», «منتظر … هستم»: the next step is promised for later.
const AFTER_PROMISE = /(?:بعد از|پس از|وقتی|همین که|به محض|تا)\s[^.!؟?\n]{0,140}\sمی[‌\s]?[^\s.!،؟?]{2,}(?:م|یم)(?=[\s.!،؟?]|$)/u;
const WAITING_ON = /منتظر\s[^.!؟?\n]{0,100}(?:هستم|می[‌\s]?مانم|می[‌\s]?مونم)(?=[\s.!،]|$)/u;
const ONCE_EN = /\b(?:once|when|after)\b[^.!?\n]{0,120}\bI(?:'ll| will)\b/i;
// Handing the polling to the owner («چند دقیقه بعد بپرسید»): he is the one who would come back.
const ASK_LATER = /(?:بعد(?:اً|ا)?|چند دقیقه(?:\s(?:دیگر|بعد))?|کمی بعد)[^.!؟?\n]{0,60}(?:بپرسید|بپرس|سر بزنید|چک کنید)/u;

/** True when the turn's closing text leaves its own work for a later turn nobody will start. */
export function leavesWorkOpen(text) {
  const clean = String(text || "").trim();
  if (!clean) return false;
  if (promisesWork(clean)) return true;
  const tail = clean.slice(-500);
  if (ASK_LATER.test(tail)) return true;
  const last = clean.split(/(?<=[.!؟?\n])\s+/u).filter(Boolean).slice(-3).join(" ").slice(-400);
  // An offer or a decision left to him («اگر بخواهید …», «بگویید …», «با تأیید شما») is fine.
  if (/[؟?]\s*$/.test(last) || /(^|\s)(اگر|اگه|در صورت|if you|بگویید|بگید|با شماست|تأیید|تایید)(\s|$)/i.test(last)) return false;
  return AFTER_PROMISE.test(last) || WAITING_ON.test(last) || ONCE_EN.test(last);
}

export const FOLLOW_THROUGH_NUDGE =
  "[تذکر سیستمی — این پیام را سیستم فرستاده، نه Owner] نوبت قبلت با قول کاری تمام شد که هنوز انجام نشده، و هیچ چیز بیدارت نمی‌کند: نه کار پس‌زمینه‌ای در جریان است، نه زیرکاری، نه سؤالی. " +
  "کار را خودت به سرانجام برسان: اگر همین حالا شدنی است انجامش بده. اگر منتظر چیزی هستی (CI، ساخت ایمیج، نصب، پاسخ یک سرویس)، یک کار پس‌زمینه بگذار که تا تمام شدن آن صبر کند و بعد خودش تمام شود " +
  "(مثلاً Bash با run_in_background و یک حلقهٔ until که وضعیت را هر چند ثانیه می‌خواند، با سقف زمان)؛ با تمام شدنش دوباره بیدار می‌شوی و ادامه می‌دهی. از Owner نخواه که بعداً بپرسد. " +
  "اگر واقعاً مانعی هست که فقط Owner برمی‌دارد، همان را دقیق بگو.";
