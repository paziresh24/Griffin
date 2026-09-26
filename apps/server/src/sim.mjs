import { classify } from "./guard.mjs";
import { ASK_REQUESTER_TOOL, ASK_TOOL } from "./asks.mjs";

// Simulation chats (evals, "what would Griffin do with this?"): the agent runs for real — real
// reads, real reasoning — but nothing leaves Griffin. Tools with a side effect are recorded instead
// of executed, and questions for a human get an automatic "no", so an eval never messages anyone,
// changes infra or pings the owner's Telegram. Applies to the whole delegation tree (root decides).

// Side effects the guard does not gate (it only gates irreversible infra work).
const SIDE_EFFECTS = new Set([
  "telegram_send", "knowledge_write", "jobs_create", "jobs_update", "jobs_delete", "jobs_run",
  "incident_update", "incident_ack", "arvan_cache_purge", "nsin_cache_purge", "agent_tools_enable",
  "agent_tools_disable", "agent_settings_set", "peer_invite", "gitlab_propose",
]);

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

export function simulateTools(tools) {
  const out = {};
  for (const [name, tool] of Object.entries(tools || {})) {
    if (!tool || typeof tool.execute !== "function") {
      out[name] = tool;
      continue;
    }
    out[name] = {
      ...tool,
      async execute(args, ...rest) {
        if (name === ASK_TOOL || name === ASK_REQUESTER_TOOL) {
          return text({ answered: true, answer: "نه", selected: ["نه"], simulated: "شبیه‌سازی: کسی جواب نمی‌دهد؛ فرض کن رد شد" });
        }
        const gate = classify(name, args || {});
        if (SIDE_EFFECTS.has(name) || gate?.approve) {
          return text({ simulated: true, note: "شبیه‌سازی: اجرا نشد، فقط ثبت شد", tool: name, needsApproval: gate?.approve || null });
        }
        return tool.execute(args, ...rest);
      },
    };
  }
  return out;
}
