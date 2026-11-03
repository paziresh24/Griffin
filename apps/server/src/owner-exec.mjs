import { ownerChat } from "./jobs/owner-jobs.mjs";
import { OPS_CALLER } from "./incidents/opsroom.mjs";

// Which Kubernetes identity kube_exec runs as (2026-10-29, owner: «این نباید باعث بشه نوا نتونه
// مشکلات رو حل کنه … الان هیچ محیط کاری به غیر از نوا ندارم»). The cluster's griffin-exec-guard
// refuses exec into the namespaces whose pods hold a master credential (infisical, the kube proxy,
// the Authentik portal) for the shared "griffin" identity. The owner's own work runs as
// "griffin-owner" instead (platform-gitops platform-rbac, broker kube.mjs asOwner): his untainted
// chats and the chats under them, any chat or job of his on «بدون پرسیدن» (index.mjs), and the ops
// room's emergency work. Everything else — colleague
// and peer chains, jobs, the desk, a chat that read Telegram, the web or another chat — stays
// "griffin", so text from someone else cannot steer the stronger identity.
//
// The flag travels as a Symbol key: JSON (a model's arguments, a peer's tools/call, the broker
// socket body) can never carry it, and any wrapper that clones the arguments through JSON drops it,
// which falls back to the restricted identity. tools.mjs turns it into the explicit asOwner field.
export const OWNER_EXEC = Symbol("griffin.ownerExec");

// Tools whose result is someone else's words. ponytail: a deny-list for this one decision (the
// knowledge allowlist taints on every platform tool, which would leave no chat trusted at all).
export const OUTSIDE_TEXT_TOOLS = Object.freeze([
  "telegram_read", "telegram_media", "telegram_dialogs", "telegram_watch_list", "telegram_ledger",
  "web_fetch", "web_search", "WebFetch", "WebSearch", "browser_open", "browser_snapshot",
  "chrome_tabs", "chrome_snapshot", "chrome_act", "chrome_eval", "chrome_devtools", "chrome_cdp",
  "network_ask", "network_reply", "chat_read", "inbox_list", "feed_read", "team_threads",
]);

// A user event whose `from` is not one of these was written by someone else. "reminder" is this
// chat's own `later` note (app.mjs), written by its agent: it carries nothing the chat had not seen.
const OWN_FROM = Object.freeze(["owner_web", "reminder"]);

const TAINT_SQL = `
  SELECT 1 FROM events
  WHERE chat_id IN (?, ?) AND (
    (type = 'tool.started' AND json_extract(data, '$.name') IN (${OUTSIDE_TEXT_TOOLS.map(() => "?").join(", ")}))
    OR (type = 'user' AND json_extract(data, '$.from') IS NOT NULL AND COALESCE(json_extract(data, '$.from.kind'), '') NOT IN (${OWN_FROM.map(() => "?").join(", ")})))
  LIMIT 1`;

/** ownerExecTrust(chatId) → true when kube_exec in this chat may run as griffin-owner, decided
 *  at call time (a chat can read Telegram mid-run). */
export function createOwnerExecTrust({ store, ownerRooted }) {
  let stmt = null;
  const tainted = (id, root) => Boolean((stmt ||= store.db.prepare(TAINT_SQL)).get(id, root, ...OUTSIDE_TEXT_TOOLS, ...OWN_FROM));
  return function ownerExecTrust(chatId) {
    if (!chatId) return false;
    const root = store.rootChatId?.(chatId) || chatId;
    const rootChat = store.getChat?.(root);
    if (!rootChat || rootChat.sim) return false;
    if (rootChat.caller === OPS_CALLER) return true;
    if (!ownerChat(store, chatId, { ownerRooted })) return false;
    return !tainted(chatId, root);
  };
}

/** Wraps kube_exec so each call carries this chat's verdict (the Symbol flag, see above). */
export function markOwnerExec(tools, { chatId, trust }) {
  const tool = tools?.kube_exec;
  if (!tool?.execute) return tools;
  const inner = tool.execute.bind(tool);
  return {
    ...tools,
    kube_exec: {
      ...tool,
      execute: (args, ...rest) => {
        const plain = { ...(args || {}) };
        delete plain.asOwner;
        return inner(trust(chatId) ? { ...plain, [OWNER_EXEC]: true } : plain, ...rest);
      },
    },
  };
}
