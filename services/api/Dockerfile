# syntax=docker/dockerfile:1

# The Lifecycle API Service image, which also serves the operator console.
#
# Built from the repository root as its context, matching the documented
# invocation:  docker build -f services/api/Dockerfile . 
#
# Multi-stage on purpose. The build stage installs the whole npm workspace and
# runs the root build, which compiles the libraries in dependency order
# (schemas, then shared, then test-support) and builds the console into
# services/api/public. The runtime stage then carries only the production
# dependency tree and the compiled output, so the toolchain never ships.

# ---------------------------------------------------------------- build stage
FROM node:22-slim AS build
WORKDIR /app

# The workspace manifests first, so a build that changes only source reuses the
# cached dependency install rather than reinstalling on every code change.
COPY package.json package-lock.json ./
COPY packages/schemas/package.json      packages/schemas/
COPY packages/shared/package.json       packages/shared/
COPY packages/test-support/package.json packages/test-support/
COPY services/api/package.json          services/api/
COPY services/worker/package.json       services/worker/
COPY services/console/package.json      services/console/

RUN npm ci

# The sources, then the build. npm run build compiles every workspace and emits
# the console into services/api/public.
COPY . .
RUN npm run build

# Drop dev dependencies so the runtime copy carries no compiler or test tooling.
RUN npm prune --omit=dev

# -------------------------------------------------------------- runtime stage
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The pruned dependency tree, and every workspace package's compiled dist. The
# @lifecycle/* entries in node_modules are relative symlinks into packages/,
# so packages/ has to travel with them.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/api ./services/api

WORKDIR /app/services/api

# Cloud Run injects PORT; config.ts reads it, defaulting to 8080. The service
# drains on SIGTERM, which Cloud Run sends before reclaiming an instance.
CMD ["node", "dist/index.js"]
