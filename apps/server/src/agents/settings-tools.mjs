import { agentNameError } from "../identity.mjs";
import { renameAssistant } from "../persona.mjs";
import { thirdPartyKey } from "../related.mjs";
import { createCustomAgent } from "./create.mjs";
import { publicProfile, resolveEnabledTools, SELF_MGMT_TOOLS, unique } from "./profiles.mjs";
import { normalizeProvider, PROVIDERS } from "../providers/index.mjs";

// mayRename(chatId): may this chat rename its agent? A name reaches every prompt and signature, so a
// chat that read someone else's content (a colleague, Telegram, the web) cannot set it.
// index.mjs passes the full check (knowledge-trust.mjs); the default knows only the third-party mark.
// confirm(chatId, question) -> { answered, answer, selected } asks the owner (asks.mjs); engine = { isEngine,
// splitModel } validates the engine accounts a new agent may name. Without confirm the tools refuse:
// making an agent hands out tools, so it never happens without the owner's yes.
export function createAgentSettingsTools({ store, catalogNames, mayRename = (chatId) => !store.getKv?.(thirdPartyKey(chatId)), confirm = null, engine = {} }) {
  const refuse = (text) => ({ isError: true, content: [{ type: "text", text }] });
  const said = (conf) => /^(بله|yes|ok|اوکی|باشه)/i.test(String(conf?.answer || conf?.selected?.[0] || "").trim());
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
        "List this install's agent profiles (id, label, domain, provider). Use this to discover peers before ask_agent — do not invent agent ids.",
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

    agent_create: {
      description:
        "Make a new specialist agent. The owner is asked first (it hands out tools), so state clearly what it is for. " +
        "label: its name (no punctuation, ≤32 chars). domain: one line on its line of work. instructions: how it should work " +
        "(plain text, ≤6000 chars). tools: names from the tool catalog (agent_tools_list shows them); omit for a safe default " +
        "(ask, look up, report). It cannot be given agent-editing tools. provider/model or models: the engine accounts it runs on " +
        "(omit to use the same as the mother agent). The new agent's id is returned; call it with ask_agent/delegate.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string" },
          domain: { type: "string" },
          instructions: { type: "string" },
          blurb: { type: "string" },
          id: { type: "string", description: "optional latin id, e.g. report-writer" },
          tools: { type: "array", items: { type: "string" }, maxItems: 80 },
          provider: { type: "string" },
          model: { type: "string" },
          models: { type: "array", items: { type: "string" }, maxItems: 12 },
        },
        required: ["label", "domain"],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        if (!confirm) return refuse("refused: agents are made from the owner's own chat or the agents page");
        if (!mayRename(ctx?.chatId)) return refuse("refused: this chat read third-party content or is not the owner's own; the owner makes agents from his own chat or the agents page");
        const defaultProvider = store.getAgentProfile("griffin")?.provider || "cursor";
        // Validate before bothering the owner with a question that cannot succeed.
        let draft;
        try {
          const dry = { getAgentProfile: (id) => store.getAgentProfile(id), upsertAgentProfile: (row) => row };
          draft = createCustomAgent({ store: dry, catalogNames: names(), input: args || {}, ...engine, defaultProvider });
        } catch (error) {
          return refuse(error.message);
        }
        const conf = await confirm(ctx?.chatId, `می‌خواهم یک ایجنت تازه بسازم: «${draft.label}» — ${draft.domain}\nابزارهایش: ${draft.tools.join("، ") || "—"}\nاوکیه؟`);
        if (!said(conf)) return refuse(`the owner did not approve making «${draft.label}»${conf?.answer ? ` (answer: ${conf.answer})` : ""}; say what you would change instead`);
        try {
          const made = createCustomAgent({ store, catalogNames: names(), input: { ...(args || {}), id: draft.id }, ...engine, defaultProvider });
          return { content: [{ type: "text", text: JSON.stringify({ ...publicProfile(made), note: "Ready now: ask_agent / delegate with this id. Tools and engine are editable on the agents page." }) }] };
        } catch (error) {
          return refuse(error.message);
        }
      },
    },

    agent_delete: {
      description: "Delete an agent that was made with agent_create (the built-in agents cannot be deleted). The owner is asked first.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      async execute(args, ctx) {
        if (!confirm) return refuse("refused: agents are deleted from the owner's own chat or the agents page");
        if (!mayRename(ctx?.chatId)) return refuse("refused: this chat is not the owner's own, or read third-party content");
        const target = store.getAgentProfile(String(args?.id || ""));
        if (!target) return refuse(`unknown agent: ${args?.id}`);
        if (target.built_in) return refuse("a built-in agent cannot be deleted");
        const conf = await confirm(ctx?.chatId, `ایجنت «${target.label}» (${target.id}) را حذف کنم؟ گفتگوهای قبلی‌اش می‌مانند ولی دیگر قابل‌صدازدن نیست.`);
        if (!said(conf)) return refuse("the owner did not approve the deletion");
        store.deleteAgentProfile(target.id);
        return { content: [{ type: "text", text: JSON.stringify({ deleted: target.id }) }] };
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
              allTools: Boolean(profile.meta?.allTools),
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
        // The name, its line of work and its blurb reach prompts and signatures: never from a chat that
        // read someone else's content, or that is not the owner's own.
        const identityChange = ["label", "domain", "blurb"].some((key) => typeof args?.[key] === "string" && args[key] !== (profile[key] ?? ""));
        if (identityChange && !mayRename(ctx?.chatId)) {
          return { isError: true, content: [{ type: "text", text: "refused: this chat read third-party content or is not the owner's own; the owner renames the agent from his own chat or the agent page" }] };
        }
        if (typeof args?.label === "string" && args.label.trim()) {
          const invalid = agentNameError(args.label);
          if (invalid) return { isError: true, content: [{ type: "text", text: `label refused: ${invalid}` }] };
          if (args.label.trim() !== profile.label) patch.label = args.label.trim();
        }
        if (typeof args?.domain === "string") patch.domain = args.domain;
        if (typeof args?.blurb === "string") patch.blurb = args.blurb;
        if (!Object.keys(patch).length) {
          return { isError: true, content: [{ type: "text", text: "no settings to change" }] };
        }
        const next = store.updateAgentProfile(profile.id, patch);
        if (profile.id === "griffin" && patch.label) renameAssistant(store, patch.label);
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
