// GRIFFIN_DEMO (or GRIFFIN_DEMO)=1: a scripted stand-in for @cursor/sdk so the UI can be developed and shown
// without a Cursor key. Never enabled in the compose deployment.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mcp = (toolName, args) => ({ type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName, args } });
const mcpResult = (value, isError = false) => ({
  status: "success",
  // Same shape the real SDK emits for MCP text content (seen on the capsule 2026-09-14).
  value: { content: [{ text: { text: JSON.stringify(value) } }], isError },
});

// The demo answers in the language of the message: Persian in, Persian out; anything else, English.
const isFa = (text) => /[\u0600-\u06FF]/.test(String(text || ""));
const L = (text, en, fa) => (isFa(text) ? fa : en);

function script(text) {
  const words = (s) => s.split(/(?<= )/).map((chunk) => ({ type: "text-delta", text: chunk }));
  const thinking = (s) => s.split(/(?<= )/).map((chunk) => ({ type: "thinking-delta", text: chunk }));
  const notes = {
    count: 3,
    notes: [
      { file: "team-preferences.md", title: L(text, "How the team likes reports", "گزارش‌ها را تیم چطور می‌خواهد"), reviewed: true },
      { file: "customers.md", title: L(text, "Top customer questions this month", "سؤال‌های پرتکرار مشتری‌ها این ماه"), reviewed: true },
      { file: "billing.md", title: L(text, "Where invoices go", "فاکتورها کجا می‌روند"), reviewed: false },
    ],
  };
  const jobs = { jobs: [{ name: L(text, "Weekly feedback", "بازخورد هفتگی"), trigger: L(text, "Mondays 09:00", "دوشنبه‌ها ۰۹:۰۰"), destination: L(text, "Team chat", "چت تیم"), enabled: true }] };
  return [
    ...thinking(L(text,
      "They want to know what I can do here. I'll check what I already know and what runs on a schedule, then answer with concrete examples. ",
      "می‌خواهد بداند این‌جا چه کارهایی از دستم برمی‌آید. اول می‌بینم چه چیزهایی می‌دانم و چه کاری زمان‌بندی شده، بعد با مثال جواب می‌دهم. ")),
    { type: "thinking-completed", thinkingDurationMs: 1800 },
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
              { content: L(text, "Read saved notes", "خواندن یادداشت‌ها"), status: "in_progress" },
              { content: L(text, "Check scheduled jobs", "دیدن جاب‌های زمان‌بندی‌شده"), status: "pending" },
              { content: L(text, "Answer with examples", "جواب با مثال"), status: "pending" },
            ],
          },
        },
      },
    },
    ...words(L(text, "Let me check what I already know. ", "اول می‌بینم چه چیزهایی می‌دانم. ")),
    { type: "tool-call-started", callId: "n1", toolCall: mcp("knowledge_list", {}) },
    { pause: 1100 },
    { type: "tool-call-completed", callId: "n1", toolCall: { ...mcp("knowledge_list", {}), result: mcpResult(notes) } },
    { type: "tool-call-started", callId: "j1", toolCall: mcp("jobs_list", {}) },
    { pause: 900 },
    { type: "tool-call-completed", callId: "j1", toolCall: { ...mcp("jobs_list", {}), result: mcpResult(jobs) } },
    ...words(L(text,
      "**Here is what I can do for you right now:**\n\n| Ask me to… | For example |\n|---|---|\n| Summarize | “Summarize this document in five lines” |\n| Schedule | “Every Monday, send the team last week's summary” |\n| Delegate | “Have the researcher compare these two tools” |\n| Remember | “Remember that invoices go to finance” |\n\n",
      "**این کارها الان از دستم برمی‌آید:**\n\n| از من بخواه… | مثلاً |\n|---|---|\n| خلاصه کنم | «این متن را در پنج خط خلاصه کن» |\n| زمان‌بندی کنم | «هر دوشنبه خلاصهٔ هفتهٔ قبل را برای تیم بفرست» |\n| بسپارم | «از پژوهشگر بخواه این دو ابزار را مقایسه کند» |\n| به خاطر بسپارم | «یادت باشد فاکتورها به مالی می‌روند» |\n\n")),
    ...words(L(text,
      "I already have **3 notes** and **1 scheduled job** (Weekly feedback, Mondays 09:00). Add agents and tools on the Agents page and I'll use them. Try “chart”, “report” or “ask me a question” to see more.",
      "الان **۳ یادداشت** و **۱ جاب زمان‌بندی‌شده** دارم (بازخورد هفتگی، دوشنبه‌ها ۰۹:۰۰). از صفحهٔ ایجنت‌ها ایجنت و ابزار اضافه کن تا از آن‌ها استفاده کنم. برای دیدن بقیه بنویس «نمودار»، «گزارش» یا «سؤال».")),
    { type: "turn-ended", usage: { inputTokens: 12480, outputTokens: 418 } },
  ];
}

// "question" / "سؤال" in the message: the agent asks through ask_owner and continues with the answer.
async function askScenario(options, localTools, cancelledRef) {
  const say = async (s) => {
    for (const chunk of s.split(/(?<= )/)) {
      await options.onDelta({ update: { type: "text-delta", text: chunk } });
      await sleep(35);
    }
  };
  const text = options.text || "";
  await say(L(text, "Before I write the summary I need one decision from you. ", "قبل از نوشتن خلاصه یک تصمیم از تو لازم دارم. "));
  const args = {
    question: L(text, "Who should the weekly summary go to?", "خلاصهٔ هفتگی برای چه کسی برود؟"),
    options: [
      { label: L(text, "The whole team", "کل تیم"), description: L(text, "Posted in the Team chat (suggested)", "در چت تیم (پیشنهادی)") },
      { label: L(text, "Just me", "فقط خودم"), description: L(text, "Sent to you privately", "فقط برای خودت") },
    ],
  };
  const call = { type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: "ask_owner", args } };
  await options.onDelta({ update: { type: "tool-call-started", callId: "ask1", toolCall: call } });
  const result = await localTools.ask_owner.execute(args);
  await options.onDelta({ update: { type: "tool-call-completed", callId: "ask1", toolCall: { ...call, result: { status: "success", value: result } } } });
  if (cancelledRef.cancelled) return;
  const answer = JSON.parse(result.content[0].text);
  await say(answer.answered ? L(text, `Okay — ${answer.answer}. `, `باشه، ${answer.answer}. `) : L(text, "No answer came; stopping here.", "جوابی نیامد؛ متوقف می‌شوم."));
}

// "report" / "file" (or Persian) in the message: write a Markdown report into the workspace and show it through
// the real show_media tool (same content shape as with Cursor: summary JSON + text for the model).
async function mediaScenario(options, localTools) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workspace = process.env.GRIFFIN_WORKSPACE || process.env.GRIFFIN_WORKSPACE || "/workspace";
  const file = path.join(workspace, "demo-report.md");
  const text = options.text || "";
  await fs.writeFile(file, L(text,
    "# Weekly feedback (demo)\n\n| Theme | Mentions |\n|---|---|\n| Faster replies | 14 |\n| Clearer pricing | 9 |\n| Mobile app bugs | 6 |\n\n1. **Top request:** faster replies\n2. Follow up on the pricing questions\n",
    "# بازخورد هفتگی (نمایشی)\n\n| موضوع | تعداد |\n|---|---|\n| جواب سریع‌تر | ۱۴ |\n| قیمت‌گذاری روشن‌تر | ۹ |\n| باگ اپ موبایل | ۶ |\n\n1. **درخواست اول:** جواب سریع‌تر\n2. پیگیری سؤال‌های قیمت\n"));
  const args = { path: file, title: L(text, "Weekly feedback (demo)", "بازخورد هفتگی (نمایشی)") };
  const call = { type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: "show_media", args } };
  await options.onDelta({ update: { type: "tool-call-started", callId: "media1", toolCall: call } });
  const result = await localTools.show_media.execute(args);
  await options.onDelta({ update: { type: "tool-call-completed", callId: "media1", toolCall: { ...call, result: { status: "success", value: { ...result, content: result.content.map((c) => (c.type === "text" ? { text: { text: c.text } } : c)) } } } } });
  for (const chunk of L(text, "The report is ready and shown above.", "گزارش آماده است و بالا نمایش داده شد.").split(/(?<= )/)) {
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

// "chart" / "نمودار" in the message: query stats, then draw with visualize.
async function chartScenario(options, localTools) {
  const say = async (s) => {
    for (const chunk of s.split(/(?<= )/)) {
      await options.onDelta({ update: { type: "text-delta", text: chunk } });
      await sleep(35);
    }
  };
  const text = options.text || "";
  await say(L(text, "I'll add up activity over the last 24 hours and draw it. ", "فعالیت ۲۴ ساعت اخیر را جمع می‌زنم و نمودارش را می‌کشم. "));
  const args = {
    title: L(text, "Activity over 24 hours", "فعالیت ۲۴ ساعت اخیر"),
    description: L(text, "Requests per 5 minutes, in hundreds (demo data)", "درخواست در هر ۵ دقیقه، به صد (دادهٔ نمایشی)"),
    datasets: [{ name: "memory", prometheus: { cluster: "demo", promql: "sum(rate(requests_total[5m]))", range: "24h", scale: 1 / 2 ** 30, unit: "×100" } }],
    spec: {
      data: { name: "memory" },
      mark: "line",
      encoding: {
        x: { field: "time", type: "temporal", title: null },
        y: { field: "value", type: "quantitative", title: L(text, "requests (×100)", "درخواست (×۱۰۰)") },
        tooltip: [{ field: "time", type: "temporal", title: L(text, "time", "زمان"), format: "%H:%M" }, { field: "value", type: "quantitative", title: L(text, "requests (×100)", "درخواست (×۱۰۰)"), format: ".1f" }],
      },
    },
  };
  const call = { type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: "visualize", args } };
  await options.onDelta({ update: { type: "tool-call-started", callId: "viz1", toolCall: call } });
  const result = await localTools.visualize.execute(args);
  await options.onDelta({ update: { type: "tool-call-completed", callId: "viz1", toolCall: { ...call, result: { status: "success", value: result } } } });
  await say(L(text, "Activity peaks around noon and is lowest after midnight.", "اوج فعالیت حوالی ظهر و کمترینش بعد از نیمه‌شب است."));
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
          if (/نمودار|chart/i.test(text) && localTools?.visualize) {
            await chartScenario({ ...options, text }, localTools);
            return { id: run.id, status: cancelled ? "cancelled" : "finished" };
          }
          if (/فایل|گزارش|report|file/i.test(text) && localTools?.show_media) {
            await mediaScenario({ ...options, text }, localTools);
            return { id: run.id, status: cancelled ? "cancelled" : "finished" };
          }
          if (/سؤال|سوال|question/i.test(text) && localTools?.ask_owner) {
            const ref = { get cancelled() { return cancelled; } };
            await askScenario({ ...options, text }, localTools, ref);
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
