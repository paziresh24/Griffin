# Two images from one tree: `app` (UI + agent runtime) and `broker` (credentials + typed tools).
# Packages come from the npm registry. A host that cannot reach it can ship a prepared
# .build/npm-cache next to the source (see deploy/README.md); it is used offline when present.

# Base images: Docker Hub by default; a build can pass mirrors (--build-arg NODE_SLIM=...).
ARG NODE_SLIM=node:24-bookworm-slim
ARG NODE_ALPINE=node:24-alpine

# The Cursor SDK ships glibc native modules, so the app side uses Debian.
FROM ${NODE_SLIM} AS deps
WORKDIR /src
# .build* matches nothing on a normal checkout; package.json keeps the COPY valid either way.
COPY package.json package-lock.json .build* ./
COPY packages/timeline/package.json packages/timeline/
COPY apps/server/package.json apps/server/
COPY apps/broker/package.json apps/broker/
COPY apps/web/package.json apps/web/
RUN if [ -d npm-cache ]; then npm ci --offline --cache npm-cache --no-audit --no-fund; \
    else npm ci --no-audit --no-fund; fi

FROM deps AS web
COPY packages packages
COPY apps/web apps/web
# A module's own screens (modules/<id>/web/) are part of the web bundle.
COPY modules modules
RUN npm run build --workspace apps/web

# Packages are downloaded once (deps); production modules are pruned without a second download.
FROM deps AS prod-deps
RUN npm prune --omit=dev --offline --no-audit --no-fund

FROM ${NODE_SLIM} AS app
# git: per-chat worktrees and the repo_* file/git tools (apps/server/src/worktrees.mjs, repo-tools.mjs).
# openssh-client: config CLAUDE_HOST runs the owner's Claude Code on the host (providers/host-spawn.mjs).
# python3: scripts and tools the chats run in Bash (the node user has no other interpreter).
# ca-certificates: git/curl over HTTPS from the chats (--no-install-recommends drops it; without it "CAfile: none").
# adb: the person's phone plugged into their browser (phone-bridge.mjs) is an `adb connect 127.0.0.1:15555` here.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssh-client python3 adb && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prod-deps /src/package.json /src/package-lock.json ./
COPY --from=prod-deps /src/node_modules node_modules
# Workspace deps of apps/server may live under apps/server/node_modules (not hoisted).
COPY --from=prod-deps /src/apps/server/node_modules apps/server/node_modules
COPY packages/timeline/package.json packages/timeline/
# BUILD_COMMIT (optionally stamped at build time) is what /healthz reports; the [T] glob keeps it optional.
COPY apps/server/package.json apps/server/BUILD_COMMI[T] apps/server/CHANGELOG.jso[n] apps/server/
COPY packages/timeline/src packages/timeline/src
COPY apps/server/src apps/server/src
COPY apps/server/assets apps/server/assets
# Scenario evals: docker exec griffin-app-1 node apps/server/scripts/eval.mjs
COPY apps/server/scripts apps/server/scripts
# Modules (modules/<id>/, docs/modules.md): loaded from /app/modules by the module host.
COPY modules modules
COPY --from=web /src/apps/web/dist apps/web/dist
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3100 \
    HOME=/data/home \
    GRIFFIN_DATA=/data \
    GRIFFIN_WORKSPACE=/workspace \
    GRIFFIN_WEB_DIST=/app/apps/web/dist \
    GRIFFIN_BROKER_SOCKET=/run/griffin/broker.sock
# Named volumes inherit this ownership on first use, so `docker run -v griffin-data:/data` just works.
RUN mkdir -p /run/griffin /data /workspace && chown node:node /run/griffin /data /workspace
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/src/index.mjs"]

FROM ${NODE_ALPINE} AS broker
# python3 + the two crypto libs are for the vendored Winbox client (apps/broker/vendor/winbox),
# used for routers whose RouterOS API is off: their console is reached over Winbox itself.
# git: clone/fetch/push of the repos chats work on (apps/broker/src/repos.mjs).
RUN apk add --no-cache age openssh-client python3 py3-pycryptodome py3-ecdsa git
WORKDIR /app
COPY apps/broker/src apps/broker/src
COPY apps/broker/vendor apps/broker/vendor
COPY apps/broker/package.json apps/broker/package.json
ENV NODE_ENV=production \
    GRIFFIN_BROKER_SOCKET=/run/griffin/broker.sock \
    GRIFFIN_SITE_CONFIG=/config/site.json \
    GRIFFIN_SSH_KNOWN_HOSTS=/config/ssh_known_hosts
RUN mkdir -p /run/griffin /broker-data && chown node:node /run/griffin /broker-data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "const p=process.env.GRIFFIN_BROKER_SOCKET;require('http').get({socketPath:p,path:'/healthz'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "apps/broker/src/server.mjs"]
