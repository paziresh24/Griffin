# Configuration

Griffin ships with no environment of its own. A default install needs nothing but a model API key:
chats, agents, jobs, charts, files and messengers all live in the app process. Infrastructure tools
are what the optional broker adds, and they appear only once you describe that infrastructure.

| What | Where | Read by |
|---|---|---|
| Runtime knobs — port, paths, proxy, public URL | `GRIFFIN_*` environment variables | app + broker |
| Inventory — clusters, routers, GitLab, object storage, shell hosts | `config/site.json` (shape: `config/site.example.json`) | broker |
| Credentials | OpenBao/Vault KV or a secret manager, never files in this repo | broker only |

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

The broker resolves every credential at call time and never returns a value to the agent. Items it
looks up in the vault (OpenBao KV at `GRIFFIN_BAO_URL`, machine token age-encrypted on disk):

| Item | Used by |
|---|---|
| `kube__token` | Kubernetes public API (a bearer token, or `{type:"authentik-basic"…}` / `{type:"authentik-m2m", token_url…}` for an SSO-fronted API) |
| `ssh-bastion__owner-key` | every emergency SSH path and `debug_exec` |
| `gitlab__token` | all `gitlab_*` tools |
| `infisical__universal-auth` | `{host, clientId, clientSecret, projectId}` for the `infisical_*` tools |
| `arvan__api-key`, `nsin__api-key` | the CDN agents |
| `mikrotik-<name>__api` | `{host, port, user, password}` for a router; a router may instead point at a secret-manager path |

`apps/broker/src/vault-put.mjs` writes an item without printing it.

## Environment

| Variable | Meaning |
|---|---|
| `GRIFFIN_DATA` | data dir: SQLite, API keys, TLS, owner token |
| `GRIFFIN_BROKER` | `off` to run without infrastructure tools even if a socket exists |
| `GRIFFIN_WEB` | `off` to run headless: API, MCP, messengers and jobs, no web UI |
| `GRIFFIN_TOKEN`, `GRIFFIN_URL` | used by the terminal client (`bin/griffin.mjs`) |
| `GRIFFIN_WORKSPACE` | agent workspaces, rules and the knowledge git |
| `GRIFFIN_SITE_CONFIG`, `GRIFFIN_SSH_KNOWN_HOSTS` | broker inventory paths |
| `GRIFFIN_BROKER_SOCKET` | unix socket shared by app and broker |
| `GRIFFIN_BAO_URL`, `GRIFFIN_BAO_TOKEN_AGE`, `GRIFFIN_AGE_IDENTITY` | vault access (broker only) |
| `GRIFFIN_PUBLIC_URL` | absolute URL used in chart/file links sent to messengers |
| `GRIFFIN_PROXY`, `CURSOR_PROXY`, `GRIFFIN_TELEGRAM_SOCKS` | egress (see `deploy/xray/`) |
| `GRIFFIN_OPS_MODE` | incident ops room: `shadow` (LLM triage), `record` (group and show only), `off` |
| `GRIFFIN_BUSINESS_SIGNAL` | optional JSON: the SQL table where your own job records business drops |
| `GRIFFIN_OWNER_NAME` | how agents refer to you in prompts and framed messages (default `Owner`) |
| `GRIFFIN_OPENAI_BASE_URL`, `GRIFFIN_OPENAI_MODEL`, `GRIFFIN_OPENAI_REASONING_EFFORT` | any OpenAI-compatible chat/completions endpoint as a third engine |
| `GRIFFIN_AUTH=off`, `GRIFFIN_DEMO=1` | local development only — never in production |

Model provider keys are files on the data volume (`cursor.api-key`, `anthropic.api-key`,
`openai.api-key`, mode 0600) or `ANTHROPIC_API_KEY` in the app's environment.
