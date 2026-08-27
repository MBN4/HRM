/**
 * Bounded connection-pool configuration for both Prisma clients (step
 * 0.10) — see /CLAUDE.md § Conventions → Connection-pool protection. This
 * is the direct fix for the tradeoff 0.3 flagged: `TenantScopeInterceptor`
 * holds one pooled connection open for a request's FULL duration (the
 * price of "RLS enforced for the whole request lifecycle"), which means an
 * unbounded pool degrades into exactly the kind of resource exhaustion
 * this whole step exists to prevent. A bounded pool + a short acquisition
 * timeout turns "connections silently exhausted, requests hang forever"
 * into "the Nth request over budget gets a clean, fast error" — see
 * `apps/api/src/resilience/db-pool-exhaustion.filter.ts` for what turns
 * that error into an HTTP 503.
 *
 * `appPrisma` (serves every tenant-scoped request) and `prisma` (owner
 * role — migrations, seeding, admin/platform cross-tenant operations, and
 * this project's own test suites) get SEPARATE, independently-sized pools
 * so a burst of admin/test activity can never starve the pool real
 * requests depend on, and vice versa.
 */
export interface DbPoolConfig {
  connectionLimit: number;
  poolTimeoutSeconds: number;
}

const DEFAULT_APP_POOL_SIZE = 10;
const DEFAULT_ADMIN_POOL_SIZE = 5;
const DEFAULT_POOL_TIMEOUT_SECONDS = 5;

/** Pool serving `appPrisma` — every tenant-scoped, request-time query goes through this. */
export function resolveAppPoolConfig(): DbPoolConfig {
  return {
    connectionLimit: Number(process.env.DB_POOL_SIZE ?? DEFAULT_APP_POOL_SIZE),
    poolTimeoutSeconds: Number(process.env.DB_POOL_TIMEOUT_SECONDS ?? DEFAULT_POOL_TIMEOUT_SECONDS),
  };
}

/** Pool serving `prisma` (owner role) — migrations, seeding, platform/admin cross-tenant operations, tests. */
export function resolveAdminPoolConfig(): DbPoolConfig {
  return {
    connectionLimit: Number(process.env.DB_ADMIN_POOL_SIZE ?? DEFAULT_ADMIN_POOL_SIZE),
    poolTimeoutSeconds: Number(process.env.DB_POOL_TIMEOUT_SECONDS ?? DEFAULT_POOL_TIMEOUT_SECONDS),
  };
}

/**
 * Appends/overrides Prisma's `connection_limit`/`pool_timeout` query
 * params on a Postgres connection URL, leaving every other param (schema,
 * sslmode, ...) untouched. `pool_timeout` is what makes exhaustion FAIL
 * FAST: once every pooled connection is checked out, Prisma queues a new
 * request for up to this many seconds before throwing `P2024` rather than
 * queueing indefinitely (Prisma's own default is effectively "wait
 * forever" for this).
 */
export function withPoolParams(url: string, config: DbPoolConfig): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', String(config.connectionLimit));
  parsed.searchParams.set('pool_timeout', String(config.poolTimeoutSeconds));
  return parsed.toString();
}
