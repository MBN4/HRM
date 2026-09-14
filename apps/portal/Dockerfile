# Phase 5.3 — production image for the tenant portal (Next.js App Router,
# see docs/conventions/deployment-scaling.md § Kubernetes). Same
# `turbo prune` shape as apps/api/Dockerfile; Alpine is fine here (unlike
# the API image) since this app has no native-binary dependencies — pure
# JS/TS all the way down (xlsx, recharts, lucide-react).

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS pruner
COPY . .
RUN npx turbo prune @hrm/portal --docker

FROM base AS installer
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# @hrm/portal imports @hrm/shared's compiled output; @hrm/db is not a
# portal dependency, so no `prisma generate` step is needed here.
RUN pnpm turbo run build --filter=@hrm/portal...

# --- Runtime: Next.js `output: 'standalone'` (next.config.js) traces the
# minimal node_modules subset this app actually needs into
# .next/standalone — the copies below follow Next.js's own documented
# monorepo layout for that output exactly. ---
FROM base AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 hrm && adduser --system --uid 1001 hrmportal

COPY --from=installer /app/apps/portal/.next/standalone ./
COPY --from=installer /app/apps/portal/.next/static ./apps/portal/.next/static
COPY --from=installer /app/apps/portal/public ./apps/portal/public

USER hrmportal
EXPOSE 3003
ENV PORT=3003
CMD ["node", "apps/portal/server.js"]
