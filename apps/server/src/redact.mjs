// Secrets must never persist in the event log (and so in the chat UI). The agent still receives
// the real tool result — this runs only on the copy stored as tool.started/tool.done events and
// ask mirrors. Same spirit as the Winbox console masking in the broker: the result may sit in a
// chat timeline, so anything secret-shaped is replaced before it is stored.

const MASK = "***";

// Object keys whose string value is a secret, whatever the tool produced it.
const SECRET_KEY =
  /^(pass(word|wd)?|passwd|secret(value|key)?|token|api[_-]?key|apikey|rawapikey|clientsecret|client_secret|credential|psk|privatekey)$/i;

// A password literal inside SQL (CREATE ROLE … PASSWORD 'x', IDENTIFIED BY 'x').
const SQL_PASSWORD = /(\b(?:password|identified\s+by)\s+)('(?:[^']|'')*'|"(?:[^"]|"")*")/gi;

// key=value / key: value / key 'value' assignments inside free text (shell commands, embedded
// JSON) for the tools whose strings routinely carry credentials.
const LITERAL_SECRET = /(\b(?:pass(word|wd)?|passwd|pw|secret|token|api[_-]?key|apikey|credential|psk)\b["']?\s*[:=]\s*["']?)([^"'\s,;}&]{3,})/gi;

const MAX_DEPTH = 8;

// Free-text masking only for tools whose args/results are known to embed credentials verbatim.
const LITERAL_TOOLS = new Set(["debug_exec", "pg_query", "infisical_get", "infisical_upsert"]);

function maskString(value, { literals = false } = {}) {
  let out = value;
  if (literals) out = out.replace(LITERAL_SECRET, `$1${MASK}`);
  return out.replace(SQL_PASSWORD, (_m, prefix) => `${prefix}'${MASK}'`);
}

// Strings that are themselves JSON objects (broker results embed JSON in text) are masked from
// the inside so key-based masking still catches them.
function walk(value, { literals = false } = {}, depth = 0) {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") {
    const trimmed = value.trimStart();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 200_000) {
      try {
        const parsed = JSON.parse(value);
        const masked = walk(parsed, { literals }, depth + 1);
        return JSON.stringify(masked);
      } catch {
        /* not JSON — fall through to plain string masking */
      }
    }
    return maskString(value, { literals });
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => walk(item, { literals }, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) && (typeof item === "string" || typeof item === "number")
      ? MASK
      : walk(item, { literals }, depth + 1);
  }
  return out;
}

export function redactArgs(name, args) {
  const literals = LITERAL_TOOLS.has(String(name));
  if (String(name) === "infisical_upsert" && args && typeof args === "object" && !Array.isArray(args) && "value" in args) {
    return walk({ ...args, value: MASK }, { literals: false });
  }
  return walk(args, { literals });
}

export function redactResult(name, result) {
  return walk(result, { literals: LITERAL_TOOLS.has(String(name)) });
}

// Free-text masking for places that embed tool args into a string (the guard's approval question).
export function maskText(value) {
  return maskString(String(value ?? ""), { literals: true });
}
