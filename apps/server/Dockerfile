# syntax=docker/dockerfile:1.7
#
# Game server (Express + Socket.io + Prisma) image.
#
# UNEXECUTED: written and reviewed by reading only; build and smoke-test it in
# CI before relying on it. Build from the REPO ROOT (npm workspaces):
#   docker build -f apps/server/Dockerfile -t poker-server .
#   docker build -f apps/server/Dockerfile --target migrate -t poker-migrate .
#
# Targets:
#   runtime (default)  the game server: production dependencies only, non-root,
#                      no Prisma CLI, no compilers, no source.
#   migrate            one-off job that runs `prisma migrate deploy`. Run it by
#                      hand (or as a gated pipeline step) with the ADMINISTRATOR
#                      DIRECT_URL injected; never at app start-up, and never
#                      with that URL given to the runtime container.
#                      See docs/DEPLOYMENT.md "Applying migrations".
#
# No secrets are baked in: .dockerignore keeps every .env* and key file out of
# the build context, and all configuration (DATABASE_URL, JWT secrets,
# GAME_ENCRYPTION_KEY, ...) is injected at container start by the orchestrator
# or secret manager. The only DATABASE_URL below is a dead placeholder that
# exists for the duration of one RUN so `prisma generate` can load
# prisma.config.ts (which refuses to load without a URL); generate never
# connects, and the value is not kept in any layer's environment.

# Pin by digest in your registry mirror for reproducible builds, e.g.
#   --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:<digest>
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
# openssl: Prisma's query engine links libssl. ca-certificates: TLS to the
# managed database and Redis. tini: PID 1 that forwards SIGTERM to node and
# reaps zombies, so the graceful drain in src/index.ts actually runs on stop.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

# ---------------------------------------------------------------------------
# Full install (dev dependencies included) for compiling.
FROM base AS build
# Manifests first so the dependency layer is cached until they change. npm ci
# validates package-lock.json against EVERY workspace manifest, so all of them
# are copied even though the web app is not built here.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# The root postinstall runs `prisma generate` for @poker/server, which needs
# the schema and config to be present during npm ci.
COPY apps/server/prisma/schema.prisma apps/server/prisma/schema.prisma
COPY apps/server/prisma.config.ts apps/server/
RUN DATABASE_URL="postgresql://build-placeholder:unused@127.0.0.1:1/unused" npm ci

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/engine packages/engine
COPY apps/server apps/server
# Regenerate in case the full prisma/ directory differs from the early copy,
# then compile only what the server needs (not the web app).
RUN DATABASE_URL="postgresql://build-placeholder:unused@127.0.0.1:1/unused" npm run prisma:generate -w @poker/server \
 && npm run build -w @poker/shared \
 && npm run build -w @poker/engine \
 && npm run build -w @poker/server

# ---------------------------------------------------------------------------
# Production dependencies of @poker/server (and its workspace packages) only.
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# --ignore-scripts: the root postinstall would run the Prisma CLI, which is a
# dev dependency and deliberately absent here. The runtime stage copies the
# generated client (node_modules/.prisma) from the build stage instead; same
# lockfile, so the client and its query engine match @prisma/client exactly.
# --omit=optional as well as --omit=dev: @prisma/client declares the Prisma
# CLI (and typescript) as OPTIONAL peers, and because the CLI is also a dev
# dependency the lockfile marks that whole tree "devOptional", which npm only
# drops when BOTH dev and optional are omitted. Verified with
# `npm ci --dry-run`: the only packages this removes are the Prisma CLI tree
# and typescript; every direct dependency of @poker/server stays.
# The `test`s fail the build if the workspace filter or the omit flags ever
# stop doing what this stage relies on (dev tooling or the web app's
# dependencies leaking into the runtime image).
RUN npm ci --omit=dev --omit=optional --ignore-scripts --workspace @poker/server \
 && test -d node_modules/@prisma/client \
 && test -e node_modules/@poker/engine \
 && test -e node_modules/@poker/shared \
 && test ! -e node_modules/prisma \
 && test ! -e node_modules/typescript \
 && test ! -e node_modules/tsx \
 && test ! -e node_modules/next

# ---------------------------------------------------------------------------
# One-off migration job. Contains the Prisma CLI (a dev dependency), so it is
# NEVER the image that serves players. Requires DIRECT_URL (administrator) at
# run time:
#   docker run --rm -e DIRECT_URL poker-migrate      (value from the secret manager)
FROM build AS migrate
ENV NODE_ENV=production
USER node
WORKDIR /app/apps/server
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/node_modules/prisma/build/index.js", "migrate", "deploy"]

# ---------------------------------------------------------------------------
# LAST stage, so a plain `docker build` (no --target) produces the runtime.
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4000
# Everything is owned by root and only readable by the app user, so a
# compromised process cannot rewrite its own code or dependencies.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/engine/package.json packages/engine/package.json
COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
# Public CA bundle for verifying the managed Postgres pooler (referenced from
# DATABASE_URL's sslcert parameter as /app/apps/server/certs/...). No keys.
COPY apps/server/certs/supabase-pooler-root.pem apps/server/certs/supabase-pooler-root.pem
COPY deploy/healthcheck.mjs deploy/healthcheck.mjs

# The official node image ships an unprivileged "node" user (uid 1000).
USER node
WORKDIR /app/apps/server
EXPOSE 4000

# Liveness: GET /api/health (process up and serving HTTP). The script speaks
# HTTPS when TLS_CERT_FILE/TLS_KEY_FILE are set, plain HTTP otherwise.
# Readiness (dependencies reachable, safe to receive traffic) is GET
# /api/ready, probed by the orchestrator over the private network; see
# docs/DEPLOYMENT.md "Health and readiness".
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/app/deploy/healthcheck.mjs", "/api/health"]

# SIGTERM starts the graceful drain in src/index.ts. Give the container a stop
# grace period long enough for it (docker stop -t / terminationGracePeriodSeconds).
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

