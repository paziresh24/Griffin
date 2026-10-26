// Agents talk to agents over the agents' network (network.mjs); Telegram is for people (owner
// 2026-10-20: «ایجنتای بچه ها بهم پیام دادن و از تلگرام باهم صحبت کردن … ترجیح گریفین بر ارتباط
// در بستر A2A باشه و فقط وقتی با آدما کار داره به تلگرام رجوع کنه»).
//
// A Telegram person that is really a colleague's agent (it signed its messages, or it is a bot) is
// matched to a member of the network by its owner's name (or an explicit access.networkAgent id on
// the person). A message to such a person then goes over the network — a queued one when that
// agent is updating or offline — and only when the network has no path at all may Telegram be used,
// with a stated reason.

const STOP = new Set(["ربات", "بات", "ایجنت", "دستیار", "هوشمند", "خودکار", "آقای", "خانم", "دکتر", "مهندس", "استاد", "bot", "agent", "assistant", "ai", "the"]);

/** Persian/Latin name -> comparable lowercase tokens (ي/ك unified, ZWNJ and diacritics gone). */
export function nameTokens(text) {
  return String(text || "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ً-ْٰٔ]/g, "")
    .replace(/[‌‏‎_.@-]+/g, " ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

const BOT_NAME = /(?:^|[\s_])bot$|_bot$|ربات|ایجنت|دستیار/i;

/** Whether a Telegram person is an automated agent rather than a human. */
export function isAgentPerson(person) {
  if (!person) return false;
  // A group or channel is never an agent, whatever its title says.
  if (String(person.external_id || "").startsWith("-") || ["group", "channel"].includes(person.meta?.chatType)) return false;
  if (person.access?.peerAgent?.user) return true;
  if (person.meta?.isBot || person.meta?.chatType === "bot") return true;
  return [person.username, person.display_name, person.fa_name, person.name].some((v) => v && BOT_NAME.test(String(v).trim()));
}

/** The network member that is this person's agent, or null: explicit id first, then the owner's name. */
export function matchNetworkAgent(person, agents) {
  const list = (agents || []).filter((a) => a.connected !== false);
  const explicit = person?.access?.networkAgent;
  if (explicit) return list.find((a) => a.id === explicit) || null;
  const mine = new Set([person?.name, person?.fa_name, person?.display_name, person?.username].flatMap(nameTokens));
  const hits = list.filter((a) => {
    const owner = nameTokens(a.owner);
    return owner.length >= 2 && owner.every((t) => mine.has(t));
  });
  return hits.length === 1 ? hits[0] : null;
}

/** { route: "telegram" } for a human (or a bot that is nobody's agent), { route: "network", agent } for
 *  an agent we are connected to, { route: "none" } for a colleague's agent with no network path (find
 *  or make one first). A bot is held to the network only once it has signed as an assistant. */
export function routeFor(person, agents) {
  if (!isAgentPerson(person)) return { route: "telegram" };
  const agent = matchNetworkAgent(person, agents);
  if (agent) return { route: "network", agent };
  return person.access?.peerAgent?.user ? { route: "none" } : { route: "telegram" };
}

export const NO_PATH_HINT =
  "«{name}» is a colleague's agent, and agents talk over the agents' network, not Telegram. Nothing was sent. " +
  "Look in network_agents for their install (the owner's name matches); if it is not there, network_connect {url} " +
  "(their install's address) or network_connect without a url to refresh, then network_ask. Only if there is truly no way " +
  "to reach it over the network, send again with telegram_because set to one line saying what you tried.";

/**
 * One decision for a send to `person`:
 *   { go: "telegram" }                        -> send as before
 *   { go: "network", agent }                  -> deliver with network.say
 *   { go: "blocked", result }                 -> return result to the model, nothing sent
 */
export function decideSend({ person, agents, because = "", name = "" }) {
  const r = routeFor(person, agents);
  if (r.route === "telegram") return { go: "telegram" };
  if (r.route === "network") return { go: "network", agent: r.agent };
  if (String(because || "").trim().length >= 8) return { go: "telegram", because: String(because).trim().slice(0, 200) };
  return { go: "blocked", result: { sent: false, via: "none", error: NO_PATH_HINT.replace("{name}", name || person?.name || "this person") } };
}
