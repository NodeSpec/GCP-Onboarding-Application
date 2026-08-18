# syntax=docker/dockerfile:1

# The Lifecycle Step Executor image.
#
# Built from the repository root as its context, matching the documented
# invocation:  docker build -f services/worker/Dockerfile . 
#
# Same multi-stage shape as the API image. The worker is the only service that
# mutates Google Workspace; it is an HTTP service that receives Cloud Tasks
# deliveries on /tasks and the API service's directory lookups on /lookup, so it
# listens on PORT exactly as the API does. It serves no console.

# ---------------------------------------------------------------- build stage
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/schemas/package.json      packages/schemas/
COPY packages/shared/package.json       packages/shared/
COPY packages/test-support/package.json packages/test-support/
COPY services/api/package.json          services/api/
COPY services/worker/package.json       services/worker/
COPY services/console/package.json      services/console/

RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# -------------------------------------------------------------- runtime stage
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/worker ./services/worker

WORKDIR /app/services/worker

# Cloud Run injects PORT; config.ts reads it, defaulting to 8080.
CMD ["node", "dist/index.js"]
