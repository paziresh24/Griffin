# Griffin

A self-hosted multi-agent shell for running your own infrastructure: you ask in plain language, an
orchestrator agent works out what to check, hands pieces to specialist agents, and answers with the
result — with every live fact coming from a typed tool, never from the model's memory.

It is built for the case most agent tooling ignores: **the platform is down and you need the agent
anyway.** The credential holder is a separate process, every cluster tool has an emergency SSH path
behind the API path, and the whole thing runs on one host with no dependency on the infrastructure it
is diagnosing.

> This is a public, environment-neutral fork of a system that runs in production. It carries the code,
> not the inventory: no hosts, credentials, clusters or organisation-specific knowledge. You supply
> those in `config/site.json`.

## What it does

- **Chat with agents** — streaming UI (assistant-ui + streamdown, RTL-first, PWA), one live run per
  chat with queue / steer / cancel, runs that survive a restart.
- **Typed infrastructure tools** — Kubernetes (status, get, logs, exec-free `df`, secrets, CNPG),
  Prometheus and Grafana (including running a dashboard panel's own query), PostgreSQL via CNPG,
  S3, GitLab (search, read, pipelines, propose an MR), secret manager, MikroTik routers (RouterOS API
  or the Winbox protocol), ArvanCloud and NSIN CDN, plus DNS/HTTP/TLS checks.
- **Agents that delegate** — `delegate` returns immediately and reports back when the subtask lands, so
  the orchestrator stays free; `ask_agent` is the short blocking variant.
- **Authority per caller** — each agent's tools are filtered by *who is calling*: the owner, another
  agent, the scheduler, or an external peer with their own token. Irreversible actions ask the owner,
  or refuse when nobody is watching.
- **Scheduled jobs** — a prompt plus a trigger plus delivery; each run gets its own hidden chat.
- **Incident intake** — Alertmanager across clusters grouped into incidents, with an ops room that can
  triage them (or just record them).
- **Messengers** — Telegram/Bale bots and a Telegram account bridge, charts delivered as images.
- **MCP endpoint** — other agents (e.g. Claude Code) connect over HTTP with a scoped token and get
  task-shaped tools: send, wait, reply, cancel.

## Layout

| Path | What |
|---|---|
| `apps/server/` | Hono + SQLite + SSE, agent runtime (Cursor or Claude SDK), auth, jobs, incidents, MCP |
| `apps/broker/` | every credential, typed tools over a unix socket, guards in code |
| `apps/web/` | the UI |
| `packages/timeline/` | folds stored events into messages (shared by server and UI) |
| `config/site.example.json` | the inventory shape: clusters, routers, GitLab, storage, shell hosts |
| `deploy/` | compose file, environment example, egress proxy notes, backup script |
| `docs/` | [architecture](docs/architecture.md) · [configuration](docs/configuration.md) |

## Run it locally

```bash
npm ci && npm test && npm run build
```

A demo mode boots the UI with a scripted agent and no credentials at all:

```bash
mkdir -p /tmp/griffin-demo/data /tmp/griffin-demo/workspace
GRIFFIN_DEMO=1 GRIFFIN_AUTH=off \
GRIFFIN_DATA=/tmp/griffin-demo/data GRIFFIN_WORKSPACE=/tmp/griffin-demo/workspace \
PORT=3100 node apps/server/src/index.mjs
```

For a real deployment see [`deploy/README.md`](deploy/README.md): copy `config/site.example.json` and
`deploy/env.example`, put your credentials in the vault, then
`docker compose -f deploy/compose.yaml up -d --build`.

## Requirements

Node 24+, Docker for the deployment, an OpenBao/Vault-compatible KV for credentials, and an API key
for a model provider — Cursor (`@cursor/sdk`) or Anthropic (`@anthropic-ai/claude-agent-sdk`).

## Security posture

- The agent process has no shell tool and no infrastructure credential; the broker holds them and
  never returns a secret value to the model.
- Tool access is filtered per caller before the tools reach the model, so quota is enforced in code,
  not in prompt text.
- Write tools on shared systems are narrow by construction: router changes only touch items Griffin
  itself created, S3 is GET/HEAD only, `gitlab_propose` opens a draft MR on a new branch and never
  merges, secret copies return key names only.
- Owner auth is local (token → signed cookie) so it keeps working when your SSO is down. Put it behind
  TLS you control; it is not built to face the open internet unauthenticated.

Read the code before you point this at production: it is opinionated, and the guards assume one owner.

## License

MIT — see [LICENSE](LICENSE).
