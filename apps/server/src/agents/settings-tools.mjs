import { agentNameError } from "../identity.mjs";
import { renameAssistant } from "../persona.mjs";
import { thirdPartyKey } from "../related.mjs";
import { createCustomAgent } from "./create.mjs";
import { publicProfile, resolveEnabledTools, SELF_MGMT_TOOLS, unique } from "./profiles.mjs";
import { normalizeProvider, PROVIDERS } from "../providers/index.mjs";

// mayRename(chatId): may this chat rename its agent? A name reaches every prompt and signature, so a
// chat that read someone else's content (a colleague, Telegram, the web) cannot set it (Karsara !72).
// index.mjs passes the full check (knowledge-trust.mjs); the default knows only the third-party mark.
// ownerChat(chatId): is this the owner's own chat (his web composer or a chat it started), whatever it
// has read since? agent_create in such a chat that read files or other text is not refused: the owner
// is asked with the new agent's whole instructions in front of him, so text a file slipped in is seen
// before it becomes an agent (a colleague 2026-11-24: «از روی فایل بساز» was refused after the Read).
// Without ownerChat (tests, older callers) a chat that fails mayRename is refused as before.
// confirm(chatId, question, detail?) -> { answered, answer, selected } asks the owner (asks.mjs); engine = { isEngine,
// splitModel } validates the engine accounts a new agent may name. Without confirm the tools refuse:
// making an agent hands out tools, so it never happens without the owner's yes.
// An agent made at run time (agent_create, the agents page). createCustomAgent saves it with
// builtIn false and never wrote meta.custom, so that flag alone missed every made agent: their
// instructions could not be edited from a chat and they could be handed agent-editing tools.
const isCustom = (profile) => Boolean(profile?.meta?.custom) || (profile != null && !profile.built_in);

// Where the owner makes an agent by hand (Settings → Assistant → Agents, «ایجنت تازه»).
const AGENTS_PAGE = "the agents page (Settings → دستیار → ایجنت‌ها, button «ایجنت تازه»)";
// The approval card's detail is cut at 4000 chars (asks.mjs); keep room for the header line.
const DETAIL_MAX = 3800;

export function createAgentSettingsTools({ store, catalogNames, mayRename = (chatId) => !store.getKv?.(thirdPartyKey(chatId)), ownerChat = null, confirm = null, engine = {} }) {
  const refuse = (text) => ({ isError: true, content: [{ type: "text", text }] });
  const said = (conf) => /^(بله|yes|ok|اوکی|باشه)/i.test(String(conf?.answer || conf?.selected?.[0] || "").trim());
  // Editing an agent (its name, line of work, instructions, another agent's tools) from a chat that
  // is not clean: the owner's own chat asks him with the exact change; any other chat is refused.
  // null = go ahead; otherwise the refusal to return.
  async function ownerGate(ctx, question, detail = null) {
    if (mayRename(ctx?.chatId)) return null;
    if (!confirm || !ownerChat?.(ctx?.chatId)) return refuse(`refused: this chat is not the owner's own, or holds someone else's words; the owner edits agents from his own chat or ${AGENTS_PAGE}`);
    const conf = await confirm(ctx?.chatId, question, detail);
    return said(conf) ? null : refuse(`the owner did not approve this change${conf?.answer ? ` (answer: ${conf.answer})` : ""}`);
  }
  function profileOf(chatId, explicitId) {
    const chat = store.getChat(chatId);
    const currentId = chat?.agent || "griffin";
    const id = typeof explicitId === "string" && explicitId.trim() ? explicitId.trim() : currentId;
    const profile = store.getAgentProfile(id);
    if (!profile) throw new Error(`unknown agent profile: ${id}`);
    return { profile, isOther: id !== currentId };
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
          blurb: p.blurb || "",
          custom: isCustom(p),
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
        "(ask, look up, report). It cannot be given agent-editing tools. No agent has an engine of its own: every agent runs on " +
        "the first ready engine of the Engines page (provider/model/models are ignored). The new agent's id is returned; call it with ask_agent/delegate.",
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
        if (!confirm) return refuse(`refused: agents are made from the owner's own chat or ${AGENTS_PAGE}`);
        const clean = mayRename(ctx?.chatId);
        if (!clean && !ownerChat?.(ctx?.chatId)) return refuse(`refused: this chat is not the owner's own; the owner makes agents from his own chat or ${AGENTS_PAGE}`);
        const defaultProvider = store.getAgentProfile("griffin")?.provider || "cursor";
        // Validate before bothering the owner with a question that cannot succeed.
        let draft;
        try {
          const dry = { getAgentProfile: (id) => store.getAgentProfile(id), upsertAgentProfile: (row) => row };
          draft = createCustomAgent({ store: dry, catalogNames: names(), input: args || {}, ...engine, defaultProvider });
        } catch (error) {
          return refuse(error.message);
        }
        const question = `می‌خواهم یک ایجنت تازه بسازم: «${draft.label}» — ${draft.domain}\nابزارهایش: ${draft.tools.join("، ") || "—"}\nاوکیه؟`;
        let detail = null;
        if (!clean) {
          // This chat read files or someone's text: the instructions may carry words that are not his.
          // He sees all of them; ones too long for the card are made on the agents page instead.
          const instructions = String(draft.meta?.instructions ?? args?.instructions ?? "").trim();
          if (instructions.length > DETAIL_MAX) return refuse(`refused: this chat read files or other people's text, and instructions this long (${instructions.length} chars, the approval card shows ${DETAIL_MAX}) cannot be shown to the owner in full; make it on ${AGENTS_PAGE}, or shorten the instructions`);
          detail = `این گفتگو فایل یا متن دیگران را خوانده؛ پیش از تأیید، دستورالعمل را ببینید:\n\n${instructions || "—"}`;
        }
        const conf = await confirm(ctx?.chatId, question, detail);
        if (!said(conf)) return refuse(`the owner did not approve making «${draft.label}»${conf?.answer ? ` (answer: ${conf.answer})` : ""}; say what you would change instead`);
        try {
          const made = createCustomAgent({ store, catalogNames: names(), input: { ...(args || {}), id: draft.id }, ...engine, defaultProvider });
          store.bus?.emit?.("prefs", { kind: "agents" });
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
        if (!confirm) return refuse(`refused: agents are deleted from the owner's own chat or ${AGENTS_PAGE}`);
        if (!mayRename(ctx?.chatId) && !ownerChat?.(ctx?.chatId)) return refuse(`refused: this chat is not the owner's own, or holds someone else's words; the owner deletes agents from his own chat or ${AGENTS_PAGE}`);
        const target = store.getAgentProfile(String(args?.id || ""));
        if (!target) return refuse(`unknown agent: ${args?.id}`);
        if (target.built_in) return refuse("a built-in agent cannot be deleted");
        const conf = await confirm(ctx?.chatId, `ایجنت «${target.label}» (${target.id}) را حذف کنم؟ گفتگوهای قبلی‌اش می‌مانند ولی دیگر قابل‌صدازدن نیست.`);
        if (!said(conf)) return refuse("the owner did not approve the deletion");
        store.deleteAgentProfile(target.id);
        store.bus?.emit?.("prefs", { kind: "agents" });
        return { content: [{ type: "text", text: JSON.stringify({ deleted: target.id }) }] };
      },
    },

    agent_tools_list: {
      description:
        "List the tool catalog and which tools are enabled on an agent profile (defaults to THIS agent; pass agent id from list_agents to inspect another agent). Use before agent_tools_enable/disable.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Optional agent id from list_agents (default: this chat's agent)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { profile } = profileOf(ctx?.chatId, args?.agent);
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
        "Enable (add) one or more tools from the catalog on an agent profile (defaults to THIS agent; pass agent id from list_agents in owner chats to edit another agent). Names must exist in the catalog.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Optional agent id from list_agents (default: this chat's agent)" },
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
        const { profile, isOther } = profileOf(ctx?.chatId, args?.agent);
        const catalog = new Set(names());
        const want = unique(args?.tools || []);
        const unknown = want.filter((n) => !catalog.has(n));
        if (unknown.length) {
          return { isError: true, content: [{ type: "text", text: `unknown tools: ${unknown.join(", ")}` }] };
        }
        if (isCustom(profile)) {
          const forbidden = want.filter((n) => SELF_MGMT_TOOLS.includes(n));
          if (forbidden.length) {
            return refuse(`custom agents cannot hold agent-management tools: ${forbidden.join(", ")}`);
          }
        }
        if (isOther) {
          const stop = await ownerGate(ctx, `این ابزارها را به ایجنت «${profile.label}» بدهم؟\n${want.join("، ")}`);
          if (stop) return stop;
        }
        const next = store.enableAgentTools(profile.id, want);
        store.bus?.emit?.("prefs", { kind: "agents" });
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
      description:
        "Disable (remove) tools from an agent profile (defaults to THIS agent; pass agent id from list_agents in owner chats to edit another agent). Self-management tools cannot be disabled.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Optional agent id from list_agents (default: this chat's agent)" },
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
        const { profile, isOther } = profileOf(ctx?.chatId, args?.agent);
        const want = unique(args?.tools || []);
        const blocked = want.filter((n) => SELF_MGMT_TOOLS.includes(n));
        if (blocked.length) {
          return {
            isError: true,
            content: [{ type: "text", text: `cannot disable self-management tools: ${blocked.join(", ")}` }],
          };
        }
        if (isOther) {
          const stop = await ownerGate(ctx, `این ابزارها را از ایجنت «${profile.label}» بگیرم؟\n${want.join("، ")}`);
          if (stop) return stop;
        }
        const next = store.disableAgentTools(profile.id, want);
        store.bus?.emit?.("prefs", { kind: "agents" });
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
      description:
        "Read an agent profile's settings: label, domain, blurb, instructions (for custom agents), provider, model. Defaults to THIS agent; pass agent id from list_agents for another agent.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Optional agent id from list_agents (default: this chat's agent)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { profile } = profileOf(ctx?.chatId, args?.agent);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...publicProfile(profile),
              custom: isCustom(profile),
              ...(isCustom(profile) ? { instructions: profile.meta?.instructions || "" } : {}),
            }),
          }],
        };
      },
    },

    agent_settings_set: {
      description:
        "Update an agent profile's settings (label/name, domain, blurb, and instructions for custom agents). Defaults to THIS agent; pass agent id from list_agents in owner chats to edit any other agent.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Optional agent id from list_agents (default: this chat's agent)" },
          provider: { type: "string", enum: [...PROVIDERS] },
          model: { type: "string", description: "Model id; empty string clears to auto" },
          label: { type: "string" },
          domain: { type: "string" },
          blurb: { type: "string" },
          instructions: { type: "string", description: "Custom agent instructions (plain text, ≤6000 chars; custom agents only)" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { profile, isOther } = profileOf(ctx?.chatId, args?.agent);
        const patch = {};
        if (typeof args?.provider === "string") patch.provider = normalizeProvider(args.provider);
        if (typeof args?.model === "string") patch.model = args.model.trim() || null;
        // The name, its line of work, its blurb, custom instructions, or editing another agent reach
        // prompts and signatures: never from a chat that read someone else's content or is not the owner's own.
        const identityChange = isOther || ["label", "domain", "blurb", "instructions"].some((key) => typeof args?.[key] === "string" && args[key] !== (key === "instructions" ? (profile.meta?.instructions ?? "") : (profile[key] ?? "")));
        if (typeof args?.label === "string" && args.label.trim()) {
          const invalid = agentNameError(args.label);
          if (invalid) return { isError: true, content: [{ type: "text", text: `label refused: ${invalid}` }] };
          if (args.label.trim() !== profile.label) patch.label = args.label.trim();
        }
        if (typeof args?.domain === "string") patch.domain = args.domain;
        if (typeof args?.blurb === "string") patch.blurb = args.blurb;
        if (typeof args?.instructions === "string") {
          if (!isCustom(profile)) return refuse("instructions can only be edited on custom agents created with agent_create");
          const text = args.instructions.trim();
          if (text.length > 6000) return refuse("instructions must be at most 6000 characters");
          patch.meta = { ...(profile.meta || {}), instructions: text };
        }
        if (!Object.keys(patch).length) {
          return { isError: true, content: [{ type: "text", text: "no settings to change" }] };
        }
        if (identityChange) {
          const lines = [];
          if (patch.label) lines.push(`نام: «${profile.label}» ← «${patch.label}»`);
          if (typeof patch.domain === "string" && patch.domain !== (profile.domain ?? "")) lines.push(`کار: ${patch.domain || "—"}`);
          if (typeof patch.blurb === "string" && patch.blurb !== (profile.blurb ?? "")) lines.push(`معرفی: ${patch.blurb || "—"}`);
          const instructions = patch.meta?.instructions;
          const newInstructions = typeof instructions === "string" && instructions !== (profile.meta?.instructions ?? "");
          if (newInstructions) lines.push("دستورالعمل تازه (زیر کارت)");
          if (newInstructions && !mayRename(ctx?.chatId) && instructions.length > DETAIL_MAX) {
            return refuse(`refused: this chat read files or other people's text, and instructions this long (${instructions.length} chars, the approval card shows ${DETAIL_MAX}) cannot be shown to the owner in full; edit them on ${AGENTS_PAGE}`);
          }
          const stop = await ownerGate(ctx, `ایجنت «${profile.label}» را این‌طور تغییر بدهم؟\n${lines.join("\n") || "تنظیمات دیگر"}`, newInstructions ? instructions : null);
          if (stop) return stop;
        }
        const next = store.updateAgentProfile(profile.id, patch);
        if (profile.id === "griffin" && patch.label) renameAssistant(store, patch.label);
        store.bus?.emit?.("prefs", { kind: "agents" });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...publicProfile(next),
              custom: isCustom(next),
              ...(isCustom(next) ? { instructions: next.meta?.instructions || "" } : {}),
              note: "Changes apply on the next run.",
            }),
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
