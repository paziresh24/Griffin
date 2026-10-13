# Configuration

Griffin ships with no environment of its own. A default install needs nothing but a model API key:
chats, agents, jobs, charts, files and messengers all live in the app process. Infrastructure tools
are what the optional broker adds, and they appear only once you describe that infrastructure.

| What | Where | Read by |
|---|---|---|
| Deploy-time knobs — port, paths, proxy, broker socket | `GRIFFIN_*` environment variables | app + broker |
| Runtime settings — public URL, ops room, self-repair, reviewers, routing, voice… | **Settings → Configuration** (or `griffin config`); the env is the fallback | app |
| Engine accounts and their keys | **Settings → Engines** (or `griffin engines`) | app |
| Inventory — clusters, routers, GitLab, object storage, shell hosts | `config/site.json` (shape: `config/site.example.json`) | broker |
| Credentials | **Settings → Secrets** (or `griffin secrets`): encrypted boxes in the app and the broker; OpenBao optional. Never files in this repo | app / broker |

## Do I need the broker?

No, unless you want the credential-holding tools. The app treats it as absent when its socket is
not there — health says `broker: { configured: false }`, the incident intake stays off, and agents
get the app tools only. Start it with the `tools` compose profile once `config/site.json` exists.

## Tool packs

The broker publishes a pack only when this site has what it needs, so an agent never sees a tool
that cannot work:

| Pack | Appears when | Tools |
|---|---|---|
| `kubernetes`, `alerts`, `postgres` | at least one cluster is configured | `kube_*`, `metrics_*`, `cnpg_*`, `alerts_*`, `pg_*` |
| `grafana` | a cluster has a `grafana` url | `grafana_*` |
| `s3` | `s3.endpoint` is set | `s3_list`, `s3_get` |
| `gitlab` | `gitlab.url` is set | `gitlab_*` |
| `mikrotik` | at least one router | `mikrotik_*` |
| `shell` | at least one entry in `debugHosts` | `debug_exec` |
| `vcenter` | `vcenter.infisical` names where the url/user/password live | `vcenter_*` |
| `infisical`, `arvan`, `nsin` | opt in explicitly (they need a vault item) | `infisical_*`, `arvan_*`, `nsin_*` |
| `net` | always | `dns_lookup`, `http_check`, `tls_check` |

Override any of them in the site config:

```json
{ "tools": { "arvan": true, "shell": false } }
```

## Site config

Copy `config/site.example.json` to `config/site.json` (gitignored) and mount it at `/config/site.json`
(`GRIFFIN_SITE_CONFIG` overrides the path). Every section is optional: a tool whose section is missing
says so — "no clusters configured", "no GitLab configured" — instead of guessing an endpoint.

- `clusters.<name>` — `api` (the Kubernetes API endpoint Griffin can reach), optional `grafana` url,
  `alerts: false` to skip that cluster's Alertmanager, and an optional `emergency` SSH path
  (`host`, `port`, `user`, `kubectl`) to a node. The emergency path is the point of the broker: when the
  API gateway or the SSO in front of it is down, the agent still answers.
- `gitlab.url`, `s3` (endpoint, region, and the Secret holding the key pairs), `debugHosts`,
  `routers` — see the comments in `apps/broker/src/site.mjs` and `mikrotik.mjs`.
- `sshKnownHosts` — path to a `known_hosts` file inside the broker container. SSH runs with
  `StrictHostKeyChecking=yes`, so a host that is not in it is refused; that is deliberate.

## Secrets

Set them in **Settings → Secrets** or with `griffin secrets set NAME [--tools]` (value on stdin). No
page, API or tool ever returns a value — only the name, the last four characters and when it changed.

- **App secrets** (engine keys `engine/<account>`, `stt`, `typesafe`, anything else the app uses) live
  in `<data>/secrets.json`, AES-256-GCM with a random key file next to it (0600).
- **Tool secrets** (scope `tools`) go to the broker. Without OpenBao they land in the broker's own box
  of the same kind on the `broker-data` volume (`GRIFFIN_BROKER_DATA`, default `/broker-data`). With
  OpenBao mounted (`GRIFFIN_BAO_URL` + age-encrypted machine token and identity, compose profile
  `infra`) reads fall through to it and writes go to it. Without a broker (`GRIFFIN_BROKER=off`) the
  page says "no broker" and only app secrets exist.

The broker resolves every credential at call time and never returns a value to the agent. Items it
looks up:

| Item | Used by |
|---|---|
| `kube__token` | Kubernetes public API (a bearer token, or `{type:"authentik-basic"…}` / `{type:"authentik-m2m", token_url…}` for an SSO-fronted API) |
| `ssh-bastion__owner-key` | every emergency SSH path and `debug_exec` |
| `gitlab__token` | all `gitlab_*` tools |
| `infisical__universal-auth` | `{host, clientId, clientSecret, projectId}` for the `infisical_*` tools |
| `arvan__api-key`, `nsin__api-key` | the CDN agents |
| `mikrotik-<name>__api` | `{host, port, user, password}` for a router; a router may instead point at a secret-manager path |

`apps/broker/src/vault-put.mjs` writes an item without printing it.

## Engines and accounts

An engine is an account of one kind: `cursor`, `claude` or `openai` (any OpenAI-compatible
chat/completions endpoint — OpenAI, OpenRouter, Z.ai, Ollama…). The three base accounts keep the kind
as their id; add more of a kind (`claude-2`, `openai-openrouter`) in **Settings → Engines** or with
`griffin engines add KIND [LABEL]`. Each account has its own key (secret `engine/<id>`), model, base
URL, and an on/off switch; a switched-off account is never routed to. A Claude subscription account
can be signed in from the browser (the token goes straight into the secret store).

A run takes the first usable candidate (on, has a key, not at its plan limit): a model pinned in the
chat → colleague-thread routing (`TEAM_*`) → the agent's ordered model list (Agents page) → the
agent's own engine → the other kind → any other account. A plan limit marks that account until it
resets and the run moves to the next candidate, so a second Claude account picks up when the first
runs dry.

## Configuration page

**Settings → Configuration** (`griffin config list|set KEY VALUE`) stores in the app's database what
used to need an env edit: public URL, ops room mode, self-repair, reviewers, colleague-thread routing
(`TEAM_*`), `FALLBACK_CLAUDE_MODEL`, title model, default repo, peer self-serve text, voice
(`STT_*`). A value set there wins over `GRIFFIN_<KEY>`. Some apply only after a restart; the page (or
`griffin config restart`) restarts the app when no run is in progress — the container's restart
policy brings it back. Paths, ports, the broker socket, `OWNER_NAME` and `TZ` stay env-only.

## Environment

| Variable | Meaning |
|---|---|
| `GRIFFIN_DATA` | data dir: SQLite, API keys, TLS, owner token |
| `GRIFFIN_TZ` | time zone for job schedules and times in messages (default: the server's own, e.g. `Europe/Berlin`) |
| `GRIFFIN_BROKER` | `off` to run without infrastructure tools even if a socket exists |
| `GRIFFIN_WEB` | `off` to run headless: API, MCP, messengers and jobs, no web UI |
| `GRIFFIN_TOKEN`, `GRIFFIN_URL` | used by the terminal client (`bin/griffin.mjs`) |
| `GRIFFIN_WORKSPACE` | agent workspaces, rules and the knowledge git |
| `GRIFFIN_SITE_CONFIG`, `GRIFFIN_SSH_KNOWN_HOSTS` | broker inventory paths |
| `GRIFFIN_BROKER_SOCKET` | unix socket shared by app and broker |
| `GRIFFIN_BAO_URL`, `GRIFFIN_BAO_TOKEN_AGE`, `GRIFFIN_AGE_IDENTITY` | optional OpenBao access (broker only) |
| `GRIFFIN_BROKER_DATA` | the broker's own encrypted secret box (default `/broker-data`) |
| `GRIFFIN_PUBLIC_URL` | absolute URL used in chart/file links sent to messengers |
| `GRIFFIN_PROXY`, `CURSOR_PROXY`, `GRIFFIN_TELEGRAM_SOCKS` | egress (see `deploy/xray/`); without them, the proxy set in the setup wizard (`<data>/proxy.json`) is used |
| `GRIFFIN_TG_BURST_SECONDS` | a burst of one colleague's Telegram messages waits this long after the latest one and becomes one turn (default `45`) |
| `GRIFFIN_OPS_MODE` | incident ops room: `shadow` (LLM triage), `record` (group and show only), `off` |
| `GRIFFIN_BUSINESS_SIGNAL` | optional JSON: the SQL table where your own job records business drops |
| `GRIFFIN_PEER_SELF_SERVE` | optional text: what a colleague can do without Griffin on your install (their kubeconfig, your GitOps repo…), `{user}` = their id. Sent once to each colleague's agent and given to Griffin so it answers self-serviceable requests with commands, not work |
| `GRIFFIN_OWNER_NAME` | how agents refer to you in prompts and framed messages (default `Owner`) |
| `GRIFFIN_OPENAI_BASE_URL`, `GRIFFIN_OPENAI_MODEL`, `GRIFFIN_OPENAI_REASONING_EFFORT` | any OpenAI-compatible chat/completions endpoint as a third engine |
| `GRIFFIN_SELF_HEAL` | `off` keeps the doctor's report (Settings → Health) but stops its automatic fixes |
| `GRIFFIN_ASSISTANT_NAME`, `GRIFFIN_ASSISTANT_LATIN` | the assistant's name (what people call it, how it signs); otherwise the setup wizard's choice in `<data>/persona.json`, default Griffin |
| `GRIFFIN_CHAT_IDLE_DAYS` | owner chats on a repo worktree that sat idle this many days go to the archive (default `3`, `0` = off) |
| `GRIFFIN_PUSH_SUBJECT` | contact for Web Push (`mailto:` or URL); defaults to `GRIFFIN_PUBLIC_URL`. Push notifications need HTTPS |
| `GRIFFIN_REVIEW` | `on` sends every change-making tool call to two independent reviewer models before it runs |
| `GRIFFIN_AUTH=off`, `GRIFFIN_DEMO=1` | local development only — never in production |

Model provider keys belong in Settings → Engines (secret store). Older installs keep working with
files on the data volume (`cursor.api-key`, `anthropic.api-key`, `openai.api-key`, mode 0600) or
`ANTHROPIC_API_KEY` in the app's environment; a key set in the store wins.
