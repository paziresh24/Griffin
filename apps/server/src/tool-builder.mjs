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

export function createToolBuilder({ store, runner, confirm, isYes, createBuildChat, log = console }) {
  const list = () => store.getKv(KV) || [];
  const save = (rows) => store.setKv(KV, rows.slice(-50));
  const update = (chatId, patch) => save(list().map((r) => (r.chat === chatId ? { ...r, ...patch } : r)));
  const isBuildChat = (chatId) => list().some((r) => r.chat === chatId);

  function watch(row) {
    const onEvent = (event) => {
      if (event.type !== "run.finished") return;
      store.bus.off(`chat:${row.chat}`, onEvent);
      report(row, event.data?.status || "error").catch((error) => log.error?.(`[tool-builder] report ${row.chat}: ${error?.message || error}`));
    };
    store.bus.on(`chat:${row.chat}`, onEvent);
  }

  async function report(row, status) {
    const current = list().find((r) => r.chat === row.chat);
    if (!current || current.state !== "building") return;
    update(row.chat, { state: "reported", status });
    if (!store.getChat(row.from)) return;
    const env = buildEnvelope(store, row.chat, { status });
    const text =
      `[گزارش خودکار ساخت ابزار «${row.title}» — این پیام را سیستم فرستاده، نه Owner]\n\n` +
      `${(env.summary || env.brief || "(بدون متن)").slice(-3_000)}\n\n` +
      `گفتگوی ساخت: ${row.chat}. اگر ادغام شد، ابزار چند دقیقه بعد با آپدیت خودکار می‌رسد؛ کار اصلی را با آن ادامه بده. اگر ادغام نشد، همان را به درخواست‌کننده بگو.`;
    await runner.send(row.from, { text, images: [], intent: runner.isActive(row.from) ? "queue" : "send" });
  }

  for (const row of list()) if (row.state === "building" && store.getChat(row.chat)) watch(row);

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

  return { tool, isBuildChat, list };
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
