import { ASK_TOOL } from "./asks.mjs";
import { maskText, redactArgs } from "./redact.mjs";

// Code-level gate for irreversible tool calls. Applies to every run whose chain is not rooted
// in the owner (teammate coverage, scheduler, ops room, and — later — external peers): the
// call only executes after an explicit "yes" from the owner, bound to that one call and
// recorded in `approvals`. Unwatched roots (scheduler/ops) have nobody to answer, so asks
// auto-rejects and the call is refused. Owner-rooted runs are not gated (the owner is the
// principal and asked for no confirmations).

const DESTRUCTIVE_SQL =
  /\b(drop\s+(database|schema|table|view|role|user|function|index)|truncate\s|delete\s+from\s+\S+\s*;?\s*$|alter\s+table\s+\S+\s+drop|grant\s+|revoke\s+)/i;

// Only catastrophic shell — normal diagnostics (df, journalctl, kubectl get, …) stay free.
const DESTRUCTIVE_SHELL =
  /\b(rm\s+(-[a-zA-Z]*\s+)*\/(\s|$)|mkfs(\.|$)|wipefs|dd\s+.*\bof=\/dev\/|shutdown\b|reboot\b|poweroff\b|init\s+[06]\b|>\s*\/dev\/sd)/i;

export function isDestructiveSql(sql) {
  return DESTRUCTIVE_SQL.test(String(sql || ""));
}

export function isDestructiveShell(command) {
  return DESTRUCTIVE_SHELL.test(String(command || ""));
}

// Changes to shared infrastructure that cannot be taken back by the agent itself.
const NEEDS_APPROVAL = new Map([
  ["mikrotik_forward_add", "باز کردن پورت روی روتر"],
  ["mikrotik_address_list_add", "تغییر address-list روتر"],
  ["mikrotik_set_enabled", "روشن/خاموش کردن قاعدهٔ روتر"],
  ["mikrotik_remove", "حذف قاعدهٔ روتر"],
  ["infisical_upsert", "نوشتن/بازنویسی secret در Infisical"],
  ["kube_copy_secret", "کپی secret بین کلاسترها"],
  ["cnpg_retry_bootstrap", "حذف Jobهای bootstrap دیتابیس"],
  ["arvan_dns_create", "ساخت رکورد DNS آروان"],
  ["arvan_dns_delete", "حذف رکورد DNS آروان"],
  ["vcenter_vm_create", "ساخت ماشین مجازی روی vCenter"],
  ["nsin_dns_create", "ساخت رکورد DNS انسین"],
  ["nsin_dns_update", "تغییر رکورد DNS انسین"],
  ["nsin_dns_delete", "حذف رکورد DNS انسین"],
  ["nsin_rule_toggle", "روشن/خاموش کردن قاعدهٔ لبهٔ انسین"],
  ["nsin_developer_mode", "تغییر developer mode انسین"],
  ["nsin_ssl_issue", "صدور گواهی انسین"],
  ["jobs_delete", "حذف جاب"],
]);

// -> null (free) | { block: reason } | { approve: reason }
export function classify(name, args = {}) {
  if (name === "pg_query") {
    if (isDestructiveSql(args?.sql)) return { block: "SQL مخرب (DROP/TRUNCATE/DELETE بدون شرط/GRANT …) اجازه ندارد" };
    return args?.write ? { approve: "اجرای SQL نوشتنی" } : null;
  }
  if (name === "debug_exec") {
    return isDestructiveShell(args?.command || args?.cmd) ? { block: "دستور مخرب (rm ریشه، mkfs، reboot …) اجازه ندارد" } : null;
  }
  if (name === "gitlab_mr") return args?.action === "merge" ? { approve: "merge کردن MR" } : null;
  if (name === "arvan_cache_purge") {
    // A full-cache purge sends the whole domain's traffic to the origin cold — on this platform
    // that killed the site for hours (owner, 2026-09-28). The approval question carries the
    // warning so the owner decides with the consequence in front of them.
    if (args?.scope === "all") return { approve: `پاک‌کردن «کل کش» دامنهٔ ${args?.domain || ""}`.trim() + " — سایت تا چند ساعت زیر بار سردِ اورجین ممکن است از دست برود" };
    return null;
  }
  if (name === "mikrotik_exec") {
    // A RouterOS console line: reading is free, anything that writes to a production router is
    // the owner's call.
    const command = String(args?.command || "");
    return routerReadOnly(command) ? null : { approve: `دستور روی روتر ${args?.router || ""}`.trim() };
  }
  const reason = NEEDS_APPROVAL.get(name);
  return reason ? { approve: reason } : null;
}

// Every line of the console command only reads. A GET-only /tool fetch that keeps nothing on the
// router's disk is a read too — asking the owner to approve a health check (2026-09-23, five
// times in an hour) is exactly the noise that buries the questions that matter.
export function routerReadOnly(command) {
  const lines = String(command || "").split(/[;\n]/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  return lines.every((line) => {
    if (/\b(add|set|remove|enable|disable|unset|move|reset|reboot|shutdown|import|run|upgrade)\b/i.test(line)) return false;
    if (/\bfile\s*=/i.test(line)) return false; // print/export file=… writes to the router's disk
    if (/\/tool\s*\/?\s*fetch\b/i.test(line)) {
      return (
        !/\b(dst-path|upload)\s*=/i.test(line) &&
        !/http-method\s*=\s*(post|put|patch|delete)/i.test(line) &&
        /(keep-result\s*=\s*no|as-value|output\s*=\s*(user|none))/i.test(line)
      );
    }
    // `:put` only echoes; write verbs were already refused above. `[/ip/route/find]` ends in `]`.
    if (/^:put\b/i.test(line)) return true;
    return /(^|\s|\/)(print|get|monitor|export|find|ping|traceroute)(\s|$|\])/i.test(line);
  });
}

// Persian answers make ASCII \b useless (word chars are [A-Za-z0-9_] only), so word ends are
// expressed with a Unicode lookahead: "بله، بساز" is a yes, "بساز ولی جدا" too, "none" is not a no.
const YES_RE = /^(بله|آره|باشه|برو|بزن|انجام|تأیید|تایید|yes|y|ok|۱|1)(?![\p{L}\p{N}])/iu;
const NO_RE = /^(نه|خیر|نرو|نکن|انصراف|cancel|no|n)(?![\p{L}\p{N}])/iu;
// Negations the owner slips mid-sentence («مرج نکن», «فعلاً لازم نیست») — an anchored ^ can't see these.
// توقف also matches متوقف (substring); متوفقف is the owner's live typo of متوقف (2026-09-29: the answer
// «متوفقف شو» to an approval card meant STOP, and anything-not-a-no would have counted it as consent).
const NEG_ANYWHERE = /نکن|نزن|نشه|نمی ?خوام|نمی ?خواهم|بی ?خیال|لازم نیست|رد شود|نخواستم|توقف|متوفقف|بس کن|ولش کن|کافیه/i;

// Consent on a yes/no card in the owner's own words: anything that is not a no counts — owners
// answer «مرج کن», «تأیید — مرج شود», «دوباره تأیید می‌کنم» and none of those matched the literal
// yes-list (2026-09-29: one merge approval was therefore re-asked seven times). An answer that is
// itself a question blesses nothing.
function consentOf(conf) {
  if (typeof conf === "string") conf = { answered: true, answer: conf };
  // Only a real answer can consent: an unanswered or cancelled question (answered:false) is never
  // a yes, whatever stringifying its payload happens to produce.
  if (!conf || conf.answered !== true) return false;
  const s = String(conf.answer || "").trim();
  const selected = Array.isArray(conf.selected) ? conf.selected : [];
  if (!s && !selected.length) return false;
  if (NO_RE.test(s) || NEG_ANYWHERE.test(s) || selected.some((x) => NO_RE.test(String(x).trim()))) return false;
  if (selected.some((x) => YES_RE.test(String(x).trim()))) return true;
  if (!s) return false;
  return /[؟?]/.test(s) && !YES_RE.test(s) ? false : true;
}

export function isYes(answer) {
  const s = String(answer?.answer || answer || "").trim();
  if (!s) return false;
  if (NO_RE.test(s)) return false;
  if (Array.isArray(answer?.selected) && answer.selected.some((x) => YES_RE.test(String(x).trim()))) return true;
  return YES_RE.test(s);
}

export async function confirmWithOwner(store, asks, chatId, question) {
  const args = { question, options: [{ label: "بله" }, { label: "نه" }] };
  const callId = `guard-${Date.now()}`;
  // The question embeds a detail of the gated call — pg_query write SQL and
  // infisical_upsert values carry credentials, so the mirrored events get the same masking.
  const safeQuestion = maskText(question);
  store?.appendEvent?.(chatId, null, "tool.started", { callId, name: ASK_TOOL, args: { ...args, question: safeQuestion } });
  const conf = await asks.confirm(chatId, { question: safeQuestion });
  store?.appendEvent?.(chatId, null, "tool.done", { callId, name: ASK_TOOL, args: { ...args, question: safeQuestion }, result: conf });
  return conf;
}

// The owner's answer to one gated call holds for the whole chain for a while. Without it the
// agent re-asked the very same command seconds after a "no" (seen 2026-09-23: three identical
// router questions denied within 13 s) and parallel identical calls each sent their own question.
const DECISION_TTL_MS = 6 * 60 * 60 * 1000;
const decisions = new Map(); // `${root}\0${tool}\0${args}` -> { yes, conf, at }
const inflight = new Map(); // same key -> Promise<conf> while the owner is being asked
// A gated call whose question died with its run (stale kill, cancel) was NOT re-askable from
// cache — so every task retry minted the same question again (2026-09-27: "git push بزنم؟" five
// times over three hours, each phrased slightly differently by the model). Remember the ask
// itself: within the window, a repeat is refused with a report-back instruction instead of
// buzzing the owner again.
const UNANSWERED_TTL_MS = 45 * 60 * 1000;
const unanswered = new Map(); // key -> askedAt

// Bridge from a model-level ask_owner to the code-level guard (2026-09-28: an Arvan DNS create
// was approved through ask_owner, then the guard asked the owner the same thing again). When the
// owner answers an approval-style question in a chain, the next guarded call in that chain is
// covered — one use, short window, audited as "blessed". A "no" vetoes the next ask the same way
// instead of buzzing the owner twice for one refusal.
const BLESSING_MS = Math.max(0, Number(process.env.GRIFFIN_GUARD_BLESSING_MS) || 10 * 60 * 1000);
const blessings = new Map(); // rootChatId -> { until, question, answer }
const vetoes = new Map(); // rootChatId -> { until, question }

// Only yes/no-shaped questions bless: several substantive options are a clarification, and an
// unrelated "بله" to one of those must never approve the next guarded call.
function approvalShaped(options) {
  const labels = (Array.isArray(options) ? options : []).map((o) => String(o?.label ?? o ?? "").trim());
  if (!labels.length || labels.length > 3) return false;
  return labels.some((label) => NO_RE.test(label));
}

/** Call when the owner settles an ask in a chat (wired from asks.onSettled). */
export function noteOwnerAnswer(store, chatId, { question = "", answer = "", selected = [], options = null } = {}) {
  if (!BLESSING_MS) return;
  const root = store?.rootChatId?.(chatId) || chatId;
  const text = String(question || "");
  const opts = options === null ? [{ label: "بله" }, { label: "نه" }] : options;
  if (!approvalShaped(opts)) return; // clarification answers never bless or veto
  if (consentOf({ answered: true, answer, selected })) {
    blessings.set(root, { until: Date.now() + BLESSING_MS, question: text.slice(0, 300), answer: String(answer || "") });
    vetoes.delete(root);
  } else {
    vetoes.set(root, { until: Date.now() + BLESSING_MS, question: text.slice(0, 300) });
    blessings.delete(root);
  }
}

// The model rephrases shell commands between retries ("cd /x && git push" → "timeout 60 git -C
// /x push"), and an exact-string cache key treated each phrasing as a brand-new question. Trim
// the wrappers so logically identical commands share one decision.
function normalizeCommand(text) {
  let s = String(text || "");
  s = s.replace(/^\s*timeout\s+[\d.]+\s+/i, "");
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|\S+)\s+)+/, ""); // VAR=x git …
  s = s.replace(/\s+/g, " ").trim();
  const cd = s.match(/^cd\s+(\S+)\s*&&\s*([\s\S]*)$/i);
  if (cd && /^git\b/i.test(cd[2])) s = cd[2].replace(/^git\b/i, `git -C ${cd[1]}`);
  return s;
}

function canonicalArgs(name, args) {
  const src = { ...(args || {}) };
  for (const key of ["command", "cmd", "sql"]) {
    if (typeof src[key] === "string") src[key] = normalizeCommand(src[key]);
  }
  return src;
}

function decisionKey(store, chatId, name, args) {
  const root = store?.rootChatId?.(chatId) || chatId;
  let raw;
  try {
    raw = JSON.stringify(canonicalArgs(name, args));
  } catch {
    raw = String(args);
  }
  return `${root}\u0000${name}\u0000${raw}`;
}

export function forgetDecisions() {
  decisions.clear();
  inflight.clear();
  unanswered.clear();
  blessings.clear();
  vetoes.clear();
}

const WHY = "why";

// Tools whose call can stop for the owner's yes. They get an optional `why` argument: one line,
// for the owner, saying who needs this and for what — the question is otherwise a tool name and
// a JSON blob the owner cannot decide on.
function mayAsk(name, extra) {
  return NEEDS_APPROVAL.has(name) || ["pg_query", "gitlab_mr", "mikrotik_exec"].includes(name) || Boolean(extra?.has(name));
}

function withWhy(schema) {
  if (!schema || schema.type !== "object" || !schema.properties || schema.properties[WHY]) return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      [WHY]: {
        type: "string",
        description:
          "If this call needs the owner's approval, this is the whole question they see: one short plain-Persian line — who needs it, for what, and what changes if they say yes. No JSON, no tool names.",
      },
    },
  };
}

// What the action touches, in a few readable words — never a credential.
function actionDetail(name, args) {
  if (name === "mikrotik_exec") return String(args?.command || "").slice(0, 160);
  if (name === "pg_query") return String(args?.sql || "").replace(/\s+/g, " ").slice(0, 160);
  if (name === "gitlab_mr") return [args?.project, args?.iid && `!${args.iid}`].filter(Boolean).join(" ");
  return Object.entries(args || {})
    .filter(([key, value]) => ["string", "number", "boolean"].includes(typeof value) && !/value|secret|pass|token|key$/i.test(key))
    .map(([key, value]) => `${key}: ${String(value).slice(0, 60)}`)
    .slice(0, 4)
    .join(" · ");
}

export function approvalQuestion(store, chatId, name, args, action, why = "") {
  const root = store?.getChat?.(store?.rootChatId?.(chatId) || chatId);
  const reason = String(why || "").trim() || (root?.title ? `برای: ${root.title}` : "");
  const detail = actionDetail(name, args);
  return [reason, `کار: ${action}${detail ? ` — ${detail}` : ""}`, "بزنم؟"].filter(Boolean).join("\n");
}

function refused(error, detail) {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error, ...(detail ? { detail } : {}) }) }] };
}

// extra: additional tool names that need approval for this caller (e.g. teammate coverage).
// allowPass(name, args): true lets a call through without asking (e.g. replying in the same chat).
// mode "refuse": nobody can approve on this path yet (external peers until a two-party approval
// flow exists) — gated calls are refused and audited instead of asking.
export function guardTools(tools, { chatId, asks, store = null, caller = "?", extra = null, allowPass = null, mode = "ask" } = {}) {
  const out = { ...tools };
  for (const name of Object.keys(out)) {
    const tool = out[name];
    if (!tool?.execute) continue;
    const inner = tool.execute.bind(tool);
    out[name] = {
      ...tool,
      ...(mayAsk(name, extra) ? { inputSchema: withWhy(tool.inputSchema) } : {}),
      async execute(rawArgs) {
        // `why` exists only for the owner's question; the tool itself never sees it.
        const { [WHY]: why = "", ...args } = rawArgs || {};
        let verdict = classify(name, args);
        if (!verdict && extra?.has(name)) verdict = { approve: `صدا زدن «${name}»` };
        if (!verdict || allowPass?.(name, args)) return inner(args);
        if (verdict.block) {
          store?.recordApproval?.({ chatId, caller, tool: name, args: redactArgs(name, args), decision: "blocked", detail: verdict.block });
          return refused(verdict.block);
        }
        if (mode === "refuse") {
          const reason = `${verdict.approve} برای «${caller}» از این مسیر مجاز نیست؛ این کار را صاحب زیرساخت (Owner) باید مستقیم انجام دهد`;
          store?.recordApproval?.({ chatId, caller, tool: name, args: redactArgs(name, args), decision: "refused", detail: reason });
          return refused(reason);
        }
        const key = decisionKey(store, chatId, name, args);
        const known = decisions.get(key);
        if (known && Date.now() - known.at < DECISION_TTL_MS) {
          if (known.yes) return inner(args);
          return refused("Owner همین کار را قبلاً رد کرده؛ دوباره نپرس و راه دیگری هم برای دور زدنش نزن — به درخواست‌کننده بگو چه چیزی لازم بود و چرا انجام نشد", known.conf);
        }
        const askedAt = unanswered.get(key);
        if (askedAt && Date.now() - askedAt < UNANSWERED_TTL_MS) {
          store?.recordApproval?.({
            chatId,
            caller,
            tool: name,
            args: redactArgs(name, args),
            decision: "throttled",
            detail: "تکرار تأییدِ همچنان بی‌پاسخ — سوال دوباره فرستاده نشد",
          });
          return refused(
            "همین تأیید تازه پرسیده شده و هنوز بی‌پاسخ مانده است؛ دوباره نپرس. به درخواست‌کننده گزارش کن که کار منتظر تأیید Owner است و تا پاسخ او ادامه پیدا نمی‌کند",
          );
        }
        // A fresh owner answer to an approval-style ask in this chain covers the next guarded
        // call once (the double-ask fix); a fresh "no" refuses it without asking again.
        const root = store?.rootChatId?.(chatId) || chatId;
        const veto = vetoes.get(root);
        if (veto && Date.now() < veto.until) {
          vetoes.delete(root);
          store?.recordApproval?.({
            chatId,
            caller,
            tool: name,
            args: redactArgs(name, args),
            decision: "vetoed",
            approver: "owner",
            detail: `Owner تازه به سوال مرتبط پاسخ منفی داد: ${veto.question}`,
          });
          return refused(
            "Owner تازه به درخواست مرتبطِ همین زنجیره پاسخ «نه» داده؛ همین کار را دوباره نپرس — نتیجه را به درخواست‌کننده گزارش کن",
          );
        }
        const blessing = blessings.get(root);
        if (blessing && Date.now() < blessing.until) {
          blessings.delete(root); // one use only
          store?.recordApproval?.({
            chatId,
            caller,
            tool: name,
            args: redactArgs(name, args),
            decision: "blessed",
            approver: "owner",
            detail: `پوشش یافت با تأیید ask_owner همین زنجیره: «${blessing.question}» → «${blessing.answer}»`,
          });
          return inner(args);
        }
        let pending = inflight.get(key);
        if (!pending) {
          pending = confirmWithOwner(store, asks, chatId, approvalQuestion(store, chatId, name, args, verdict.approve, why)).finally(() =>
            inflight.delete(key),
          );
          inflight.set(key, pending);
        }
        const conf = await pending;
        const yes = consentOf(conf);
        // Only a real answer is remembered; an unanswered question is remembered as *asked* (see
        // above) so retries report instead of re-asking.
        if (conf?.answered) {
          decisions.set(key, { yes, conf, at: Date.now() });
          unanswered.delete(key);
        } else {
          unanswered.set(key, Date.now());
        }
        store?.recordApproval?.({ chatId, caller, tool: name, args: redactArgs(name, args), decision: yes ? "approved" : "denied", approver: "owner", detail: conf });
        if (!yes) {
          return refused(
            conf?.answered
              ? "Owner تأیید نکرد؛ همین کار یا نسخهٔ دیگری از آن را دوباره نپرس — به درخواست‌کننده بگو چه چیزی لازم بود و چرا انجام نشد"
              : "سؤال تأیید بی‌جواب بسته شد",
            conf,
          );
        }
        return inner(args);
      },
    };
  }
  return out;
}
