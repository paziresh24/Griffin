// An agent that lacks a tool builds it, with the owner's approval. It came from an MR review that
// stalled because no tool showed an MR's diff and a large file was parked where the agent could not read it.
//
// build_tool asks the owner once, in plain words. On yes a NEW chat of the owner's own builds the
// tool on the Griffin repo — a worktree, tests, a Draft MR — in the app container (never on the
// host with his keys), since the asking chain (often a colleague's) has neither files nor a shell.
// When that chat's first run ends, its report goes back to the chat that asked.
//
// What keeps this from being a way around the fences:
// - the owner says yes before anything starts, and again for the merge (the build chat's
//   gitlab_mr merge asks him; merging to main deploys every install by itself);
// - a merge on the Griffin repo that touches the guard files is refused in code from a build chat
//   or any chain not rooted in the owner, and the registry may only grow (protectedTouch);
// - the build chat's rules: read-only tools only, no new credentials, no values returned.
import { buildEnvelope } from "./peers.mjs";

export const BUILD_TOOL = "build_tool";
const KV = "toolbuilds";
const MAX_OPEN = 5;

// The files that decide who may do what. A tool built on request never changes them.
export const PROTECTED = [
  /^apps\/server\/src\/guard\.mjs$/,
  /^apps\/server\/src\/review\.mjs$/,
  /^apps\/server\/src\/tool-builder\.mjs$/,
  /^apps\/server\/src\/prompt\.mjs$/,
  /^apps\/server\/src\/auth\.mjs$/,
  /^apps\/server\/src\/peer-auth\.mjs$/,
  /^apps\/server\/src\/redact\.mjs$/,
  /^apps\/server\/src\/sim\.mjs$/,
  /^apps\/server\/src\/agents\/profiles\.mjs$/,
  /^apps\/server\/src\/providers\/file-scope\.mjs$/,
  /^apps\/server\/src\/providers\/host-spawn\.mjs$/,
  /^apps\/broker\/src\/(vault|secretbox|server)\.mjs$/,
  /^deploy\//,
  /^Dockerfile/,
  /^\.gitlab-ci/,
];
// The quota lists: a new tool name may be added, nothing removed or widened.
const ADD_ONLY = /^apps\/server\/src\/agents\/registry\.mjs$/;

/** Why a diff (gitlab_mr_changes files) may not be merged by an agent, or null. */
export function protectedTouch(files = []) {
  const hit = files.filter((f) => [f.path, f.oldPath].some((p) => p && PROTECTED.some((re) => re.test(p))));
  if (hit.length) return `به فایل‌های مرز دسترسی دست می‌زند: ${hit.map((f) => (f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path)).join("، ")}`;
  for (const f of files) {
    if (!ADD_ONLY.test(f.path || "")) continue;
    if (f.diffOmitted || f.tooLargeForGitlab) return `دیف ${f.path} کامل دیده نشد`;
    if (f.removed > 0 || /^-(?!--)/m.test(f.diff || "")) return `در ${f.path} سطری حذف یا عوض شده (فقط افزودن نام ابزار مجاز است)`;
  }
  return null;
}

export const isGriffinRepoProject = (project) => (String(process.env.GRIFFIN_SELF_REPO || "").split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)).includes(String(project || "").trim().toLowerCase());

export function buildCharter({ title, need, spec, from }) {
  return `[ساخت ابزار — درخواست از گفتگوی «${from}»؛ صاحب‌کار ساختنش را تأیید کرد]

ابزار: ${title}
چرا لازم شد: ${need}
مشخصات:
${spec}

How to build it (this chat is yours to finish; the requesting chat gets your final answer automatically):
- Work only in this chat's worktree of the Griffin repo. Read neighbours first and copy their shape: a broker tool
  lives in apps/broker/src/<area>.mjs ({description, inputSchema, execute}, ToolInputError for bad input) with a
  test in apps/broker/test/; an app tool in apps/server/src/ with a test in apps/server/test/. Give the new name a
  Persian label in apps/server/src/integrations/format.mjs, and add it to the callers that need it in
  apps/server/src/agents/registry.mjs — only ADD names there: never remove or widen an entry.
- Read-only only: GET/list/describe. No write, no new credential, no secret value in a result (mask or omit).
- Never touch: guard.mjs, review.mjs, tool-builder.mjs, prompt.mjs, auth.mjs, peer-auth.mjs, redact.mjs, sim.mjs,
  agents/profiles.mjs, providers/file-scope.mjs, providers/host-spawn.mjs, broker vault/secretbox/server, deploy/,
  Dockerfile, CI. A merge that touches them is refused in code.
- Run the tests in the worktree (npm test, or node --test on the touched workspace) and compare any red with main:
  only reds that main has too are acceptable — say which.
- Commit with a clear message, then repo_push {mrTitle, mrDescription} to open a Draft MR. Do not merge it yourself:
  ask the owner with ask_owner in one plain sentence (what the tool does, that tests pass); on yes, gitlab_mr ready
  then merge. Merging to main deploys every install within minutes.
- Final answer: the MR link, what the tool does, the test result, and whether it was merged.`;
}

// hasTool(name) -> true once that tool is in this install's catalog (a merge reaches it with the next
// update): the chat that asked is woken again then, to finish the work it was waiting on.
export function createToolBuilder({ store, runner, confirm, isYes, createBuildChat, hasTool = async () => false, log = console, livePollMs = 5 * 60_000 }) {
  const list = () => store.getKv(KV) || [];
  const save = (rows) => store.setKv(KV, rows.slice(-50));
  const update = (chatId, patch) => save(list().map((r) => (r.chat === chatId ? { ...r, ...patch } : r)));
  const isBuildChat = (chatId) => list().some((r) => r.chat === chatId);
  const wake = (chatId, text) => runner.send(chatId, { text, images: [], intent: runner.isActive(chatId) ? "queue" : "send" });
  // A subtask that asked (an arvan-ban thread of a colleague's chat) already reported to its parent:
  // waking it would answer nobody. The root is told, and steers that thread.
  function wakeAsker(fromId, text) {
    const root = store.rootChatId?.(fromId) ?? fromId;
    if (root === fromId || !store.getChat(root)) return wake(fromId, text);
    const thread = store.getChat(fromId);
    return wake(root, `${text}\n\nرشتهٔ «${thread?.title || fromId}» (id ${fromId}) این ابزار را خواسته بود: با subtasks steer همان را ادامه بده تا نتیجه به تو برگردد.`);
  }

  // Only a run that really ended reports: one cut by a restart continues by itself after the boot
  // (2026-10-19: the build of arvan_load_balancer_get was cut, its «cancelled» half was reported,
  // and the MR and merge that followed never reached the chain that asked — it told the colleague
  // «the owner is on it» and stopped). An error is said once and the build is still watched.
  function watch(row) {
    const onEvent = (event) => {
      if (event.type !== "run.finished") return;
      const status = event.data?.status || "error";
      const cut = status === "cancelled" && /ری‌استارت/.test(String(event.data?.error || ""));
      if (cut) return;
      if (status !== "finished") {
        const current = list().find((r) => r.chat === row.chat);
        if (current?.errorSaid) return;
        update(row.chat, { errorSaid: true });
        if (store.getChat(row.from)) store.appendEvent(row.from, null, "note", { text: `🛠 ساخت ابزار «${row.title}» ${status === "cancelled" ? "متوقف شد" : "با خطا قطع شد"}؛ اگر دوباره راه بیفتد و تمام شود، گزارشش همین‌جا می‌آید.` });
        return;
      }
      store.bus.off(`chat:${row.chat}`, onEvent);
      report(row, status).catch((error) => log.error?.(`[tool-builder] report ${row.chat}: ${error?.message || error}`));
    };
    store.bus.on(`chat:${row.chat}`, onEvent);
  }

  async function report(row, status) {
    const current = list().find((r) => r.chat === row.chat);
    if (!current || current.state !== "building") return;
    update(row.chat, { state: "reported", status, waitTool: true, reportedAt: new Date().toISOString() });
    if (!store.getChat(row.from)) return;
    const env = buildEnvelope(store, row.chat, { status });
    const text =
      `[گزارش خودکار ساخت ابزار «${row.title}» — این پیام را سیستم فرستاده، نه Owner]\n\n` +
      `${(env.summary || env.brief || "(بدون متن)").slice(-3_000)}\n\n` +
      `گفتگوی ساخت: ${row.chat}. اگر ادغام شد، وقتی ابزار روی همین نصب فعال شد دوباره خودکار خبرت می‌کنم تا کار اصلی را با آن تمام کنی؛ تا آن موقع به درخواست‌کننده بگو منتظر چه هستی. اگر ادغام نشد، همان را به درخواست‌کننده بگو.`;
    await wakeAsker(row.from, text);
    checkLive().catch(() => {});
  }

  // A reported build whose tool is now in the catalog: the chat that asked carries on with it.
  // Given up after three days (an MR nobody merged).
  async function checkLive() {
    for (const row of list().filter((r) => r.state === "reported" && r.waitTool)) {
      if (Date.now() - Date.parse(row.reportedAt || row.at) > 3 * 24 * 3600_000) {
        update(row.chat, { waitTool: false });
        continue;
      }
      if (!(await hasTool(row.title).catch(() => false))) continue;
      update(row.chat, { state: "live", waitTool: false });
      if (!store.getChat(row.from)) continue;
      await wakeAsker(
        row.from,
        `[ابزار «${row.title}» حالا روی همین نصب فعال است — این پیام را سیستم فرستاده، نه Owner]\n\nکاری که منتظر این ابزار بود را همین حالا با آن تمام کن و نتیجه را به درخواست‌کننده بده. اگر هنوز چیزی کم است، دقیق بگو چه.`,
      ).catch((error) => log.error?.(`[tool-builder] wake ${row.from}: ${error?.message || error}`));
    }
  }

  for (const row of list()) if (row.state === "building" && store.getChat(row.chat)) watch(row);
  const livePoll = setInterval(() => checkLive().catch(() => {}), livePollMs);
  livePoll.unref?.();
  setTimeout(() => checkLive().catch(() => {}), 60_000).unref?.();

  function tool(chat, { requester }) {
    return {
      description:
        "Build a missing READ-ONLY tool into Griffin when no tool can do what this work needs (e.g. an MR's diff, a paged read). Asks the owner once; on yes a separate build chat writes it with tests and opens a Draft MR, and its report comes back here by itself — end your turn after calling it. Not for writes, credentials or anything a terminal command can already do.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 3, maxLength: 80, description: "the tool, e.g. gitlab_mr_changes" },
          need: { type: "string", minLength: 10, maxLength: 600, description: "one plain Persian sentence: what work is blocked without it" },
          spec: { type: "string", minLength: 20, maxLength: 3000, description: "inputs, output, which API it reads, limits" },
        },
        required: ["title", "need", "spec"],
        additionalProperties: false,
      },
      async execute(args) {
        const title = String(args?.title || "").trim().slice(0, 80);
        const need = String(args?.need || "").trim().slice(0, 600);
        const spec = String(args?.spec || "").trim().slice(0, 3000);
        if (!title || !need || !spec) return fail("title, need and spec are required");
        if (isBuildChat(chat.id)) return fail("this is already a build chat: build it here");
        const rows = list();
        const same = rows.find((r) => r.state === "building" && r.title.toLowerCase() === title.toLowerCase());
        if (same) return ok({ chatId: same.chat, already: true, note: "this tool is already being built; its report comes back to the chat that asked first" });
        if (rows.filter((r) => r.state === "building").length >= MAX_OPEN) return fail(`${MAX_OPEN} tools are already being built; wait for them`);
        const question = `${requester} کاری خواسته که ابزارش را نداریم: ${need}\nمی‌خواهم ابزار «${title}» را به گریفین اضافه کنم (فقط خواندنی؛ با تست و MR، ادغامش را جدا از شما می‌پرسم). اوکیه؟`;
        const conf = await confirm(chat.id, question);
        if (!isYes(conf)) return fail(`the owner did not approve building ${title}${conf?.answer ? ` (answer: ${conf.answer})` : ""}; say what is missing instead`);
        const built = await createBuildChat({ title, text: buildCharter({ title, need, spec, from: chat.title || chat.id }) });
        const row = { chat: built.id, from: chat.id, title, state: "building", at: new Date().toISOString() };
        save([...list(), row]);
        watch(row);
        store.appendEvent(chat.id, null, "note", { text: `🛠 ساخت ابزار «${title}» شروع شد (گفتگوی ${built.id}).` });
        return ok({ chatId: built.id, started: true, note: "end your turn now; the build report arrives here automatically" });
      },
    };
  }

  return { tool, isBuildChat, list, checkLive, stop: () => clearInterval(livePoll) };
}

const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }] });

/** gitlab_mr merge on the Griffin repo from a build chat or a chain not rooted in the owner:
 * refused when the diff touches the fences; from a build chat the owner is asked first. */
export function guardGriffinMerge(tools, { chatId, buildChat, callBroker, confirm, isYes }) {
  const mr = tools?.gitlab_mr;
  if (!mr) return tools;
  return {
    ...tools,
    gitlab_mr: {
      ...mr,
      async execute(args, ...rest) {
        if (args?.action !== "merge" || !isGriffinRepoProject(args?.project)) return mr.execute(args, ...rest);
        const changes = await callBroker("gitlab_mr_changes", { project: args.project, iid: args.iid });
        const files = changes?.files || [];
        const why = protectedTouch(files);
        if (why) return fail(`merge refused: this MR ${why}. Only the owner merges that by hand — report it.`);
        if (buildChat) {
          const conf = await confirm(chatId, `ابزار تازهٔ گریفین آماده است (MR !${args.iid}، ${files.length} فایل). ادغامش کنم؟ بعد از ادغام همهٔ نصب‌ها خودکار به‌روز می‌شوند.`);
          if (!isYes(conf)) return fail("the owner did not approve the merge; leave the MR open and report");
        }
        return mr.execute(args, ...rest);
      },
    },
  };
}
