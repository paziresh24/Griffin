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

// Secret-shaped text, masked in every string whatever the tool: a PEM private key block and a JWT.
// 2026-09-26: an owner SSH private key read with infisical_get and 108 kube_secret results sat in
// the event log in clear, because neither matched a secret-looking key name.
const PEM_PRIVATE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
// Provider-issued PATs (GitLab/Anthropic/OpenAI-style/Slack). 2026-09-27: a glpat-… travelled to
// the owner's Telegram inside an approval question because it followed "login ", not "token=".
const TOKEN_LITERAL = /\b(?:glpat|ghp|gho|ghu|github_pat|sk-ant|sk-proj|sk-svcacct|sk-none|xox[bporsa])-[A-Za-z0-9_-]{10,}\b/g;

// Tools whose result *is* the secret: which fields hold it.
const SECRET_FIELDS = {
  infisical_get: { keys: new Set(["value"]) },
  kube_secret: { under: new Set(["data", "stringData"]) },
};

const MAX_DEPTH = 8;

// Free-text masking only for tools whose args/results are known to embed credentials verbatim.
const LITERAL_TOOLS = new Set(["debug_exec", "pg_query", "infisical_get", "infisical_upsert"]);

function maskString(value, { literals = false } = {}) {
  let out = value.replace(PEM_PRIVATE, MASK).replace(JWT, MASK).replace(TOKEN_LITERAL, MASK);
  if (literals) out = out.replace(LITERAL_SECRET, `$1${MASK}`);
  return out.replace(SQL_PASSWORD, (_m, prefix) => `${prefix}'${MASK}'`);
}

// Strings that are themselves JSON objects (broker results embed JSON in text) are masked from
// the inside so key-based masking still catches them.
function walk(value, { literals = false, fields = null, under = false } = {}, depth = 0) {
  if (under && (typeof value === "string" || typeof value === "number")) return MASK;
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") {
    const trimmed = value.trimStart();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 200_000) {
      try {
        const parsed = JSON.parse(value);
        const masked = walk(parsed, { literals, fields, under }, depth + 1);
        return JSON.stringify(masked);
      } catch {
        /* not JSON — fall through to plain string masking */
      }
    }
    return maskString(value, { literals });
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => walk(item, { literals, fields, under }, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const scalar = typeof item === "string" || typeof item === "number";
    // The result wrapper carries its payload as JSON text under "value" too: open it, don't mask it.
    const embedded = typeof item === "string" && /^\s*[[{]/.test(item);
    out[key] = scalar && (SECRET_KEY.test(key) || (fields?.keys?.has(key) && !embedded))
      ? MASK
      : walk(item, { literals, fields, under: under || Boolean(fields?.under?.has(key)) }, depth + 1);
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
  return walk(result, { literals: LITERAL_TOOLS.has(String(name)), fields: SECRET_FIELDS[String(name)] || null });
}

// Free-text masking for places that embed tool args into a string (the guard's approval question).
export function maskText(value) {
  return maskString(String(value ?? ""), { literals: true });
}
