// GRIFFIN_DEMO (or GRIFFIN_DEMO)=1: a scripted stand-in for @cursor/sdk so the UI can be developed and shown
// without a Cursor key. Never enabled in the compose deployment.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mcp = (toolName, args) => ({ type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName, args } });
const mcpResult = (value, isError = false) => ({
  status: "success",
  // Same shape the real SDK emits for MCP text content (seen on the capsule 2026-09-14).
  value: { content: [{ text: { text: JSON.stringify(value) } }], isError },
});

function script(text) {
  const words = (s) => s.split(/(?<= )/).map((chunk) => ({ type: "text-delta", text: chunk }));
  const thinking = (s) => s.split(/(?<= )/).map((chunk) => ({ type: "thinking-delta", text: chunk }));
  return [
    ...thinking("کاربر وضعیت کلاستر و دیسک را می‌خواهد. اول وضعیت پروداکشن را از broker می‌گیرم، بعد df دیسک ۱. "),
    { type: "thinking-completed", thinkingDurationMs: 2100 },
    {
      type: "tool-call-completed",
      callId: "todo1",
      toolCall: {
        type: "updateTodos",
        args: {},
        result: {
          status: "success",
          value: {
            todos: [
              { content: "وضعیت پادهای پروداکشن", status: "in_progress" },
              { content: "فضای دیسک ۱ S3", status: "pending" },
              { content: "جمع‌بندی برای Owner", status: "pending" },
            ],
          },
        },
      },
    },
    ...words(`برای «${text.slice(0, 40)}» اول وضعیت کلاستر پروداکشن را می‌خوانم. `),
    { type: "tool-call-started", callId: "k1", toolCall: mcp("kube_status", { cluster: "prod" }) },
    { pause: 1600 },
    {
      type: "tool-call-completed",
      callId: "k1",
      toolCall: {
        ...mcp("kube_status", { cluster: "prod" }),
        result: mcpResult({
          cluster: "prod",
          scope: "cluster",
          counts: { total: 412, by_phase: { Running: 405, Pending: 3, Failed: 4 } },
          pods: [
            { namespace: "team-a", name: "web-auth-7c9d", phase: "Running", reason: "CrashLoopBackOff", ready: "0/1", restarts: 37, node: "node-2" },
            { namespace: "storage", name: "seaweedfs-filer-2", phase: "Pending", reason: null, ready: "0/1", restarts: 0, node: "" },
          ],
          cnpg: [],
          source: "emergency-ssh 203.0.113.10:22",
          attempts: [
            { path: "public-api", ok: false, error: "timeout" },
            { path: "emergency-ssh", ok: true },
          ],
        }),
      },
    },
    ...words("API عمومی جواب نداد و از مسیر اضطراری خواندم؛ ۲ پاد مشکل دارند. حالا فضای دیسک ۱ را می‌گیرم. "),
    { type: "tool-call-started", callId: "d1", toolCall: mcp("kube_df", { cluster: "prod", namespace: "storage", pod: "seaweedfs-volume-1", path: "/data0" }) },
    { pause: 1200 },
    {
      type: "tool-call-completed",
      callId: "d1",
      toolCall: {
        ...mcp("kube_df", { cluster: "prod", namespace: "storage", pod: "seaweedfs-volume-1", path: "/data0" }),
        result: mcpResult({
          df: [{ filesystem: "/dev/sdb1", size: "905G", used: "896G", available: "8.6G", usePercent: "99%", mount: "/data0" }],
          source: "emergency-ssh 203.0.113.10:22",
          attempts: [{ path: "emergency-ssh", ok: true }],
        }),
      },
    },
    ...words("**نتیجه:**\n\n| مورد | مقدار |\n|---|---|\n| پادهای پروداکشن | `412` (۷ ناسالم) |\n| دیسک ۱ S3 آزاد | **8.6G** از 905G (۹۹٪ پر) |\n\n"),
    ...words("- `web-auth-7c9d` در `CrashLoopBackOff` با ۳۷ restart\n- `seaweedfs-filer-2` در Pending مانده\n\n"),
    ...words("دیسک ۱ تقریباً پر است؛ بدون دستور صریح شما PVC را تغییر نمی‌دهم."),
    { type: "turn-ended", usage: { inputTokens: 18234, outputTokens: 612 } },
  ];
}

// "سؤال" in the message: the agent asks through ask_owner and continues with the answer.
async function askScenario(options, localTools, cancelledRef) {
  const say = async (s) => {
    for (const chunk of s.split(/(?<= )/)) {
      await options.onDelta({ update: { type: "text-delta", text: chunk } });
      await sleep(35);
    }
  };
  await say("قبل از ساخت نمودار باید بدانم کدام کلاستر را می‌خواهی. ");
  const args = {
    question: "مصرف مموری api را برای کدام کلاستر نشان بدهم؟",
    options: [
      { label: "پروداکشن", description: "۱۶ پاد در team-b (پیشنهادی)" },
      { label: "آسیا", description: "در آسیا پادی از api پیدا نشد" },
    ],
  };
  const call = { type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: "ask_owner", args } };
  await options.onDelta({ update: { type: "tool-call-started", callId: "ask1", toolCall: call } });
  const result = await localTools.ask_owner.execute(args);
  await options.onDelta({ update: { type: "tool-call-completed", callId: "ask1", toolCall: { ...call, result: { status: "success", value: result } } } });
  if (cancelledRef.cancelled) return;
  const answer = JSON.parse(result.content[0].text);
  await say(answer.answered ? `باشه، ${answer.answer}. ` : "جوابی نیامد؛ متوقف می‌شوم.");
}

// "گزارش" / "فایل" in the message: write a Markdown report into the workspace and show it through
// the real show_media tool (same content shape as with Cursor: summary JSON + text for the model).
async function mediaScenario(options, localTools) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workspace = process.env.GRIFFIN_WORKSPACE || process.env.GRIFFIN_WORKSPACE || "/workspace";
  const file = path.join(workspace, "demo-report.md");
  await fs.writeFile(file, "# گزارش نمایشی\n\n| پاد | وضعیت | ری‌استارت |\n|---|---|---|\n| `prescription-v2-db-0` | CrashLoopBackOff | ۷۹ |\n| `seapi-7f7c9f44b9-bk47v` | Evicted | ۱ |\n\n1. **اولویت بالا:** دیتابیس نسخه‌ها\n2. پادهای Evicted را پاک کن\n");
  const args = { path: file, title: "گزارش نمایشی" };
  const call = { type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: "show_media", args } };
  await options.onDelta({ update: { type: "tool-call-started", callId: "media1", toolCall: call } });
  const result = await localTools.show_media.execute(args);
  await options.onDelta({ update: { type: "tool-call-completed", callId: "media1", toolCall: { ...call, result: { status: "success", value: { ...result, content: result.content.map((c) => (c.type === "text" ? { text: { text: c.text } } : c)) } } } } });
  for (const chunk of "گزارش آماده است و بالا نمایش داده شد.".split(/(?<= )/)) {
    await options.onDelta({ update: { type: "text-delta", text: chunk } });
    await sleep(35);
  }
}

// Synthetic Prometheus series for GRIFFIN_DEMO (or GRIFFIN_DEMO) only (clearly fake data; shape matches the broker).
export async function demoMetrics({ range = "24h", scale = 1 }) {
  const end = Math.floor(Date.now() / 1000);
  const step = 300;
  const count = range === "24h" ? 288 : 60;
  const GiB = 2 ** 30;
  const points = Array.from({ length: count }, (_, i) => {
    const hour = (i / 12) % 24;
    const daily = 2.2 + 9.5 * Math.max(0, Math.sin(((hour - 7) / 24) * Math.PI * 2)) ** 1.6;
    return [end - (count - 1 - i) * step, (daily + Math.sin(i / 3) * 0.25) * GiB * scale];
  });
  const values = points.map(([, v]) => v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { instant: false, step, start: points[0][0], end, series: [{ labels: {}, points }], scale, overall: { min, max }, domain: [0, Math.ceil(max / 2) * 2], source: "demo", attempts: [] };
}

// "نمودار" in the message: query stats, then draw with visualize.
async function chartScenario(options, localTools) {
  const say = async (s) => {
    for (const chunk of s.split(/(?<= )/)) {
      await options.onDelta({ update: { type: "text-delta", text: chunk } });
      await sleep(35);
    }
  };
  await say("مصرف مموری api در ۲۴ ساعت اخیر را جمع می‌زنم و نمودارش را می‌کشم. ");
  const args = {
    title: "مصرف مموری api",
    description: "پروداکشن · team-b · مجموع همهٔ پادها · ۲۴ ساعت · GiB (دادهٔ دمو)",
    datasets: [{ name: "memory", prometheus: { cluster: "prod", promql: 'sum(container_memory_working_set_bytes{namespace="team-b",pod=~"api-.*",container!="",container!="POD"})', range: "24h", scale: 1 / 2 ** 30, unit: "GiB" } }],
    spec: {
      data: { name: "memory" },
      mark: "line",
      encoding: {
        x: { field: "time", type: "temporal", title: null },
        y: { field: "value", type: "quantitative", title: "GiB" },
        tooltip: [{ field: "time", type: "temporal", title: "زمان", format: "%H:%M" }, { field: "value", type: "quantitative", title: "GiB", format: ".2f" }],
      },
    },
  };
  const call = { type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: "visualize", args } };
  await options.onDelta({ update: { type: "tool-call-started", callId: "viz1", toolCall: call } });
  const result = await localTools.visualize.execute(args);
  await options.onDelta({ update: { type: "tool-call-completed", callId: "viz1", toolCall: { ...call, result: { status: "success", value: result } } } });
  await say("اوج حدود **۱۱٫۹ GiB** حوالی ظهر و کمینه **۲ GiB** نیمه‌شب است.");
}

function makeAgent(agentId, agentOptions = {}) {
  return {
    agentId,
    async send(message, options) {
      const text = typeof message === "string" ? message : message.text;
      let cancelled = false;
      const run = {
        id: `demo-${Date.now()}`,
        supports: () => true,
        async cancel() {
          cancelled = true;
        },
        async steer() {
          return "revert_to_followup";
        },
        async wait() {
          await sleep(700);
          const localTools = agentOptions.local?.customTools;
          if (/نمودار/.test(text) && localTools?.visualize) {
            await chartScenario(options, localTools);
            return { id: run.id, status: cancelled ? "cancelled" : "finished" };
          }
          if (/فایل|گزارش/.test(text) && localTools?.show_media) {
            await mediaScenario(options, localTools);
            return { id: run.id, status: cancelled ? "cancelled" : "finished" };
          }
          if (/سؤال|سوال/.test(text) && localTools?.ask_owner) {
            const ref = { get cancelled() { return cancelled; } };
            await askScenario(options, localTools, ref);
            return { id: run.id, status: cancelled ? "cancelled" : "finished" };
          }
          for (const step of script(text)) {
            if (cancelled) return { id: run.id, status: "cancelled" };
            if (step.pause) {
              await sleep(step.pause);
              continue;
            }
            await options.onDelta({ update: step });
            await sleep(step.type?.endsWith("delta") ? 35 : 250);
          }
          return { id: run.id, status: "finished" };
        },
      };
      return run;
    },
  };
}

export const demoSdk = {
  create: async (options) => makeAgent(`demo-agent-${Date.now()}`, options),
  resume: async (id, options) => makeAgent(id, options),
};
