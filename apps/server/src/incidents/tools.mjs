import { incidentBucket, incidentView } from "./index.mjs";
import { ADDABLE_KINDS, SOURCE_KINDS, slugify, sourceView, testSource } from "./sources.mjs";

// Chat tools for the incident layer's data sources and its link to workspace chats (owner 2026-10-25:
// «چت گریفین هم توانایی مدیریتش رو داشته باشه… آلرت‌ها بتونن به چت‌های فضای کار اساین و ساجست بشن»).
//   incident_sources     — read: every source, its kind and live status
//   incident_source_set  — add / update / enable / disable / remove / test a source
//   incident_assign      — tie an incident to a chat (this one by default); that chat hears its changes
//   incident_suggest     — put a card on the workspace: a new chat to work on this incident

export const INCIDENT_SOURCES = "incident_sources";
export const INCIDENT_SOURCE_SET = "incident_source_set";
export const INCIDENT_ASSIGN = "incident_assign";
export const INCIDENT_SUGGEST = "incident_suggest";
export const SOURCE_TOOL_NAMES = [INCIDENT_SOURCES, INCIDENT_SOURCE_SET, INCIDENT_ASSIGN, INCIDENT_SUGGEST];
export const SOURCE_WRITE_TOOLS = [INCIDENT_SOURCE_SET, INCIDENT_ASSIGN, INCIDENT_SUGGEST];

// The unattended ops room may put at most this many incident cards on the workspace per day.
export const OPS_SUGGEST_PER_DAY = 6;

const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (error) => ({ isError: true, content: [{ type: "text", text: String(error) }] });
const tehran = (iso) => (iso ? new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(iso)) : "—");

/** A Telegram chat named by id, @username or title → its person row (only chats a message already came from). */
export function findTelegramChat(store, chat) {
  const s = String(chat || "").trim();
  if (!s) return { error: "chat is required (id, @username or title)" };
  if (/^-?\d+$/.test(s)) {
    const p = store.findPerson(s);
    return p ? { person: p } : { error: `no Telegram chat with id ${s} has written to this account yet` };
  }
  const q = s.replace(/^@/, "");
  const all = store.listPersons({ source: "telegram", query: q });
  const exact = all.filter((p) => (p.username || "").toLowerCase() === q.toLowerCase() || p.display_name === s || p.fa_name === s);
  const hits = exact.length ? exact : all;
  if (hits.length === 1) return { person: hits[0] };
  if (!hits.length) return { error: `no Telegram chat matches «${s}»; a group or channel shows up once one message of it reached this account` };
  return { error: `«${s}» matches ${hits.length} chats: ${hits.slice(0, 8).map((p) => `${p.display_name} (${p.external_id}${p.username ? ` @${p.username}` : ""})`).join("، ")} — name one by id` };
}

/** The first message of a chat that works on an incident (a suggestion card's prompt). */
export function incidentPrompt(view) {
  const t = view.triage || {};
  const lines = [
    `روی این حادثه کار کن (شناسه ${view.id.slice(0, 8)}). این گفتگو به همین حادثه اساین شده و هر تغییرش (بدتر شدن، برگشتن، رفع) این‌جا می‌رسد.`,
    `- آلارم: ${view.alertname} · منبع ${view.source || view.cluster}${view.scope ? ` · ${view.scope}` : ""} · ${view.severity}`,
    `- از ${tehran(view.startsAt || view.firstSeen)}${view.flaps ? ` · ${view.flaps} بار قطع‌ووصل` : ""}${view.members.length > 1 ? ` · ${view.members.length} مورد: ${view.members.slice(0, 10).join("، ")}` : view.members[0] && view.members[0] !== "-" ? ` · ${view.members[0]}` : ""}`,
  ];
  if (view.summary) lines.push(`- متن آلارم: ${view.summary.slice(0, 400)}`);
  if (t.cause) lines.push(`- تشخیص اتاق عملیات: ${t.cause}${t.impact ? ` — اثر: ${t.impact}` : ""}${t.action ? ` — پیشنهاد: ${t.action}` : ""}`);
  lines.push("", "اول incident_history را ببین، علت را با شاهد پیدا کن، اگر رفع روشن و برگشت‌پذیر است انجامش بده و زنده تأیید کن. نتیجه را با incident_update روی همین حادثه ثبت کن.");
  return lines.join("\n");
}

export function createSourceTools({
  store,
  incidents,
  sources,
  secrets = null,
  chatId = null,
  caller = "owner",
  builtins = {},
  baseUrl = () => "",
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  const find = (id) => {
    const s = String(id || "");
    return incidents.get(s) || incidents.list({ status: "all", limit: 500 }).find((r) => r.id.startsWith(s)) || null;
  };
  const view = (s) => sourceView(s, { status: sources.status(s.id), baseUrl: baseUrl() });

  return {
    [INCIDENT_SOURCES]: {
      description: `List this install's incident data sources (like Grafana data sources): each source's id, kind, name, enabled, live status (last read ok/error, firing count) and config without secret values. Kinds: ${Object.entries(SOURCE_KINDS).map(([k, v]) => `${k} (${v.label})`).join(", ")}.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return ok({ sources: sources.list().map(view), addable: ADDABLE_KINDS });
      },
    },
    [INCIDENT_SOURCE_SET]: {
      description:
        "Manage incident data sources of this install. action add: kind + name (+ url for alertmanager/grafana/prometheus, chat for telegram); update: id + fields to change; enable/disable/remove/test: id. " +
        "telegram: `chat` = a group/channel/bot chat (id, @username or title) this Telegram account already receives; every new message there is read as an alert ([FIRING]/[RESOLVED], Grafana/Alertmanager/Uptime Kuma templates, 🔴/✅ text). " +
        "webhook: returns a URL to paste into Alertmanager/Grafana as a webhook contact point (full URL is shown on the sources page). " +
        "Credentials: never pass a token or password here — `secret` is only the NAME of an item in this install's secret store (Settings → secrets, or the source form on the incidents page). Built-in kinds (clusters, business, vault) cannot be added again, only enabled/disabled.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "update", "enable", "disable", "remove", "test"] },
          id: { type: "string", maxLength: 40, description: "source id (a-z 0-9 -); for add it is made from the name when omitted" },
          kind: { type: "string", enum: ADDABLE_KINDS },
          name: { type: "string", maxLength: 80 },
          url: { type: "string", maxLength: 500, description: "base URL, e.g. https://alertmanager.example.com or https://grafana.example.com" },
          auth: { type: "string", enum: ["bearer", "basic", "header"], description: "how the secret is sent (basic = user:password)" },
          header: { type: "string", maxLength: 80, description: "header name when auth=header" },
          secret: { type: "string", maxLength: 100, description: "NAME of a secret in this install's secret store, never the value" },
          watchdog: { type: "boolean", description: "alertmanager: expect a Watchdog alert; its absence becomes an incident" },
          chat: { type: "string", maxLength: 200, description: "telegram: the alert chat (id, @username or title)" },
          ttlHours: { type: "number", minimum: 1, maximum: 168, description: "push sources: a firing alert nobody repeats or resolves closes after this many hours" },
          everyMessage: { type: "boolean", description: "telegram: treat every message as an alert, even without a firing marker" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async execute(args) {
        const { action } = args;
        try {
          if (action === "add") {
            if (!args.kind) return fail("kind is required");
            const config = {};
            for (const k of ["url", "auth", "header", "watchdog", "ttlHours", "everyMessage"]) if (args[k] !== undefined) config[k] = args[k];
            if (args.secret) {
              if (!secrets?.has?.(args.secret)) return fail(`secret «${args.secret}» is not in this install's secret store; ask the owner to add it there (Settings → secrets) or to fill the source form on the incidents page — never take the value in chat`);
              config.secret = args.secret;
            }
            let name = args.name;
            if (args.kind === "telegram") {
              const found = findTelegramChat(store, args.chat);
              if (found.error) return fail(found.error);
              config.personId = found.person.id;
              config.chatTitle = found.person.display_name;
              name = name || found.person.display_name;
            }
            const id = args.id || slugify(name) || undefined;
            const source = sources.add({ id, kind: args.kind, name: name || id, config, by: caller });
            const test = await testSource(source, { secrets, builtins, fetchImpl, sources });
            return ok({ ok: true, source: view(source), test });
          }
          const source = sources.get(args.id);
          if (!source) return fail(`no source «${args.id}»; incident_sources lists them`);
          if (action === "remove") {
            if (SOURCE_KINDS[source.kind]?.builtin) return fail("a built-in source is disabled, not removed (action: disable)");
            sources.remove(source.id);
            return ok({ ok: true, removed: source.id, note: "its open incidents resolve on the next poll" });
          }
          if (action === "enable" || action === "disable") return ok({ ok: true, source: view(sources.update(source.id, { enabled: action === "enable" })) });
          if (action === "test") return ok({ source: source.id, ...(await testSource(source, { secrets, builtins, fetchImpl, sources })) });
          if (action === "update") {
            const config = {};
            for (const k of ["url", "auth", "header", "watchdog", "ttlHours", "everyMessage"]) if (args[k] !== undefined) config[k] = args[k];
            if (args.secret !== undefined) {
              if (args.secret && !secrets?.has?.(args.secret)) return fail(`secret «${args.secret}» is not in this install's secret store`);
              config.secret = args.secret || null;
            }
            if (args.chat) {
              const found = findTelegramChat(store, args.chat);
              if (found.error) return fail(found.error);
              config.personId = found.person.id;
              config.chatTitle = found.person.display_name;
            }
            const next = sources.update(source.id, { name: args.name, config: Object.keys(config).length ? config : undefined });
            return ok({ ok: true, source: view(next) });
          }
          return fail(`unknown action ${action}`);
        } catch (error) {
          return fail(error.message);
        }
      },
    },
    [INCIDENT_ASSIGN]: {
      description:
        "Assign an incident to a workspace chat: that chat then gets a short message whenever the incident gets worse, comes back or resolves, and the incidents page shows it as «در حال پیگیری» with a link. chat: «this» (default) or a chat id. remove=true unassigns.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 8, description: "incident id or its first 8 chars" },
          chat: { type: "string", maxLength: 80, description: "«this» (default) or a chat id" },
          remove: { type: "boolean" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(args) {
        const row = find(args.id);
        if (!row) return fail(`no incident ${args.id}`);
        if (args.remove) {
          incidents.assign(row.id, null);
          incidents.log(row.id, "unassigned", { by: chatId });
          return ok({ ok: true, incident: row.id.slice(0, 8), chat: null });
        }
        const target = !args.chat || args.chat === "this" ? chatId : String(args.chat);
        if (!target || !store.getChat(target)) return fail(`no chat ${args.chat || "(this)"}`);
        incidents.assign(row.id, target);
        incidents.log(row.id, "assigned", { chat: target, by: chatId });
        return ok({ ok: true, incident: row.id.slice(0, 8), chat: target, title: store.getChat(target)?.title || "" });
      },
    },
    [INCIDENT_SUGGEST]: {
      description:
        "Put a card on the owner's workspace proposing a NEW chat to work on an incident (nothing starts until the owner clicks it). When started, that chat is assigned to the incident. title/tldr/prompt are optional — a prompt with the incident's facts and triage is written for you. Not for noise, acked/intentional or already-assigned incidents.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 8 },
          title: { type: "string", maxLength: 100 },
          tldr: { type: "string", maxLength: 500, description: "one or two plain Persian sentences: what is wrong and why it needs work" },
          prompt: { type: "string", maxLength: 3500 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(args) {
        const row = find(args.id);
        if (!row) return fail(`no incident ${args.id}`);
        const v = incidentView({ ...row, ack: incidents.isAcked(row) ? incidents.acksFor(row.key) : null });
        if (v.chatId && store.getChat(v.chatId)) return fail(`already assigned to chat «${store.getChat(v.chatId)?.title || v.chatId}»`);
        if (v.suggestionId && store.getSuggestion(v.suggestionId)?.status === "open") return fail("a card for this incident is already on the workspace");
        if (caller === "ops" && incidentBucket(v, { now: now() }) === "noise") return fail("noise or intentional: no card");
        if (caller === "ops") {
          const day = now().toISOString().slice(0, 10);
          const kv = store.getKv("ops_suggest") || {};
          const used = kv.day === day ? kv.n : 0;
          if (used >= OPS_SUGGEST_PER_DAY) return fail(`daily cap (${OPS_SUGGEST_PER_DAY}) of incident cards reached; record with incident_update`);
          store.setKv("ops_suggest", { day, n: used + 1 });
        }
        const t = v.triage || {};
        const title = (args.title || `بررسی ${v.alertname}${v.scope ? ` · ${v.scope}` : ""}`).slice(0, 100);
        const tldr = (args.tldr || [t.impact || t.cause || v.summary || `${v.severity} از منبع ${v.source || v.cluster}`, t.action].filter(Boolean).join(" — ")).slice(0, 500);
        const prompt = args.prompt ? `${args.prompt.trim()}\n\n(این گفتگو به حادثهٔ ${v.id.slice(0, 8)} اساین می‌شود.)` : incidentPrompt(v);
        const suggestion = store.createSuggestion({ fromChatId: chatId, title, tldr, prompt, repo: null, model: null });
        if (chatId && store.getChat(chatId)) store.appendEvent(chatId, null, "chat.suggested", { id: suggestion.id, title, tldr });
        incidents.setSuggestion(row.id, suggestion.id);
        incidents.log(row.id, "suggested", { suggestion: suggestion.id, by: chatId });
        return ok({ ok: true, suggestion: suggestion.id, incident: row.id.slice(0, 8) });
      },
    },
  };
}
