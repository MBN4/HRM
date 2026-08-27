import { PrismaClient } from '@prisma/client';
import { resolveAdminPoolConfig, resolveAppPoolConfig, withPoolParams } from './pool-config';

declare global {
  // eslint-disable-next-line no-var
  var __hrmPrisma: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __hrmAppPrisma: PrismaClient | undefined;
}

function ownerDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set.');
  }
  return url;
}

/**
 * Owner/migration-role client (DATABASE_URL). Superuser in local dev — it
 * ALWAYS bypasses Row-Level Security. Only for migrations, seeding, and
 * cross-tenant admin/bootstrap tooling. Never use this for a request-time
 * query that should be tenant-scoped. `datasourceUrl` is built with its
 * own, separately-sized bounded pool (see pool-config.ts) — 0.10's
 * connection-pool protection applies to this client too, not just
 * `appPrisma`, since seeding/tests/platform-admin operations can also
 * exhaust a pool if left unbounded.
 */
export const prisma =
  global.__hrmPrisma ?? new PrismaClient({ datasourceUrl: withPoolParams(ownerDatabaseUrl(), resolveAdminPoolConfig()) });

if (process.env.NODE_ENV !== 'production') {
  global.__hrmPrisma = prisma;
}

function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      'APP_DATABASE_URL is not set. The application must connect through the ' +
        'restricted, non-superuser `hrm_app` role for all tenant-scoped queries ' +
        '(see /CLAUDE.md § Conventions → Tenancy model). DATABASE_URL is ' +
        'reserved for migrations/admin tooling and must never be used for ' +
        'request-time queries, since it always bypasses Row-Level Security.',
    );
  }
  return url;
}

/**
 * Restricted, non-superuser role (APP_DATABASE_URL / `hrm_app`) that Row-Level
 * Security policies are actually enforced against. All tenant-scoped
 * request-time queries must go through this client via `withTenantContext`
 * — never call it directly outside of that helper. Bounded pool + short
 * acquisition timeout (see pool-config.ts / /CLAUDE.md § Conventions →
 * Connection-pool protection) — this is the client every
 * `TenantScopeInterceptor`-held-open-transaction request draws from, so
 * it's the one that actually needs the exhaustion protection this step
 * adds.
 */
export const appPrisma =
  global.__hrmAppPrisma ?? new PrismaClient({ datasourceUrl: withPoolParams(appDatabaseUrl(), resolveAppPoolConfig()) });

if (process.env.NODE_ENV !== 'production') {
  global.__hrmAppPrisma = appPrisma;
}
