import { mediaContent, storeMedia } from "./media.mjs";
import fs from "node:fs";
import http from "node:http";

// Exposes broker tools to the Cursor agent as SDK customTools. The broker owns the tool
// list and schemas; this side only forwards calls over the shared unix socket.
export function brokerRequest(socketPath, method, urlPath, body, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, method, path: urlPath, headers: { "content-type": "application/json" }, timeout: timeoutMs },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            reject(new Error(`broker returned invalid JSON (http ${res.statusCode})`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("broker timeout")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export function createToolSource({ socketPath, refreshMs = 5 * 60_000, request = brokerRequest, store = null, exists = (p) => fs.existsSync(p) }) {
  let cache = { at: 0, defs: null };
  let warned = false;

  /** The broker is present when its socket is there. Absent is a valid, quiet state. */
  function available() {
    if (!socketPath) return false;
    try {
      return exists(socketPath);
    } catch {
      return false;
    }
  }

  async function definitions() {
    // No broker: this install has no credential-holding tools, and that is a complete setup.
    if (!available()) return null;
    if (cache.defs && Date.now() - cache.at < refreshMs) return cache.defs;
    try {
      const { status, body } = await request(socketPath, "GET", "/tools", undefined, 5_000);
      if (status !== 200 || !Array.isArray(body)) throw new Error(`http ${status}`);
      cache = { at: Date.now(), defs: body };
      warned = false;
    } catch (error) {
      if (!warned) {
        console.error(`[tools] broker unavailable (${error.message}); running with app tools only`);
        warned = true;
      }
    }
    return cache.defs;
  }

  async function listNames() {
    const defs = await definitions();
    return (defs || []).map((d) => d.name).filter(Boolean);
  }

  // A broker result may carry a file ({ file: { name, mimeType, data } } or the older { image }).
  // It is stored as chat media; the event log gets only the media id.
  function toContent(result, chatId) {
    const file = result?.file || (result?.image?.data ? { ...result.image, name: result.key } : null);
    if (!file?.data || !store || !chatId) return [{ type: "text", text: JSON.stringify(result) }];
    const media = storeMedia(store, { chatId, name: file.name || result.key, mimeType: file.mimeType, data: file.data, meta: { source: result.source } });
    const { raw, ...summaryMedia } = media;
    const { file: _file, image: _image, ...rest } = result;
    return mediaContent({ ...rest, media: summaryMedia }, media);
  }

  async function customTools(chatId) {
    const defs = await definitions();
    if (!defs) return undefined;
    const tools = {};
    for (const def of defs) {
      tools[def.name] = {
        description: def.description,
        inputSchema: def.inputSchema,
        async execute(args) {
          try {
            const response = await request(socketPath, "POST", `/tools/${def.name}`, args ?? {});
            if (response.body?.ok) return { content: toContent(response.body.result, chatId) };
            return errorResult(response.body?.error || `http ${response.status}`, response.body?.attempts);
          } catch (error) {
            return errorResult(`broker unreachable: ${error.message}`);
          }
        },
      };
    }
    return tools;
  }

  return { customTools, listNames, available, socketPath };
}

function errorResult(message, attempts) {
  const hint = errorHint(String(message));
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: message, ...(attempts ? { attempts } : {}), ...(hint ? { hint } : {}) }) }],
  };
}

// Error messages that tell the model how to self-correct (Fowler: "custom linter messages that
// include instructions"). Each line is a recurring wasted-round class from 7 days of runs
// (2026-10-08): the model retried the same guess instead of changing approach.
const HINTS = [
  [/all paths failed/i, "Every access path to this cluster failed (see attempts). Retrying the same call will not help: report the cluster as unreachable with the attempt errors, or answer from another source."],
  [/domain not found/i, "Pass the zone apex registered in the CDN account (example.com, not api.example.com). arvan_domains / nsin_domains list the real zones."],
  [/file not found|commit not found/i, "Wrong path or ref. Find the real path with gitlab_search {scope:\"filenames\"} (or the project's default branch) instead of guessing another path."],
  [/(project|group) not found/i, "Wrong project/group path. Get the exact path_with_namespace from gitlab_projects {search} first."],
  [/killed \(timeout\)/i, "The command hit the 120s limit. Narrow it, or start it in the background (nohup … > /root/x.log 2>&1 &) and read the log in the next call."],
  [/serializer for text\/html/i, "kubectl got the SSO login page (gateway auth). Use kube_get / kube_exec / kube_logs / kube_secret, never kubectl from a shell."],
  [/^timeout$|aborted due to timeout|ETIMEDOUT/i, "No answer within the timeout from this vantage point. Check dns_lookup / the route once; a second identical try is not new evidence."],
  [/unauthorized|http_401|http_403|permission/i, "A permission refusal is the answer: report which permission on which system is missing. Do not switch identity or hunt other credentials."],
];

export function errorHint(message) {
  return HINTS.find(([pattern]) => pattern.test(message))?.[1] || "";
}
