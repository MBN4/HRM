# HRM

Global, multi-tenant HR SaaS — sold both as rented SaaS and as a lifetime
on-prem license. See [`CLAUDE.md`](./CLAUDE.md) for the full product/technical
brief, non-negotiables, conventions, and the running build log.

## Stack

- **Monorepo**: Turborepo + pnpm workspaces
- **API**: NestJS + TypeScript
- **Web**: Next.js 14 (App Router) — `admin` (vendor console) and `portal` (tenant org portal)
- **Data**: Prisma + PostgreSQL 16
- **Cache / queues**: Redis + BullMQ
- **Object storage**: S3-compatible (MinIO locally)

## Workspaces

| Path               | Purpose                                   |
| ------------------ | ------------------------------------------ |
| `apps/api`          | NestJS backend                            |
| `apps/admin`        | Vendor super-admin console (Next.js)      |
| `apps/portal`       | Tenant org portal (Next.js)               |
| `packages/db`       | Prisma schema + generated client          |
| `packages/shared`   | Shared types, DTOs, zod validators, constants |
| `packages/config`   | Shared ESLint / TypeScript / Prettier config |

## Prerequisites

- Node.js >= 20.9 (see `.nvmrc`)
- [pnpm](https://pnpm.io) 9.x — enable via `corepack enable pnpm` (or `npm i -g pnpm`)
- Docker + Docker Compose (for Postgres, Redis, MinIO)

## Setup

1. **Install dependencies**

   ```bash
   pnpm install
   ```

2. **Copy environment files** — one per app/package, each documents every variable it needs:

   ```bash
   cp apps/api/.env.example apps/api/.env
   cp apps/admin/.env.example apps/admin/.env.local
   cp apps/portal/.env.example apps/portal/.env.local
   cp packages/db/.env.example packages/db/.env
   ```

3. **Start local infrastructure** (Postgres 16, Redis, MinIO):

   ```bash
   docker compose up -d
   ```

4. **Generate the Prisma client**:

   ```bash
   pnpm db:generate
   ```

5. **Run database migrations** (once the schema is defined beyond the placeholder):

   ```bash
   pnpm db:migrate
   ```

6. **Run everything in dev mode**:

   ```bash
   pnpm dev
   ```

   - API: http://localhost:3001
   - Admin console: http://localhost:3002
   - Portal: http://localhost:3003
   - MinIO console: http://localhost:9001

## Common commands

| Command             | Description                              |
| -------------------- | ----------------------------------------- |
| `pnpm build`          | Build all workspaces (via Turborepo)     |
| `pnpm dev`            | Run all apps in watch mode               |
| `pnpm lint`           | Lint all workspaces                      |
| `pnpm test`           | Run tests in all workspaces              |
| `pnpm format`         | Format the repo with Prettier            |
| `pnpm db:generate`    | Regenerate the Prisma client             |
| `pnpm db:migrate`     | Run Prisma migrations (dev)              |
| `pnpm db:studio`      | Open Prisma Studio                       |

## Conventions & project memory

Tenancy model, country/tenant resolution, licensing, and everything else
architectural is tracked in [`CLAUDE.md`](./CLAUDE.md), which also serves as
an append-only build log and a checklist of what is/isn't built yet. Read it
before starting new work.
