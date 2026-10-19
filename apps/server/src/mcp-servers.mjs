import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Settings → MCP servers: the owner's user-scope MCP servers, i.e. `mcpServers` in ~/.claude.json,
// which full Claude Code (config CLAUDE_CODE=on) loads in the owner's own Claude chats. Every other
// key of that file (Claude Code's own state) is kept as it is. Env and header values are secrets:
// the browser only sees a mask, and a mask sent back means «keep what is stored».

export const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MASK = "••••";
export const maskValue = (v) => {
  const s = String(v ?? "");
  return s.length > 8 ? `${MASK}${s.slice(-4)}` : MASK;
};
const isMask = (v) => typeof v === "string" && v.startsWith(MASK);

const typeOf = (s) => (s?.type === "http" || s?.type === "sse" ? s.type : s?.url && !s?.command ? "http" : "stdio");
const strMap = (m) => (m && typeof m === "object" && !Array.isArray(m) ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, String(v ?? "")])) : {});
const maskMap = (m) => Object.fromEntries(Object.entries(strMap(m)).map(([k, v]) => [k, maskValue(v)]));

// What the browser gets: no env/header value in the clear.
export function publicServer(name, server) {
  const type = typeOf(server);
  return type === "stdio"
    ? { name, type, command: String(server?.command || ""), args: Array.isArray(server?.args) ? server.args.map(String) : [], env: maskMap(server?.env) }
    : { name, type, url: String(server?.url || ""), headers: maskMap(server?.headers) };
}

// A masked value from the client keeps the stored one; anything else replaces it.
function keepMasked(next, stored) {
  const prev = strMap(stored);
  const out = {};
  for (const [k, v] of Object.entries(strMap(next))) {
    if (!k.trim()) continue;
    if (isMask(v)) {
      if (!(k in prev)) throw new Error(`no stored value for «${k}»; type the value`);
      out[k] = prev[k];
    } else out[k] = v;
  }
  return out;
}

// The stored entry for a submitted form (fields Claude Code itself added, e.g. oauth, are kept).
export function mergeServer(input, stored) {
  const type = input?.type === "http" || input?.type === "sse" ? input.type : "stdio";
  const base = stored && typeOf(stored) === type ? { ...stored } : {};
  if (type === "stdio") {
    const command = String(input?.command || "").trim();
    if (!command) throw new Error("command is required");
    const args = Array.isArray(input?.args) ? input.args.map(String).filter((a) => a !== "") : [];
    const env = keepMasked(input?.env, stored?.env);
    delete base.url;
    delete base.headers;
    return { ...base, type, command, args, env };
  }
  const url = String(input?.url || "").trim();
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error("url must be http(s)://…");
  const headers = keepMasked(input?.headers, stored?.headers);
  delete base.command;
  delete base.args;
  delete base.env;
  return { ...base, type, url, headers };
}

// The file Claude Code reads its user-scope MCP servers from: inside CLAUDE_CONFIG_DIR when that is
// set (a host install pointed at the owner's account folder), else beside ~/.claude (the image).
export const claudeJsonPath = (env = process.env, home = os.homedir()) =>
  env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json");

export function createMcpServers({ file = claudeJsonPath() } = {}) {
  function read() {
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      return state && typeof state === "object" && !Array.isArray(state) ? state : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new Error(`${path.basename(file)} is not readable JSON (${error.message})`);
    }
  }
  const serversOf = (state) => (state.mcpServers && typeof state.mcpServers === "object" ? state.mcpServers : {});

  function write(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    file,
    // The stored entry as it is (secrets included): server code only, never sent to a browser or an agent.
    get: (name) => serversOf(read())[name] || null,
    // One header of an http/sse entry set by code (the OAuth sign-in, mcp-oauth.mjs).
    setHeader(name, header, value) {
      const state = read();
      const servers = { ...serversOf(state) };
      if (!servers[name]) throw new Error(`no MCP server named «${name}»`);
      servers[name] = { ...servers[name], headers: { ...strMap(servers[name].headers), [header]: value } };
      write({ ...state, mcpServers: servers });
    },
    list: () => Object.entries(serversOf(read())).map(([name, s]) => publicServer(name, s)),
    // `previous` renames: the old entry's stored secrets carry over to the new name.
    save({ name, previous, server }) {
      name = String(name || "").trim();
      if (!MCP_NAME.test(name)) throw new Error("invalid name (letters, digits, . _ -)");
      // ponytail: read-modify-write is not locked against Claude Code writing the same file at the same instant.
      const state = read();
      const servers = { ...serversOf(state) };
      const from = previous && previous !== name ? previous : name;
      if (from !== name && name in servers) throw new Error(`«${name}» already exists`);
      servers[name] = mergeServer(server, servers[from]);
      if (from !== name) delete servers[from];
      write({ ...state, mcpServers: servers });
      return publicServer(name, servers[name]);
    },
    remove(name) {
      const state = read();
      const servers = { ...serversOf(state) };
      if (!(name in servers)) return false;
      delete servers[name];
      write({ ...state, mcpServers: servers });
      return true;
    },
  };
}
