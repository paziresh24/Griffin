import { t } from "./i18n.js";
// The colleagues' agents page as a short list (owner 2026-10-18: «اصلا قابل فهم نیست و خیلی پیچیده
// و طولانیه»): one row per colleague, the most recently active first, the switched-off ones folded
// away; everything else opens on a row tap (Peers.jsx).

/** Latest use of any of the colleague's device tokens, or null. */
export function lastSeen(user) {
  let best = null;
  for (const c of user?.clients || []) if (c.last_used_at && (!best || c.last_used_at > best)) best = c.last_used_at;
  return best;
}

export const activeClients = (user) => (user?.clients || []).filter((c) => !c.revoked_at && !(c.expires_at && new Date(c.expires_at) < new Date()));

/** { on, off }: matching colleagues, each list newest activity first (never seen last). */
export function peerList(users, query = "") {
  const q = query.trim().toLowerCase();
  const match = (u) => !q || `${u.label || ""} ${u.id || ""} ${u.caller || ""}`.toLowerCase().includes(q);
  const byLast = (a, b) => String(lastSeen(b) || "").localeCompare(String(lastSeen(a) || "")) || String(a.label).localeCompare(String(b.label), "fa");
  const all = (users || []).filter(match).sort(byLast);
  return { on: all.filter((u) => u.enabled), off: all.filter((u) => !u.enabled) };
}

/** How many of the agents this colleague may give work to (an agent with no tools is closed). */
export const openAgents = (user) => (user?.quotas || []).filter((q) => q.tools?.length).length;

/** The letter in a row's circle: «آقای رستمی» → «ر», not «آ» for every «آقای». */
export const initial = (label) => String(label || "").replace(/^\s*(آقای|خانم|مهندس|دکتر|Mr\.?|Ms\.?)\s+/i, "").trim().charAt(0) || t("؟"); // i18n-ignore

/** A task title without the colleague's own name in front («نورا کریمی: سلام…» → «سلام…»). */
export const taskTitle = (title, label) => {
  const t = String(title || "");
  const name = String(label || "").trim();
  return name && t.startsWith(`${name}:`) ? t.slice(name.length + 1).trim() : t;
};
