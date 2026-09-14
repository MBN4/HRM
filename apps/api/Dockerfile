# Phase 5.3 — production image for BOTH the HTTP API and the worker
# process (docs/conventions/deployment-scaling.md § Kubernetes). One image,
# two entrypoints: `dist/main.js` (the API, see src/main.ts) and
# `dist/worker.js` (the BullMQ worker, see src/worker.ts) — `nest build`
# (plain `tsc` under the hood, per apps/api/nest-cli.json) compiles every
# file `tsconfig.json` includes, so both land in `dist/` from one build.
# The api/worker Deployments below select which one runs via `command:`,
# never a different image — this is what makes "same business logic, same
# image, different deployable" true rather than a documentation claim.
#
# Multi-stage, `turbo prune` based (this is a pnpm+Turborepo monorepo — see
# /CLAUDE.md § Stack): stage 1 computes the minimal pruned subset of the
# monorepo @hrm/api actually needs (its own source plus @hrm/db/@hrm/shared/
# @hrm/config, nothing from apps/portal|admin); stage 2 installs only those
# dependencies and builds; stage 3 is the slim runtime image.
#
# `node:20-bookworm-slim` (Debian, not Alpine) on purpose: @node-rs/argon2
# (auth password hashing, see docs/conventions/auth-rbac.md) and Prisma's
# query engine both ship prebuilt native binaries keyed to glibc by
# default — Alpine's musl libc is a real, documented source of "works
# locally, breaks in the container" failures for exactly these two
# dependencies. Debian slim avoids that class of bug entirely, at the cost
# of a larger base image than Alpine — a deliberate reliability-over-size
# tradeoff for the SAME reason this codebase's `docs/conventions/*.md`
# consistently favor "prove it directly" over "should be fine."

FROM node:20-bookworm-slim AS base
# A REAL bug this Dockerfile's own smoke test caught before it shipped:
# without `openssl` installed, Prisma's engine-binary OS/libc detection
# (both at `prisma generate` time in the installer stage, and again at
# actual runtime in the final stage) falls back to guessing
# `debian-openssl-1.1.x` — but `node:20-bookworm-slim` (Debian 12) ships
# OpenSSL 3.0 by default, which has NO `libssl.so.1.1` at all, so the
# container crashed on boot with "Prisma cannot find the required libssl
# system library" the moment `appPrisma`/`prisma` was first used. Explicitly
# installing `openssl` here — in `base`, so EVERY later stage (the
# `prisma generate` step in `installer` AND the running container in
# `runner`) sees the same, correctly-detected OpenSSL 3.0.x — fixes both
# sides of this at once: generate-time detection and runtime library
# presence must agree, or this exact crash reappears.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# --- Stage 1: prune the monorepo down to what @hrm/api needs ---
FROM base AS pruner
COPY . .
RUN npx turbo prune @hrm/api --docker

# --- Stage 2: install pruned deps + build ---
FROM base AS installer
# `out/json` carries ONLY package.json files (+ lockfile) for the pruned
# subgraph — installing from this layer first means `pnpm install` is
# cached by Docker as long as no dependency actually changed, independent
# of source-code edits.
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
# Now bring in the actual pruned source and build. `prisma generate` must
# run in THIS image (not copied from the host) — its query-engine binary
# is resolved for the container's own OS/libc at generate time, the same
# "native" default packages/db/prisma/schema.prisma already uses locally.
COPY --from=pruner /app/out/full/ .
RUN pnpm --filter @hrm/db run generate
RUN pnpm turbo run build --filter=@hrm/api...

# --- Stage 3: slim runtime image ---
FROM base AS runner
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 hrm && useradd --system --uid 1001 --gid hrm hrmapi

COPY --from=installer /app/apps/api/dist ./apps/api/dist
COPY --from=installer /app/apps/api/package.json ./apps/api/package.json
COPY --from=installer /app/apps/api/keys ./apps/api/keys
COPY --from=installer /app/node_modules ./node_modules
COPY --from=installer /app/apps/api/node_modules ./apps/api/node_modules
# Includes packages/db's own node_modules — which is where its `prisma`
# CLI devDependency lives (see deploy/k8s/base/migration-job.yaml, which
# runs `prisma migrate deploy` from THIS SAME image). A deliberate
# simplification: this carries some devDependency weight into the runtime
# image (prisma CLI, its own deps) rather than maintaining a fourth,
# separate "migrator" image just to trim it — one image, three commands
# (`main.js` / `worker.js` / `prisma migrate deploy`), documented here
# rather than silently accepted.
COPY --from=installer /app/packages ./packages

WORKDIR /app/apps/api
USER hrmapi

# API (3001) and worker-health (3002) — a given deployment only ever
# exercises one of the two, per its own `command:` override (see
# deploy/k8s/base/api-deployment.yaml vs. worker-deployment.yaml).
EXPOSE 3001 3002

CMD ["node", "dist/main.js"]
