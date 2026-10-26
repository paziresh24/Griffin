// mcp_server_list / mcp_server_add / mcp_server_remove: the owner's user-scope MCP servers
// (Settings → MCP servers, mcp-servers.mjs) from the agent, in the owner's own chats only.
// Same code as the page's «افزودن» button (createMcpServers.save); nothing else in ~/.claude.json
// is reachable. No secret passes through here: env is not accepted, a header whose name or value
// looks like a credential is refused (a server that needs one is signed in through Claude Code's
// own OAuth, or the owner types the value on the page). Claude Code reads the list from the session's
// own config folder; claude.mjs copies it there before each run (syncMcpServers).
import { createMcpServers, MCP_NAME } from "./mcp-servers.mjs";
import { isOwnerChat } from "./owner-chat-tools.mjs";

export const MCP_SERVER_TOOL_NAMES = ["mcp_server_list", "mcp_server_add", "mcp_server_login", "mcp_server_remove"];

const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: String(error?.message || error) }) }] });

const SECRET_HEADER = /auth|cookie|token|secret|passw|key|credential|session/i;
const SECRET_VALUE = /^\s*(bearer|basic|token)\s+\S|^(sk|ghp|glpat|xox[bap])[-_]/i;

export function createMcpServerTools({ store, chatId, mcp = createMcpServers(), oauth = null, publicUrl = "" }) {
  if (!isOwnerChat(store, store.getChat(chatId))) return {};
  return {
    mcp_server_list: {
      description: "List the owner's MCP servers (name, type, url or command). Header and env values are masked.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        try {
          return ok({ servers: mcp.list(), file: mcp.file });
        } catch (error) {
          return fail(error);
        }
      },
    },
    mcp_server_add: {
      description:
        "Add (or update, same name) one MCP server in the owner's list — what Settings → MCP servers → «افزودن» does. type http|sse needs `url`; stdio needs `command` (+ `args`). Never pass a password or token: headers named like a credential are refused (a server that signs in with OAuth is authorised afterwards from Claude Code's /mcp).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "letters, digits, . _ -" },
          type: { type: "string", enum: ["http", "sse", "stdio"] },
          url: { type: "string", description: "http(s)://… for http/sse" },
          command: { type: "string", description: "stdio only" },
          args: { type: "array", items: { type: "string" }, description: "stdio only" },
          headers: { type: "object", additionalProperties: { type: "string" }, description: "non-secret headers only" },
        },
        required: ["name", "type"],
        additionalProperties: false,
      },
      async execute(args) {
        try {
          const name = String(args?.name || "").trim();
          if (!MCP_NAME.test(name)) throw new Error("invalid name (letters, digits, . _ -)");
          const type = args?.type;
          if (!["http", "sse", "stdio"].includes(type)) throw new Error("type must be http, sse or stdio");
          for (const [k, v] of Object.entries(args?.headers || {})) {
            if (SECRET_HEADER.test(k) || SECRET_VALUE.test(String(v))) throw new Error(`header «${k}» looks like a credential; this tool takes no secrets — the owner enters it on the MCP page`);
          }
          const server = type === "stdio" ? { type, command: args?.command, args: args?.args } : { type, url: args?.url, headers: args?.headers };
          return ok({ server: mcp.save({ name, server }), note: "saved to the owner's MCP list" });
        } catch (error) {
          return fail(error);
        }
      },
    },
    mcp_server_login: {
      description:
        "Start the OAuth sign-in of one http/sse MCP server of the owner (what the «ورود» button on Settings → MCP servers does). Returns a `url` the owner opens in a browser and signs in with his own account; Griffin keeps the token (no value is returned here) and the server works once signed in. Needs the server to publish OAuth metadata with dynamic client registration.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      async execute(args) {
        try {
          if (!oauth) throw new Error("sign-in is not available on this install");
          const base = String(publicUrl || "").trim().replace(/\/+$/, "");
          if (!/^https?:\/\/[^\s/]+$/.test(base)) throw new Error("GRIFFIN_PUBLIC_URL is not set; use the «ورود» button on the MCP page");
          const { url } = await oauth.start({ name: String(args?.name || "").trim(), redirectUri: `${base}/api/mcp-oauth/callback` });
          return ok({ url, note: "the owner opens this link and signs in; then the server works" });
        } catch (error) {
          return fail(error);
        }
      },
    },
    mcp_server_remove: {
      description: "Remove one MCP server from the owner's list by name.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      async execute(args) {
        try {
          const name = String(args?.name || "").trim();
          return ok({ removed: mcp.remove(name), name });
        } catch (error) {
          return fail(error);
        }
      },
    },
  };
}
