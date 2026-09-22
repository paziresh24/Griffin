import { TriggerError } from "./triggers.mjs";

export function createJobTools({ jobs, targets = () => [] }) {
  const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const fail = (error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: String(error?.message || error) }) }] });

  function summarize(job) {
    const view = jobs.view(job);
    return {
      id: view.id,
      name: view.name,
      prompt: view.prompt,
      agent: view.agent,
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
    for (const want of deliverTo) {
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
    const patch = { triggerType, trigger, delivery };
    if (args.name !== undefined) patch.name = args.name;
    if (args.prompt !== undefined) patch.prompt = args.prompt;
    if (args.agent !== undefined) patch.agent = args.agent;
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    if (args.options !== undefined) patch.options = args.options;
    return patch;
  }

  return {
    jobs_list: {
      description:
        "List Platform-Ban scheduled jobs (name, when it next runs, last run) and the messenger chats a job can be delivered to. Use before creating or changing a job.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return ok({ jobs: jobs.list().map(summarize), destinations: destinations() });
      },
    },

    jobs_create: {
      description:
        "Create a Griffin job the chosen agent will run later (hidden chat). Time: every (30m, 1h, 6h) or cron (Tehran). Official output goes to deliverTo (paired messenger chats from jobs_list). agent defaults to platform; use griffin to orchestrate via ask_agent.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "short Persian name" },
          prompt: { type: "string", description: "the instruction the agent should follow each run" },
          agent: { type: "string", enum: ["griffin", "platform", "arvan-ban", "nsin-ban"], description: "which agent runs the job" },
          every: { type: "string", description: "interval such as 30m, 1h, 6h, 1d (Tehran wall clock)" },
          cron: { type: "string", description: "5-field cron in Tehran time, e.g. 0 8 * * *" },
          triggerType: { type: "string", enum: ["schedule", "manual"] },
          deliverTo: { type: "array", items: { type: "string" }, description: "names of paired messenger chats from jobs_list" },
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
      description: "Change an existing Griffin job (name, prompt, agent, schedule, destinations, enabled). Pass only the fields that should change.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          prompt: { type: "string" },
          agent: { type: "string", enum: ["griffin", "platform", "arvan-ban", "nsin-ban"] },
          every: { type: "string" },
          cron: { type: "string" },
          triggerType: { type: "string", enum: ["schedule", "manual"] },
          deliverTo: { type: "array", items: { type: "string" } },
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
      description: "Delete a Platform-Ban job and its run history chats. Ask the owner first unless they already named that job to remove.",
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
      description: "Run a Platform-Ban job once now, without waiting for the schedule. Does not wait for the agent to finish.",
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
        jobs.run(id, "manual").catch(() => {});
        return ok({ started: true, id });
      },
    },
  };
}
