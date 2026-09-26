import { ASK_TOOL } from "./asks.mjs";
import { maskText } from "./redact.mjs";

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

export function isYes(answer) {
  const s = String(answer?.answer || answer || "")
    .trim()
    .toLowerCase();
  if (!s) return false;
  if (/^(نه|خیر|نرو|نکن|cancel|no|n)\b/i.test(s)) return false;
  if (Array.isArray(answer?.selected) && answer.selected.some((x) => /^(بله|آره|باشه|برو|انجام|تأیید|تایید|yes|y|ok|۱|1)$/i.test(String(x).trim()))) {
    return true;
  }
  return /^(بله|آره|باشه|برو|انجام|تأیید|تایید|yes|y|ok|۱|1)\b/i.test(s);
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

function decisionKey(store, chatId, name, args) {
  const root = store?.rootChatId?.(chatId) || chatId;
  let raw;
  try {
    raw = JSON.stringify(args ?? {});
  } catch {
    raw = String(args);
  }
  return `${root}\u0000${name}\u0000${raw}`;
}

export function forgetDecisions() {
  decisions.clear();
  inflight.clear();
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
          store?.recordApproval?.({ chatId, caller, tool: name, args, decision: "blocked", detail: verdict.block });
          return refused(verdict.block);
        }
        if (mode === "refuse") {
          const reason = `${verdict.approve} برای «${caller}» از این مسیر مجاز نیست؛ این کار را صاحب زیرساخت (Owner) باید مستقیم انجام دهد`;
          store?.recordApproval?.({ chatId, caller, tool: name, args, decision: "refused", detail: reason });
          return refused(reason);
        }
        const key = decisionKey(store, chatId, name, args);
        const known = decisions.get(key);
        if (known && Date.now() - known.at < DECISION_TTL_MS) {
          if (known.yes) return inner(args);
          return refused("Owner همین کار را قبلاً رد کرده؛ دوباره نپرس و راه دیگری هم برای دور زدنش نزن — به درخواست‌کننده بگو چه چیزی لازم بود و چرا انجام نشد", known.conf);
        }
        let pending = inflight.get(key);
        if (!pending) {
          pending = confirmWithOwner(store, asks, chatId, approvalQuestion(store, chatId, name, args, verdict.approve, why)).finally(() =>
            inflight.delete(key),
          );
          inflight.set(key, pending);
        }
        const conf = await pending;
        const yes = isYes(conf);
        // Only a real answer is remembered; a question that died with its run is asked again.
        if (conf?.answered) decisions.set(key, { yes, conf, at: Date.now() });
        store?.recordApproval?.({ chatId, caller, tool: name, args, decision: yes ? "approved" : "denied", approver: "owner", detail: conf });
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
