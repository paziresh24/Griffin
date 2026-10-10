// The tools Griffin offers over MCP. No imports, so the stdio bridge (bin/griffin-mcp.mjs) can
// serve them without installing the server's dependencies.

const TASK_ID = { type: "string", description: "taskId returned by griffin_send" };

export const MCP_TOOLS = [
  {
    name: "griffin_send",
    description:
      "Give Griffin (the platform owner's operations agent) a task in natural language (Persian or English). " +
      "Returns within waitSec: the final answer if it finished, a question if Griffin needs input (answer with griffin_reply), " +
      "or state=working with a taskId — then keep calling griffin_wait until the state is completed/failed/canceled. " +
      "Never assume a working task failed; it is still running. Omit contextId to start a new conversation (tasks in " +
      "different contexts run in parallel); pass the contextId of a finished task to follow up in the same conversation.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What you need, with all the context Griffin needs." },
        contextId: { type: "string", description: "Continue an earlier conversation (its previous task must be finished)." },
        agent: { type: "string", description: "Optional specialist: griffin (default), platform, arvan-ban, nsin-ban." },
        messageId: { type: "string", description: "Idempotency key: resending the same messageId returns the same task." },
        waitSec: { type: "number", description: "Seconds to wait for a result before returning (default 10; up to 55 when the client accepts SSE, else 12)." },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "griffin_wait",
    description:
      "Wait (up to waitSec; max 55 with SSE, else 12) for news on a task: returns new progress after afterSeq (tool names and Griffin's text), " +
      "a question (state=input-required), or the final answer. Pass the seq from the previous result as afterSeq.",
    inputSchema: {
      type: "object",
      properties: { taskId: TASK_ID, afterSeq: { type: "number" }, waitSec: { type: "number" } },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "griffin_reply",
    description: "Answer the question of a task in state input-required. Only reversible decisions are asked here; irreversible actions go to humans.",
    inputSchema: {
      type: "object",
      properties: { taskId: TASK_ID, answer: { type: "string" }, waitSec: { type: "number" } },
      required: ["taskId", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "griffin_cancel",
    description: "Cancel a running task.",
    inputSchema: { type: "object", properties: { taskId: TASK_ID }, required: ["taskId"], additionalProperties: false },
  },
  {
    name: "griffin_tasks",
    description: "List your recent tasks (optionally in one contextId) with their states.",
    inputSchema: { type: "object", properties: { contextId: { type: "string" } }, additionalProperties: false },
  },
];
