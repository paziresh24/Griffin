# Two images from one tree: `app` (UI + agent runtime) and `broker` (credentials + typed tools).
# The build needs no network: .build/npm-cache is prepared on a machine with good
# registry access (see deploy/README.md) and installed with --offline.

# The Cursor SDK ships glibc native modules, so the app side uses Debian.
FROM node:24-bookworm-slim AS deps
WORKDIR /src
COPY .build/npm-cache /tmp/npm-cache
COPY package.json package-lock.json ./
COPY packages/timeline/package.json packages/timeline/
COPY apps/server/package.json apps/server/
COPY apps/broker/package.json apps/broker/
COPY apps/web/package.json apps/web/
RUN npm ci --offline --cache /tmp/npm-cache --no-audit --no-fund

FROM deps AS web
COPY packages packages
COPY apps/web apps/web
RUN npm run build --workspace apps/web

# Packages are downloaded once (deps); production modules are pruned offline.
FROM deps AS prod-deps
RUN npm prune --omit=dev --offline --cache /tmp/npm-cache --no-audit --no-fund

FROM node:24-bookworm-slim AS app
WORKDIR /app
COPY --from=prod-deps /src/package.json /src/package-lock.json ./
COPY --from=prod-deps /src/node_modules node_modules
# Workspace deps of apps/server may live under apps/server/node_modules (not hoisted).
COPY --from=prod-deps /src/apps/server/node_modules apps/server/node_modules
COPY packages/timeline/package.json packages/timeline/
COPY apps/server/package.json apps/server/
COPY packages/timeline/src packages/timeline/src
COPY apps/server/src apps/server/src
COPY apps/server/assets apps/server/assets
# Scenario evals: docker exec griffin-app-1 node apps/server/scripts/eval.mjs
COPY apps/server/scripts apps/server/scripts
COPY --from=web /src/apps/web/dist apps/web/dist
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3100 \
    HOME=/data/home \
    GRIFFIN_DATA=/data \
    GRIFFIN_WORKSPACE=/workspace \
    GRIFFIN_WEB_DIST=/app/apps/web/dist \
    GRIFFIN_BROKER_SOCKET=/run/griffin/broker.sock
# Named volume for the broker socket inherits this ownership on first use.
RUN mkdir -p /run/griffin && chown node:node /run/griffin
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/src/index.mjs"]

FROM node:24-alpine AS broker
# python3 + the two crypto libs are for the vendored Winbox client (apps/broker/vendor/winbox),
# used for routers whose RouterOS API is off: their console is reached over Winbox itself.
RUN apk add --no-cache age openssh-client python3 py3-pycryptodome py3-ecdsa
WORKDIR /app
COPY apps/broker/src apps/broker/src
COPY apps/broker/vendor apps/broker/vendor
COPY apps/broker/package.json apps/broker/package.json
ENV NODE_ENV=production \
    GRIFFIN_BROKER_SOCKET=/run/griffin/broker.sock \
    GRIFFIN_SITE_CONFIG=/config/site.json \
    GRIFFIN_SSH_KNOWN_HOSTS=/config/ssh_known_hosts
RUN mkdir -p /run/griffin && chown node:node /run/griffin
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "const p=process.env.GRIFFIN_BROKER_SOCKET;require('http').get({socketPath:p,path:'/healthz'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "apps/broker/src/server.mjs"]
