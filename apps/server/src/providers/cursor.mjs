import { Agent, Cursor } from "@cursor/sdk";

export const PROVIDER_CURSOR = "cursor";

export function createCursorProvider({
  apiKey,
  defaultModel = "auto",
  builtinTools,
} = {}) {
  return {
    id: PROVIDER_CURSOR,
    defaultModel,
    async listModels() {
      if (!apiKey) return [];
      const list = await Cursor.models.list({ apiKey });
      return list.map((m) => ({
        id: m.id,
        name: m.displayName || m.name || m.id,
        provider: PROVIDER_CURSOR,
      }));
    },
    async health() {
      const started = Date.now();
      try {
        const response = await fetch("https://api.cursor.com/", {
          method: "HEAD",
          signal: AbortSignal.timeout(8_000),
        });
        return { ok: true, status: response.status, ms: Date.now() - started };
      } catch (error) {
        return {
          ok: false,
          error: error?.name === "TimeoutError" ? "timeout" : String(error?.cause?.code || error?.message),
          ms: Date.now() - started,
        };
      }
    },
    create(options) {
      return Agent.create(toCursorOptions(options, { apiKey, defaultModel, builtinTools }));
    },
    resume(agentId, options) {
      return Agent.resume(agentId, toCursorOptions(options, { apiKey, defaultModel, builtinTools }));
    },
    async clearStuck(agentId, options) {
      if (!agentId) return { cancelled: 0 };
      const listed = await Agent.listRuns(agentId, {
        runtime: "local",
        cwd: options?.cwd,
        limit: 20,
      }).catch(() => ({ items: [] }));
      let cancelled = 0;
      for (const run of listed.items || []) {
        if (String(run.status || "").toLowerCase() !== "running") continue;
        await Agent.cancelRun(run.id, { runtime: "local", cwd: options?.cwd }).catch(() => {});
        cancelled += 1;
      }
      return { cancelled };
    },
  };
}

function toCursorOptions(options, { apiKey, defaultModel, builtinTools }) {
  return {
    apiKey,
    model: { id: options.model?.id || defaultModel },
    tools: builtinTools,
    local: {
      cwd: options.cwd,
      settingSources: options.settingSources || ["project"],
      useHttp1ForAgent: true,
      customTools: options.customTools,
    },
  };
}
