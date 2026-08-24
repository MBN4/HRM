import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __hrmPrisma: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __hrmAppPrisma: PrismaClient | undefined;
}

/**
 * Owner/migration-role client (DATABASE_URL). Superuser in local dev — it
 * ALWAYS bypasses Row-Level Security. Only for migrations, seeding, and
 * cross-tenant admin/bootstrap tooling. Never use this for a request-time
 * query that should be tenant-scoped.
 */
export const prisma = global.__hrmPrisma ?? new PrismaClient();

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
 * — never call it directly outside of that helper.
 */
export const appPrisma =
  global.__hrmAppPrisma ?? new PrismaClient({ datasourceUrl: appDatabaseUrl() });

if (process.env.NODE_ENV !== 'production') {
  global.__hrmAppPrisma = appPrisma;
}
