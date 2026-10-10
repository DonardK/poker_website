# syntax=docker/dockerfile:1.7
#
# Web app (Next.js) image.
#
# UNEXECUTED: written and reviewed by reading only; build and smoke-test it in
# CI before relying on it. Build from the REPO ROOT (npm workspaces):
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://poker.example.com \
#     --build-arg NEXT_PUBLIC_SOCKET_URL=https://poker.example.com \
#     -t poker-web .
#
# NEXT_PUBLIC_* values are PUBLIC: Next.js inlines them into the browser
# bundle at build time, so they are build arguments, and they are the only
# configuration this image takes. Never pass a secret as a build argument
# (build args are recorded in the image history). With the one-origin edge in
# deploy/, both are the public origin itself (https://<PUBLIC_HOST>), because
# the client code appends /api/... and Socket.io's /socket.io/ path.
#
# Because the URLs are baked in, an image is built per environment (staging
# and production get different images from the same commit).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
# tini: PID 1 that forwards SIGTERM to next and reaps zombies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------------------
FROM base AS build
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SOCKET_URL
# Set to 1 ONLY for a local smoke test of the image over plain http.
ARG ALLOW_INSECURE_PUBLIC_URLS=0
# Refuse to build a bundle that would talk to the API in cleartext (or fall
# back to the client's http://localhost:4000 default): the refresh cookie is
# Secure and hole cards must only travel over TLS.
RUN set -eu; \
    for v in "NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-}" "NEXT_PUBLIC_SOCKET_URL=${NEXT_PUBLIC_SOCKET_URL:-}"; do \
      name="${v%%=*}"; value="${v#*=}"; \
      if [ -z "$value" ]; then echo "build arg $name is required" >&2; exit 1; fi; \
      case "$value" in \
        https://*) ;; \
        *) if [ "$ALLOW_INSECURE_PUBLIC_URLS" != "1" ]; then echo "$name must start with https:// (got $value)" >&2; exit 1; fi ;; \
      esac; \
    done

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# --ignore-scripts: the only lifecycle script that matters here is the root
# postinstall, which generates the Prisma client for the SERVER; the web app
# does not use it. (next's own native pieces ship as prebuilt optional
# packages and need no install script.)
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
ENV NODE_ENV=production \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_SOCKET_URL=${NEXT_PUBLIC_SOCKET_URL}
# The web app imports @poker/shared through its package exports (dist/), so
# shared is built first; the engine and server are not needed.
RUN npm run build -w @poker/shared \
 && npm run build -w @poker/web \
 && rm -rf apps/web/.next/cache
# next.config.ts at RUNTIME would make `next start` look for the typescript
# package and, if it is missing, try to npm-install it at start-up (Next 15,
# build/next-config-ts/transpile-config.js). The runtime image therefore gets a
# compiled next.config.mjs instead. tsc keeps the code as is; the sed adds
# ".js" to bare "next/..." subpath imports, which Node's ESM loader requires
# because the next package has no "exports" map. The import check fails the
# build if the compiled config does not load.
RUN cd apps/web \
 && ../../node_modules/.bin/tsc next.config.ts --outDir /tmp/next-config --module esnext --moduleResolution bundler \
      --target es2022 --skipLibCheck --types node \
 && sed -E 's#from "next/([A-Za-z0-9/_-]+)"#from "next/\1.js"#g' /tmp/next-config/next.config.js > next.config.mjs \
 && node --input-type=module -e "const m = await import('./next.config.mjs'); const c = typeof m.default === 'function' ? m.default('phase-production-server') : m.default; if (!c || c.distDir !== '.next') { console.error('compiled next.config.mjs is wrong'); process.exit(1); }"

# ---------------------------------------------------------------------------
# Production dependencies of @poker/web only.
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# --omit=optional as well as --omit=dev: next declares typescript and
# @playwright/test as optional peers, and because they are also dev
# dependencies the lockfile marks them "devOptional", which npm only drops when
# both are omitted. Verified with `npm ci --dry-run`: this additionally drops
# sharp and next's SWC binary. Neither is used by `next start` here: SWC only
# compiles (and a TypeScript config, replaced above), and sharp is only for
# next/image optimisation, which the app does not use. If next/image is ever
# added, add sharp as a regular dependency of @poker/web.
RUN npm ci --omit=dev --omit=optional --ignore-scripts --workspace @poker/web \
 && test -f node_modules/next/dist/bin/next \
 && test ! -e node_modules/typescript \
 && test ! -e node_modules/@playwright/test \
 && test ! -e node_modules/tailwindcss \
 && test ! -e node_modules/@prisma/client \
 && test ! -e node_modules/express

# ---------------------------------------------------------------------------
# LAST stage, so a plain `docker build` (no --target) produces the runtime.
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Owned by root, readable by the app user: the process cannot modify its code.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# The workspace link node_modules/@poker/shared points here. Its code is
# compiled into the Next bundle (transpilePackages); dist/ is shipped anyway
# (a few KiB) so a server chunk that ever resolves it at runtime still works.
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/web/package.json apps/web/package.json
COPY --from=build /app/apps/web/next.config.mjs apps/web/next.config.mjs
COPY --from=build /app/apps/web/.next apps/web/.next
COPY deploy/healthcheck.mjs deploy/healthcheck.mjs

USER node
WORKDIR /app/apps/web
EXPOSE 3000

# Liveness: the home page renders. The web tier has no dependencies of its own
# (it talks to the API from the browser), so liveness doubles as readiness.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/app/deploy/healthcheck.mjs", "/", "3000"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "--port", "3000", "--hostname", "0.0.0.0"]
