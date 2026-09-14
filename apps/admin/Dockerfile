# Phase 5.3 — production image for the vendor super-admin console
# (Next.js App Router). See apps/portal/Dockerfile's comment header — the
# identical `turbo prune` + Next.js standalone-output shape, just for
# @hrm/admin.

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS pruner
COPY . .
RUN npx turbo prune @hrm/admin --docker

FROM base AS installer
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@hrm/admin...

FROM base AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 hrm && adduser --system --uid 1001 hrmadmin

COPY --from=installer /app/apps/admin/.next/standalone ./
COPY --from=installer /app/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=installer /app/apps/admin/public ./apps/admin/public

USER hrmadmin
EXPOSE 3002
ENV PORT=3002
CMD ["node", "apps/admin/server.js"]
