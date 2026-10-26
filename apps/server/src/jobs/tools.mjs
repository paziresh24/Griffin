import { TriggerError } from "./triggers.mjs";

// chatId: the chat these tools run in. Any jobs_create / jobs_update from it records it as the job's
// writer (options.promptChatId, read by jobs/owner-jobs.mjs) — a schedule, agent or destination
// change steers the job as much as its prompt does. writerOf(chatId) may answer "unknown" instead,
// for a chat already carrying someone else's words (index.mjs). Without a chat: "unknown", never
// the owner.
export function createJobTools({ jobs, targets = () => [], chatId = null, writerOf = (id) => id }) {
  const writer = () => (chatId ? String(writerOf(chatId) || "unknown") : "unknown");
  const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const fail = (error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: String(error?.message || error) }) }] });

  function summarize(job) {
    const view = jobs.view(job);
    return {
      id: view.id,
      name: view.name,
      prompt: view.prompt,
      agent: view.agent,
      mode: view.mode,
      enabled: view.enabled,
      trigger: view.triggerType,
      when: view.description,
      nextAt: view.nextAt,
      delivery: view.delivery,
      lastRun: view.lastRun
        ? { status: view.lastRun.status, startedAt: view.lastRun.startedAt, error: view.lastRun.error, summary: view.lastRun.summary }
        : null,
    };
  }

  function destinations() {
    return targets().map((t) => ({
      name: t.name,
      integration: t.integrationName,
      kind: t.kind,
      chat: t.chat,
      enabled: t.enabled,
    }));
  }

  function resolveTargets(deliverTo) {
    if (!Array.isArray(deliverTo) || !deliverTo.length) return [];
    const available = targets();
    const resolved = [];
    for (const raw of deliverTo) {
      // The model copies a target from jobs_list as the whole object {integrationId, chat} (2026-10-21).
      const want = raw && typeof raw === "object" ? raw.chat ?? raw.name ?? "" : raw;
      const q = String(want || "").trim().toLowerCase();
      if (!q) continue;
      const hit =
        available.find((t) => String(t.chat) === String(want) || String(t.name).toLowerCase() === q || String(t.integrationName).toLowerCase() === q) ||
        available.find((t) => String(t.name).toLowerCase().includes(q) || String(t.integrationName).toLowerCase().includes(q));
      if (!hit) {
        const names = available.map((t) => t.name).filter(Boolean).join("، ") || "هیچ گفتگوی وصل‌شده‌ای نیست";
        throw new TriggerError(`مقصد «${want}» پیدا نشد. وصل‌شده‌ها: ${names}`);
      }
      resolved.push({ integrationId: hit.integrationId, chat: hit.chat });
    }
    return resolved;
  }

  function inputFromTool(args, current = null) {
    const every = args.every !== undefined ? String(args.every || "").trim() : "";
    const cron = args.cron !== undefined ? String(args.cron || "").trim() : "";
    let triggerType = args.triggerType || current?.triggerType;
    let trigger = args.trigger ?? current?.trigger;
    if (cron) {
      triggerType = "schedule";
      trigger = { cron };
    } else if (every) {
      triggerType = "schedule";
      trigger = { every };
    } else if (!triggerType) {
      triggerType = "schedule";
      trigger = { every: "30m" };
    }
    const delivery = {
      notify: args.notify || current?.delivery?.notify || "always",
      targets: args.deliverTo !== undefined ? resolveTargets(args.deliverTo) : current?.delivery?.targets || [],
    };
    const patch = { triggerType, trigger, delivery, promptChatId: writer() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.prompt !== undefined) patch.prompt = args.prompt;
    if (args.agent !== undefined) patch.agent = args.agent;
    if (args.mode !== undefined) patch.mode = args.mode;
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    if (args.options !== undefined) patch.options = args.options;
    return patch;
  }

  return {
    jobs_list: {
      description:
        "List scheduled jobs (name, when it next runs, last run) and the messenger chats a job can be delivered to. Use before creating or changing a job.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return ok({ jobs: jobs.list().map(summarize), destinations: destinations() });
      },
    },

    jobs_create: {
      description:
        "Create a scheduled job the chosen agent will run later (hidden chat). Time: every (30m, 1h, 6h) or cron (the owner's time zone). Official output goes to deliverTo (paired messenger chats from jobs_list). agent defaults to griffin, which can orchestrate specialists via ask_agent.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "short Persian name" },
          prompt: { type: "string", description: "the instruction the agent should follow each run" },
          agent: { type: "string", enum: ["griffin", "platform", "arvan-ban", "nsin-ban"], description: "which agent runs the job" },
          mode: { type: "string", enum: ["agent", "auto", "ask", "edits", "plan", "limited"], description: "how a job the owner wrote runs: agent = all his chat tools, nothing asks (default); auto/ask/edits = same tools, risky calls ask him; plan = plans only; limited = the lean scheduler quota, risky calls refused. A job anyone else wrote always runs limited." },
          every: { type: "string", description: "interval such as 30m, 1h, 6h, 1d (owner's wall clock)" },
          cron: { type: "string", description: "5-field cron in the owner's time zone, e.g. 0 8 * * *" },
          triggerType: { type: "string", enum: ["schedule", "manual"] },
          deliverTo: { type: "array", items: { type: ["string", "object"] }, description: "paired messenger chats from jobs_list: a name, a chat id, or the {integrationId, chat} entry itself" },
          notify: { type: "string", enum: ["always", "error", "never"] },
          enabled: { type: "boolean" },
        },
        required: ["name", "prompt"],
        additionalProperties: false,
      },
      async execute(args) {
        try {
          return ok(summarize(jobs.create(inputFromTool(args || {}))));
        } catch (error) {
          return fail(error);
        }
      },
    },

    jobs_update: {
      description: "Change an existing scheduled job (name, prompt, agent, mode, schedule, destinations, enabled). Pass only the fields that should change.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          prompt: { type: "string" },
          agent: { type: "string", enum: ["griffin", "platform", "arvan-ban", "nsin-ban"] },
          mode: { type: "string", enum: ["agent", "auto", "ask", "edits", "plan", "limited"], description: "how a job the owner wrote runs: agent = all his chat tools, nothing asks (default); auto/ask/edits = same tools, risky calls ask him; plan = plans only; limited = the lean scheduler quota, risky calls refused. A job anyone else wrote always runs limited." },
          every: { type: "string" },
          cron: { type: "string" },
          triggerType: { type: "string", enum: ["schedule", "manual"] },
          deliverTo: { type: "array", items: { type: ["string", "object"] } },
          notify: { type: "string", enum: ["always", "error", "never"] },
          enabled: { type: "boolean" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(args) {
        try {
          const current = jobs.get(args?.id);
          if (!current) return fail("جاب پیدا نشد");
          const job = jobs.update(current.id, inputFromTool(args || {}, current));
          return job ? ok(summarize(job)) : fail("جاب پیدا نشد");
        } catch (error) {
          return fail(error);
        }
      },
    },

    jobs_delete: {
      description: "Delete a scheduled job and its run history chats. Ask the owner first unless they already named that job to remove.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(args) {
        const id = String(args?.id || "");
        if (!jobs.get(id)) return fail("جاب پیدا نشد");
        jobs.remove(id);
        return ok({ ok: true, id });
      },
    },

    jobs_run: {
      description: "Run a scheduled job once now, without waiting for the schedule. Does not wait for the agent to finish.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(args) {
        const id = String(args?.id || "");
        if (!jobs.get(id)) return fail("جاب پیدا نشد");
        if (jobs.isRunning(id)) return fail("این جاب همین حالا در حال اجراست");
        // Who fired it decides the run's tools as much as who wrote it (jobs/owner-jobs.mjs).
        jobs.run(id, "manual", { by: writer() }).catch(() => {});
        return ok({ started: true, id });
      },
    },
  };
}
