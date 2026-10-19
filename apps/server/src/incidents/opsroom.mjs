import { OWNER_NAME } from "../owner.mjs";
import { incidentView } from "./index.mjs";
import { DEFAULT_TZ } from "../jobs/cron.mjs";

// Griffin's ops room: one long-lived chat per day (local time) where incident state changes arrive as
// batched digests. Griffin is the manager here — it triages and delegates (ask_agent), it does not
// run domain tools itself. Mode "shadow": nobody is messaged; triage is only recorded on the
// incident, so we can compare what Griffin knew with what still reached the owner.

export const OPS_CALLER = "ops";
export const INCIDENTS_LIST = "incidents_list";
export const INCIDENT_UPDATE = "incident_update";
export const INCIDENT_ACK = "incident_ack";
export const INCIDENT_HISTORY = "incident_history";
export const TELL_OWNER = "tell_owner";

const tehranDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TZ }).format(d);
const tehranTime = (iso) =>
  iso ? new Intl.DateTimeFormat("fa-IR", { timeZone: DEFAULT_TZ, hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(iso)) : "—";

export const OPS_CHARTER = `[اتاق عملیات — حالت سایه]
این چت را لایهٔ حادثه خودکار می‌سازد، نه ${OWNER_NAME}. کسی پشت چت نیست.
نقش تو: مدیر. آلارم‌ها را لایهٔ بدون‌LLM به «حادثه» تجمیع کرده؛ فقط تغییر وضعیت‌ها به تو می‌رسد.

برای هر حادثهٔ تازه/بازگشته/شدیدشده:
0. اول سابقه را ببین: incident_history همان حادثه (triageهای قبلی و ackهای Owner) و knowledge_list. اگر وضعیت می‌تواند عمدی باشد (سرویس خاموش، replicas=0، اپ غیرفعال)، از platform بخواه commitهای اخیر مسیر GitOps همان اپ را با gitlab_commits ببیند. «قطع عمدی» را خرابی حساب نکن؛ اگر شواهد عمدی بودن داری ولی ack نیست، در action بنویس «احتمالاً عمدی — Owner ack کند».
1. اگر از خود اطلاعات حادثه (نام آلارم، کلاستر، scope، اعضا، summary) و دانش knowledge معلوم است، مستقیم نتیجه بگیر.
2. وگرنه با ask_agent به platform یک درخواست **خواندنی و مشخص** بده (مثلاً «پادهای ns X در کلاستر Y چرا NotReady اند؟ events و لاگ آخر»). حادثه‌های هم‌ریشه را با هم بپرس، نه یکی‌یکی.
3. نتیجه را با incident_update ثبت کن: cause (علت محتمل)، impact (چه سرویس/کاربری آسیب می‌بیند)، owner (مالک اپ از label یا knowledge)، whoWouldAsk (چه کسی احتمالاً به ${OWNER_NAME} پیام می‌دهد)، action (اقدام پیشنهادی)، reversible (true/false)، confidence (low/medium/high)، noise (true اگر آلارم نویز/بی‌اقدام است و باید rule اصلاح شود).

برای حادثه‌های TeamReport (یک همکار برای کمک به ${OWNER_NAME} پیام داده؛ متن خلاصه در summary/اعضا):
- اگر درخواست فنی/عملیاتی نیست (احوال‌پرسی، شخصی، تشکر) فقط noise=true ثبت کن.
- اگر هست: ببین کدام حادثهٔ باز همین را پوشش می‌داد (incidents_list) → coveredBy=<id> و missed=false؛ اگر هیچ سیگنالی نبود → missed=true و در action بنویس چه سیگنال/آلارمی باید آن را زودتر نشان می‌داد (منبع و تأخیرش).
- whoWouldAsk همان فرستنده است. به او جواب نده.

قوانین سخت:
- به همکاران پیام نده و هیچ تغییری در هیچ سیستمی نده. فقط تشخیص و ثبت (و در حالت critical، خبر به ${OWNER_NAME} طبق قاعدهٔ همان حالت).
- برای حادثه‌های resolved کاری نکن مگر flap زیاد داشته باشند (آن‌وقت noise=true با توضیح).
- هزینه را کم نگه دار: حادثهٔ واضح یا نویز شناخته‌شده را بدون ask_agent ثبت کن.
- جواب متنی‌ات خیلی کوتاه باشد (یک خط برای هر حادثه)؛ جزئیات در incident_update.`;

export function formatChange({ kind, incident }) {
  const i = incidentView(incident);
  const label = { opened: "🆕 تازه", reopened: "🔁 بازگشت", escalated: "⬆️ شدیدتر", resolved: "✅ رفع", baseline: "📋 موجود" }[kind] || kind;
  const scope = i.scope ? ` · ${i.scope}` : "";
  const members = i.members.length > 1 ? ` · ${i.members.length} مورد (${i.members.slice(0, 5).join("، ")}${i.members.length > 5 ? "، …" : ""})` : i.members[0] && i.members[0] !== "-" ? ` · ${i.members[0]}` : "";
  const flaps = i.flaps ? ` · flap×${i.flaps}` : "";
  return `- ${label} [${i.id.slice(0, 8)}] ${i.severity} ${i.alertname} @${i.cluster}${scope}${members}${flaps} — از ${tehranTime(i.startsAt || i.firstSeen)}${i.summary ? `\n  ${i.summary.slice(0, 220)}` : ""}`;
}

// A burst of changes to the same incident (several DMs, flap + escalate) is shown once, latest state.
export function dedupeChanges(changes) {
  const byId = new Map();
  for (const change of changes) {
    const prev = byId.get(change.incident.id);
    byId.set(change.incident.id, prev && prev.kind !== "reopened" && change.kind === "reopened" ? { ...change, kind: prev.kind } : change);
  }
  return [...byId.values()];
}

export function digestMessage(allChanges, { openCount, bootstrap }) {
  const changes = dedupeChanges(allChanges);
  const work = changes.filter((c) => c.kind !== "resolved");
  const resolved = changes.filter((c) => c.kind === "resolved");
  const lines = [];
  if (bootstrap) {
    lines.push(`لایهٔ حادثه تازه روشن شده و این‌ها از قبل باز بودند (${work.length} حادثه). همه را triage نکن: فقط critical ها و مواردی که به اپ/کاربر آسیب می‌زنند را بررسی و ثبت کن؛ بقیه را یک خطی با confidence=low و noise در صورت لزوم ثبت کن.`);
  }
  if (work.length) lines.push(`تغییرها (${work.length}):`, ...work.slice(0, 40).map(formatChange));
  if (work.length > 40) lines.push(`… و ${work.length - 40} مورد دیگر (incidents_list).`);
  if (resolved.length) lines.push(`رفع‌شده از دیجست قبل: ${resolved.map((c) => `${c.incident.alertname}@${c.incident.cluster}`).slice(0, 20).join("، ")}`);
  lines.push(`حادثه‌های باز الان: ${openCount}.`);
  return lines.join("\n");
}

// "critical" mode reaches the owner, but only for what he would want to hear (the away watcher's bar).
// Too many alerts for the owner to check: tell_owner is a heads-up without a question; ask_owner stays for a decision.
export const CRITICAL_RULE = `[حالت critical] حادثه‌های تازه/بدترشده (critical و warning) به تو می‌رسند. ${OWNER_NAME} آلارم‌ها را نمی‌خواند؛ تو صافی او هستی. بیشتر warningها نویز یا بی‌اقدام‌اند: فقط ثبت کن، مگر همان معیار پایین را داشته باشند.
- مستقل راستی‌آزمایی کن (عدد واقعی، روند، اثر روی کاربر)؛ آلارم تکراریِ از قبل معلوم را فقط ثبت کن.
- ${OWNER_NAME} باید بداند (tell_owner) وقتی: کاربر واقعاً اثر می‌بیند؛ خطر از دست رفتن داده یا بکاپ هست (بکاپ/آرشیو WAL دیتابیس حساس، S3 اصلی نزدیک پر شدن)؛ مسیر آلارم خودش کور شده؛ یا همکاری به‌زودی دربارهٔ همین به او پیام می‌دهد. یک پیام برای چند حادثهٔ هم‌ریشه، ۲–۴ خط فارسی ساده: چه شده، اثرش، عدد، و کاری که پیشنهاد می‌کنی یا در جریان است. اسم آلارم/پاد/ابزار نه.
- اگر تصمیمی با ${OWNER_NAME} است (تغییر، هزینه، دست زدن به سیستم کسی): به‌جای tell_owner یک ask_owner کوتاه با عدد و پیشنهاد (گزینه‌ها: «انجام بده» / «فعلاً نه»).
- نویز، آزمایشگاه خود ${OWNER_NAME}، چیز عمدی/ack‌شده، mirror بی‌اثر، و حادثه‌ای که قبلاً گفته‌ای و بدتر نشده: هیچ پیامی؛ فقط incident_update.`;

// Worth a Griffin run: something new, worse, or back without a diagnosis. A flap of an incident
// Griffin already diagnosed only rides along with the next digest (counted as flaps).
const needsLook = (c) => c.kind === "opened" || c.kind === "escalated" || c.kind === "baseline" || (c.kind === "reopened" && !c.incident.triage_json);
const urgentChange = (c) => needsLook(c) && c.kind !== "baseline" && c.incident.severity === "critical";

export function createOpsRoom({
  store,
  runner,
  incidents,
  mode = "shadow",
  log = console,
  now = () => new Date(),
  debounceMs = 2 * 60_000,
  warnDebounceMs = 15 * 60_000,
  urgentMs = 15_000,
  maxRunsPerHour = 4,
}) {
  // "record": incidents are grouped and shown, heartbeat stays green, but no LLM triage runs.
  const triaging = mode !== "off" && mode !== "record";
  let pending = [];
  let bootstrapPending = false;
  let timer = null;
  // Timestamps of digests sent in the last hour; kept in kv so a restart does not reset the budget.
  const sent = (store.getKv("ops_room_sent") || []).filter((t) => t > now().getTime() - 3_600_000);

  function room() {
    const day = tehranDay(now());
    const current = store.getKv("ops_room");
    if (current?.day === day && store.getChat(current.chatId)) return store.getChat(current.chatId);
    if (current?.chatId && store.getChat(current.chatId)) store.updateChat(current.chatId, { pinned: false });
    const chat = store.createChat({ title: `اتاق عملیات — ${day}`, agent: "griffin", caller: OPS_CALLER });
    store.updateChat(chat.id, { pinned: true });
    store.setKv("ops_room", { chatId: chat.id, day, fresh: true });
    return store.getChat(chat.id);
  }

  function schedule(ms) {
    if (timer) {
      if (ms >= timer.ms) return;
      clearTimeout(timer.handle);
    }
    const handle = setTimeout(() => {
      timer = null;
      flush().catch((error) => log.error?.(`[ops] flush: ${error.message}`));
    }, ms);
    handle.unref?.();
    timer = { handle, ms };
  }

  async function flush() {
    if (!pending.length || !triaging) return null;
    const chat = room();
    if (runner.isActive(chat.id)) {
      schedule(60_000);
      return null;
    }
    const hourAgo = now().getTime() - 3_600_000;
    while (sent.length && sent[0] < hourAgo) sent.shift();
    // Warnings must not spend the hour's budget a new critical needs: a critical gets double.
    const cap = pending.some(urgentChange) ? maxRunsPerHour * 2 : maxRunsPerHour;
    if (sent.length >= cap) {
      schedule(Math.max(60_000, sent[0] + 3_600_000 - now().getTime()));
      return null;
    }
    const changes = pending;
    const bootstrap = bootstrapPending;
    pending = [];
    bootstrapPending = false;
    const kv = store.getKv("ops_room");
    const charter = kv?.fresh ? `${OPS_CHARTER}${mode === "critical" ? `\n\n${CRITICAL_RULE}` : ""}\n\n` : "";
    if (kv?.fresh) store.setKv("ops_room", { ...kv, fresh: false });
    const text = charter + digestMessage(changes, { openCount: incidents.open().length, bootstrap });
    sent.push(now().getTime());
    store.setKv("ops_room_sent", sent);
    await runner.send(chat.id, { text, images: [] });
    return chat.id;
  }

  return {
    mode,
    push(changes, { bootstrap = false } = {}) {
      // "critical": only an incident that is new, worse or back gets a run, never the bootstrap
      // backlog. Warnings too — batched on a slower clock, and the room tells the owner only what
      // passes the bar.
      if (mode === "critical") {
        changes = changes.filter((c) => c.kind !== "baseline" && c.kind !== "resolved");
        bootstrap = false;
      }
      if (!triaging || !changes.length) return;
      pending.push(...changes);
      if (pending.length > 500) pending = pending.slice(-500); // quiet flaps must not grow forever
      if (bootstrap) bootstrapPending = true;
      if (changes.some(urgentChange)) schedule(urgentMs);
      else if (changes.some((c) => needsLook(c) && c.incident.severity === "critical")) schedule(debounceMs);
      else if (changes.some(needsLook)) schedule(warnDebounceMs);
      // resolved-only changes wait for the next actionable digest
    },
    flush,
    // A colleague's report the mother tied to an open incident (desk.forwardToIncident): straight to
    // the room, past the hourly digest budget (a person seeing it is the strongest signal), mid-turn if
    // the room is at work. Returns the room's chat id, or null when triage is off.
    async relay({ text, from = null }) {
      if (!triaging) return null;
      const chat = room();
      const kv = store.getKv("ops_room");
      const charter = kv?.fresh ? `${OPS_CHARTER}${mode === "critical" ? `\n\n${CRITICAL_RULE}` : ""}\n\n` : "";
      if (kv?.fresh) store.setKv("ops_room", { ...kv, fresh: false });
      const running = runner.isActive(chat.id);
      await runner.send(chat.id, { text: charter + text, images: [], ...(from ? { from } : {}), intent: running ? "steer" : "send" });
      return chat.id;
    },
    roomId: () => store.getKv("ops_room")?.chatId || null,
    pendingCount: () => pending.length,
  };
}

// Tools for Griffin in the ops room: list incidents, record triage; owner chats can also ack.
// ponytail: in-memory, a restart forgets what was told (one repeat at worst); kv if that bites.
const told = new Map(); // incident key -> ms
const toldToday = [];
const TELL_REPEAT_MS = 6 * 3_600_000;
const TELL_PER_DAY = 12;

export function createIncidentTools({ incidents, notify = null, now = () => Date.now() }) {
  const find = (id) => {
    const s = String(id || "");
    return incidents.get(s) || incidents.list({ status: "all", limit: 500 }).find((r) => r.id.startsWith(s)) || null;
  };
  return {
    [TELL_OWNER]: {
      description: `Tell ${OWNER_NAME} (his Telegram) something he should know about incidents: real user impact, data/backup at risk, the alert path blind, or something a colleague will ask him about. A heads-up, no question; for a decision use ask_owner. Plain Persian, 2-4 lines, numbers, no alert/pod/tool names. Never for noise, his own lab, acked/intentional states, or an incident already told that did not get worse.`,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 10, maxLength: 1200 },
          ids: { type: "array", items: { type: "string", minLength: 8 }, minItems: 1, maxItems: 20, description: "the incidents this is about" },
          worse: { type: "boolean", description: "true if an incident already told got worse since" },
        },
        required: ["text", "ids"],
        additionalProperties: false,
      },
      async execute(args) {
        if (!notify) return { isError: true, content: [{ type: "text", text: `shadow mode: nothing reaches ${OWNER_NAME}; record with incident_update.` }] };
        const rows = args.ids.map(find).filter(Boolean);
        if (!rows.length) return { isError: true, content: [{ type: "text", text: `no incident ${args.ids.join(", ")}` }] };
        const t = now();
        const fresh = rows.filter((r) => args.worse || !(told.get(r.key) > t - TELL_REPEAT_MS));
        if (!fresh.length) return { isError: true, content: [{ type: "text", text: `already told ${OWNER_NAME} about these in the last 6h; only again if it got worse (worse:true).` }] };
        while (toldToday.length && toldToday[0] < t - 86_400_000) toldToday.shift();
        if (toldToday.length >= TELL_PER_DAY) return { isError: true, content: [{ type: "text", text: `daily cap (${TELL_PER_DAY}) reached; record with incident_update, use ask_owner only for a decision.` }] };
        const ok = await notify(`🛰 ${args.text.trim()}`);
        if (!ok) return { isError: true, content: [{ type: "text", text: `${OWNER_NAME}'s bot is not paired; nothing sent.` }] };
        toldToday.push(t);
        for (const r of fresh) {
          told.set(r.key, t);
          incidents.log(r.id, "told_owner", { text: args.text.slice(0, 300) });
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, told: fresh.map((r) => r.id.slice(0, 8)) }) }] };
      },
    },
    [INCIDENT_HISTORY]: {
      description: "History of one incident key: earlier occurrences with their triage, the owner's acks (intentional states), and this incident's log. Check this before diagnosing.",
      inputSchema: { type: "object", properties: { id: { type: "string", minLength: 8 } }, required: ["id"], additionalProperties: false },
      async execute(args) {
        const row = find(args.id);
        if (!row) return { isError: true, content: [{ type: "text", text: `no incident ${args.id}` }] };
        const past = incidents.history(row.key, 10).map((r) => ({ id: r.id, status: r.status, firstSeen: r.first_seen, resolvedAt: r.resolved_at, flaps: r.flaps, triage: JSON.parse(r.triage_json || "null") }));
        return { content: [{ type: "text", text: JSON.stringify({ key: row.key, acks: incidents.acksFor(row.key), occurrences: past, log: incidents.logs(row.id, 30) }) }] };
      },
    },
    [INCIDENT_ACK]: {
      description: "Record the owner's statement that an incident (or one member of it, e.g. one endpoint) is intentional/known, so it stops waking the ops room. Only when the owner said so. remove=true deletes the ack.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 8 },
          member: { type: "string", maxLength: 300, description: "one member (endpoint/pod/bucket); omit for the whole incident" },
          reason: { type: "string", minLength: 3, maxLength: 500 },
          days: { type: "integer", minimum: 1, maximum: 365, description: "expire after N days (omit = until removed)" },
          remove: { type: "boolean" },
        },
        required: ["id", "reason"],
        additionalProperties: false,
      },
      async execute(args) {
        const row = find(args.id);
        if (!row) return { isError: true, content: [{ type: "text", text: `no incident ${args.id}` }] };
        if (args.remove) {
          incidents.unack(row.key, args.member || "");
          incidents.log(row.id, "unack", { member: args.member || "" });
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, acks: incidents.acksFor(row.key) }) }] };
        }
        const until = args.days ? new Date(Date.now() + args.days * 86_400_000).toISOString() : null;
        const acks = incidents.ack({ key: row.key, member: args.member || "", reason: args.reason, by: "owner", until });
        incidents.log(row.id, "ack", { member: args.member || "", reason: args.reason, until });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, key: row.key, acks, nowQuiet: incidents.isAcked(row) }) }] };
      },
    },
    [INCIDENTS_LIST]: {
      description: "List incidents (grouped alerts): open by default, or all/resolved; critical first, with total/shown and a per-cluster count so you know if the list is partial. An incident is an alert, not proof of user impact. Each has id, cluster, alertname, scope, severity, owner, members, times, flaps and any recorded triage.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["open", "resolved", "all"] },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      async execute(args = {}) {
        const status = args.status || "open";
        const rows = incidents.list({ status, limit: args.limit || 50 }).map(incidentView);
        const { total, byCluster } = incidents.summary?.({ status }) || { total: rows.length, byCluster: {} };
        // Critical first; `shown` vs `total` says whether this is the whole picture.
        return { content: [{ type: "text", text: JSON.stringify({ total, shown: rows.length, byCluster, incidents: rows }) }] };
      },
    },
    [INCIDENT_UPDATE]: {
      description: "Record your triage on an incident (id or its first 8 chars). Nothing is sent to anyone.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 8 },
          cause: { type: "string", maxLength: 1000 },
          impact: { type: "string", maxLength: 1000 },
          owner: { type: "string", maxLength: 120 },
          whoWouldAsk: { type: "string", maxLength: 300 },
          action: { type: "string", maxLength: 1000 },
          reversible: { type: "boolean" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          noise: { type: "boolean" },
          coveredBy: { type: "string", maxLength: 64, description: "for TeamReport: id of the incident that already covered it" },
          missed: { type: "boolean", description: "for TeamReport: true if no machine signal covered it" },
        },
        required: ["id", "cause", "confidence"],
        additionalProperties: false,
      },
      async execute(args) {
        const id = String(args.id);
        const row = incidents.get(id) || incidents.list({ status: "all", limit: 500 }).find((r) => r.id.startsWith(id));
        if (!row) return { isError: true, content: [{ type: "text", text: `no incident ${id}` }] };
        const { id: _id, ...triage } = args;
        const updated = incidents.setTriage(row.id, triage);
        incidents.log(row.id, "triage", triage);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, incident: incidentView(updated) }) }] };
      },
    },
  };
}
