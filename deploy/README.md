# Deploying Griffin

One host, one or two containers. Nothing at runtime depends on the infrastructure Griffin looks at —
that is the point.

```bash
docker compose -f deploy/compose.yaml up -d --build                     # the app: chat + agents
COMPOSE_PROFILES=tools docker compose -f deploy/compose.yaml up -d      # + infrastructure tools
COMPOSE_PROFILES=tools,infra docker compose -f deploy/compose.yaml up -d # + its own vault and proxy
```

| service | holds | talks to |
|---|---|---|
| `app` | the model API key, SQLite, the owner token | the model provider, and the broker if there is one |
| `broker` (profile `tools`) | the vault token (age-encrypted) and the age identity; every credential is read per call | the vault on loopback, cluster APIs, emergency SSH paths, shell hosts |

The app alone is a complete install. The agent has no shell tool; live operations go through the
broker's typed tools, and those only exist once `config/site.json` describes something.

## Prepare the host

```
/srv/griffin/
  data/         SQLite, cursor.api-key / anthropic.api-key (0600), tls/, owner.token
  workspace/    agent workspaces, rules, knowledge git
  # only for the broker (profile "tools"):
  config/       site.json (from config/site.example.json), ssh_known_hosts
  vault/        OpenBao raft + state (state/machine.token.age, state/unseal.b64.age)
  keys/         identity.age  (the age identity that decrypts the vault token)
  xray/         optional egress proxy (see xray/README.md)
```

Only `data/` and `workspace/` are needed for the default install; compose defaults them to `./data`
and `./workspace` next to the compose file.

Copy `deploy/env.example` to `deploy/.env` and set the paths, port and public URL. `.env` is never in
git. Then:

```bash
docker compose -f deploy/compose.yaml up -d --build
```

## Offline npm cache

If the host cannot reach the npm registry reliably, the image installs from a prepared cache. Build it
on a machine that can, with the same npm version as the `node:24` image:

```bash
rm -rf .build && mkdir -p .build/src && cp package.json package-lock.json .build/src/
for w in packages/timeline apps/server apps/broker apps/web; do mkdir -p .build/src/$w && cp $w/package.json .build/src/$w/; done
(cd .build/src && npx -y npm@11.19.0 ci --cache ../npm-cache --ignore-scripts) && rm -rf .build/src
```

Rebuild the cache whenever `package-lock.json` changes, and ship `.build/npm-cache` with the source.

## Before you recreate the app

A restart marks any active run as failed, so gate on it in the same command:

```bash
curl -s 127.0.0.1:${GRIFFIN_PORT:-3100}/healthz   # activeRuns must be 0
```

## Login

The owner token is created on first start at `$GRIFFIN_DATA/owner.token`, mode 0600. Read it on the
host; never paste it into a chat. `POST /api/auth/revoke-all` ends every session.

## Backups

`scripts/backup-knowledge.sh` packs the knowledge git and a consistent SQLite copy. The host that runs
Griffin also holds its vault and its knowledge — one failure domain — so copy the archives off it.
