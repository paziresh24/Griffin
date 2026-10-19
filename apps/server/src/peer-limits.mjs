import { OWNER } from "./persona.mjs";
// Limits on what a colleague's agent (peer:*) may spend on one agent profile): its
// default and allowed models, a token cap per rolling hour and per rolling day, and the texts it
// gets back when a cap is reached or the AI provider cannot be reached. They live next to the tool
// quota, in agent_profiles.meta.callers["peer:<user>"], so every setting is per agent × colleague.
import { kindOf, splitModel } from "./providers/ids.mjs";
import { ownerTimeZone } from "./token-usage.mjs";

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
export const WINDOWS = { hourly: HOUR_MS, daily: DAY_MS };
// Usage lands when a run (turn) ends, so a cap is admission control: it is checked before every
// request and answer, and this bounds how many requests can overshoot it at once.
export const MAX_OPEN_TASKS_PER_PEER = 2;
const MAX_MESSAGE = 2_000;

// A model the owner can allow: "<account>:<model>" or a whole account ("claude-2") — the same
// forms as an agent's ordered model list.
export const isPeerModelId = (id) => typeof id === "string" && id.length <= 100 && Boolean(splitModel(id) || kindOf(id));

// What a colleague gets on an agent by default (and what an older tools-only grant runs with): the
// agent's own engines (no model list) and no token cap — caps are off by default. They stay: a cap
// set for one colleague on the peers page still applies, and the two open requests per colleague
// (MAX_OPEN_TASKS_PER_PEER) still hold.
export const PEER_DEFAULT_LIMITS = {
  model: null,
  models: [],
  budget: { hourly: null, daily: null },
  messages: {},
};

export const DEFAULT_PEER_MESSAGES = {
  overBudget:
    `سقف مصرف شما پر شده است ({window}: {used} از {limit} توکن). درخواست اجرا نشد. بعد از {retryAt} دوباره بفرستید، یا از ${OWNER.nameFa} بخواهید سقف را بالا ببرد.`,
  unavailable:
    `الان به سرویس هوش مصنوعی دسترسی نیست و درخواست پردازش نشد. چند دقیقهٔ دیگر دوباره بفرستید؛ اگر ادامه داشت به ${OWNER.nameFa} خبر بدهید.`,
};

const WINDOW_LABEL = { hourly: "سقف یک ساعت", daily: "سقف ۲۴ ساعت" };

const cap = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

// The effective settings of a caller entry, or null when the agent is not granted to it.
export function peerSettings(profile, caller) {
  const entry = profile?.meta?.callers?.[caller];
  if (!entry) return null;
  const model = typeof entry.model === "string" && entry.model ? entry.model : null;
  const listed = Array.isArray(entry.models) ? entry.models.filter((m) => typeof m === "string" && m) : [];
  const budget = "budget" in entry ? entry.budget || {} : PEER_DEFAULT_LIMITS.budget;
  const messages = entry.messages || {};
  return {
    tools: Array.isArray(entry.tools) ? entry.tools : [],
    model,
    models: listed.length ? listed : model ? [model] : [],
    budget: { hourly: cap(budget.hourly), daily: cap(budget.daily) },
    messages: {
      overBudget: String(messages.overBudget || "").trim() || DEFAULT_PEER_MESSAGES.overBudget,
      unavailable: String(messages.unavailable || "").trim() || DEFAULT_PEER_MESSAGES.unavailable,
    },
  };
}

// Does an allowed list let this candidate run? An entry is a whole account or "<account>:<model>".
// An empty list allows the agent's own engines.
export function allowsModel(models, provider, model) {
  if (!models?.length) return true;
  return models.some((m) => {
    const split = splitModel(m);
    return split ? split.provider === provider && split.model === model : m === provider;
  });
}

// A chat's model value (pinned "<account>:<model>", or null for the agent's own engines) allowed?
export const allowsChatModel = (settings, value) => {
  if (!settings.models.length) return true;
  const split = splitModel(value);
  return split ? allowsModel(settings.models, split.provider, split.model) : false;
};

export function fillMessage(template, vars = {}) {
  return String(template || "").replace(/\{(window|used|limit|retryAt)\}/g, (all, key) => (vars[key] == null ? all : String(vars[key])));
}

// Used tokens per window for this colleague on this agent -> { hourly: { limit, used, remaining }, … }
export function budgetState(store, settings, { caller, agent, now = Date.now() }) {
  const out = {};
  for (const [window, ms] of Object.entries(WINDOWS)) {
    const limit = settings?.budget?.[window] ?? null;
    const { tokens: used } = store.peerUsageSince(caller, agent, new Date(now - ms).toISOString());
    out[window] = { limit, used, remaining: limit == null ? null : Math.max(limit - used, 0) };
  }
  return out;
}

// The first window at or over its cap, or null. retryAt: when the oldest usage still counted
// leaves that window — a lower bound (later usage may still hold it over).
export function overBudget(store, settings, { caller, agent, now = Date.now() }) {
  for (const [window, ms] of Object.entries(WINDOWS)) {
    const limit = settings?.budget?.[window] ?? null;
    if (limit == null) continue;
    const { tokens: used, oldest } = store.peerUsageSince(caller, agent, new Date(now - ms).toISOString());
    if (used < limit) continue;
    return { window, used, limit, retryAt: new Date((oldest ? Date.parse(oldest) : now) + ms).toISOString() };
  }
  return null;
}

export function overBudgetText(settings, over) {
  const retry = new Date(over.retryAt).toLocaleString("fa-IR", { timeZone: ownerTimeZone(), dateStyle: "short", timeStyle: "short" });
  return fillMessage(settings.messages.overBudget, {
    window: WINDOW_LABEL[over.window] || over.window,
    used: over.used.toLocaleString("en-US"),
    limit: over.limit.toLocaleString("en-US"),
    retryAt: retry,
  });
}

// The owner's PUT body -> the new callers entry, or { error }. Only the fields sent change.
export function mergeLimits(current, body, { isModelId = isPeerModelId } = {}) {
  const next = { ...current };
  if ("models" in body) {
    if (!Array.isArray(body.models)) return { error: "models must be a list" };
    const models = [...new Set(body.models.map((m) => String(m ?? "").trim()))];
    const bad = models.filter((m) => !m || !isModelId(m));
    if (bad.length) return { error: `unknown model: ${bad.map((m) => m || "(empty)").join(", ")}` };
    next.models = models;
  }
  if ("model" in body) {
    if (body.model === null || body.model === "") next.model = null;
    else {
      const model = String(body.model).trim();
      // The default is pinned on the colleague's new chats, so it names a model, not just an account.
      if (!splitModel(model) || !isModelId(model)) return { error: `unknown model: ${model} (use account:model)` };
      next.model = model;
    }
  }
  if (next.model && Array.isArray(next.models) && next.models.length && !allowsChatModel({ models: next.models }, next.model)) {
    return { error: "the default model must be one of the allowed models" };
  }
  for (const key of ["budget", "messages"]) {
    if (key in body && (body[key] === null || typeof body[key] !== "object" || Array.isArray(body[key]))) return { error: `${key} must be an object` };
  }
  if ("budget" in body) {
    const budget = { ...("budget" in current ? current.budget || {} : PEER_DEFAULT_LIMITS.budget) };
    for (const window of Object.keys(WINDOWS)) {
      if (!(window in body.budget)) continue;
      const v = body.budget[window];
      if (v === null || v === "") budget[window] = null;
      else if (Number.isInteger(Number(v)) && Number(v) >= 0) budget[window] = Number(v);
      else return { error: `budget.${window} must be a non-negative whole number or null` };
    }
    next.budget = budget;
  }
  if ("messages" in body) {
    const messages = { ...(current.messages || {}) };
    for (const key of Object.keys(DEFAULT_PEER_MESSAGES)) {
      if (!(key in body.messages)) continue;
      const text = String(body.messages[key] ?? "");
      if (text.length > MAX_MESSAGE) return { error: `messages.${key} is longer than ${MAX_MESSAGE} characters` };
      messages[key] = text;
    }
    next.messages = messages;
  }
  return { entry: next };
}

export const cloneDefaults = () => structuredClone(PEER_DEFAULT_LIMITS);
