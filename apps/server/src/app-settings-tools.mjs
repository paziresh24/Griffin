// Direct settings, appearance, engines and connections management tools for the owner's own chats.
// Secrets never pass through tool arguments or tool outputs: keys/tokens are referenced by
// Infisical location or Griffin secret-store name and resolved server-side.
import {
  FLAGS,
  LOOK_IDS,
  LOOKS,
  NAV_ITEMS,
  NAV_STYLES,
  PREFS_REV,
  cleanPrefs,
  navStyleChoice,
  navStyleFlags,
  resolvePrefs,
} from "../../web/src/ui-flags.js";
import { agentNameError } from "./identity.mjs";
import { PERSONA, saveAssistantName } from "./persona.mjs";

const FLAG_KEYS = FLAGS.map((f) => f.key);

export const APP_SETTINGS_TOOLS = [
  "app_settings_get",
  "app_settings_set",
  "engine_list",
  "engine_manage",
  "connection_list",
  "connection_manage",
];

const UI_PREFS_KEY = "ui-prefs";
const PROFILE_KEY = "profile";
const maskProxyUrl = (raw) => {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    if (u.username) u.username = "***";
    return u.toString();
  } catch {
    return String(raw).replace(/:\/\/[^@]+@/, "://***@");
  }
};

const okJson = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const errMsg = (text) => ({ isError: true, content: [{ type: "text", text }] });

function readOwnerProfile(store) {
  try {
    const raw = store.getKv(PROFILE_KEY);
    if (!raw) return {};
    return typeof raw === "string" ? JSON.parse(raw) || {} : raw || {};
  } catch {
    return {};
  }
}

function isApproved(conf) {
  if (conf === true) return true;
  if (!conf || typeof conf !== "object") return false;
  if (conf.answered === false) return false;
  return /^(بله|yes|ok|اوکی|باشه|حذف)/i.test(String(conf.answer || conf.selected?.[0] || "").trim());
}

export function createAppSettingsTools({
  store,
  config,
  skin = "griffin",
  providersApi,
  integrationsApi,
  proxyApi,
  vpnApi = null,
  mcpServers = null,
  devicesApi = null,
  secrets = null,
  readInfisical = null,
  confirm = null,
  emitPrefs = (kind) => store.bus?.emit?.("prefs", { kind }),
}) {
  const resolveSecretValue = async ({ fromInfisical, secretName }) => {
    if (fromInfisical && typeof fromInfisical === "object") {
      if (!readInfisical) throw new Error("خواندن از Infisical در این نصب فعال نیست.");
      const val = await readInfisical({
        projectId: fromInfisical.projectId,
        environment: fromInfisical.environment || "prod",
        path: fromInfisical.path || "/",
        name: String(fromInfisical.name || "").trim(),
      });
      if (!val) throw new Error("کلید خواسته‌شده در Infisical خالی یا پیدا نشد.");
      return val;
    }
    if (secretName) {
      const name = String(secretName).trim();
      const val = secrets?.get?.(name);
      if (!val) throw new Error(`سکرت «${name}» در خزانهٔ این نصب پیدا نشد.`);
      return val;
    }
    return null;
  };

  return {
    app_settings_get: {
      description:
        "Read Griffin's current appearance (look/theme, UI layout & sidebar flags), owner/assistant names, and editable app config settings (never secrets). Use before app_settings_set.",
      inputSchema: {
        type: "object",
        properties: {
          section: {
            type: "string",
            enum: ["all", "appearance", "config", "profile"],
            description: "Which part to read (default all).",
          },
        },
      },
      async execute(args) {
        const section = args?.section || "all";
        const out = {};
        if (section === "all" || section === "appearance") {
          const stored = store.getKv(UI_PREFS_KEY);
          const resolved = resolvePrefs(stored, skin);
          out.appearance = {
            look: resolved.look,
            installPreset: skin,
            availableLooks: LOOKS.map((l) => ({ id: l.id, label: l.label, note: l.note })),
            navStyle: navStyleChoice(resolved.flags),
            availableNavStyles: NAV_STYLES.map((s) => ({ id: s.id, label: s.label })),
            availableNavItems: NAV_ITEMS.map((i) => ({ id: i.id, label: i.label })),
            flags: resolved.flags,
            flagDescriptions: FLAGS.map((f) => ({ key: f.key, area: f.area, label: f.label })),
          };
        }
        if (section === "all" || section === "profile") {
          const prof = readOwnerProfile(store);
          const mother = store.getAgentProfile?.("griffin");
          out.profile = {
            ownerName: prof.name || "",
            assistantName: mother?.label || PERSONA.name,
            assistantLatin: PERSONA.latin,
          };
        }
        if (section === "all" || section === "config") {
          const rows = (config?.view?.() || []).map((s) => ({
            key: s.key,
            value: s.value,
            default: s.default,
            kind: s.kind,
            options: s.options,
            restart: Boolean(s.restart),
          }));
          out.config = rows;
        }
        return okJson(out);
      },
    },

    app_settings_set: {
      description:
        "Update Griffin's appearance (look, navStyle, UI flags, resetAppearance), owner/assistant names (ownerName, assistantName, assistantLatin), or editable app config settings (config key→value). Changes apply live in open browser tabs. Never handles secrets.",
      inputSchema: {
        type: "object",
        properties: {
          look: { type: "string", enum: LOOK_IDS, description: "Theme/look: griffin or karsara" },
          navStyle: { type: "string", enum: NAV_STYLES.map((s) => s.id), description: "Sidebar section layout: list, icons, launcher, rail, menu" },
          flags: { type: "object", description: "UI flags to set (boolean flags, navHidden array, railPinned boolean, navOrder array)" },
          resetAppearance: { type: "boolean", description: "Reset look and all UI flags back to the install preset" },
          ownerName: { type: "string", description: "Owner's display name in the sidebar (empty string resets to Telegram name)" },
          assistantName: { type: "string", description: "New Persian display name for the main assistant" },
          assistantLatin: { type: "string", description: "Optional latin slug for the main assistant (branches)" },
          config: { type: "object", description: "Editable /api/config key→value pairs (e.g. ENTER_KEY, AUTO_CONTINUE, PLAN_APPROVAL, PROMPT_SUGGESTIONS)" },
        },
      },
      async execute(args) {
        const changed = [];
        let needsRestart = [];
        let uiDirty = false;
        let configDirty = false;

        if (args?.resetAppearance === true) {
          store.setKv(UI_PREFS_KEY, {});
          changed.push("appearance:reset");
          uiDirty = true;
        } else if (args?.look !== undefined || args?.navStyle !== undefined || (args?.flags && typeof args.flags === "object")) {
          const current = resolvePrefs(store.getKv(UI_PREFS_KEY), skin);
          const nextLook = args.look !== undefined ? args.look : current.look;
          if (!LOOK_IDS.includes(nextLook)) return errMsg(`ظاهر «${nextLook}» معتبر نیست. گزینه‌ها: ${LOOK_IDS.join(", ")}`);
          const navPatch = args.navStyle ? navStyleFlags(args.navStyle) : {};
          const rawFlags = { ...current.flags, ...(args.flags || {}), ...navPatch };
          const cleaned = cleanPrefs({ look: nextLook, flags: rawFlags, rev: PREFS_REV });
          // Reject unknown flag keys clearly instead of silently ignoring typos.
          const allowedExtras = new Set(["navHidden", "navStyle", "railPinned", "navOrder"]);
          const unknown = Object.keys(args.flags || {}).filter((k) => !FLAG_KEYS.includes(k) && !allowedExtras.has(k));
          if (unknown.length) return errMsg(`فلگ ناشناخته: ${unknown.join(", ")} (ابتدا app_settings_get را ببینید).`);
          store.setKv(UI_PREFS_KEY, { look: cleaned.look || nextLook, flags: { ...current.flags, ...cleaned.flags }, rev: PREFS_REV });
          if (args.look !== undefined) changed.push(`look=${nextLook}`);
          if (args.navStyle !== undefined) changed.push(`navStyle=${args.navStyle}`);
          if (args.flags) changed.push(`flags:${Object.keys(args.flags).join(",")}`);
          uiDirty = true;
        }

        if (typeof args?.ownerName === "string") {
          const name = args.ownerName.trim().slice(0, 60);
          const cur = readOwnerProfile(store);
          const next = { ...cur };
          if (name) next.name = name;
          else delete next.name;
          store.setKv(PROFILE_KEY, next);
          changed.push(`ownerName=${name || "(reset)"}`);
          uiDirty = true;
        }

        if (typeof args?.assistantName === "string" || typeof args?.assistantLatin === "string") {
          const nextName = typeof args.assistantName === "string" ? args.assistantName.trim() : undefined;
          if (nextName !== undefined) {
            const bad = agentNameError(nextName);
            if (bad) return errMsg(bad);
          }
          const finalName = nextName !== undefined ? nextName : PERSONA.name;
          const finalLatin = typeof args.assistantLatin === "string" && args.assistantLatin.trim() ? args.assistantLatin.trim() : PERSONA.latin;
          saveAssistantName(store, finalName, finalLatin);
          if (nextName !== undefined) {
            store.updateAgentProfile?.("griffin", { label: finalName });
          }
          changed.push(`assistantName=${finalName}`);
          uiDirty = true;
        }

        if (args?.config && typeof args.config === "object" && Object.keys(args.config).length) {
          if (!config?.set) return errMsg("پیکربندی در این نصب در دسترس نیست.");
          try {
            const res = config.set(args.config);
            changed.push(`config:${Object.keys(args.config).join(",")}`);
            if (Array.isArray(res?.restart) && res.restart.length) needsRestart = res.restart;
            configDirty = true;
          } catch (error) {
            return errMsg(String(error?.message || error));
          }
        }

        if (!changed.length) return errMsg("هیچ تغییری مشخص نشده است.");
        if (uiDirty || configDirty) emitPrefs(configDirty ? "settings" : "ui");
        if (configDirty) store.bus?.emit?.("chats", { type: "config" });

        const resolved = resolvePrefs(store.getKv(UI_PREFS_KEY), skin);
        const prof = readOwnerProfile(store);
        return okJson({
          ok: true,
          changed,
          ...(needsRestart.length ? { needsRestart } : {}),
          current: {
            look: resolved.look,
            navStyle: navStyleChoice(resolved.flags),
            ownerName: prof.name || "",
            assistantName: store.getAgentProfile?.("griffin")?.label || PERSONA.name,
          },
        });
      },
    },

    engine_list: {
      description:
        "List all AI engine accounts configured in Griffin (Claude, OpenAI/Codex/Antigravity/Z.ai/OpenRouter/Ollama, Cursor): id, label, kind, enabled, default, state, signedInAs, Claude 5h/7d usage windows, defaultModel and switchSameKind.",
      inputSchema: {
        type: "object",
        properties: {
          includeModels: { type: "boolean", description: "Include each engine's model list (default false)" },
        },
      },
      async execute(args) {
        if (!providersApi?.list) return errMsg("مدیریت موتورها در این نصب در دسترس نیست.");
        const data = await providersApi.list({ includeModels: Boolean(args?.includeModels) });
        return okJson(data);
      },
    },

    engine_manage: {
      description:
        "Manage AI engine accounts: add a new engine (claude/openai/cursor, optional label/plan/preset/baseUrl/endpoint), update an engine (rename label, enable/disable, auto fallback, defaultModel, reasoningEffort, preset/baseUrl, API key by Infisical/secret reference), set_default, clear_limit, test live health, start OAuth signin (returns sign-in URL), change global switchSameKind (action='settings'), or remove an engine (asks owner first). Never accepts raw API keys.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "update", "set_default", "clear_limit", "test", "signin", "remove", "settings"],
          },
          id: { type: "string", description: "Engine account id from engine_list (e.g. claude, claude-2, openai)" },
          kind: { type: "string", enum: ["claude", "openai", "cursor"], description: "For add: engine kind" },
          label: { type: "string", description: "Display name for the engine (add or rename in update)" },
          slug: { type: "string", description: "Optional latin id suffix when adding" },
          plan: { type: "string", enum: ["codex", "antigravity"], description: "For add kind=openai: subscription plan" },
          preset: { type: "string", enum: ["zai", "freebucks", "openai", "openrouter", "ollama"], description: "OpenAI-compatible preset" },
          baseUrl: { type: "string", description: "Custom OpenAI-compatible base URL" },
          endpoint: { type: "string", enum: ["anthropic", "zai", "custom"], description: "For claude-* accounts: endpoint" },
          defaultModel: { type: "string", description: "Default model id (empty string clears to auto)" },
          reasoningEffort: { type: "string", enum: ["", "low", "medium", "high", "max"], description: "Reasoning effort level" },
          enabled: { type: "boolean", description: "Enable or disable the engine" },
          auto: { type: "boolean", description: "Include in automatic fallback switching" },
          switchSameKind: { type: "boolean", description: "For action=settings: switch only to another account of the same kind" },
          fromInfisical: {
            type: "object",
            description: "API key reference in Infisical (never pass a raw key): {projectId?, environment?, path?, name}",
            properties: {
              projectId: { type: "string" },
              environment: { type: "string" },
              path: { type: "string" },
              name: { type: "string" },
            },
            required: ["name"],
          },
          secretName: { type: "string", description: "API key name in Griffin's secret store (alternative to fromInfisical)" },
        },
        required: ["action"],
      },
      async execute(args, ctx) {
        if (!providersApi) return errMsg("مدیریت موتورها در این نصب در دسترس نیست.");
        const action = args?.action;
        try {
          if (action === "settings") {
            if (typeof args.switchSameKind !== "boolean") return errMsg("مقدار switchSameKind باید true یا false باشد.");
            await providersApi.setGlobal({ sameKind: args.switchSameKind });
            emitPrefs("providers");
            return okJson({ ok: true, switchSameKind: args.switchSameKind });
          }

          if (action === "add") {
            if (!["claude", "openai", "cursor"].includes(args.kind)) return errMsg("نوع موتور باید claude، openai یا cursor باشد.");
            const apiKey = await resolveSecretValue({ fromInfisical: args.fromInfisical, secretName: args.secretName });
            const created = await providersApi.add({
              kind: args.kind,
              label: args.label,
              slug: args.slug,
              plan: args.plan,
              preset: args.preset,
              baseUrl: args.baseUrl,
              endpoint: args.endpoint,
              defaultModel: args.defaultModel,
              apiKey,
            });
            emitPrefs("providers");
            return okJson({ ok: true, ...created });
          }

          const id = String(args?.id || "").trim();
          if (!id) return errMsg("شناسهٔ موتور (id) لازم است.");

          if (action === "update") {
            const apiKey = await resolveSecretValue({ fromInfisical: args.fromInfisical, secretName: args.secretName });
            const res = await providersApi.update(id, {
              ...(args.label !== undefined ? { label: args.label } : {}),
              ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
              ...(args.auto !== undefined ? { auto: args.auto } : {}),
              ...(args.defaultModel !== undefined ? { defaultModel: args.defaultModel } : {}),
              ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
              ...(args.preset !== undefined ? { preset: args.preset } : {}),
              ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
              ...(args.endpoint !== undefined ? { endpoint: args.endpoint } : {}),
              ...(apiKey ? { apiKey } : {}),
            });
            emitPrefs("providers");
            return okJson({ ok: true, id, ...res });
          }

          if (action === "set_default") {
            const res = await providersApi.setDefault(id);
            emitPrefs("providers");
            return okJson({ ok: true, id, default: true, ...res });
          }

          if (action === "clear_limit") {
            const res = await providersApi.clearLimit(id);
            emitPrefs("providers");
            return okJson({ ok: true, id, ...res });
          }

          if (action === "test") {
            const res = await providersApi.test(id);
            emitPrefs("providers");
            return okJson({ ok: true, id, probe: res });
          }

          if (action === "signin") {
            const res = await providersApi.startSignin(id);
            return okJson({ ok: true, id, ...res });
          }

          if (action === "remove") {
            if (confirm && ctx?.chatId) {
              const info = (await providersApi.list())?.providers?.find((p) => p.id === id);
              const title = info?.label ? `${info.label} (${id})` : id;
              const conf = await confirm(ctx.chatId, {
                question: `موتور «${title}» حذف شود؟`,
                detail: `حذف موتور ${title} کلید یا نشست ذخیره‌شدهٔ آن را هم پاک می‌کند.`,
                options: [
                  { label: "بله، حذف کن", description: `حذف موتور ${title}` },
                  { label: "لغو", description: "دست نزن" },
                ],
              });
              if (!isApproved(conf)) return okJson({ ok: false, cancelled: true, message: "تأیید نشد." });
            }
            const res = await providersApi.remove(id);
            emitPrefs("providers");
            return okJson({ ok: true, removed: id, ...res });
          }

          return errMsg(`عملیات ناشناخته: ${action}`);
        } catch (error) {
          return errMsg(String(error?.message || error));
        }
      },
    },

    connection_list: {
      description:
        "List all Griffin connections: messenger integrations (Telegram/Bale bots & Telegram account, status, paired chats), outgoing HTTP proxy, VPN status, MCP server names, and browser/phone connection state. Never returns tokens or credentials.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const list = (integrationsApi?.list?.() || []).map((it) => ({
          id: it.id,
          kind: it.kind,
          name: it.name,
          enabled: it.enabled !== false,
          status: it.status || it.state || "unknown",
          username: it.username || it.botUsername || null,
          defaultAgent: it.defaultAgent || it.agent || null,
          pairedChats: Array.isArray(it.paired) ? it.paired.length : Array.isArray(it.chats) ? it.chats.length : undefined,
          error: it.error || null,
        }));
        const rawProxy = proxyApi?.get?.() || { url: "", fromEnv: "" };
        const vpnStatus = vpnApi?.status ? await vpnApi.status().catch(() => null) : null;
        const mcp = mcpServers?.list ? mcpServers.list().map((s) => ({ name: s.name, type: s.type, url: s.url || undefined })) : [];
        const devices = devicesApi ? await devicesApi().catch(() => null) : null;
        return okJson({
          integrations: list,
          proxy: {
            configured: Boolean(rawProxy.url || rawProxy.fromEnv),
            url: maskProxyUrl(rawProxy.url || ""),
            fromEnv: Boolean(rawProxy.fromEnv),
          },
          ...(vpnStatus ? { vpn: vpnStatus } : {}),
          mcpServers: mcp,
          ...(devices ? { devices } : {}),
        });
      },
    },

    connection_manage: {
      description:
        "Manage Griffin connections: rename/enable/disable/update a messenger integration, restart it, add a Telegram or Bale bot using a token reference (fromInfisical or secretName — never a raw token), remove an integration (asks owner first), set/clear the outgoing proxy, or test egress.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["update", "restart", "add_bot", "remove", "set_proxy", "test_egress"],
          },
          id: { type: "string", description: "Integration id from connection_list" },
          name: { type: "string", description: "Display name (for update or add_bot)" },
          enabled: { type: "boolean", description: "Enable or disable the integration (for update)" },
          defaultAgent: { type: "string", description: "Default agent id for incoming chats on this integration" },
          kind: { type: "string", enum: ["telegram_bot", "bale_bot"], description: "For add_bot: bot platform" },
          fromInfisical: {
            type: "object",
            description: "For add_bot: bot token reference in Infisical (never pass raw token)",
            properties: {
              projectId: { type: "string" },
              environment: { type: "string" },
              path: { type: "string" },
              name: { type: "string" },
            },
            required: ["name"],
          },
          secretName: { type: "string", description: "For add_bot: bot token name in Griffin's secret store" },
          proxyUrl: { type: "string", description: "For set_proxy: http(s)/socks5 proxy URL, or empty string to clear" },
        },
        required: ["action"],
      },
      async execute(args, ctx) {
        const action = args?.action;
        try {
          if (action === "set_proxy") {
            if (!proxyApi?.set) return errMsg("تنظیم پراکسی در این نصب در دسترس نیست.");
            const url = String(args?.proxyUrl ?? "").trim();
            await proxyApi.set(url);
            emitPrefs("connections");
            return okJson({ ok: true, proxyUrl: maskProxyUrl(url), cleared: !url });
          }

          if (action === "test_egress") {
            if (!proxyApi?.test) return errMsg("آزمایش مسیر خروجی در این نصب در دسترس نیست.");
            const res = await proxyApi.test();
            return okJson({ ok: true, egress: res });
          }

          if (action === "add_bot") {
            if (!integrationsApi?.add) return errMsg("افزودن بات در این نصب در دسترس نیست.");
            if (!["telegram_bot", "bale_bot"].includes(args.kind)) return errMsg("نوع بات باید telegram_bot یا bale_bot باشد.");
            const token = await resolveSecretValue({ fromInfisical: args.fromInfisical, secretName: args.secretName });
            if (!token) return errMsg("توکن بات را به‌صورت مستقیم نفرستید؛ مسیر آن در Infisical (fromInfisical) یا نام سکرت در خزانه (secretName) را بدهید.");
            const created = await integrationsApi.add({
              kind: args.kind,
              name: String(args.name || "").trim() || (args.kind === "bale_bot" ? "بات بله" : "بات تلگرام"),
              token,
              defaultAgent: args.defaultAgent,
            });
            emitPrefs("connections");
            return okJson({ ok: true, id: created?.id, kind: args.kind, name: created?.name, status: created?.status });
          }

          const id = String(args?.id || "").trim();
          if (!id) return errMsg("شناسهٔ اتصال (id) لازم است.");

          if (action === "update") {
            if (!integrationsApi?.update) return errMsg("ویرایش اتصال در این نصب در دسترس نیست.");
            const patch = {};
            if (args.name !== undefined) patch.name = String(args.name).trim();
            if (args.enabled !== undefined) patch.enabled = Boolean(args.enabled);
            if (args.defaultAgent !== undefined) patch.defaultAgent = String(args.defaultAgent).trim();
            if (!Object.keys(patch).length) return errMsg("فیلدی برای تغییر داده نشده است.");
            const res = await integrationsApi.update(id, patch);
            emitPrefs("connections");
            return okJson({ ok: true, id, name: res?.name, enabled: res?.enabled, status: res?.status });
          }

          if (action === "restart") {
            if (!integrationsApi?.restart) return errMsg("ری‌استارت اتصال در این نصب در دسترس نیست.");
            await integrationsApi.restart(id);
            emitPrefs("connections");
            return okJson({ ok: true, id, restarted: true });
          }

          if (action === "remove") {
            if (!integrationsApi?.remove) return errMsg("حذف اتصال در این نصب در دسترس نیست.");
            if (confirm && ctx?.chatId) {
              const info = (integrationsApi.list?.() || []).find((i) => i.id === id);
              const title = info?.name ? `${info.name} (${id})` : id;
              const conf = await confirm(ctx.chatId, {
                question: `اتصال «${title}» حذف شود؟`,
                detail: `حذف این اتصال آن را از پیام‌رسان جدا می‌کند و جفت‌شدگی‌هایش پاک می‌شود.`,
                options: [
                  { label: "بله، حذف کن", description: `حذف اتصال ${title}` },
                  { label: "لغو", description: "دست نزن" },
                ],
              });
              if (!isApproved(conf)) return okJson({ ok: false, cancelled: true, message: "تأیید نشد." });
            }
            await integrationsApi.remove(id);
            emitPrefs("connections");
            return okJson({ ok: true, removed: id });
          }

          return errMsg(`عملیات ناشناخته: ${action}`);
        } catch (error) {
          return errMsg(String(error?.message || error));
        }
      },
    },
  };
}
