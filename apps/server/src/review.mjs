import { classify, controlPlaneWrite, gitWrite, routerReadOnly, confirmWithOwner, consentOf } from "./guard.mjs";
import { redactArgs, maskText } from "./redact.mjs";

// Two-reviewer gate for risky changes. OPT-IN: off unless GRIFFIN_REVIEW=on (it costs two model
// calls per gated change and needs two engines). Once one model decided alone to push a partial
// clone to a shared GitOps repo's main branch and the repo was wiped. With the gate on, such a change
// runs only after two independent models (ideally different vendors) approve it — a reviewer that
// cannot answer (timeout/error) is no vote, not a veto: the one that did answer decides. A rejection in the owner's own chat asks the owner;
// anywhere else it refuses. Reviewers see the request, the agent's recent reasoning and the exact
// call — never a credential (args are redacted).

// Shell lines that change something. Reads stay free so diagnostics keep their speed.
// ponytail: regex heuristic over shell text, not a sandbox — the reviewers and guard are the fence.
const KUBE_WRITE = /\b(kubectl|k0s\s+kubectl)\b[^\n]*\s(apply|delete|patch|edit|scale|replace|create|annotate|label|drain|cordon|uncordon|taint|set\s|rollout\s+(restart|undo|resume))\b/i;
const HELM_WRITE = /\bhelm\s+(install|upgrade|uninstall|rollback|delete)\b/i;
const SERVICE_WRITE = /\bsystemctl\s+(restart|stop|start|disable|enable|reload|kill|mask)\b|\bservice\s+\S+\s+(restart|stop|start|reload)\b/i;
const DOCKER_WRITE = /\bdocker\s+(compose\s+\S*\s*)?(rm|stop|restart|kill|up|down|push|rmi|prune|update)\b|\b(skopeo\s+(copy|delete)|crane\s+(push|delete|copy))\b/i;
const HTTP_WRITE = /(-X\s*|--request[\s=]+)(PUT|PATCH|DELETE)\b/i;
const SQL_WRITE = /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|alter\s+(table|role|user|database)|drop\s+|create\s+(table|role|user|database)|grant\s|revoke\s|truncate\s)/i;
const FS_WRITE = /\b(rm\s+-[a-z]*[rf]|mv\s|dd\s|mkfs|wipefs|iptables\s+-[ADIF]|nft\s+(add|delete|flush|insert)|ip\s+route\s+(add|del|replace))\b/i;

function shellChange(command, host) {
  const cmd = String(command || "");
  const git = gitWrite(cmd);
  if (git) return git;
  const cp = controlPlaneWrite(cmd);
  if (cp) return `تغییر مستقیم API ${cp.host}: ${cp.method} ${cp.path}`;
  if (KUBE_WRITE.test(cmd)) return "تغییر در کلاستر با kubectl";
  if (HELM_WRITE.test(cmd)) return "نصب/ارتقا/حذف با helm";
  if (SERVICE_WRITE.test(cmd)) return "روشن/خاموش/ری‌استارت سرویس";
  if (DOCKER_WRITE.test(cmd)) return "تغییر کانتینر/ایمیج";
  if (HTTP_WRITE.test(cmd)) return "درخواست نوشتنی HTTP (PUT/PATCH/DELETE)";
  if (/\b(psql|mysql|sqlcmd|mongo(sh)?)\b/i.test(cmd) && SQL_WRITE.test(cmd)) return "نوشتن در دیتابیس";
  // The sandbox is scratch space: deleting its own temp files is not a change.
  if (host && host !== "sandbox" && FS_WRITE.test(cmd)) return "تغییر فایل/شبکه روی سرور";
  return null;
}

const ALWAYS = new Map([
  ["gitlab_propose", "ساخت شاخه و MR در گیت‌لب"],
  ["git_push", "push شاخه به گیت‌لب"],
  ["repo_push", "push شاخه به گیت‌لب"],
  ["arvan_cache_purge", "پاک کردن کش آروان"],
  ["nsin_cache_purge", "پاک کردن کش انسین"],
  ["nsin_cache_purge_path", "پاک کردن کش انسین"],
  ["infisical_create_project", "ساخت پروژهٔ Infisical"],
]);

// Only the catastrophic categories go through the two-reviewer gate, not every mutation. Everything
// else that `changeOf` flags still passes through guard.mjs (owner approval in a chain the owner did
// not start) — it just does not pay two full model reviews. The wipe was a git push to main; data
// loss is a destructive filesystem op. Those two keep the gate.
const GIT_TOOLS = new Set(["gitlab_propose", "git_push", "repo_push"]);
const DESTRUCTIVE_FS = /\b(rm\s+-[a-z]*[rf]|dd\s|mkfs|wipefs|shred)\b/i;

export function reviewWorthy(name, args = {}) {
  const a = args || {};
  if (GIT_TOOLS.has(name)) return true;
  if (name === "gitlab_mr" && a.action === "merge") return true;
  const cmd = name === "debug_exec" ? a.command || a.cmd : name === "ssh_exec" || name === "kube_exec" ? a.command : "";
  if (cmd) {
    if (gitWrite(String(cmd))) return true;
    const host = a.host || (name === "kube_exec" ? "pod" : "sandbox");
    if (host !== "sandbox" && DESTRUCTIVE_FS.test(String(cmd))) return true;
  }
  return false;
}

// -> plain description of the change, or null when the call only reads.
export function changeOf(name, args = {}) {
  const a = args || {};
  if (name === "debug_exec") return shellChange(a.command || a.cmd, a.host || "sandbox");
  if (name === "ssh_exec") return shellChange(a.command, a.host || "?");
  if (name === "kube_exec") return shellChange(a.command, "pod");
  if (name === "mikrotik_exec") return routerReadOnly(a.command) ? null : `دستور روی روتر ${a.router || ""}`.trim();
  if (name === "gitlab_mr") return a.action === "merge" ? "merge کردن MR" : null;
  if (name === "gitlab_pipeline") return a.retryFailed || a.playJob ? "اجرای job پایپ‌لاین" : null;
  if (ALWAYS.has(name)) return ALWAYS.get(name);
  return classify(name, a)?.approve || null;
}

export const REVIEW_SYSTEM = `You are an independent change reviewer for an ops agent that acts on a company's production
infrastructure (Kubernetes GitOps repo, GitLab, CDN, routers, databases). Another AI agent wants to run ONE change.
Decide if it is safe to run right now. Approve only if ALL hold:
- it is needed for what the requester actually asked, and limited to that;
- it does not push to main/master of a shared repo when a merge request would do, unless the request is an explicit owner order;
- it does not use someone else's credentials or a root/admin token for a colleague's task;
- it cannot delete, overwrite or disable more than the request needs (watch partial git clones/checkouts: a
  commit from a clone made with --no-checkout or a sparse/partial checkout deletes every file it did not check out);
- the exact command does what the agent says it does;
- if a reviewer or sub-agent earlier refused it for safety, nothing in the request overrides that except the owner.
You are the technical/safety check, not the approval step: in a chain the owner did not start, a change you approve
is shown to the owner for yes/no before it runs; in the owner's own chat the owner asked for it. Never reject only
because the owner has not approved yet — judge whether the change itself is correct, scoped and safe.
When unsure, reject. Answer with ONLY a JSON object: {"verdict":"approve"|"reject","reason":"one short Persian sentence"}`;

export function reviewPrompt({ requester, request, ownerAnswers = "", narrative, tool, args, change }) {
  return `${REVIEW_SYSTEM}

Requester: ${requester}
Original request:
${request || "(unknown)"}

The owner's answers so far in this request:
${ownerAnswers || "(none)"}

What the agent said/thought just before this call (latest last):
${narrative || "(nothing)"}

The change (${change}):
tool: ${tool}
args: ${args}`;
}

export function parseVerdict(text) {
  const raw = String(text || "");
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  try {
    const v = JSON.parse(json);
    const verdict = String(v.verdict || "").toLowerCase() === "approve" ? "approve" : "reject";
    return { verdict, reason: String(v.reason || "").slice(0, 300) };
  } catch {
    return { verdict: "none", reason: "جواب بازبین قابل خواندن نبود" };
  }
}

// One ask -> { verdict: "approve"|"reject"|"none" }. "none" = the reviewer could not answer
// (timeout, error, unreadable reply) — never a veto (a reviewer timeout once blocked every
// gitlab_propose of a chain and told the agent never to retry).
async function askOnce(r, prompt, timeoutMs) {
  let timer;
  try {
    const text = await Promise.race([
      r.ask(prompt),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
    ]);
    return parseVerdict(text);
  } catch (error) {
    return { verdict: "none", reason: `بازبینی انجام نشد (${String(error.message).slice(0, 80)})` };
  } finally {
    clearTimeout(timer);
  }
}

// Retry once, then the reviewer's fallback model if it has one; still "none" -> the other reviewer decides.
async function verdictOf(r, prompt, timeoutMs) {
  let note;
  for (const who of [r, r, r.fallback].filter(Boolean)) {
    note = { label: who.label, ...(await askOnce(who, prompt, timeoutMs)) };
    if (note.verdict !== "none") return note;
  }
  return { ...note, label: r.label };
}

function chainContext(store, chatId) {
  const rootId = store?.rootChatId?.(chatId) || chatId;
  const root = store?.getChat?.(rootId);
  const firstUser = (id) => {
    for (const e of store?.allEvents?.(id) || []) if (e.type === "user" && e.data?.text) return String(e.data.text);
    return "";
  };
  // The agent's own words in this chat, plus every steer/request it received — the review
  // must see a parent's «do it, push to main» as well as the child's earlier refusal.
  const parts = [];
  let text = "";
  for (const e of store?.allEvents?.(chatId) || []) {
    if (e.type === "text" || e.type === "thinking") text += e.data?.text || "";
    else {
      if (text.trim()) parts.push(text.trim());
      text = "";
      if (e.type === "user" && e.data?.text) parts.push(`[message to the agent] ${e.data.text}`);
    }
  }
  if (text.trim()) parts.push(text.trim());
  const narrative = maskText(parts.join("\n---\n")).slice(-5000);
  // What the owner already said yes/no to in this request (root and this chat) — so a reviewer
  // does not block what the owner has explicitly okayed in the conversation.
  const answers = [];
  for (const id of new Set([rootId, chatId])) {
    for (const e of store?.allEvents?.(id) || []) {
      if (e.type !== "tool.done" || e.data?.name !== "ask_owner" || !e.data?.result?.answered) continue;
      answers.push(`- Q: ${String(e.data.args?.question || "").replace(/\s+/g, " ").slice(0, 400)}\n  A: ${String(e.data.result.answer || "").slice(0, 200)}`);
    }
  }
  const ownerAnswers = maskText(answers.slice(-8).join("\n"));
  return {
    requester: `${root?.caller || "?"}${root?.title ? ` — ${root.title}` : ""}`,
    request: maskText(firstUser(rootId)).slice(0, 2500),
    narrative,
    ownerAnswers,
    ownerRooted: (root?.caller || "owner") === "owner",
    unattended: ["scheduler", "ops"].includes(root?.caller) || Boolean(root?.job_id),
    rootId,
  };
}

const CACHE_MS = 60 * 60 * 1000;
const decided = new Map(); // `${root}\0${tool}\0${args}` -> { ok, notes, at }

export function forgetReviews() {
  decided.clear();
}

// reviewers: [{ label, ask(prompt) -> Promise<string> }] — exactly the two independent agents.
export const REVIEW_ENABLED = String(process.env.GRIFFIN_REVIEW || "").toLowerCase() === "on";

export function reviewChanges(tools, { chatId, store, asks = null, reviewers = [], log = console, timeoutMs = 90_000, enabled = REVIEW_ENABLED } = {}) {
  if (!enabled || reviewers.length < 2) return tools; // ponytail: opt-in, and needs two reviewers wired
  const out = { ...tools };
  for (const name of Object.keys(out)) {
    const tool = out[name];
    if (!tool?.execute) continue;
    const inner = tool.execute.bind(tool);
    out[name] = {
      ...tool,
      async execute(rawArgs) {
        const { intent: _i, why: _w, ...args } = rawArgs || {};
        const change = changeOf(name, args);
        if (!change) return inner(rawArgs);
        if (!reviewWorthy(name, args)) return inner(rawArgs);
        const ctx = chainContext(store, chatId);
        const shown = JSON.stringify(redactArgs(name, args)).slice(0, 4000);
        const key = `${ctx.rootId}\0${name}\0${shown}`;
        let result = decided.get(key);
        if (!result || Date.now() - result.at > CACHE_MS) {
          const prompt = reviewPrompt({ ...ctx, tool: name, args: shown, change });
          const notes = await Promise.all(reviewers.map((r) => verdictOf(r, prompt, timeoutMs)));
          const rejected = notes.some((n) => n.verdict === "reject");
          const answered = notes.some((n) => n.verdict !== "none");
          result = { ok: answered && !rejected, rejected, notes, at: Date.now() };
          if (answered) decided.set(key, result); // no verdict at all -> ask again next time
          log.info?.(`[review] ${chatId} ${name}: ${notes.map((n) => `${n.label}=${n.verdict}`).join(" ")}`);
        }
        const summary = result.notes.map((n) => `${n.label}: ${{ approve: "✅", reject: "⛔" }[n.verdict] || "⚠️"} ${n.reason}`).join("\n");
        store?.recordApproval?.({ chatId, caller: "review", tool: name, args: redactArgs(name, args), decision: result.ok ? "reviewed" : result.rejected ? "review-rejected" : "review-unanswered", detail: result.notes });
        if (result.ok) return inner(rawArgs);
        // In the owner's own chat the owner can still say yes; anywhere else a rejection stands.
        if (ctx.ownerRooted && !ctx.unattended && asks) {
          const conf = await confirmWithOwner(store, asks, chatId, `${result.rejected ? "دو بازبین با این تغییر موافق نیستند" : "بازبین‌ها جواب ندادند"}:\n${change}\n\n${summary}\n\nباز هم انجام بدهم؟`);
          store?.recordApproval?.({ chatId, caller: "review", tool: name, args: redactArgs(name, args), decision: consentOf(conf) ? "review-overridden" : "review-upheld", approver: "owner", detail: conf });
          if (consentOf(conf)) return inner(rawArgs);
        }
        const error = result.rejected
          ? "بازبین‌ها این تغییر را رد کردند؛ همین کار یا نسخهٔ دورزدهٔ آن را دوباره نزن. دلیل‌ها را به درخواست‌کننده بگو."
          : "بازبین‌ها جواب ندادند (timeout/خطا) — تغییر رد نشده؛ چند دقیقه بعد همین فراخوانی را دوباره بزن.";
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error, reviews: result.notes }) }] };
      },
    };
  }
  return out;
}
