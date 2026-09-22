# Configuration

Griffin ships with no environment of its own. Three things decide what a deployment can reach:

| What | Where | Read by |
|---|---|---|
| Inventory — clusters, routers, GitLab, object storage, shell hosts | `config/site.json` (shape: `config/site.example.json`) | broker |
| Credentials | OpenBao / Infisical, never files in this repo | broker only |
| Runtime knobs — ports, paths, proxy, public URL | `GRIFFIN_*` environment variables | app + broker |

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
| `GRIFFIN_WORKSPACE` | agent workspaces, rules and the knowledge git |
| `GRIFFIN_SITE_CONFIG`, `GRIFFIN_SSH_KNOWN_HOSTS` | broker inventory paths |
| `GRIFFIN_BROKER_SOCKET` | unix socket shared by app and broker |
| `GRIFFIN_BAO_URL`, `GRIFFIN_BAO_TOKEN_AGE`, `GRIFFIN_AGE_IDENTITY` | vault access (broker only) |
| `GRIFFIN_PUBLIC_URL` | absolute URL used in chart/file links sent to messengers |
| `GRIFFIN_PROXY`, `CURSOR_PROXY`, `GRIFFIN_TELEGRAM_SOCKS` | egress (see `deploy/xray/`) |
| `GRIFFIN_OPS_MODE` | incident ops room: `shadow` (LLM triage), `record` (group and show only), `off` |
| `GRIFFIN_BUSINESS_SIGNAL` | optional JSON: the SQL table where your own job records business drops |
| `GRIFFIN_AUTH=off`, `GRIFFIN_DEMO=1` | local development only — never in production |

Model provider keys are files on the data volume (`cursor.api-key`, `anthropic.api-key`, mode 0600) or
`ANTHROPIC_API_KEY` in the app's environment.
