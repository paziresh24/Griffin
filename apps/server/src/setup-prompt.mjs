// The prompt the first-run wizard hands to the agent the owner already uses (Claude Code, Cursor, …).
// The owner first answers a few questions on the page (name, engine, proxy, secrets, what to bring
// over); the prompt then holds only the steps those answers need, so the agent does the work and asks
// the human only for what nobody else can give — a key, a sign-in code, a paid choice, a proxy link.
// People are not their agents' agents (owner, 2026-10-17). No credential is put in the prompt: the
// agent reads the owner token on the server itself.

const AGENTS = {
  claude: { label: "Claude Code", home: "~/.claude", memory: "~/.claude/CLAUDE.md and ~/.claude/projects/*/memory/", skills: "~/.claude/skills/", mcp: "the mcpServers in ~/.claude.json (and the project's .mcp.json)" },
  cursor: { label: "Cursor", home: "~/.cursor", memory: "your Cursor rules (~/.cursor/rules, the project's .cursor/rules) and memories", skills: "", mcp: "~/.cursor/mcp.json" },
  zcode: { label: "ZCode", home: "", memory: "your saved instructions and memory", skills: "", mcp: "your MCP server list" },
  codex: { label: "Codex", home: "~/.codex", memory: "~/.codex/AGENTS.md and the project's AGENTS.md", skills: "", mcp: "the mcp_servers in ~/.codex/config.toml" },
  other: { label: "your agent", home: "", memory: "your saved instructions and memory", skills: "", mcp: "your MCP server list" },
};

// One block per engine the owner picked in the wizard (web ENGINES ids).
function engineSteps(engine, secrets) {
  const key = secrets === "move" ? "If you already hold this key (env, a config file, a password manager I gave you), use it; otherwise ask me for it." : "Ask me for the key; don't look for it yourself.";
  const doctor = "Then GET /api/doctor/engine/<id> must say ok; if not, act on its cause (bad_key → a fresh key, region/network → the proxy step, quota → tell me, model → pick one from GET /api/models?provider=<id>).";
  const steps = {
    "claude-sub": `Claude subscription (Pro/Max): POST /api/providers/claude/signin returns a URL. Send me the URL, I open it, sign in and give you the code; then POST /api/providers/claude/signin/code {"code":"…"}. ${doctor}`,
    "claude-api": `Anthropic API key: PATCH /api/providers/claude {"apiKey":"sk-ant-…"} (any sk-ant- key except sk-ant-oat, which is a subscription token). ${key} ${doctor}`,
    zai: `Z.ai (GLM): PATCH /api/providers/openai {"preset":"zai","apiKey":"…","model":"glm-5.3"}. ${key} ${doctor}`,
    openai: `OpenAI: PATCH /api/providers/openai {"preset":"openai","apiKey":"sk-…","model":"gpt-4o-mini"}. ${key} ${doctor}`,
    openrouter: `OpenRouter: PATCH /api/providers/openai {"preset":"openrouter","apiKey":"sk-or-…","model":"<provider/model>"}. ${key} ${doctor}`,
    ollama: `Ollama on this server: PATCH /api/providers/openai {"preset":"ollama","model":"<a model you see in ollama list>"}; if the app runs in Docker it must reach the host (host.docker.internal). ${doctor}`,
    custom: `OpenAI-compatible service: PATCH /api/providers/openai {"baseUrl":"https://…/v1","apiKey":"…","model":"…"}. Ask me for the address and model. ${key} ${doctor}`,
    cursor: `Cursor: PATCH /api/providers/cursor {"apiKey":"key_…"}. ${key} ${doctor}`,
  };
  if (steps[engine]) return steps[engine];
  return `Ask me which account I want to use (Claude subscription, Anthropic key, Z.ai, OpenAI, OpenRouter, Ollama, Cursor), then set it up through GET /api/providers and PATCH /api/providers/<id> (or POST /api/providers/claude/signin for a Claude subscription). ${doctor}`;
}

function proxySteps(proxy, product) {
  const check = "GET /api/setup/egress shows, per AI service, whether this server reaches it directly and through the proxy in use.";
  const set = `POST /api/setup/proxy {"url":"http://host:port"} (user:pass@ allowed; inside Docker 127.0.0.1 is the container itself, so use the host's LAN address or host.docker.internal)`;
  if (proxy === "move") return `${check} I want ${product} to use the same proxy as my current setup: find the HTTP proxy you (or my machine) use for the AI services (env HTTPS_PROXY / your proxy settings / a local Xray or v2ray client). If the server can reach it, ${set}. If it is only on my laptop, install the same client (Xray/sing-box) on the server with the same config and an HTTP inbound on 127.0.0.1, then point ${product} at it. Re-run the check until my engine is reachable.`;
  if (proxy === "link") return `${check} I will give you a v2ray link (vless/vmess/trojan/ss, several of them, a subscription URL or a v2ray JSON config): ask me for it and POST /api/setup/vpn {"link":"<exactly what I gave>"} — ${product} runs Xray itself and answers {"vpn":{"working":true|false}}; do not install anything. If it says the server has no Xray, install Xray-core at <data folder>/vpn/xray and POST again. Re-run the check until my engine is reachable.`;
  if (proxy === "none") return `${check} I don't want a proxy. If my engine is "region" or "unreachable", stop and tell me plainly instead of adding one.`;
  return `${check} If my engine is reachable, no proxy is needed: skip. If it is "region" or "unreachable", ask me whether I have a proxy or a v2ray link, then ${set}.`;
}

function transferSteps(transfer, agent, product, claudeHome) {
  const a = AGENTS[agent] || AGENTS.other;
  const out = [];
  if (transfer.includes("chats")) {
    // The history is Claude Code / Claude desktop's, whichever agent moves it (ZCode, Codex, … can).
    out.push(`Old chats (Claude Code / Claude desktop history, on the machine where I used Claude — ask me which machine if it isn't this one): pack ~/.claude/projects (tar czf - -C ~/.claude projects; on Windows %USERPROFILE%\\.claude) and POST it as the raw body to /api/setup/import/upload → {"upload":"<id>"} (a folder already on this server works too: POST /api/setup/import {"path":"<folder>","dryRun":true}). POST /api/setup/import {"upload":"<id>","dryRun":true} shows the counts — tell me them — then the same with "dryRun":false. They continue in ${product} with the same memory.${agent === "claude" || agent === "other" ? "" : ` ${a.label}'s own chat history can't be imported, only Claude's.`}`);
  }
  if (transfer.includes("memory")) out.push(`My instructions and memory: read ${a.memory}. Put the lasting, general parts (how I work, my preferences, facts about my systems) into ${product}'s Claude config as CLAUDE.md in ${claudeHome} (a path inside the app; under Docker use docker cp) (merge, don't overwrite what is there). Leave out anything project-specific to a machine ${product} can't reach, and never copy a secret value into it.`);
  if (transfer.includes("skills") && a.skills) out.push(`Skills: copy the folders in ${a.skills} I still use into ${claudeHome}/skills/ (inside the app; under Docker use docker cp). Skip ones that need tools the server doesn't have, and tell me which.`);
  if (transfer.includes("mcp")) out.push(`MCP servers: read ${a.mcp}. For each one that can run from the server, PUT /api/mcp-servers {"name":"…","command":"…","args":[…],"env":{…}} (or {"name":"…","url":"…","headers":{…}} for remote ones); GET /api/mcp-servers lists them. Skip ones bound to my laptop (local files, desktop apps) and tell me which.`);
  if (transfer.includes("git")) out.push(`Git access: ${product} needs to clone and push my repos. Set up GitLab/GitHub access for the server with a token scoped to read/write repositories (POST /api/setup/gitlab {"token":"…"} for GitLab; for GitHub, git credentials for the app's user), and check it with a real git ls-remote.`);
  return out;
}

function telegramSteps(product) {
  return `Messenger: ask me which I want — a Telegram bot, a Bale bot, or my own Telegram account (${product} then reads my chats and answers in Saved Messages). Bot: tell me step by step how to make one (Telegram: open https://t.me/BotFather, send /newbot, a name, a username ending in "bot"; Bale: @botfather in Bale), ask me for the token, then POST /api/integrations {"kind":"telegram_bot"|"bale_bot","token":"…","name":"Telegram"|"Bale"}. The answer has username and pairingCode: give me the link https://t.me/<username>?start=<pairingCode> (Bale: https://ble.ir/<username>?start=<pairingCode>), I press Start; then GET /api/integrations must show my chat under "paired". My account: POST /api/integrations/telegram-account/login {"phone":"+98…"} → {loginId} (if it says api_id/api_hash are needed, I make an app at https://my.telegram.org/apps and give you both: add "apiId","apiHash"); Telegram sends me a code in the app; ask me for it, POST /api/integrations/telegram-account/login/<loginId> {"code":"…"}; if the answer is {"needPassword":true,"hint":…} ask me for my two-step password (tell me the hint) and POST {"password":"…"} to the same URL. Then GET /api/integrations must show the account with state "polling". If Telegram is unreachable from this server, it needs the proxy step first.`;
}

const SECTIONS = ["proxy", "engine", "name", "import", "telegram"];

export function setupPrompt({ origin, dataDir, missing = [], name = "", product = "Griffin", claudeHome = "", choices = {}, access = "" }) {
  const agent = AGENTS[choices.agent] ? choices.agent : "other";
  const secrets = choices.secrets === "move" ? "move" : "ask";
  const transfer = Array.isArray(choices.transfer) ? choices.transfer : [];
  const home = claudeHome || `${dataDir}/home/.claude`;
  const todo = missing.length ? missing.map((m) => `- ${m}`).join("\n") : "- nothing required is missing";
  const section = SECTIONS.includes(choices.section) ? choices.section : null;
  const finish = `Finish: POST /api/setup/done, then GET /api/doctor. Send one real test message through ${product} (POST /api/chats then POST /api/chats/<id>/messages {"text":"سلام، کار می‌کنی؟"}) and check that an answer comes. Tell me in a few lines what is set, what isn't, and anything I must still do. Logo, colours and the Telegram/Bale bot are easier in the web wizard; just mention them.`;
  const steps = section
    ? [
        "State: GET /api/setup and GET /api/doctor.",
        section === "proxy" ? `Network: ${proxySteps(choices.proxy, product)}` : null,
        section === "engine" ? `AI engine: ${engineSteps(choices.engine, secrets)}` : null,
        section === "name" ? (name ? `Name: it is «${name}» now. Ask me whether to keep it; to change it POST /api/setup/persona {"name":"…","latin":"…"}.` : 'Name: ask me for one, then POST /api/setup/persona {"name":"…","latin":"…"}.') : null,
        section === "import" ? transferSteps(["chats", ...transfer.filter((t) => t !== "chats")], agent, product, home).join("\n") : null,
        section === "telegram" ? telegramSteps(product) : null,
        "Check: GET /api/doctor, and tell me in two or three lines what is now set and anything I must still do.",
      ].filter(Boolean)
    : [
        "State: GET /api/setup and GET /api/doctor (findings with a cause per engine).",
        `Network: ${proxySteps(choices.proxy, product)}`,
        `AI engine (required): ${engineSteps(choices.engine, secrets)}`,
        name ? `Name: I chose «${name}»; it is already saved. Keep it.` : 'Name: POST /api/setup/persona {"name":"…","latin":"…"} with a name I give you.',
        ...transferSteps(transfer, agent, product, home),
        choices.telegram ? telegramSteps(product) : null,
        finish,
      ].filter(Boolean);
  const secretRule =
    secrets === "move"
      ? `Secrets: you may move keys and tokens you already hold for what I chose into ${product} (engine keys through the engine step, others through PUT /api/secrets {"name":"…","value":"…"}). Move only what the steps below need, never print a value, never paste one into a chat or a file outside ${product}.`
      : `Secrets: don't read or move any key or token on your own. When a step needs one, ask me for it, and send it straight to ${product}'s API; never print it.`;
  const goal = section ? `Set up one part of ${product} (a self-hosted AI assistant platform) on my server: ${{ proxy: "its network/proxy", engine: "its AI engine", name: "its assistant name", import: "bringing my old chats and setup into it", telegram: "its Telegram/Bale connection" }[section]}. Do only that part.` : `Finish setting up ${product} (a self-hosted AI assistant platform) on my server.`;
  return `${goal} Do the work yourself through its HTTP API; ask me only for what only I can give. Talk to me in my language, short, one step at a time.

${product}: ${origin}
${section ? "" : `Still missing:\n${todo}\n`}
${access ? `Where my access is (read these first, with my own login; never print a value): ${access}\n\n` : ""}Auth: every /api call needs \`Authorization: Bearer <owner token>\`. The token is the file \`owner.token\` in ${product}'s data directory (${dataDir} inside the ${product} process). If ${product} runs in Docker: \`docker ps\` to find the app container, then \`docker exec <container> cat ${dataDir}/owner.token\`. Keep it in a shell variable; never print it, never send it anywhere but ${origin}. If two-step sign-in is on (Settings → ورود دومرحله‌ای), the owner token is refused from the network (401 «two-step sign-in is on») and works only from the server itself: call http://127.0.0.1:<port> on the server. With the owner token you can do every step through ${origin} without a shell on the server; a shell is only needed for installing a proxy client or copying files into the app. If you have neither the token nor a shell, tell me exactly which one you need.

${secretRule}

Steps (check each with the API first, skip what already works):
${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Don't change anything on the server outside ${product} and what these steps need.`;
}
