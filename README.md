<p align="center">
  <img src="docs/media/griffin-mark.svg" width="88" alt="Griffin">
</p>

<h1 align="center">Griffin</h1>

<p align="center">
  A self-hosted multi-agent shell for running your own infrastructure.<br>
  You ask in plain language; an orchestrator plans, hands the pieces to specialist agents,<br>
  and answers from typed tools — never from the model's memory.
</p>

<p align="center">
  <sub>Node 24 · Cursor or Claude Agent SDK · SQLite · no SaaS control plane · MIT</sub>
</p>

<p align="center">
  <img src="docs/media/chat.png" width="880" alt="Griffin answering a cluster question: a plan, a cluster-status tool card marked as coming from the emergency path, and a disk-usage card">
</p>

## Why this exists

Most agent tooling assumes the platform is healthy. Griffin is built for the opposite moment — the
one where you actually need help:

- **It survives the outage it is diagnosing.** Every cluster tool tries the public API first and
  falls back to SSH on a node. Each answer says which path produced it, so a green answer from a
  broken gateway is impossible to mistake for a healthy one.
- **The model never holds a credential.** A separate broker process owns the vault, the SSH key and
  every API token, and exposes a narrow, typed tool per capability. The agent has no shell.
- **Authority is a property of the caller, not of the agent.** The same agent gives the owner one set
  of tools, a colleague's agent another, and an unattended scheduler a third — filtered in code
  before the tools ever reach the model.
- **It runs on one box.** SQLite, a local vault, no SaaS control plane, no CI dependency at runtime.

## What it does

**Agents that delegate.** `delegate` returns immediately and reports back when the subtask lands, so
the orchestrator stays free to keep talking to you; `ask_agent` is the short blocking variant. Agents
are profiles, editable at runtime: which tools they own, which caller gets which subset, and whether
they run on the Cursor or Claude SDK.

**Typed infrastructure tools** — Kubernetes (status, get, logs, in-pod `df`, secrets, CNPG),
Prometheus and Grafana (including running a dashboard panel's own query), PostgreSQL through CNPG,
S3, GitLab (search, read, pipelines, propose an MR), a secret manager, MikroTik routers over the
RouterOS API *or* the Winbox protocol when the API is deliberately off, ArvanCloud and NSIN CDNs, and
DNS/HTTP/TLS probes.

**Charts and files in the conversation** — the agent draws Vega-Lite from real series and the same
chart is delivered to a messenger as an image; images, video, PDF, Markdown and CSV render inline.

<p align="center">
  <img src="docs/media/chart.png" width="880" alt="A memory usage chart drawn by the agent inside the chat, labelled as demo data">
</p>

**Scheduled jobs** — a prompt plus a trigger plus a delivery target; each run gets its own hidden
chat, so a job that misbehaves leaves the same trace a person's chat would.

**Incident intake** — Alertmanager across clusters (plus an optional business-metric signal from your
own SQL table) grouped into incidents, with an ops room that can triage them or just record them.

**Messengers and other agents** — Telegram/Bale bots and a Telegram account bridge; an MCP endpoint
where another agent (Claude Code, for instance) connects with its own scoped token and gets
task-shaped tools: send, wait, reply, cancel.

The UI is Persian-first and right-to-left; the code, tools and docs are English.

## How it fits together

```
browser · Telegram · MCP client
            │
     ┌──────▼─────────────────────────┐
     │ app     chats, runs, jobs,     │  holds the model key
     │         incidents, auth, MCP   │  no infrastructure credentials, no shell
     └──────┬─────────────────────────┘
            │ unix socket · typed JSON tools
     ┌──────▼─────────────────────────┐
     │ broker  kube · metrics · pg    │  holds every credential
     │         s3 · gitlab · routers  │  guards enforced in code
     └────────────────────────────────┘  public API first, emergency SSH second
```

More in [docs/architecture.md](docs/architecture.md).

## Try it

```bash
npm ci && npm test && npm run build
```

Demo mode boots the whole UI against a scripted agent — no credentials, no cluster, nothing to
configure (the screenshots above are exactly this):

```bash
mkdir -p /tmp/griffin-demo/data /tmp/griffin-demo/workspace
GRIFFIN_DEMO=1 GRIFFIN_AUTH=off \
GRIFFIN_DATA=/tmp/griffin-demo/data GRIFFIN_WORKSPACE=/tmp/griffin-demo/workspace \
PORT=3100 node apps/server/src/index.mjs
```

Then open `http://127.0.0.1:3100`.

## Run it for real

1. Copy `config/site.example.json` to `config/site.json` and describe your world: clusters and their
   emergency SSH paths, GitLab, object storage, routers, shell hosts.
2. Put credentials in the vault (OpenBao/Vault KV) — see [docs/configuration.md](docs/configuration.md)
   for the item names the broker looks up.
3. Copy `deploy/env.example` to `deploy/.env`, set the paths and the public URL, and add a provider
   key (`cursor.api-key` or `anthropic.api-key`, mode 0600, on the data volume).
4. `docker compose -f deploy/compose.yaml up -d --build`

Full notes, including the offline npm cache for hosts with a poor registry path, are in
[deploy/README.md](deploy/README.md).

**This repository ships no environment.** There are no hosts, clusters, tokens or organisation
knowledge in it: unconfigured tools say "not configured" instead of guessing an endpoint, and the
tests declare their own fixture site.

## Layout

| Path | What |
|---|---|
| `apps/server/` | Hono + SQLite + SSE, agent runtime, auth, jobs, incidents, MCP |
| `apps/broker/` | every credential, typed tools over a unix socket, guards in code |
| `apps/web/` | the UI (assistant-ui + streamdown, RTL, PWA) |
| `packages/timeline/` | folds stored events into messages; shared by server and UI |
| `config/` | the site inventory shape |
| `deploy/` | compose, environment example, egress proxy notes, backup script |
| `docs/` | [architecture](docs/architecture.md) · [configuration](docs/configuration.md) |

## Security posture

- The agent process has no shell tool and no infrastructure credential; the broker holds them and
  never returns a secret value to the model.
- Tool access is filtered per caller before the tools reach the model — quota is code, not prompt text.
- Write tools are narrow by construction: router changes only touch items Griffin itself created, S3
  is GET/HEAD only, `gitlab_propose` opens a draft MR on a new branch and never merges, secret copies
  return key names only.
- Irreversible actions ask the owner and wait; in an unattended chain (a scheduled job, the ops room)
  they are refused rather than guessed. Every approval is recorded.
- Owner auth is local (token → signed cookie) so it keeps working when your SSO is down. Put it behind
  TLS you control; it is not built to face the open internet unauthenticated.

Read the code before you point this at production: it is opinionated, and the guards assume one owner.

## License

MIT — see [LICENSE](LICENSE).
