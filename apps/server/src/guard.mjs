import { ASK_TOOL } from "./asks.mjs";

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
    // A RouterOS console line: reading a menu is free, anything that writes to a production
    // router is the owner's call — the command itself is shown in the question.
    const command = String(args?.command || "");
    return /(^|\s|\/)(print|get|monitor|export|find)(\s|$)/i.test(command) && !/\b(add|set|remove|enable|disable|unset|move)\b/i.test(command)
      ? null
      : { approve: `اجرای دستور روی روتر: ${command.slice(0, 120)}` };
  }
  const reason = NEEDS_APPROVAL.get(name);
  return reason ? { approve: reason } : null;
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

export function summarizeArgs(name, args) {
  try {
    const raw = JSON.stringify(args || {});
    return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
  } catch {
    return name;
  }
}

export async function confirmWithOwner(store, asks, chatId, question) {
  const args = { question, options: [{ label: "بله" }, { label: "نه" }] };
  const callId = `guard-${Date.now()}`;
  store?.appendEvent?.(chatId, null, "tool.started", { callId, name: ASK_TOOL, args });
  const conf = await asks.confirm(chatId, { question });
  store?.appendEvent?.(chatId, null, "tool.done", { callId, name: ASK_TOOL, args, result: conf });
  return conf;
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
      async execute(args) {
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
        const conf = await confirmWithOwner(
          store,
          asks,
          chatId,
          `ایجنت (به درخواست «${caller}») می‌خواهد ${verdict.approve}: «${name}» با\n${summarizeArgs(name, args)}\nتأیید می‌کنی؟`,
        );
        const yes = isYes(conf);
        store?.recordApproval?.({ chatId, caller, tool: name, args, decision: yes ? "approved" : "denied", approver: "owner", detail: conf });
        if (!yes) return refused("Owner تأیید نکرد", conf);
        return inner(args);
      },
    };
  }
  return out;
}
