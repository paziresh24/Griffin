import { ASK_TOOL } from "./asks.mjs";
import { maskText, redactArgs } from "./redact.mjs";
import { OWNER, PERSONA } from "./persona.mjs";
import { escalateReason } from "./handoff.mjs";

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

// Lateral movement / credential hunting from a shell host: trying keys on other hosts, port sweeps,
// replaying cached auth or forging an auth-proxy header. A delegated read-only check once swept a
// whole /24, tried root keys on every host and spoofed the proxy's user header for 20 minutes
// instead of reporting the blocker.
// ponytail: regex heuristic, not a sandbox — the real fence is the tool quota.
const CREDENTIAL_HUNT =
  /(\bssh\b[^\n]*\s-i\s|\/dev\/tcp\/\$|\bnmap\b|\bmasscan\b|x-authentik|authentik_proxy|\.kube\/cache|\.ssh\/(m\/)?id_|ping\s+-c\s*1[^\n]*\{1\.\.254\}|seq\s+1\s+254)/i;

// A write straight to a CDN control plane from a shell (raw key + curl) skips the tool fence. Once,
// with no write tool on the CDN agent, a raw PATCH switched developer mode on for a whole domain
// after the owner had approved «respect origin headers» — the cache was off for two hours. The
// approval shows the exact call so the owner sees what will actually change.
// ponytail: regex heuristic over curl/httpie/requests, not a sandbox.
const CONTROL_PLANE = /\b(napi\.arvancloud\.ir|api\.nsin\.ir)\b/i;
const WRITE_VERB = /(-X\s*|--request[\s=]+|\bhttp\s+|requests\.|method\s*[=:]\s*["']?)(PUT|PATCH|POST|DELETE)\b/i;

// A git push or a forge API write from the shell skips the gitlab_mr/git_push fence the same way.
// A subtask once read an admin token from the secret store and pushed a partial clone to main:
// the commit dropped every file of a shared GitOps repository and the CD tool deleted what it
// described.
// ponytail: regex heuristic over git/curl, not a sandbox.
const GIT_PUSH = /\bgit\b[^\n;|&]*\spush\b[^\n;|&]*/i;
const FORGE_API_WRITE = /(\/api\/v4\/|api\.github\.com\/)\S*/i;

export function gitWrite(command) {
  const cmd = String(command || "");
  const push = cmd.match(GIT_PUSH);
  if (push) return `push به گیت: ${push[0].trim().slice(0, 200)}`;
  const api = cmd.match(FORGE_API_WRITE);
  const verb = cmd.match(WRITE_VERB);
  if (api && verb) return `تغییر مستقیم API گیت: ${verb[2].toUpperCase()} ${api[0].slice(0, 160)}`;
  return null;
}

// A forge (GitLab/GitHub) API or push token is for the owner's own sessions. A chain rooted in a
// teammate, a peer, the scheduler or the ops room never needs one — the broker's git tools carry
// their own. After one admin token name was blocked, a peer chain read three OTHER forge tokens
// from the secret store — so the block matches the family of names, not one.
// ponytail: name heuristic; the push itself is still caught by gitWrite (+ the review gate).
const OWNER_ROOT_TOKEN = /git(lab|hub)[-_ ]?(superuser|admin|root|push|pat|api[-_ ]?token|token)|\bGIT(LAB|HUB)_TOKEN\b/i;

export function controlPlaneWrite(command) {
  const cmd = String(command || "");
  const host = cmd.match(CONTROL_PLANE);
  if (!host) return null;
  const verb = cmd.match(WRITE_VERB);
  const data = cmd.match(/(?:-d|--data(?:-raw|-binary)?|--json)[\s=]+('[^']*'|"(?:[^"\\]|\\.)*"|\S+)/);
  if (!verb && !data) return null;
  const method = verb ? verb[2].toUpperCase() : "POST";
  const path = (cmd.match(new RegExp(`${host[1].replace(/\./g, "\\.")}(/[^\\s"'?]*)`, "i")) || [])[1] || "";
  const body = data ? maskText(data[1].replace(/^['"]|['"]$/g, "")).slice(0, 300) : "";
  return { host: host[1].toLowerCase(), method, path, body };
}

export function isCredentialHunt(command) {
  return CREDENTIAL_HUNT.test(String(command || ""));
}

export function isDestructiveSql(sql) {
  return DESTRUCTIVE_SQL.test(String(sql || ""));
}

export function isDestructiveShell(command) {
  return DESTRUCTIVE_SHELL.test(String(command || ""));
}

// The secret manager's own admin plane (Infisical's instance-admin secret, bootstrap password, its
// database) is a back door around the tool fence. An owner-rooted chat with no tool for machine
// identities once read the instance-admin secret, dumped the bootstrap password and ran ~25 guessed
// queries on the secret manager's database — leaking admin credentials into chat events. Blocked for every caller, owner too:
// the supported path is infisical_machine_identity / infisical_* or reporting the gap.
// ponytail: name/regex heuristic, not a sandbox.
const SECRET_ADMIN_SHELL = /infisical-(instance-admin|db|secrets)\b|\bADMIN_PASSWORD\b|\binfisical\b[^\n]*\b(psql|pg_dump)\b/i;
const BACKDOOR_REASON =
  "این مسیر پنل/دیتابیسِ ادمینِ Infisical است و بسته است. identity، عضویت پروژه و client secret را با infisical_machine_identity بساز؛ اگر کاری با ابزارها شدنی نیست، همین مانع را دقیق به درخواست‌کننده بگو.";

export function secretAdminBackdoor(name, args = {}) {
  const a = args || {};
  if (name === "pg_query" && (/infisical/i.test(String(a.name || "")) || String(a.database || "").toLowerCase() === "infisical")) return BACKDOOR_REASON;
  if ((name === "kube_secret" || name === "kube_exec" || name === "kube_copy_secret") && (String(a.namespace || "").toLowerCase() === "infisical" || /instance-admin|bootstrap/i.test(String(a.name || "")))) return BACKDOOR_REASON;
  if ((name === "debug_exec" || name === "ssh_exec") && SECRET_ADMIN_SHELL.test(String(a.command || a.cmd || ""))) return BACKDOOR_REASON;
  // A git server's pre-receive hook may reject a push that deletes many files unless the push says
  // allow-mass-delete. That escape hatch is the owner's own, by hand — never an agent's.
  if ((name === "debug_exec" || name === "ssh_exec") && /allow-mass-delete/i.test(String(a.command || a.cmd || ""))) {
    return `push با allow-mass-delete (دور زدن گارد حذف انبوه گیت‌لب) فقط کار دستی خود ${OWNER.nameFa} است؛ اگر حذف انبوه لازم است همین را دقیق به او بگو.`;
  }
  return null;
}

// Applied to every run, whatever the caller (see secretAdminBackdoor).
export function fenceBackdoors(tools, { chatId, store = null, caller = "?" } = {}) {
  const out = { ...tools };
  for (const name of Object.keys(out)) {
    const tool = out[name];
    if (!tool?.execute) continue;
    const inner = tool.execute.bind(tool);
    out[name] = {
      ...tool,
      async execute(args) {
        const reason = secretAdminBackdoor(name, args);
        if (!reason) return inner(args);
        store?.recordApproval?.({ chatId, caller, tool: name, args: redactArgs(name, args), decision: "blocked", detail: reason });
        return refused(reason);
      },
    };
  }
  return out;
}

// Changes to shared infrastructure that cannot be taken back by the agent itself.
const NEEDS_APPROVAL = new Map([
  ["mikrotik_forward_add", "باز کردن پورت روی روتر"],
  ["mikrotik_address_list_add", "تغییر address-list روتر"],
  ["mikrotik_set_enabled", "روشن/خاموش کردن قاعدهٔ روتر"],
  ["mikrotik_remove", "حذف قاعدهٔ روتر"],
  ["infisical_upsert", "نوشتن/بازنویسی secret در Infisical"],
  ["infisical_machine_identity", "ساخت machine identity در Infisical یا عضو کردنش در یک پروژه"],
  ["infisical_create_project", "ساخت پروژهٔ Infisical"],
  ["gitlab_project_member", "دادن نقش (Reporter/Developer) به یک کاربر روی پروژهٔ گیت‌لب"],
  ["kube_copy_secret", "کپی secret بین کلاسترها"],
  ["kube_create", "ساختن یک آبجکت در کلاستر"],
  ["kube_exec", "اجرای دستور داخل پاد"],
  ["cnpg_retry_bootstrap", "حذف Jobهای bootstrap دیتابیس"],
  ["arvan_dns_create", "ساخت رکورد DNS آروان"],
  ["arvan_dns_delete", "حذف رکورد DNS آروان"],
  ["arvan_page_rule_create", "ساخت page rule آروان"],
  ["vcenter_vm_create", "ساخت ماشین مجازی روی vCenter"],
  ["nsin_dns_create", "ساخت رکورد DNS انسین"],
  ["nsin_dns_update", "تغییر رکورد DNS انسین"],
  ["nsin_dns_delete", "حذف رکورد DNS انسین"],
  ["nsin_rule_toggle", "روشن/خاموش کردن قاعدهٔ لبهٔ انسین"],
  ["nsin_developer_mode", "تغییر developer mode انسین"],
  ["nsin_ssl_issue", "صدور گواهی انسین"],
  ["jobs_delete", "حذف جاب"],
]);

const ROOT_TOKEN_REASON =
  `توکن گیت‌لب مالِ خودِ ${OWNER.nameFa} است و در این زنجیره خوانده/استفاده نمی‌شود (هیچ توکن دیگری هم جایگزینش نیست). برای تغییر ریپو از MR (gitlab_propose) استفاده کن یا مانع را به درخواست‌کننده بگو.`;

// -> null (free) | { block: reason } | { approve: reason }
export function classify(name, args = {}) {
  if ((name === "infisical_get" || name === "infisical_list") && OWNER_ROOT_TOKEN.test(`${args?.path || ""} ${args?.name || ""} ${args?.search || ""}`)) {
    return { block: ROOT_TOKEN_REASON };
  }
  if (name === "pg_query") {
    if (isDestructiveSql(args?.sql)) return { block: "SQL مخرب (DROP/TRUNCATE/DELETE بدون شرط/GRANT …) اجازه ندارد" };
    return args?.write ? { approve: "اجرای SQL نوشتنی" } : null;
  }
  if (name === "debug_exec") {
    const command = args?.command || args?.cmd;
    if (isDestructiveShell(command)) return { block: "دستور مخرب (rm ریشه، mkfs، reboot …) اجازه ندارد" };
    if (isCredentialHunt(command)) return { block: "اسکن شبکه / امتحان کلید SSH / گشتن دنبال کریدنشیال اجازه ندارد — مانع را دقیق گزارش کن (برای داخل پاد: kube_exec)" };
    if (OWNER_ROOT_TOKEN.test(String(command || ""))) return { block: ROOT_TOKEN_REASON };
    const git = gitWrite(command);
    if (git) return { approve: git };
    const write = controlPlaneWrite(command);
    if (write) {
      const who = write.host.includes("arvan") ? "آروان" : "انسین";
      return { approve: `تغییر مستقیم API ${who} با کلید خام: ${write.method} ${write.path}${write.body ? ` — ${write.body}` : ""}` };
    }
    // The sandbox is disposable; any other configured host is a real server.
    if (args?.host && args.host !== "sandbox") return { approve: `اجرای دستور روی میزبان «${args.host}»` };
    return null;
  }
  if (name === "ssh_exec") {
    const command = args?.command || "";
    if (isDestructiveShell(command)) return { block: "دستور مخرب (rm ریشه، mkfs، reboot …) اجازه ندارد" };
    if (isCredentialHunt(command)) return { block: "اسکن شبکه / امتحان کلید SSH / گشتن دنبال کریدنشیال اجازه ندارد" };
    if (OWNER_ROOT_TOKEN.test(command)) return { block: ROOT_TOKEN_REASON };
    // The user griffin is read-only by construction (no sudo but docker ps/logs, no write to anyone's
    // files), so asking added nothing. Another user asks.
    if (!args?.user || args.user === "griffin") return null;
    return { approve: `اجرای دستور با SSH روی ${args.user}@${args?.host || "?"}` };
  }
  if (name === "gitlab_mr") return args?.action === "merge" ? { approve: "merge کردن MR" } : args?.action === "close" ? { approve: "بستن MR" } : null;
  if (name === "gitlab_pipeline") return args?.playJob || args?.retryFailed ? { approve: "اجرای job پایپ‌لاین" } : null;
  if (name === "infisical_machine_identity") {
    return { approve: args?.membershipOnly ? "عضو کردن machine identity موجود در یک پروژهٔ دیگر Infisical (بدون ساخت secret)" : "ساخت machine identity و client secret در Infisical و ذخیره‌اش در پروژه" };
  }
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
export function consentOf(conf) {
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

// Questions the guard itself sends. A yes to one of them is the decision for THAT scope only; it
// must not also become a «blessing» for the chain's next gated call, which a parallel call of
// another scope then spent (2026-10-21: a yes for one cluster's gitlab-runner ran another cluster's monitoring,
// and that cluster's question was asked twice).
const guardAsked = new Map(); // masked question -> askedAt

export async function confirmWithOwner(store, asks, chatId, question) {
  const args = { question, options: [{ label: "بله" }, { label: "نه" }] };
  const callId = `guard-${Date.now()}`;
  // The question embeds a detail of the gated call — pg_query write SQL and
  // infisical_upsert values carry credentials, so the mirrored events get the same masking.
  const safeQuestion = maskText(question);
  guardAsked.set(safeQuestion, Date.now());
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

// Owner's standing rule (2026-09-29, live case: a peer request's secret rewrite the agent wanted
// to run itself): work the requester's side could do itself gets a method card, not our execution.
// Prompt text alone did not hold — the rule was in the very request and the model still executed —
// so the FIRST gated attempt in a peer-rooted chain is refused with that instruction, and only the
// retry (the model insisting) reaches the owner. GRIFFIN_GUARD_PEER_CARD=off disables.
const PEER_CARD = process.env.GRIFFIN_GUARD_PEER_CARD !== "off";
const peerCards = new Map(); // decisionKey -> firstAttemptAt

// The agent tends to write `intent` once and drop it on the next calls (e.g. the same secrets moved
// to a new folder = a new scope = a new question). The chain's last plain sentence carries over.
const INTENT_MS = 60 * 60 * 1000;
const intents = new Map(); // rootChatId -> { text, at }

// A chain is peer-rooted when the ROOT chat's caller is a peer agent (a delegated subtask carries
// its own caller, so only the root answers "whose request is this?"). Test stores without getChat
// simply say no.
function peerRooted(store, chatId) {
  try {
    const root = store?.rootChatId?.(chatId) || chatId;
    return String(store?.getChat?.(root)?.caller || "").startsWith("peer:");
  } catch {
    return false;
  }
}

function peerTrust(store, chatId) {
  try {
    const root = store?.getChat?.(store?.rootChatId?.(chatId) || chatId);
    const caller = String(root?.caller || "");
    return caller.startsWith("peer:") ? store?.getKv?.(`peertrust:${caller.slice(5)}`) || null : null;
  } catch {
    return null;
  }
}

// Only yes/no-shaped questions bless: several substantive options are a clarification, and an
// unrelated "بله" to one of those must never approve the next guarded call.
function approvalShaped(options) {
  const labels = (Array.isArray(options) ? options : []).map((o) => String(o?.label ?? o ?? "").trim());
  if (!labels.length || labels.length > 3) return false;
  return labels.some((label) => NO_RE.test(label));
}

// The owner typing an order in a chain he did not start (a colleague's or a peer's chat) is his yes:
// «دسترسی بهش بده» and «میشه دسترسی بدی بهشون؟» were followed by approval cards and the reviewers
// called it «ادعای نقل‌شده» (2026-10-21, 8e1ce443). For 30 minutes the chain's gated calls run, each
// recorded as owner-ordered and learned like a yes. A question about the work («چرا…؟») is not an order.
const ORDER_MS = 30 * 60 * 1000;
const orders = new Map(); // rootChatId -> { until, text }
const ORDER_RE = /(?<![\p{L}])(بده|بدی|بدید|بکن|بکنی|بکنید|بزن|بزنی|بزنید|بساز|بسازی|بسازید|انجام|اعمال|مرج|مرجش|مرج کن|ادامه بده|حلش کن|درستش کن|ببرش|برو جلو|اوکیه|موافقم|بله|آره)(?![\p{L}])/u;
export function noteOwnerOrder(store, chatId, text) {
  const s = String(text || "").trim();
  if (!s || NO_RE.test(s) || NEG_ANYWHERE.test(s) || !ORDER_RE.test(s)) return false;
  if (/^(چرا|چی|کجا|کی|آیا)\b/.test(s)) return false;
  const root = store?.rootChatId?.(chatId) || chatId;
  orders.set(root, { until: Date.now() + ORDER_MS, text: s.slice(0, 300) });
  vetoes.delete(root);
  return true;
}
export function ownerOrder(store, chatId) {
  const root = store?.rootChatId?.(chatId) || chatId;
  const o = orders.get(root);
  return o && Date.now() < o.until ? o : null;
}

/** Call when the owner settles an ask in a chat (wired from asks.onSettled). */
export function noteOwnerAnswer(store, chatId, { question = "", answer = "", selected = [], options = null } = {}) {
  if (!BLESSING_MS) return;
  for (const [q, at] of guardAsked) if (Date.now() - at > 24 * 3600_000) guardAsked.delete(q);
  if (guardAsked.has(maskText(String(question || "")))) return;
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

// One owner answer covers a whole target for the chain, not one exact command. 2026-10-05: an
// in-pod connectivity test asked five times (nc → /dev/tcp → node → python), five Infisical keys
// under one path asked three times — the owner stopped reading and pressed «بله» on all of them.
function scopeOf(name, args) {
  const a = args || {};
  if (name === "kube_exec" || name === "kube_create") return { cluster: a.cluster, namespace: a.namespace };
  if (name === "infisical_upsert") return { projectId: a.projectId, environment: a.environment, path: a.path };
  if (name === "infisical_get") return { projectId: a.projectId };
  if (name === "pg_query" && a.write) return { cluster: a.cluster, namespace: a.namespace, name: a.name, database: a.database };
  // Page rules under one host + first path segment are one change to the owner; the agent tried
  // several source rules to copy from and each one used to be a new question.
  // ponytail: the source rule is not part of the scope; key on its load_balancer if a path ever mixes origins.
  if (name === "arvan_page_rule_create") return { domain: a.domain, prefix: pageRulePrefix(a.url) };
  // Read-only shell steps on one host: one yes for the host (2026-10-21, 76d2e08a: uptime, docker logs,
  // list-timers and ps on host griffin were four questions). A command that may change something
  // keeps its own question.
  if (name === "debug_exec" || name === "ssh_exec") {
    const cmd = String(a.command || a.cmd || "");
    if (!cmd || gitWrite(cmd) || controlPlaneWrite(cmd) || SHELL_CHANGE.test(cmd)) return null;
    return { host: a.host || "sandbox" };
  }
  return null;
}

const SHELL_CHANGE = /\b(rm|mv|cp|dd|tee|chmod|chown|kill|pkill|reboot|shutdown|sed\s+-i|kubectl\b[^\n]*\b(apply|delete|patch|edit|scale|replace|create|annotate|label|drain|cordon|rollout)|helm\s+(install|upgrade|uninstall|rollback)|systemctl\s+(restart|stop|start|disable|enable|reload|kill|mask)|docker\s+(compose\s+\S*\s*)?(rm|stop|restart|kill|up|down|push|rmi|prune|update|exec)|psql|mysql|curl\b[^\n]*-(X|d)\b)|>/i;

function pageRulePrefix(url) {
  const m = /^https?:\/\/([^/]+)\/([^/*?]*)/i.exec(String(url || ""));
  return m ? `${m[1].toLowerCase()}/${m[2]}` : String(url || "");
}

function scopeLabel(name, args) {
  const a = args || {};
  if (name === "kube_exec") return `هر دستوری داخل پادهای namespace «${a.namespace}» (کلاستر ${a.cluster})`;
  if (name === "kube_create") return `ساختن آبجکت‌های یک‌باره (Job، Pod تست، Backup…) در namespace «${a.namespace}» (کلاستر ${a.cluster})`;
  if (name === "infisical_upsert") return `نوشتن secret در Infisical پروژهٔ «${a.projectId}»، ${a.environment || "prod"}، مسیر ${a.path || "/"}`;
  if (name === "infisical_get") return `خواندن سکرت‌های Infisical پروژهٔ «${a.projectId}»`;
  if (name === "pg_query") return `SQL نوشتنی روی دیتابیس ${a.database || "postgres"} در ${a.name} (namespace «${a.namespace}»، ${a.cluster})`;
  if (name === "debug_exec" || name === "ssh_exec") return `دستورهای فقط‌خواندنی روی سرور «${a.host || "sandbox"}»`;
  if (name === "arvan_page_rule_create") return `ساخت page rule آروان زیر ${pageRulePrefix(a.url)}… با کپی تنظیمات ruleهای موجود همین مسیر`;
  return "";
}

function decisionKey(store, chatId, name, args) {
  const root = store?.rootChatId?.(chatId) || chatId;
  let raw;
  try {
    raw = JSON.stringify(scopeOf(name, args) || canonicalArgs(name, args));
  } catch {
    raw = String(args);
  }
  return `${root}\u0000${name}\u0000${raw}`;
}

// A yes is learned, not spent (owner 2026-10-21: «نمیخواستم برا هرکاری از من دسترسی بخواد. فقط
// میخواستم بفهمه باید چیکار کنه و هی رشد کنه» — ~140 approvals in a week, 90% «بله», mostly the same
// namespace/project for the same person). A yes on a scoped call (scopeOf) is kept in kv `grants`
// for that requester and that scope, for good: the next chain of the same person doing the same kind
// of thing there runs without asking. A «نه» is not learned (the 6h decision cache still holds it).
// ponytail: grants never expire and have no UI; delete kv `grants` (or a key in it) to revoke.
function requesterOf(store, chatId) {
  try {
    const root = store?.getChat?.(store?.rootChatId?.(chatId) || chatId);
    const caller = String(root?.caller || "");
    if (!caller) return "";
    return caller === "team" ? (root?.person_id ? `person:${root.person_id}` : "") : caller;
  } catch {
    return "";
  }
}

function grantKey(store, chatId, name, args) {
  const scope = scopeOf(name, args);
  const who = requesterOf(store, chatId);
  if (!scope || !who) return "";
  return `${who}\u0000${name}\u0000${JSON.stringify(scope)}`;
}

export function learnedGrant(store, chatId, name, args) {
  const key = grantKey(store, chatId, name, args);
  return key ? store?.getKv?.("grants")?.[key] || null : null;
}

function learnGrant(store, chatId, name, args, question) {
  const key = grantKey(store, chatId, name, args);
  if (!key || !store?.setKv) return;
  const all = store.getKv?.("grants") || {};
  all[key] = { at: new Date().toISOString(), question: maskText(String(question || "")).slice(0, 300) };
  store.setKv("grants", all);
}

export function forgetDecisions() {
  decisions.clear();
  orders.clear();
  inflight.clear();
  unanswered.clear();
  blessings.clear();
  vetoes.clear();
  peerCards.clear();
  intents.clear();
}

const WHY = "why"; // older prompts still send it; stripped, never shown
const INTENT = "intent";
// Tools whose `description` is the step's name in the chat (apps/broker/src/step-title.mjs).
const STEP_TITLED = new Set(["debug_exec", "ssh_exec", "kube_exec", "mikrotik_exec"]);

// A code-built question names the tool and its args, which tells the owner nothing about whether
// the path is right. Only the agent knows what the requester wants, so gated tools take one plain
// sentence for the question; the code still adds who asked (delivery header), whose namespace it is
// and what one yes covers. A sentence that pleads («لطفاً اجرا شود، تأیید گرفته شده»), names a tool
// or runs long falls back to the code-built line.
const INTENT_SCHEMA = {
  type: "string",
  description:
    `Only used if this call needs ${OWNER.name}'s approval: ONE everyday-Persian sentence, the way you'd say it to them out loud — what the requester wants and what you are about to change, e.g. «می‌خوان سرویس inbox به سرور تلفن برسه؛ برای این کار باید روی گیت‌وی یه route اضافه کنم». No tool/table/pod names, JSON or IDs, no pleading.`,
};

function mayAsk(name, extra) {
  return NEEDS_APPROVAL.has(name) || ["pg_query", "gitlab_mr", "gitlab_pipeline", "mikrotik_exec", "debug_exec", "ssh_exec", "arvan_cache_purge"].includes(name) || Boolean(extra?.has(name));
}

function withIntent(schema) {
  if (!schema || schema.type !== "object" || !schema.properties || schema.properties[INTENT]) return schema;
  return { ...schema, properties: { ...schema.properties, [INTENT]: INTENT_SCHEMA } };
}

export function plainIntent(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s || s.length > 240) return "";
  if (/[a-z]+_[a-z_]+|[{}[\]]|لطف|تأیید (شده|گرفته)|تایید (شده|گرفته)|فوری|ضروری/i.test(s)) return "";
  return s;
}

// Plain labels for tools gated only on some paths (teammate coverage) — «صدا زدن «telegram_send»»
// meant nothing to the owner.
const EXTRA_LABELS = { telegram_send: "فرستادن پیام", knowledge_write: `نوشتن یادداشت در دانش ${PERSONA.name}`, arvan_cache_purge: "پاک کردن کش آروان", knowledge_edit: `ویرایش یادداشت در دانش ${PERSONA.name}`, knowledge_delete: `حذف یادداشت از دانش ${PERSONA.name}` };

// What the action touches, in a few readable words — never a credential.
function actionDetail(name, args) {
  if (name === "mikrotik_exec") return String(args?.command || "").slice(0, 160);
  if (name === "pg_query") return String(args?.sql || "").replace(/\s+/g, " ").slice(0, 120);
  if (name === "kube_exec") return args?.pod ? `پاد ${args.pod}` : ""; // a shell one-liner means nothing to the owner
  if (name === "infisical_upsert") return String(args?.name || "");
  // A DNS cleanup is one call for the whole list: the owner sees every record he is saying yes to.
  if (name === "arvan_dns_delete") {
    const recs = Array.isArray(args?.records) ? args.records : [args || {}];
    const names = recs.map((r) => `${r?.name || "?"}${r?.type ? ` (${r.type})` : ""}`);
    return `${recs.length} رکورد در ${args?.domain || "?"}: ${names.join("، ").slice(0, 900)}`;
  }
  if (name === "gitlab_mr") return [args?.project, args?.iid && `!${args.iid}`].filter(Boolean).join(" ");
  if (name === "telegram_send") {
    const file = args?.file ? ` فایل «${String(args.file).split("/").pop()}» با` : "";
    return `در «${args?.chat || "?"}»:${file} «${String(args?.text || "").replace(/\s+/g, " ").slice(0, 200)}»`;
  }
  return Object.entries(args || {})
    .filter(([key, value]) => ["string", "number", "boolean"].includes(typeof value) && !/value|secret|pass|token|key$/i.test(key))
    .map(([key, value]) => `${key}: ${String(value).slice(0, 60)}`)
    .slice(0, 4)
    .join(" · ");
}

// A namespace/peer id as the owner says it: kv `owner-names` ({id: "Mr. Smith"}), then the peer's
// own label, then the raw id.
export function ownerLabel(store, id) {
  const key = String(id || "");
  try {
    return store?.getKv?.("owner-names")?.[key] || store?.getPeerUser?.(key)?.label || key;
  } catch {
    return key;
  }
}

// Who a peer caller is in namespaces and Infisical projects. A network peer's id is its install
// (net-karsara-sara-example-org), not the person (sara-sharifi), so her own namespace looked
// like someone else's: every exec in her own pods and every read of her own secrets asked the owner,
// with a warning that it belonged to someone else (2026-10-21). kv `peer-owner` maps a peer id
// to that person's slug(s): {"net-karsara-sara-example-org": ["sara-sharifi"]}.
export function selfIds(store, caller) {
  const peer = String(caller || "").replace(/^peer:/, "");
  let mapped = [];
  try {
    const m = store?.getKv?.("peer-owner")?.[peer];
    mapped = Array.isArray(m) ? m : m ? [m] : [];
  } catch {}
  return [peer, ...mapped].map((x) => String(x).toLowerCase());
}

// The namespace/project this call writes into, when it is not the requesting colleague's own
// (owner names = namespaces = Infisical projects). That is the line the owner must not miss.
function foreignTarget(store, chatId, args) {
  const root = store?.getChat?.(store?.rootChatId?.(chatId) || chatId);
  const caller = String(root?.caller || "");
  if (!caller.startsWith("peer:")) return "";
  const target = String(args?.namespace || args?.projectId || "");
  return target && !selfIds(store, caller).includes(target.toLowerCase()) ? target : "";
}

// «X می‌خواد …؛ برای این کار باید …. اوکیه؟» — the agent's sentence when it gave a usable one,
// otherwise the code-built action. The requester's name comes from the delivery header.
export function approvalQuestion(store, chatId, name, args, action, intent = "", carried = false) {
  const root = store?.getChat?.(store?.rootChatId?.(chatId) || chatId);
  const scope = scopeLabel(name, args);
  const plain = plainIntent(intent);
  const foreign = foreignTarget(store, chatId, args);
  const own = store?.getChat?.(chatId);
  const source = /^←/.test(String(own?.title || "")) ? own.title : root?.title;
  const title = String(source || "").replace(/^[^:]{1,40}:\s*/, "").replace(/^\/agent\b.*$/, "").trim();
  const lines = [];
  if (plain) {
    lines.push(plain);
    // A carried-over sentence was about an earlier call; name what this one touches.
    if (carried || name === "arvan_dns_delete") {
      const detail = actionDetail(name, args);
      if (detail) lines.push(`(این بار: ${detail})`);
    }
    // The exact call stays visible for a raw control-plane write or a full-cache purge.
    if (name === "debug_exec" || name === "arvan_cache_purge") lines.push(`(${action})`);
  } else {
    const detail = actionDetail(name, args);
    lines.push(scope ? `${scope}\n(این بار: ${detail})` : `${action}${detail ? ` — ${detail}` : ""}`);
    if (title) lines.push(`برای: ${title.length > 90 ? `${title.slice(0, 90).replace(/\s+\S*$/, "")}…` : title}`);
  }
  if (foreign) lines.push(`⚠️ این مالِ ${ownerLabel(store, foreign)} است، نه خودِ درخواست‌کننده.`);
  if (scope) lines.push("با «بله» همین نوع کار برای همین شخص دیگر هیچ‌وقت پرسیده نمی‌شود.");
  lines.push("اوکیه؟");
  return lines.join("\n");
}

function refused(error, detail) {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error, ...(detail ? { detail } : {}) }) }] };
}

// The assistant's secret-store identity may reach every project (an org admin), but other people's
// secrets only with the owner's yes. Managing identities and memberships stays
// as it is; reading or writing a secret VALUE in a project that is not the requester's own asks the
// owner first, in every chain — the owner's own chats too. One yes covers that project for the
// chain (scopeOf). Listing key names stays free. own: project names/ids that count as the
// requester's (the owner's from config; a colleague's = their peer user id).
// ponytail: a teammate (Telegram) chain owns no project here, so reading even their own secrets asks;
// map the person to their project if that gets noisy.
export function foreignSecret(store, chatId, args, ownerProjects = []) {
  const root = store?.getChat?.(store?.rootChatId?.(chatId) || chatId);
  const caller = String(root?.caller || "");
  const own = caller === "owner" ? ownerProjects : caller.startsWith("peer:") ? selfIds(store, caller) : [];
  const target = String(args?.projectId || "").trim();
  if (!target) return "";
  return own.some((p) => String(p).trim().toLowerCase() === target.toLowerCase()) ? "" : target;
}

export function secretsGate(tools, { chatId, asks, store = null, caller = "?", mode = "ask", ownerProjects = [] } = {}) {
  const picked = {};
  for (const name of ["infisical_get", "infisical_upsert"]) if (tools[name]) picked[name] = tools[name];
  const gated = guardTools(picked, {
    chatId,
    asks,
    store,
    caller,
    mode,
    verdictOf: (name, args) => {
      const project = foreignSecret(store, chatId, args, ownerProjects);
      if (!project) return null;
      return { approve: name === "infisical_get" ? `خواندن سکرت از پروژهٔ Infisical «${project}» (مال کس دیگری)` : `نوشتن سکرت در پروژهٔ Infisical «${project}» (مال کس دیگری)` };
    },
  });
  return { ...tools, ...gated };
}

// extra: additional tool names that need approval for this caller (e.g. teammate coverage).
// allowPass(name, args): true lets a call through without asking (e.g. replying in the same chat).
// mode "escalate": a colleague's read-only chain — refused with the handoff instruction (handoff.mjs).
// mode "refuse": nobody can approve on this path yet (external peers until a two-party approval
// flow exists) — gated calls are refused and audited instead of asking.
export function guardTools(tools, { chatId, asks, store = null, caller = "?", extra = null, allowPass = null, mode = "ask", verdictOf = classify } = {}) {
  const out = { ...tools };
  for (const name of Object.keys(out)) {
    const tool = out[name];
    if (!tool?.execute) continue;
    const inner = tool.execute.bind(tool);
    out[name] = {
      ...tool,
      ...(mayAsk(name, extra) && mode === "ask" ? { inputSchema: withIntent(tool.inputSchema) } : {}),
      async execute(rawArgs) {
        const { [WHY]: _why, [INTENT]: intent = "", ...rest } = rawArgs || {};
        // A shell step's title is for the chat row only: it must not change what an approval or a
        // remembered answer is keyed on (the same command with another title is the same command).
        const { description: _title, ...bare } = rest;
        const args = STEP_TITLED.has(name) ? bare : rest;
        let verdict = verdictOf(name, args);
        if (!verdict && extra?.has(name)) verdict = { approve: EXTRA_LABELS[name] || `اجرای «${name}»` };
        if (!verdict || allowPass?.(name, args)) return inner(args);
        if (verdict.block) {
          store?.recordApproval?.({ chatId, caller, tool: name, args: redactArgs(name, args), decision: "blocked", detail: verdict.block });
          return refused(verdict.block);
        }
        // A colleague's Telegram chain only reads (handoff.mjs): the write is refused with the way
        // to hand it to the owner's own chats, and nobody is asked per call.
        if (mode === "escalate") {
          const reason = escalateReason(verdict.approve);
          store?.recordApproval?.({ chatId, caller, tool: name, args: redactArgs(name, args), decision: "escalate", detail: verdict.approve });
          return refused(reason);
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
        const learned = learnedGrant(store, chatId, name, args);
        if (learned) {
          store?.recordApproval?.({ chatId, caller, tool: name, args: redactArgs(name, args), decision: "learned", approver: "owner", detail: `قبلاً برای همین شخص و همین محدوده «بله» گفته شده (${learned.at})` });
          return inner(args);
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
        const order = ownerOrder(store, chatId);
        if (order) {
          learnGrant(store, chatId, name, args, order.text);
          store?.recordApproval?.({ chatId, caller, tool: name, args: redactArgs(name, args), decision: "owner-ordered", approver: "owner", detail: `${OWNER.nameFa} خودش در همین گفتگو نوشت: «${order.text}»` });
          return inner(args);
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
        // A method card only makes sense for the requester's own namespace/project; for someone
        // else's they have no access, and the card just sent the agent asking around (2026-10-06).
        // A colleague the owner trusts with in-pod reads (peertrust:<user>, set from PATCH
        // /api/peers/:id {trustInPod}) does not wait on the owner for kube_exec — the owner was the
        // bottleneck (three asks in one request). And every colleague runs kube_exec on their OWN
        // namespace without asking: their own kubeconfig already grants pods/exec there.
        if ((name === "kube_exec" || name === "kube_create") && peerRooted(store, chatId) && (peerTrust(store, chatId)?.inPod || !foreignTarget(store, chatId, args))) {
          const own = !foreignTarget(store, chatId, args);
          store?.recordApproval?.({ chatId, caller, tool: name, args: redactArgs(name, args), decision: "trusted", detail: own ? "پادِ namespaceِ خودِ همکار" : "همکارِ مورد اعتماد Owner برای اجرای داخل پاد" });
          return inner(args);
        }
        const viaPeer = PEER_CARD && peerRooted(store, chatId) && !foreignTarget(store, chatId, args);
        if (viaPeer) {
          const cardAt = peerCards.get(key);
          if (cardAt && Date.now() - cardAt < DECISION_TTL_MS) {
            peerCards.delete(key); // the insistence — this one reaches the owner, with the triage line
          } else {
            peerCards.set(key, Date.now());
            store?.recordApproval?.({
              chatId,
              caller,
              tool: name,
              args: redactArgs(name, args),
              decision: "peer-card",
              detail: "نخستین تلاش اجرای کارِ همکار — روش کامل (method card) به‌جای اجرا درخواست شد",
            });
            return refused(
              "این کار در زنجیرهٔ یک همکار است: پیش از اجرای خودت، راهِ کامل را به خودِ درخواست‌کننده بده (method card: مسیر، جای سکرت فقط با مرجعِ سکرت‌منیجر، دستور دقیق) تا خودش بزند و بعد راستی‌آزمایی کن. اگر واقعاً نمی‌تواند و فراهم‌کردن دسترسی برایش هم ممکن یا منطقی نیست، همین فراخوانی را دوباره صدا بزن — آن‌گاه سؤال تأیید به Owner می‌رسد",
            );
          }
        }
        let plain = plainIntent(intent);
        let carried = false;
        if (plain) intents.set(root, { text: plain, at: Date.now() });
        else if (intents.get(root) && Date.now() - intents.get(root).at < INTENT_MS) {
          plain = intents.get(root).text;
          carried = true;
        }
        const question = approvalQuestion(store, chatId, name, args, verdict.approve, plain, carried);
        let pending = inflight.get(key);
        if (!pending) {
          pending = confirmWithOwner(store, asks, chatId, question).finally(() => inflight.delete(key));
          inflight.set(key, pending);
        }
        const conf = await pending;
        const yes = consentOf(conf);
        // He typed a question back («کجا در جریانه که من نمیبینم؟») instead of answering: that is not
        // a «نه». Remembered as one, it blocked the same step for 6 hours (2026-10-21, chat 8e1ce443).
        const reply = String(conf?.answer || "").trim();
        if (conf?.answered && !yes && /[؟?]/.test(reply) && !NO_RE.test(reply) && !NEG_ANYWHERE.test(reply)) {
          store?.recordApproval?.({ chatId, caller, tool: name, args: redactArgs(name, args), decision: "clarify", approver: "owner", detail: conf });
          return refused(`Owner به‌جای جواب سؤال پرسید: «${reply.slice(0, 300)}». این «نه» نیست: اول در همین چت جوابش را بده و بگو دقیقاً چه کاری و برای چه می‌خواهی، بعد همین فراخوانی را دوباره بزن`);
        }
        // Only a real answer is remembered; an unanswered question is remembered as *asked* (see
        // above) so retries report instead of re-asking.
        if (conf?.answered) {
          decisions.set(key, { yes, conf, at: Date.now() });
          if (yes) learnGrant(store, chatId, name, args, question);
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
