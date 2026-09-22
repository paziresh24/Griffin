import { publicProfile, resolveEnabledTools, SELF_MGMT_TOOLS, unique } from "./profiles.mjs";
import { normalizeProvider, PROVIDERS } from "../providers/index.mjs";

export function createAgentSettingsTools({ store, catalogNames }) {
  function profileOf(chatId) {
    const chat = store.getChat(chatId);
    const id = chat?.agent || "griffin";
    const profile = store.getAgentProfile(id);
    if (!profile) throw new Error(`unknown agent profile: ${id}`);
    return profile;
  }

  function names() {
    return typeof catalogNames === "function" ? catalogNames() : catalogNames || [];
  }

  return {
    list_agents: {
      description:
        "List Griffin agent profiles (id, label, domain, provider). Use this to discover peers before ask_agent — do not invent agent ids.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const agents = store.listAgentProfiles().map((p) => ({
          id: p.id,
          label: p.label,
          domain: p.domain,
          provider: p.provider,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ agents }) }] };
      },
    },

    agent_tools_list: {
      description:
        "List the tool catalog and which tools are enabled on THIS agent profile. Use before agent_tools_enable/disable.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        const chatId = ctx?.chatId;
        const profile = profileOf(chatId);
        const catalog = names();
        const enabled = new Set(resolveEnabledTools(profile, { caller: "owner", catalogNames: catalog }));
        const tools = catalog.map((name) => ({ name, enabled: enabled.has(name) }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agent: profile.id,
              allPlatform: Boolean(profile.meta?.allPlatform),
              disabled: profile.meta?.disabled || [],
              tools,
            }),
          }],
        };
      },
    },

    agent_tools_enable: {
      description:
        "Enable (add) one or more tools from the catalog on THIS agent profile only. Names must exist in the catalog.",
      inputSchema: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 40,
            description: "Tool names to enable",
          },
        },
        required: ["tools"],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const profile = profileOf(ctx?.chatId);
        const catalog = new Set(names());
        const want = unique(args?.tools || []);
        const unknown = want.filter((n) => !catalog.has(n));
        if (unknown.length) {
          return { isError: true, content: [{ type: "text", text: `unknown tools: ${unknown.join(", ")}` }] };
        }
        const next = store.enableAgentTools(profile.id, want);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agent: next.id,
              enabled: want,
              tools: next.tools,
              disabled: next.meta?.disabled || [],
              note: "New tools apply on the next agent run (new message).",
            }),
          }],
        };
      },
    },

    agent_tools_disable: {
      description: "Disable (remove) tools from THIS agent profile. Self-management tools cannot be disabled.",
      inputSchema: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 40,
          },
        },
        required: ["tools"],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const profile = profileOf(ctx?.chatId);
        const want = unique(args?.tools || []);
        const blocked = want.filter((n) => SELF_MGMT_TOOLS.includes(n));
        if (blocked.length) {
          return {
            isError: true,
            content: [{ type: "text", text: `cannot disable self-management tools: ${blocked.join(", ")}` }],
          };
        }
        const next = store.disableAgentTools(profile.id, want);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agent: next.id,
              disabled: want,
              tools: next.tools,
              metaDisabled: next.meta?.disabled || [],
              note: "Takes effect on the next agent run.",
            }),
          }],
        };
      },
    },

    agent_settings_get: {
      description: "Read THIS agent profile settings: provider (cursor|claude), model, label, domain.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        const profile = profileOf(ctx?.chatId);
        return { content: [{ type: "text", text: JSON.stringify(publicProfile(profile)) }] };
      },
    },

    agent_settings_set: {
      description:
        "Update THIS agent profile settings. provider: cursor|claude; model: provider model id or empty for auto.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", enum: [...PROVIDERS] },
          model: { type: "string", description: "Model id; empty string clears to auto" },
          label: { type: "string" },
          domain: { type: "string" },
          blurb: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const profile = profileOf(ctx?.chatId);
        const patch = {};
        if (typeof args?.provider === "string") patch.provider = normalizeProvider(args.provider);
        if (typeof args?.model === "string") patch.model = args.model.trim() || null;
        if (typeof args?.label === "string" && args.label.trim()) patch.label = args.label.trim();
        if (typeof args?.domain === "string") patch.domain = args.domain;
        if (typeof args?.blurb === "string") patch.blurb = args.blurb;
        if (!Object.keys(patch).length) {
          return { isError: true, content: [{ type: "text", text: "no settings to change" }] };
        }
        const next = store.updateAgentProfile(profile.id, patch);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ...publicProfile(next), note: "Provider/model apply on the next run." }),
          }],
        };
      },
    },
  };
}

/** Wrap tools so execute receives { chatId }. */
export function bindChatTools(toolMap, chatId) {
  const out = {};
  for (const [name, tool] of Object.entries(toolMap || {})) {
    out[name] = {
      ...tool,
      async execute(args) {
        return tool.execute(args, { chatId });
      },
    };
  }
  return out;
}
