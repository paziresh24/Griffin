// mr-explainer: the first module (docs/modules.md). It reads merge requests through the core's
// GitLab tools and gives the owner (or a colleague's install) a page that lists them with one button
// per row: «توضیح بده» opens a chat with the module's own agent.

import { categorize, pipelineLabel } from "./categorize.mjs";

const PROJECT = /^[\w.-]+(\/[\w.-]+)+$/;

export default function register(api) {
  const project = (value) => {
    const p = String(value || api.config("DEFAULT_PROJECT")).trim();
    if (!PROJECT.test(p)) throw new Error("پروژه را به شکل group/name بنویسید");
    return p;
  };

  // The rows of the page: one per merge request, each on a shelf (categorize.mjs) with the reason in
  // words. A project of «*» is every project the GitLab token can see.
  api.source("mrs", async (query) => {
    const state = ["opened", "merged", "closed"].includes(query.state) ? query.state : "opened";
    const all = ["*", "all"].includes(String(query.project || "").trim());
    const args = { state, limit: 50 };
    if (!all) args.project = project(query.project);
    const author = String(query.author || "").trim().replace(/^@/, "");
    if (author) {
      if (!/^[\w.-]{1,100}$/.test(author)) throw new Error("نام کاربری GitLab درست نیست");
      args.author = author;
    }
    const result = await api.call("gitlab_mrs", args);
    // The list does not carry the pipeline or a settled merge status; one read per open MR does
    // (a few at a time). A read that fails leaves that row with what the list gave.
    const mrs = result.mergeRequests;
    if (state === "opened") {
      for (let i = 0; i < mrs.length; i += 6) {
        await Promise.all(
          mrs.slice(i, i + 6).map(async (m, j) => {
            try {
              const one = await api.call("gitlab_mr", { project: m.project, iid: m.iid });
              mrs[i + j] = { ...m, pipeline: one.pipeline?.status || m.pipeline, detailedMergeStatus: one.detailedMergeStatus || m.detailedMergeStatus };
            } catch {
              // keep the list's own values
            }
          }),
        );
      }
    }
    return mrs.map((m) => {
      const { category, reason } = categorize(m);
      const files = Number(m.changesCount);
      return {
        ...m,
        id: `${m.project}!${m.iid}`,
        category,
        reason,
        pipeline: pipelineLabel(m.pipeline),
        pipelineStatus: m.pipeline || "",
        branches: m.sourceBranch ? `${m.sourceBranch} ← ${m.targetBranch || ""}`.replace(/ ← $/, "") : "",
        changes: Number.isFinite(files) && files > 0 ? `${files} فایل` : "",
        comments: m.comments ? `${m.comments} نظر` : "",
        labels: (m.labels || []).join("، "),
        reviewers: (m.reviewers || []).join("، "),
      };
    });
  });

  // The button: the page opens a chat with this agent and this first message. Nothing runs here.
  api.action("explain", async ({ row }) => {
    const iid = Number(row?.iid);
    if (!Number.isInteger(iid) || iid < 1) throw new Error("شمارهٔ MR معلوم نیست");
    const where = project(row?.project);
    return {
      openChat: {
        agent: "mr-explainer",
        title: `توضیح MR !${iid}`,
        text: `MR شمارهٔ ${iid} در پروژهٔ ${where} را برایم توضیح بده: هدفش چیست، هر بخش از تغییر چه می‌کند، ریسکش چیست و آمادهٔ مرج هست یا نه.`,
      },
    };
  });

  // For the agent: the shape of a change without its diff, so it reads only what matters.
  api.tool("overview", {
    description: "نمای کلی یک MR: فایل‌های تغییرکرده گروه‌بندی‌شده بر اساس پوشه، با تعداد خط اضافه و کم (بدون دیف)",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, iid: { type: "integer", minimum: 1 } },
      required: ["project", "iid"],
      additionalProperties: false,
    },
    async execute({ project: p, iid }) {
      const [mr, changes] = await Promise.all([api.call("gitlab_mr", { project: project(p), iid }), api.call("gitlab_mr_changes", { project: project(p), iid })]);
      const groups = {};
      for (const f of changes.files || []) {
        const area = String(f.path || f.newPath || "").split("/").slice(0, 2).join("/") || ".";
        const g = (groups[area] ||= { area, files: 0, added: 0, removed: 0, paths: [] });
        g.files += 1;
        g.added += f.added || 0;
        g.removed += f.removed || 0;
        if (g.paths.length < 8) g.paths.push(f.path || f.newPath);
      }
      return {
        title: mr.title,
        state: mr.state,
        draft: mr.draft,
        description: mr.description,
        pipeline: mr.pipeline,
        fileCount: changes.fileCount,
        areas: Object.values(groups).sort((a, b) => b.added + b.removed - (a.added + a.removed)),
        note: "برای دیدن دیف یک فایل: gitlab_mr_changes با path",
      };
    },
  });
}
