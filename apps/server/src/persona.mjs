// Griffin is the platform; the assistant running on it has its own name per install (every agent
// used to be told «You are Griffin» and they stepped on each other). Defaults keep a fresh install
// named Griffin.
// Env wins; then the name saved in the database (kv "persona": the setup wizard, or a rename of the
// main agent's profile); then <data>/persona.json (older installs); then «گریفین».
// Read live: a rename reaches prompts and signatures without a
// restart. Call words (CALL_RE below) are still built once at load.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { genv } from "./env.mjs";
import { agentNameError, currentProduct } from "./identity.mjs";
import { nameOf } from "./profile.mjs";

export const PERSONA_FILE = path.join(process.env.GRIFFIN_DATA || "/data", "persona.json");
export const PERSONA_KV = "persona";
const saved = (() => {
  try {
    return JSON.parse(readFileSync(PERSONA_FILE, "utf8"));
  } catch {
    return {};
  }
})();

// The store the live values come from (index.mjs binds it at start; tests bind their own).
let store = null;
export function bindPersonaStore(next) {
  store = next || null;
}
const kv = (key) => {
  try {
    return store?.getKv?.(key) || null;
  } catch {
    return null;
  }
};
const usableName = (value) => (nameOf(value) && !agentNameError(value) ? nameOf(value) : null);
const storedPersona = () => {
  const row = kv(PERSONA_KV);
  const name = usableName(row?.name);
  return name ? { name, latin: usableName(row.latin) || name } : null;
};

export const PERSONA = {
  get name() {
    return process.env.GRIFFIN_ASSISTANT_NAME || storedPersona()?.name || saved.name || "گریفین";
  },
  get latin() {
    return process.env.GRIFFIN_ASSISTANT_LATIN || storedPersona()?.latin || saved.latin || "Griffin";
  },
};

/**
 * The assistant's name for git and tool names (branches aydin/<id>, the MCP server, commit author):
 * the Latin name, lowercased and git-safe — each install's agent goes by its own name everywhere,
 * never «griffin».
 */
export function agentSlug() {
  const slug = String(PERSONA.latin || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return slug || "assistant";
}

/**
 * Whose name commits and chat branches carry. With GIT_NAME + GIT_EMAIL set
 * (Settings → config) commits are the owner's, and GIT_BRANCH_PREFIX names new chat branches; unset,
 * they carry the assistant's own name (never «griffin»).
 */
export function gitIdentity() {
  const name = String(genv("GIT_NAME") || "").trim();
  const email = String(genv("GIT_EMAIL") || "").trim();
  if (name && email) return { name, email };
  return { name: PERSONA.latin || agentSlug(), email: `${agentSlug()}@agents.griffin.invalid` };
}

export function gitPrefix() {
  const slug = String(genv("GIT_BRANCH_PREFIX") || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return slug || agentSlug();
}

/**
 * The owner's display name, live: the name typed in Settings («نام شما»), else the connected
 * Telegram account's name, else the configured one (env / persona.json, else «the owner»).
 */
export function liveOwnerName(fallback) {
  const typed = nameOf(kv("profile")?.name);
  if (typed) return typed;
  try {
    for (const integration of store?.listIntegrations?.() || []) {
      if (integration.kind === "telegram_account" && integration.enabled !== false && nameOf(integration.settings?.me?.name)) {
        return nameOf(integration.settings.me.name);
      }
    }
  } catch {
    // a store that cannot answer leaves the configured name
  }
  return fallback;
}

// Whose assistant this is, per install: env wins over persona.json's "owner" block.
//   GRIFFIN_OWNER_NAME / _NAME_FA        short name the rules use («Write and decide the way X does»)
//   GRIFFIN_OWNER_FULL_NAME / _FULL_NAME_FA  full name (the git identity check, «the assistant of …»)
//   GRIFFIN_OWNER_ROLE                   one line after the name («platform lead at Example Co»)
//   GRIFFIN_OWNER_GUIDE                  a Markdown file that replaces the built-in voice-and-decision
//                                        guide — e.g. the owner's ~/.claude/CLAUDE.md; its @imports are
//                                        read in, the way Claude Code reads them
//   GRIFFIN_OWNER_SECRETS                where this owner's secrets live («the vault: Infisical project …»)
// Any owner setting at all makes the owner custom (his own guide, or a neutral line); with none the
// owner is unnamed («the owner») and the built-in generic voice guide applies.
const savedOwner = saved.owner && typeof saved.owner === "object" ? saved.owner : {};
const ownerSetting = (env, key) => {
  const fromEnv = typeof process.env[env] === "string" ? process.env[env].trim() : "";
  const fromFile = typeof savedOwner[key] === "string" ? savedOwner[key].trim() : "";
  return fromEnv || fromFile;
};
const set = {
  name: ownerSetting("GRIFFIN_OWNER_NAME", "name"),
  nameFa: ownerSetting("GRIFFIN_OWNER_NAME_FA", "nameFa"),
  fullName: ownerSetting("GRIFFIN_OWNER_FULL_NAME", "fullName"),
  fullNameFa: ownerSetting("GRIFFIN_OWNER_FULL_NAME_FA", "fullNameFa"),
  role: ownerSetting("GRIFFIN_OWNER_ROLE", "role"),
  guide: ownerSetting("GRIFFIN_OWNER_GUIDE", "guide"),
  secrets: ownerSetting("GRIFFIN_OWNER_SECRETS", "secrets"),
};
const custom = Object.values(set).some(Boolean);
const STATIC_OWNER = custom
  ? {
      custom: true,
      named: Boolean(set.name),
      name: set.name || "the owner",
      nameFa: set.nameFa || set.name || "صاحب‌کار",
      fullName: set.fullName || set.name || "the owner",
      fullNameFa: set.fullNameFa || set.nameFa || "",
      role: set.role,
      guide: set.guide,
      secrets: set.secrets,
    }
  : {
      custom: false,
      named: false,
      name: "the owner",
      nameFa: "صاحب‌کار",
      fullName: "the owner",
      fullNameFa: "",
      role: "",
      guide: "",
      secrets: "",
    };
// The rules and prompts use these configured values; the name people see in a signature, the MCP
// card and «دستیارِ …» is live (ownerSignatureName below: Settings, else Telegram, else these).
export const OWNER = STATIC_OWNER;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Names people call the assistant by: the configured ones plus «گریفین/Griffin», which colleagues
// already use and keep working after a rename.
export const CALL_NAMES = [...new Set([PERSONA.name, PERSONA.latin, "گریفین", "گریف", "Griffin"])];
// Longest first, so «گریف» never eats the start of «گریفین».
export const CALL_RE = [...CALL_NAMES].sort((a, b) => b.length - a.length).map(esc).join("|");

// A call name as a whole word («اوریونی بود» or «griffins» is not a call).
export const CALL_WORD = `(?:${CALL_RE})(?![\\p{L}\\p{N}])`;

// A signature line under a message: the assistant, or an agent that signed with its name.
export const SIGNATURE_RE = `(?:ایجنت\\s*)?(?:${CALL_RE})`;

/** The owner as a signature names him: live, or null when this install never named its owner. */
export const ownerSignatureName = () => liveOwnerName(STATIC_OWNER.named || set.nameFa ? STATIC_OWNER.nameFa : null);

// The line under every message the assistant sends (Settings → Configuration, SIGNATURE): per install
// and free-form; {name}, {owner} and {product} are filled in live, e.g. «— {name}، دستیارِ {owner} ·
// {product}». Unset, it is «— <this install's name>».
export function outgoingSignature() {
  return configuredSignature() || `— ${PERSONA.name}`;
}

const MAX_SIGNATURE = 120;
/** The SIGNATURE setting filled in (one line, at most 120 characters), or null when it is not set. */
export function configuredSignature() {
  const template = String(genv("SIGNATURE", "") || "").replace(/\s+/g, " ").trim().slice(0, MAX_SIGNATURE);
  if (!template) return null;
  const owner = ownerSignatureName() || "";
  const parts = { name: PERSONA.name, owner, product: currentProduct().name };
  let line = template.replace(/\{(name|owner|product)\}/g, (_, key) => parts[key]);
  // No owner known: «— نوا، دستیارِ {owner} · گریفین» reads «— نوا · گریفین».
  if (!owner && template.includes("{owner}")) line = line.replace(/[،,]?\s*دستیارِ?\s*(?=·|$)/u, " ");
  return line.replace(/\s+/g, " ").trim() || null;
}

/**
 * This install's own signature as a mark of an agent's message: only a SIGNATURE that was set and is
 * more than a name. Unset, the signature is «— <name>», and a person's «ممنون\n— نوا» (a pasted
 * reply, someone called Nova) must not be answered as an agent.
 */
export function distinctiveSignature() {
  const line = configuredSignature();
  if (!line) return null;
  const bare = line.replace(/^—\s*/u, "").trim();
  return CALL_NAMES.includes(bare) || bare === PERSONA.name || bare === PERSONA.latin || !/[^\p{L}\p{M}\s\u200c]/u.test(bare) ? null : line;
}

// Known peers' assistants by name: the labels of this install's live MCP tokens (Settings → peers) that
// read as a name. Labels are often devices («لپ‌تاپ») or generated («… (invite)», punctuation, so never a
// name); a label equal to the peer's own name is that person, not their agent, and is left out.
export function peerAgentNames() {
  const names = new Set();
  try {
    for (const user of store?.listPeerUsers?.() || []) {
      if (!user.enabled) continue;
      for (const client of store.listPeerClients(user.id)) {
        if (client.revoked_at || (client.expires_at && Date.parse(client.expires_at) <= Date.now())) continue;
        const label = nameOf(client.label);
        if (label && !agentNameError(client.label) && label !== nameOf(user.label)) names.add(label);
      }
    }
  } catch {
    // a store that cannot answer knows no peers
  }
  return [...names];
}

/**
 * The main agent's profile label is its name: renaming it renames the assistant
 * everywhere, at once. The caller has checked the name (agentNameError).
 */
export function renameAssistant(target, name, latin = "") {
  const clean = nameOf(name);
  target.setKv(PERSONA_KV, { name: clean, latin: nameOf(latin) || clean });
}

/**
 * The setup wizard names the assistant: persona.json keeps everything else in it (the "owner" block
 * too), and the database copy makes the name live at once.
 */
export function saveAssistantName(target, name, latin = "", file = PERSONA_FILE) {
  let current = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    current = {};
  }
  writeFileSync(file, JSON.stringify({ ...current, name, latin: latin || name }));
  renameAssistant(target, name, latin);
}

/** The line under the assistant's name on the home page (signed-in /api/brand). */
export function brandLine() {
  const owner = ownerSignatureName();
  if (!owner) return { owner: null, blurb: "" };
  return { owner, blurb: STATIC_OWNER.custom ? `دستیارِ ${owner}` : "دستیار هوشمند شخصی شما" };
}
