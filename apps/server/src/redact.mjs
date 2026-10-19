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
// ArvanCloud API keys are the literal "apikey" + a UUID, no separator — key-based and literal
// patterns both missed it when a command embedded {"key":"apikey…"} (such a key once sat
// raw in debug_exec transcripts).
const ARVAN_TOKEN = /\bapikey[a-z0-9]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12}\b/g;

// Tools whose result *is* the secret: which fields hold it.
const SECRET_FIELDS = {
  infisical_get: { keys: new Set(["value"]) },
  kube_secret: { under: new Set(["data", "stringData"]) },
};

const MAX_DEPTH = 8;

// Secret values already seen in a tool result. Once the model read an app token with
// infisical_get (masked in the log) and then typed the raw value into a debug_exec command, which no
// shape-based pattern caught. Every value masked by key/field is remembered and masked anywhere later.
// ponytail: process-wide, oldest dropped past 2000, empties on restart.
const seenSecrets = new Set();
const MIN_SEEN = 12;

function remember(value) {
  const text = String(value);
  if (text.length < MIN_SEEN) return;
  seenSecrets.add(text);
  if (seenSecrets.size > 2000) seenSecrets.delete(seenSecrets.values().next().value);
}

// Free-text masking only for tools whose args/results are known to embed credentials verbatim.
const LITERAL_TOOLS = new Set(["debug_exec", "pg_query", "infisical_get", "infisical_upsert"]);

function maskString(value, { literals = false } = {}) {
  let out = value;
  for (const secret of seenSecrets) if (out.includes(secret)) out = out.split(secret).join(MASK);
  out = out.replace(PEM_PRIVATE, MASK).replace(JWT, MASK).replace(TOKEN_LITERAL, MASK).replace(ARVAN_TOKEN, MASK);
  if (literals) out = out.replace(LITERAL_SECRET, `$1${MASK}`);
  return out.replace(SQL_PASSWORD, (_m, prefix) => `${prefix}'${MASK}'`);
}

// Strings that are themselves JSON objects (broker results embed JSON in text) are masked from
// the inside so key-based masking still catches them.
function walk(value, { literals = false, fields = null, under = false } = {}, depth = 0) {
  if (under && (typeof value === "string" || typeof value === "number")) {
    remember(value);
    return MASK;
  }
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
    const secret = scalar && (SECRET_KEY.test(key) || (fields?.keys?.has(key) && !embedded));
    if (secret) remember(item);
    out[key] = secret
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

// Text the owner did not type, made inert for the Claude CLI before it reaches the agent. The CLI
// reads "@/any/path" (or "@.env", "@~/…") anywhere in a user message into the message (no tool
// call, no permission check), and runs a message starting with "/" as a local command or skill. A
// zero-width space after such an "@" and before a line's leading "/" keeps both as plain text. An
// "@" inside a word (an email, git@host:repo) is not a mention and stays. Applying it twice adds
// nothing.
export const inertText = (text) => String(text ?? "").replace(/(?<![\p{L}\p{N}_.+-])@(?!\u200b)/gu, "@\u200b").replace(/^(\s*)\//gm, "$1\u200b/");

// The way out: an agent copies what it read, so an inert "@\u200busername" can come back in a
// Telegram send or a chat lookup, where it is no longer a mention or a resolvable handle. Every
// outgoing messenger text and every agent-supplied chat target drops exactly the marker inertText
// adds (a zero-width space right after "@", or before a line's leading "/"); any other zero-width
// character (the Persian half-space included) stays. A "@\u200b" someone typed on purpose is
// indistinguishable from the marker and loses its zero-width space too.
export const withoutInertMarks = (text) => String(text ?? "").replace(/@\u200b/g, "@").replace(/^(\s*)\u200b\//gm, "$1/");

// The same for one channel delivery, before any prefix ("❓ ", "🤖 ") pushes a "/" off its line
// start: the text, the status line, a question with its options, a close note, file captions.
export function withoutInertMarksIn(message) {
  if (!message || typeof message !== "object") return message;
  const out = { ...message };
  const clean = (value) => (typeof value === "string" ? withoutInertMarks(value) : value);
  for (const key of ["text", "status"]) out[key] = clean(out[key]);
  if (out.question) {
    out.question = { ...out.question, question: clean(out.question.question) };
    if (Array.isArray(out.question.options)) out.question.options = out.question.options.map((o) => ({ ...o, label: clean(o.label), description: clean(o.description) }));
  }
  if (out.closeQuestion) out.closeQuestion = { ...out.closeQuestion, note: clean(out.closeQuestion.note) };
  if (Array.isArray(out.files)) out.files = out.files.map((f) => ({ ...f, caption: clean(f.caption) }));
  return out;
}
