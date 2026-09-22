# Deploying Griffin

Two containers built from this tree and run on one host. Nothing at runtime depends on the
infrastructure Griffin diagnoses — that is the point.

| service | holds | talks to |
|---|---|---|
| `broker` | the vault token (age-encrypted) and the age identity; every credential is read per call | OpenBao on loopback, cluster APIs, emergency SSH paths, shell hosts |
| `app` | the model API key, SQLite, the owner token | the model provider (through the proxy), the broker over a unix socket |

The agent has no shell tool. Live operations go through the broker's typed tools.

## Prepare the host

```
/srv/griffin/
  config/       site.json (from config/site.example.json), ssh_known_hosts
  data/         SQLite, cursor.api-key / anthropic.api-key (0600), tls/, owner.token
  workspace/    agent workspaces, rules, knowledge git
  vault/        OpenBao raft + state (state/machine.token.age, state/unseal.b64.age)
  keys/         identity.age  (the age identity that decrypts the vault token)
  xray/         optional egress proxy (see xray/README.md)
```

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
