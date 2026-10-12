#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// Griffin from a terminal. The web UI is one surface; this is another, and neither is the product.
//
//   griffin "why is the build slow?"        ask, watch it work, get the answer
//   griffin -i                              keep talking in the same chat
//   griffin agents                          who exists, what they may use
//   griffin agents new <id> --instructions … make one
//   griffin jobs / jobs run <id>            scheduled work
//   griffin health                          what this install can reach
//   griffin doctor [fix <id> | heal]        live self-check, and its fixes
//   griffin secrets / engines / config      credentials, engine accounts, runtime settings
//
// It talks to a running Griffin over HTTP with the owner token, which it finds by itself:
// GRIFFIN_TOKEN, or <data dir>/owner.token when it runs on the same machine.

const RESET = "[0m";
const DIM = "[2m";
const BOLD = "[1m";
const ORANGE = "[38;5;173m";
const color = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code, text) => (color ? `${code}${text}${RESET}` : text);

function usage(code = 0) {
  process.stdout.write(`griffin — talk to your agents from the terminal

  griffin [options] <message…>        ask once and stream the answer
  griffin -i | --interactive          keep the chat open
  griffin agents [new <id>]           list agents, or create one
  griffin jobs [run <id>]             list scheduled jobs, or run one now
  griffin health                      providers, broker, tools
  griffin doctor [fix <id> | heal]    live check of engines, agents, runs; apply a fix
  griffin chats                       recent chats
  griffin secrets [list | set NAME [--tools] | rm NAME [--tools]]
                                      names only; set reads the value from stdin; --tools = the broker's
  griffin engines [list | on ID | off ID | add KIND [LABEL]]
                                      engine accounts (KIND: cursor, claude, openai)
  griffin config [list | set KEY VALUE | restart]
                                      runtime settings (Settings → Configuration)

Options
  --url <url>        Griffin base url (default $GRIFFIN_URL or http://127.0.0.1:3100)
  --data <dir>       where owner.token lives (default $GRIFFIN_DATA or ./data)
  --agent <id>       which agent answers (default: the install's default agent)
  --chat <id>        continue an existing chat
  --json             print raw JSON instead of prose
  --quiet            answer only: no thinking, no tool lines

For "agents new": --label, --domain, --instructions (or --instructions-file), --tools a,b,c
`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = { url: process.env.GRIFFIN_URL || "http://127.0.0.1:3100", data: process.env.GRIFFIN_DATA || "./data" };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => argv[(i += 1)];
    if (arg === "-h" || arg === "--help") usage();
    else if (arg === "-i" || arg === "--interactive") options.interactive = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--quiet" || arg === "-q") options.quiet = true;
    else if (arg === "--url") options.url = take();
    else if (arg === "--data") options.data = take();
    else if (arg === "--agent") options.agent = take();
    else if (arg === "--chat") options.chat = take();
    else if (arg === "--label") options.label = take();
    else if (arg === "--domain") options.domain = take();
    else if (arg === "--instructions") options.instructions = take();
    else if (arg === "--instructions-file") options.instructions = fs.readFileSync(take(), "utf8");
    // --tools a,b,c (agents new) or a bare --tools flag (secrets: the broker's vault).
    else if (arg === "--tools" && (argv[i + 1] === undefined || argv[i + 1].startsWith("-"))) options.toolsScope = true;
    else if (arg === "--tools") options.tools = take().split(",").map((t) => t.trim()).filter(Boolean);
    else rest.push(arg);
  }
  return { options, rest };
}

function token(options) {
  if (process.env.GRIFFIN_TOKEN) return process.env.GRIFFIN_TOKEN.trim();
  const file = path.resolve(options.data, "owner.token");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  fail(`no owner token: set GRIFFIN_TOKEN, or point --data at the directory holding owner.token (tried ${file})`);
  return "";
}

function fail(message) {
  process.stderr.write(`${paint(ORANGE, "griffin:")} ${message}\n`);
  process.exit(1);
}

async function call(options, method, urlPath, body) {
  const url = `${options.url.replace(/\/+$/, "")}${urlPath}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token(options)}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    fail(`cannot reach ${options.url} (${error.message}). Is Griffin running?`);
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) fail(parsed?.error || `${method} ${urlPath} → http ${response.status}`);
  return parsed;
}

/** Stream one run and print it as it happens. Resolves when the run finishes. */
async function follow(options, chatId, { after = 0 } = {}) {
  const url = `${options.url.replace(/\/+$/, "")}/api/chats/${chatId}/stream?after=${after}`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${token(options)}`, accept: "text/event-stream" } });
  if (!response.ok || !response.body) fail(`stream failed: http ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let started = false;
  let lastTool = null;

  const write = (text) => process.stdout.write(text);

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      let event;
      try {
        event = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      const { type, data } = event;
      if (options.json) {
        write(`${JSON.stringify(event)}\n`);
      } else if (type === "text" && data?.text) {
        if (!started && lastTool) write("\n");
        started = true;
        answer += data.text;
        write(data.text);
      } else if (!options.quiet && type === "tool.started" && data?.name) {
        const args = data.args && typeof data.args === "object" ? Object.keys(data.args).join(", ") : "";
        write(`${started ? "\n" : ""}${paint(DIM, `· ${data.name}(${args})`)}\n`);
        started = false;
        lastTool = data.name;
      } else if (!options.quiet && type === "tool.done" && data?.name === "ask_owner") {
        write(`${paint(ORANGE, "؟ ")}${paint(DIM, "the agent is waiting for your answer — reply below")}\n`);
      }
      if (type === "run.finished") {
        await reader.cancel().catch(() => {});
        write(answer.endsWith("\n") || options.json ? "" : "\n");
        return { status: data?.status || "finished", answer };
      }
    }
  }
  return { status: "ended", answer };
}

async function ask(options, message) {
  if (options.chat) {
    const before = await call(options, "GET", `/api/chats/${options.chat}/events?after=0`);
    const after = before?.events?.length ? before.events[before.events.length - 1].id : 0;
    await call(options, "POST", `/api/chats/${options.chat}/messages`, { text: message });
    return follow(options, options.chat, { after });
  }
  const created = await call(options, "POST", "/api/chats", { text: message, ...(options.agent ? { agent: options.agent } : {}) });
  const chatId = created?.chat?.id;
  if (!chatId) fail("could not start a chat");
  options.chat = chatId;
  if (!options.quiet && !options.json) process.stdout.write(`${paint(DIM, `chat ${chatId}`)}\n`);
  return follow(options, chatId);
}

async function interactive(options) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.question(`${paint(ORANGE, "›")} `, async (line) => {
    const text = line.trim();
    if (!text) return prompt();
    if (["exit", "quit", ":q"].includes(text)) return rl.close();
    try {
      await ask(options, text);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
    }
    prompt();
  });
  process.stdout.write(`${paint(DIM, "Griffin — write a message, or 'exit'.")}\n`);
  prompt();
}

async function agents(options, rest) {
  if (rest[0] === "new") {
    const id = rest[1];
    if (!id) fail("usage: griffin agents new <id> [--label …] [--domain …] [--instructions …] [--tools a,b]");
    const created = await call(options, "POST", "/api/agents", {
      id,
      label: options.label || id,
      domain: options.domain || "",
      instructions: options.instructions || "",
      ...(options.tools ? { tools: options.tools } : {}),
    });
    const agent = created.agent;
    process.stdout.write(`${paint(BOLD, agent.label)} ${paint(DIM, agent.id)} — ${agent.tools.length} tools\n`);
    return;
  }
  const { agents: list } = await call(options, "GET", "/api/agents");
  if (options.json) return process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
  for (const agent of list) {
    const tools = agent.allTools ? "every tool" : `${agent.tools.length} tools`;
    process.stdout.write(`${paint(BOLD, agent.label)} ${paint(DIM, agent.id)}  ${paint(DIM, `${agent.provider} · ${tools} · ${agent.callers.length} callers`)}\n`);
    if (agent.domain) process.stdout.write(`  ${agent.domain}\n`);
  }
}

async function jobs(options, rest) {
  if (rest[0] === "run") {
    const id = rest[1];
    if (!id) fail("usage: griffin jobs run <id>");
    await call(options, "POST", `/api/jobs/${id}/run`);
    process.stdout.write("started\n");
    return;
  }
  const { jobs: list } = await call(options, "GET", "/api/jobs");
  if (options.json) return process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
  if (!list?.length) return process.stdout.write("no jobs\n");
  for (const job of list) {
    const when = job.nextAt ? `next ${job.nextAt}` : job.trigger?.type || "";
    process.stdout.write(`${job.enabled ? "●" : "○"} ${paint(BOLD, job.name)} ${paint(DIM, `${job.agent} · ${when}`)}\n`);
  }
}

async function chats(options) {
  const { chats: list } = await call(options, "GET", "/api/chats");
  if (options.json) return process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
  for (const chat of list.slice(0, 20)) {
    process.stdout.write(`${paint(DIM, chat.id.slice(0, 8))}  ${chat.title || "(untitled)"} ${paint(DIM, chat.agent || "")}\n`);
  }
}

async function health(options) {
  const body = await call(options, "GET", "/api/health");
  if (options.json) return process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  const line = (name, ok, note = "") => process.stdout.write(`${ok ? "✓" : "✗"} ${name}${note ? paint(DIM, ` — ${note}`) : ""}\n`);
  line("cursor", body.cursor?.ok, body.cursor?.error || "");
  line("claude", body.claude?.ok, body.claude?.error || "");
  line("broker", body.broker?.ok, body.broker?.configured === false ? "not configured (app tools only)" : body.broker?.error || "");
  for (const [name, state] of Object.entries(body.clusters || {})) {
    line(`cluster ${name}`, state?.api?.ok ?? state?.ok, state?.api?.error || "");
  }
  process.stdout.write(`${paint(DIM, `${body.activeRuns} active run(s)`)}\n`);
}

async function doctor(options, rest) {
  if (rest[0] === "fix" && rest[1]) {
    const r = await call(options, "POST", "/api/doctor/fix", { id: rest[1] });
    return process.stdout.write(`${r.done || JSON.stringify(r)}\n`);
  }
  const body = await call(options, rest[0] === "heal" ? "POST" : "GET", rest[0] === "heal" ? "/api/doctor/heal" : "/api/doctor");
  if (options.json) return process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  const fill = (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const mark = { ok: "✓", warn: "!", error: "✗" };
  for (const c of body.checks || []) {
    process.stdout.write(`${mark[c.level] || "·"} ${fill(c.title, c.vars)}${c.detail ? paint(DIM, ` — ${String(c.detail).slice(0, 160)}`) : ""}\n`);
    if (c.fix && !c.fix.manual) process.stdout.write(paint(DIM, `    griffin doctor fix ${c.fix.id}\n`));
  }
  for (const done of body.applied || []) process.stdout.write(`fixed: ${done}\n`);
}

async function readStdin() {
  if (process.stdin.isTTY) process.stderr.write(paint(DIM, "value (it echoes; prefer piping it in), then Ctrl-D: "));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// Secret values only ever go in (stdin → API); nothing here prints one, not even its last characters.
async function secrets(options, rest) {
  const [sub = "list", name = options.tools?.[0]] = rest;
  const scope = options.toolsScope || options.tools ? "tools" : "app";
  if (sub === "set") {
    if (!name) fail("usage: griffin secrets set NAME [--tools]   (value on stdin)");
    const value = await readStdin();
    if (!value) fail("empty value on stdin");
    await call(options, "PUT", "/api/secrets", { scope, name, value });
    return process.stdout.write(`set ${name} (${scope})\n`);
  }
  if (sub === "rm") {
    if (!name) fail("usage: griffin secrets rm NAME [--tools]");
    await call(options, "DELETE", `/api/secrets?scope=${scope}&name=${encodeURIComponent(name)}`);
    return process.stdout.write(`removed ${name} (${scope})\n`);
  }
  if (sub !== "list") fail("usage: griffin secrets [list | set NAME [--tools] | rm NAME [--tools]]");
  const body = await call(options, "GET", "/api/secrets");
  const strip = (items) => (items || []).map(({ name: n, note, updatedAt, source }) => ({ name: n, note, updatedAt, source }));
  if (options.json) return process.stdout.write(`${JSON.stringify({ app: strip(body.app), tools: { ...body.tools, items: strip(body.tools?.items) } }, null, 2)}\n`);
  const row = (i) => process.stdout.write(`  ${i.name}${paint(DIM, `${i.source ? ` · ${i.source}` : ""}${i.updatedAt ? ` · ${new Date(i.updatedAt).toISOString()}` : ""}${i.note ? ` — ${i.note}` : ""}`)}\n`);
  process.stdout.write(`${paint(BOLD, "app")}\n`);
  strip(body.app).forEach(row);
  process.stdout.write(`${paint(BOLD, "tools")}${paint(DIM, ` (${body.tools?.error || body.tools?.backend || "?"})`)}\n`);
  strip(body.tools?.items).forEach(row);
  const set = new Set((body.tools?.items || []).map((i) => i.name));
  for (const c of body.catalog || []) if (!set.has(c.name)) process.stdout.write(paint(DIM, `  ○ ${c.name} — ${c.note}\n`));
}

async function engines(options, rest) {
  const [sub = "list", id, ...label] = rest;
  if (sub === "on" || sub === "off") {
    if (!id) fail(`usage: griffin engines ${sub} ID`);
    await call(options, "PATCH", `/api/providers/${encodeURIComponent(id)}`, { enabled: sub === "on" });
    return process.stdout.write(`${id} ${sub}\n`);
  }
  if (sub === "add") {
    if (!id) fail("usage: griffin engines add KIND [LABEL]   (KIND: cursor, claude, openai)");
    const created = await call(options, "POST", "/api/providers", { kind: id, label: label.join(" ") });
    return process.stdout.write(`added ${created.id} — set its key with: griffin secrets set engine/${created.id}\n`);
  }
  if (sub !== "list") fail("usage: griffin engines [list | on ID | off ID | add KIND [LABEL]]");
  const { providers: list } = await call(options, "GET", "/api/providers");
  if (options.json) return process.stdout.write(`${JSON.stringify(list.map(({ models, ...p }) => p), null, 2)}\n`);
  for (const p of list) {
    const state = !p.enabled ? "off" : p.health?.ok ? "ok" : p.health?.error || "down";
    const notes = [p.kind, p.defaultModel, p.hasKey ? "key set" : "no key", p.limitedUntil ? `limited until ${new Date(p.limitedUntil).toISOString()}` : ""].filter(Boolean);
    process.stdout.write(`${p.enabled ? (p.health?.ok ? "✓" : "✗") : "○"} ${paint(BOLD, p.id)}${p.label ? ` ${p.label}` : ""} ${paint(DIM, `${state} · ${notes.join(" · ")}`)}\n`);
  }
}

async function config(options, rest) {
  const [sub = "list", key, ...value] = rest;
  if (sub === "set") {
    if (!key) fail("usage: griffin config set KEY VALUE   (empty VALUE clears it)");
    const r = await call(options, "PATCH", "/api/config", { [key]: value.join(" ") });
    return process.stdout.write(`${key} saved${r?.restart ? " — applies after: griffin config restart" : ""}\n`);
  }
  if (sub === "restart") {
    await call(options, "POST", "/api/admin/restart", {});
    return process.stdout.write("restarting\n");
  }
  if (sub !== "list") fail("usage: griffin config [list | set KEY VALUE | restart]");
  const { settings } = await call(options, "GET", "/api/config");
  if (options.json) return process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`);
  for (const s of settings) {
    const from = s.value ? "" : s.fromEnv ? " (env)" : "";
    process.stdout.write(`${paint(BOLD, s.key)} = ${s.effective || paint(DIM, "—")}${paint(DIM, `${from}${s.live ? "" : " · restart"}`)}\n`);
  }
}

const { options, rest } = parseArgs(process.argv.slice(2));
const command = rest[0];

try {
  if (command === "agents") await agents(options, rest.slice(1));
  else if (command === "jobs") await jobs(options, rest.slice(1));
  else if (command === "chats") await chats(options);
  else if (command === "health") await health(options);
  else if (command === "doctor") await doctor(options, rest.slice(1));
  else if (command === "secrets") await secrets(options, rest.slice(1));
  else if (command === "engines") await engines(options, rest.slice(1));
  else if (command === "config") await config(options, rest.slice(1));
  else if (options.interactive) await interactive(options);
  else if (rest.length) await ask(options, rest.join(" "));
  else usage(1);
} catch (error) {
  fail(error.message);
}
